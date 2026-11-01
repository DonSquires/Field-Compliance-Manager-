# Governed Custom Report Builder

## Decision

Custom reports reuse `monthly_report_packs` because that table already owns the
review, publication, PDF, delivery, audit, and issued-record immutability
lifecycle. The table name is now narrower than its responsibility, but renaming
it would create a large cross-surface migration with no user benefit. The
`report_kind` column distinguishes scheduled `monthly` packs from manually
scoped `custom` packs.

Every custom report is anchored to one accepted operational service agreement.
A report cannot combine unrelated clients or agreements. This preserves the
agreement as the authorization and delivery boundary.

Provider authority is deliberately narrower than general agreement visibility:
only a direct provider custodian or its parent organisation may administer the
report. A provider that happens to serve the report-owning provider as a client
does not inherit report access. Human platform-owner administrators, including
`grand_master`, have no standing subscriber report access; diagnostics require
the governed, audited break-glass path.

## Scope Semantics

The builder accepts a date range and zero or more canonical IDs in three filter
dimensions:

- Place facets: Sites and Zones from active `service_agreement_locations`
  links.
- People from `canonical_person_public` only when tenant-scoped observations
  link that person to the agreement's places in the selected period.
- Vehicles from `canonical_vehicle_public` only when tenant-scoped observations
  link that vehicle to the agreement's places in the selected period.

Sites and Zones are **OR-matched within the place dimension**. People and
Vehicles are each OR-matched within their own dimensions, and populated
dimensions are AND-matched. For example, selecting two Sites, one Zone, one
Person, and one Vehicle means activity at any selected Site or Zone that links
both the selected Person and selected Vehicle. With no entity selections, the
report covers all activity linked to the agreement.

`report_scope` freezes the selected IDs, public labels, sections, semantics, and
version at generation time. `data` freezes the matched source facts and counts.
Neither is editable in provider review.

## Privacy And Evidence Boundary

The builder never reads `canonical_people` or `canonical_vehicles` directly for
display labels. It uses the redacted public projections and excludes date of
birth, registered-owner names, and private welfare notes.

Person and vehicle filters currently apply only to `observations` and breach
alerts joined to those observations. Incidents and checkpoint visits do not
carry a governed canonical person/vehicle relationship, so those sections are
available only for agreement/place scope. The UI disables them and the database
rejects attempts to bypass that control.

Person/Vehicle scope and any report containing detailed observations, breaches,
or checkpoint visits are marked `privacy_tier = personal`. Incident detail is
marked `sensitive_personal`. Only a summary-only report without Person/Vehicle
scope is `operational_metadata`. After provider review and publication, only an
active `client_admin` in the agreement's client organisation can read a
personal or sensitive custom pack; ordinary client viewers retain access to
monthly and operational-metadata custom reports.

Client access requires active, direct membership in the agreement's client
organisation. A different provider that also serves that client does not gain
access to this provider's report rows or PDF objects. Personal and sensitive
reports cannot be published until an active client administrator exists. They
use portal delivery when enabled; if portal reporting is disabled, email is
allowed only when the active primary contact email belongs to that client
administrator. Operational-metadata reports may use the approved primary
contact email when portal delivery is unavailable.

Each requested detail section is capped at 1,000 rows. The database rejects a
broader requested detail result and instructs the administrator to narrow the
period or scope rather than creating a partial snapshot. Unselected detail
sections do not block generation; summary counts remain exact.

Observations, breaches, incidents, checkpoint visits, and selected public
labels are materialized by one SQL statement, so every count and detail array
comes from the same PostgreSQL statement snapshot. Breaches must match both the
scoped observation and provider tenant and retain that observation's frozen
Site/Zone evidence; an unconstrained Zone value on the alert cannot replace the
observation's authorized Place. Checkpoint evidence includes legacy
place checkpoints and route checkpoints whose Site is inherited from the
governed patrol route.

## Lifecycle

1. A provider administrator chooses one agreement, period, scope, and sections.
2. `generate_custom_report_pack` validates every ID and writes a new provider-
   private `draft` plus `custom_report_pack_generated` audit evidence.
3. The existing review form displays the frozen scope and source metrics.
4. `review_monthly_report_pack` saves editorial content or publishes the pack.
5. Published portal packs expose the same frozen scope and details to the
  authorized client. Email delivery requires the current reviewed PDF and
  sends a seven-day private link only to the client's active primary contact;
  personal email also requires that contact to be an active client admin.
6. An atomic delivery claim prevents concurrent email attempts. Sent rows
  remain immutable, and an uncertain claim requires explicit review and
  republication before retry.

PDF metadata, delivery claims, successful receipts, failed receipts, and their
audit events are committed by service-role-only database RPCs. Each RPC
rechecks the authenticated human actor's provider-tree authority. Browser
clients cannot call these state-transition functions directly, and authenticated
roles have no direct `INSERT`, `UPDATE`, or `DELETE` privilege or policy on
report-pack rows.

The PDF renderer embeds pinned Noto Sans fonts so Māori names and macrons remain
faithful. Ligatures are disabled at embed time because pdf-lib advances the
"fi" glyph incorrectly, which split words visually and in copied text. Its
metadata update uses the pack's `updated_at` value as an optimistic
lock, wraps text by actual font width without truncating report evidence, and
removes a newly uploaded artifact if the report changed while rendering.
The footer states the pack's actual availability: provider-private draft,
authorized client portal, approved primary-contact email, or governed provider
record. It never promises portal access for a draft or email-only report.
`pdf_source_updated_at = updated_at` identifies the one current reviewed PDF.
Review or publication keeps the old path for later cleanup but makes that
artifact stale, so neither the portal nor email delivery can expose it. A
successful replacement removes the old object; a failed cleanup is audited.
If email delivery fails after a signed link is created, the pack's PDF is made
stale and the object is deleted so that link no longer resolves; cleanup
failure is separately audited.

Objects under `org/{provider}/report-packs/` do not inherit the provider prefix's
general read rule. Storage access requires a pack row that is visible to the
caller under `monthly_report_packs` RLS and currently references that exact PDF.
This keeps client-admin restrictions effective at both the database row and
private object boundaries.

Generating a custom report never creates or sends a scheduled R&M monthly pack.

## Monthly Packs: Month-End Activity

Scheduled monthly packs share this renderer. The migration
`20261102210000_rm_monthly_activity_report.sql` extends `generate_due_report_packs`
to freeze a categorised client site activity report (`data.activityReport`,
version 2) and up to 2,000 itemised lines (`activity_lines`, a separate column
that list queries do not select). The PDF adds the client sections (at a
glance, activity overview, incidents and investigations, pest control,
maintenance, manufacture, observations) and a site log by location, with up to
3 photos per entry and 60 per report; packs without an activity report keep
their earlier layout. Travel, administration and shift markers are withheld
from the client report. The PDF and email never describe the import or
matching process; pack, snapshot and renderer provenance is kept in the PDF's
document properties. Provider administrators see the withheld counts in a
collapsed, provider-only completeness check and can compare a pack with live
records through `get_report_pack_activity_accounting`. That result is never
persisted to client-readable data.

Photos do not make travel, administration or shift markers reportable, and a
pest-control classification cannot override an explicit operational activity.
These records remain accounted for privately, without contributing entries,
photos or pest statistics to the client report. Site comments, CCTV evidence,
observations and incident photos remain beside their corresponding entries.
The review page gives unavailable photos a visible retry action, including
when a previously issued photo link has expired. Retrying renews that photo's
short-lived link under the same storage permissions; it does not change the
report or its evidence.

Generation and accounting use explicit Auckland midnight boundaries, independent
of the database session timezone. Freshness compares every summary section and a
stable digest of all reportable itemised lines, even beyond the display cap.
The review panel checks the displayed pack version before showing lazy-loaded
lines or live accounting; if another administrator regenerated the pack, refresh
and reopen it rather than combining two snapshots.

`generate-report-pack-pdf`, `send-report-pack` and
`apps/web/src/lib/reportPackRenderer.ts` must name the same renderer version;
`test/report-activity-sections.test.js` enforces it. Raising the version makes
published but unsent PDFs stale until they are regenerated. See
`docs/RM_ONBOARDING_TRACKER.md` for categories, data caveats and deployment
order.
