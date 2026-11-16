> **Canonical copy (extract).** Origin: GitLab `don-squires1/field-compliance-manager` `docs/ARCHITECTURE.md` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. Only the still-canonical sections are kept: the Refining Layer (unified field-operations model), the NZ Legal Framework, and the Key Design Principles. The System/Bob/RunPod/Railway infrastructure sections of the origin were already marked SUPERSEDED there and are omitted; current infrastructure is in `docs/INFRASTRUCTURE_VERIFICATION_MAP.md`. The "Live status" section at the end was verified against the live database on 2026-09-14.

# Unified Field-Operations Model

## Owner ruling 2026-11-16 - planned amendments and live handovers

The roster inspector is a viewport-bounded drawer with independently scrollable
details and persistent actions. One **Edit shift** form covers officer, work
unit, planned start/end, planned unpaid-break allowance, briefing and the
designated static-shift contact, before or after publication/start.

An active administrator with operating authority for the branch may amend the
plan with a reason, fresh slot/linked-shift/contact versions and an idempotent
request receipt. Notes, contact and planned-break corrections do not revalidate
an unchanged assignment against unrelated readiness changes. Assignment/time
changes retain availability, eligibility, contract, overlap and fatigue checks.
Completing an already-recorded attendance segment does not requalify its source
officer against later availability changes; the replacement still passes all
assignment checks. A completed segment may only retain its plan or be bounded
to its evidenced actual attendance here.
Assignment writers share a per-person transaction guard; contention explicitly
requires a retry rather than allowing concurrent overlapping assignments.
The guard checks both roster responsibility and standalone field attendance,
excluding only a slot's own linked field record. Declined/cancelled/missed field
shifts do not reserve time; completed field work occupies its recorded interval,
falling back to its plan only where attendance bounds are absent.
Replacement assignments, including internal/workshop handovers, require an
effective rosterable branch authorization when staff work outside their home
organization. Moving a live planned start never removes recorded duty or its
audited predecessor segments from fatigue checks, including after successive
timing edits; continuity follows the original handover audit, not a mutable plan.
Cancelling a proposed handover restores the administrator's prior planned-start
input.
Completed/cancelled or historical source records are not editable here.

Changing the officer or work unit/place after actual work starts is a **timed
responsibility handover**, not a reassignment of history. Atomically finish the
original segment through the governed administrative finish path and publish a
separate, unstarted remainder. The replacement accepts/starts normally. Preserve
the original actual start, recorded breaks, completed visits, evidence, GPS,
approved payroll and existing invoice snapshots. Audit the original planned
interval before truncating its planned segment at the confirmed handover time.
The new segment's planned-break allowance is explicitly reviewed; it is not an
automatic deduction or a substitute for statutory entitlements.

Same-run patrol handovers carry outstanding pending/en-route non-dispatch visits
and their unfinished module configuration, never regenerate the full route or
copy actual visit evidence. Lock outstanding visits before finishing the source;
concurrent visit changes require a retry, never resurrect a cancelled visit.
Dispatch returns to its queue. Open welfare alerts
require explicit confirmation that the original officer is safe. Validation or
safety failure rolls back the entire handover. Exactly contiguous, audited
segments of the same person's continuous duty share one fatigue/rest interval;
the complete duty still counts toward weekly-hours and consecutive-day limits.

## Refining Layer — Unified Field-Operations Model

> Status: design authority for the field-operations refinement. Records decisions
> worked out 2026-07-11/12. This is the "next level" refinement over L1-L4, not a
> new foundation. Detail sections marked DEFERRED / RESEARCH are not yet decided.

### The unifying truth

**Every field role is a guard on a place for a shift, with a toolset.** Everything
else is configuration.

- **Freedom camping** = a guard on a ZONE + the FC scan tool.
- **Parking** = a guard on a zone + the parking scan tool.
- **Noise / smoke / biosecurity** = a guard on a place + that assessment tool.
- **Static guarding** = a guard on a site with the base toolkit only (no specialty tool).
- **Patrol** = a guard covering MANY places in one shift (a multi-stop assignment).

The "guard-ness" is identical across all of them; the specialty tool is the only
delta. No module is a bespoke build — each is "add a tool" on the one spine.

### Three-gate tool resolution

Which tools a guard can use in a shift is the intersection of three gates:

1. **Person eligible** — the guard holds/qualifies for the tool (`user_profiles.module_access` = eligibility).
2. **Place capability** — the site/zone is configured for the tool (`organization_modules` / place config). The place dictates what is POSSIBLE.
3. **Assignment grant** — the roster grants the guard the tools required for THIS shift. The roster dictates what is ACTIVE.

Effective toolset = person-eligible ∩ place-capability ∩ assignment-grant, **plus the
base toolkit which is always on**.

### Assignment (the bucket)

An **assignment** is the bucket that carries a client's requirement + places into a
shift. It is a STANDING operational unit the roster STAFFS (not created per shift).

- **Parent assignment** = the client requirement / operational unit. Holds settings:
  `guards_required`, schedule (dates or recurring), and **type** (see below).
  Carries the **base call sign** (e.g. "Alpha").
- **Child assignments** = the individual staffable positions under the parent
  (collapsible children). Each child has its OWN tool selection and supervisor
  options, and sequences its call sign from the parent (Alpha 1, Alpha 2, ...).
  "3 guards required" = a parent with 3 children.
- **stops** = the places (site XOR zone). Static = 1 stop; patrol = N stops.
  Pre-planned (from roster) or ad-hoc (from dispatch).

**Assignment type** (does double duty):
- **Dispatch routing** — general patrol / client patrol / specialty patrol / static —
  so dispatch can identify who to send a job to.
- **Channel grouping** — a type (esp. general patrol) may opt into a shared base call
  sign / group channel (e.g. 4 Nelson patrol runs sharing a "Nelson Patrol" channel).

### Staffing lifecycle (roster)

The assignment bucket flows through the roster into ownership:

1. Assignment (bucket) exists holding client requirements.
2. Rosterer places the bucket in the roster for specific dates or on a schedule.
3. Staffing mode:
   - **Direct assign** — attach a specific guard -> guard is notified -> **confirm**
     (owns it for the shift/sequence) or **decline**.
   - **Open** — all QUALIFIED guards (hold the required tools) are notified -> guards
     **put their name forward** -> rosterer **selects + approves** one.
4. On confirm/approve, the guard **owns the bucket** for the shift or sequence.

States: `unstaffed -> offered (direct|open) -> owned`, plus decline/withdraw.

### Presence

Proof the guard is (was) at the place: shift start/end + verification-point /
checkpoint scans + GPS. Identical mechanism for static (one long stop) and patrol
(many stops). Feeds SLA/obligation, timesheets, welfare, and client "your site was
serviced" reporting. Presence records carry `client_org_id` (same tenancy substrate
as compliance observations).

### Owner direction 2026-11-06: single-site attendance and actual breaks

- For one static place, **Start shift** records shift start and arrival together;
  **End shift** records departure and completion together after the debrief and
  other required work. Do not demand separate on-site/off-site actions.
- The owner permits an officer to proceed when GPS is missing, outside the
  assigned boundary or the boundary is unverified, **with an explanation**.
  Preserve the available position and the exception for operations review.
  This is unverified attendance, never proof of presence or an Oracle entitlement
  to read private site information.
- A roster may specify optional break minutes and whether the break is unpaid.
  Deduct only the actual recorded unpaid duration, not the planned allowance.
  Missing, shorter and longer breaks require visible review evidence; a timer
  reaching zero does not end a break or manufacture a payroll deduction.
- Payroll-authorised administrators may recover scheduled details into a
  separately reviewed manual timesheet and make reasoned, audited pay-code/rate
  corrections for that timesheet only. Neither scheduled hours nor administrative
  recovery prove physical attendance; ongoing employment rates remain unchanged.
- Ordinary report/incident photos are private original evidence with target,
  actor, organization, selection/upload time and hash provenance. Selection time
  is not proof of when the image was taken. Recording a photo
  is not permission to publish it to a client; existing disclosure/review gates
  continue to apply.

### Owner direction 2026-11-08: timesheet roster tolerances

- Timesheet start and finish snap independently to their rostered timestamps
  when the recorded endpoint is within 15 minutes either side, inclusive.
  Beyond that tolerance, retain the recorded time and highlight the mismatch.
- A positive rostered unpaid-break allowance is the mandatory unpaid-break plan
  for this rule. Its recorded unpaid duration snaps to the plan within five
  minutes either side, inclusive. Missing, open, paid-only, shorter and longer
  out-of-tolerance unpaid breaks are highlighted; missing breaks never create
  a deduction. Paid breaks and unplanned unpaid breaks remain actual-duration.
- This is a timesheet-only derivation exception to the exact-duration deduction
  above. Preserve original attendance, break timestamps and recorded duration;
  retain the snapped values and review flags in the submitted work snapshot.
  Existing submitted, approved and exported snapshots are not silently rewritten.
  Split periods must not duplicate worked time or break deductions.

- Timesheets are reviewed one shift at a time: completed shifts whose endpoints
  and mandatory unpaid break match the tolerances are green and their **hours**
  are automatically confirmed. Final payroll review remains separate (owner
  clarification, 2026-11-08). Mismatches are amber; missed shifts are red.
- An authorised reviewer may edit payable start/finish dates and unpaid minutes,
  or explicitly copy the roster dates/times. These are reasoned administrative
  corrections, not changes to recorded presence, and require payroll review.
  Missed work without recorded attendance may be reassigned to an active,
  branch-authorised replacement staff member. Preserve the original assignment
  and decision in audit; never transfer recorded attendance or finalised payroll.

#### Owner clarification 2026-11-15: human approval colours

The shift-hours row colour now represents human review: amber awaiting approval,
green approved, red rejected, and neutral for finalised payroll. This supersedes
the automatic-matching row colours above, not the tolerance calculations.
Show the calculation result separately and retain an explicit approval label.
Saving a payable correction invalidates approval; it does not approve hours.

### Owner direction 2026-11-12: operations starts and finishes the shift by phone

- **Record admin start** on the roster starts the officer's real shift in their
  portal (status in progress, actual start at the recorded time) and notifies
  them. **Record admin finish** finishes it through the supervisor close path:
  open breaks end, reached stops complete, unreached stops are skipped, and open
  dispatch jobs or welfare alerts must be closed first. Both are reasoned,
  audited and idempotent. This supersedes the 2026-11-09 design in which these
  were only separate reported times; those earlier rows remain as reported times.
- The administrator must confirm they spoke with the officer by phone and covered
  the site, its risks and the safety briefing. That confirmation is stored as the
  shift's safety-briefing acknowledgement (`acknowledged_via = admin_phone`,
  recorded by the administrator) and replaces the officer's own pre-start
  briefing confirmation and start-position check for that shift. If the briefing
  changes afterwards, the officer must confirm the new version as usual.
- An admin start is refused while the officer still has another shift in
  progress; operations finishes that shift first, so a back-dated start never
  overlaps it. The generic shift-change notice is suppressed for these actions
  because each sends its own "Operations started/finished your shift" notice.
- The officer's location is captured from their own device once their portal
  reports against the started shift; the roster shows "waiting for the officer's
  device" until then. An administrator's phone confirmation is not GPS proof of
  presence, and static-post arrival remains the officer's own evidence.

### Owner direction 2026-10-25: roster placement and Workshop labour

- Imported forestry assignments belong in the ordinary staff/work-unit roster
  calendar, not a separate historical-area table. Existing source assignments
  retain their recorded dates, officer and route. Their time ranges are evidence,
  not payable durations or verified attendance. Posted patrol-log labour slots
  take precedence for the same staff/day, with recorded-hours provenance and
  an explicit approximate-start warning.
- Create work unit must offer **Manufacturing & maintenance**, for client
  jobs linked to the existing Workshop work order. This is a
  distinct roster category, not a relabelled Office / internal unit.
- Owner clarification: this category requires a client-backed order (lock or
  gate repairs/installations, signs, digger work and similar maintenance).
  Generic internal fabrication remains available in Workshop, not in this
  client roster category. Description-based classification is an explicit,
  reviewable suggestion using the active organisation catalogue; it cannot
  determine commercial entitlement, rates or attendance. Digger and excavator
  work uses the catalogue subject **Earthworks (digger / excavator)**
  (`earthworks`, added 2026-10-29); an organisation without it must choose a
  subject manually.
- Pete Crawford is R&M's usual worker for these jobs. Each organisation's usual
  job lead is stored in `workshop_settings.default_job_lead_user_id` (written
  only by the audited `set_workshop_default_job_lead`; R&M is seeded with Pete).
  The form offers that person as an explicit one-click choice only when they
  are an active member of the operating organisation; never silently assign a
  lead or infer who performed historical work. Each actual
  worker and their hours belongs in a separate roster slot.
- One work-order-backed unit can roster several people in separate slots. Its
  service type is derived from the order's `fabrication`/`maintenance` kind.
  A provider workplace is the roster base; an on-site maintenance job retains
  its actual client place/zone/asset on the work order.
- The roster plans labour and applies the existing staff eligibility, overlap,
  availability and fatigue gates. The work order must be approved/open before
  labour is rostered. Creating or staffing the unit does not silently reassign
  the order's job lead or manufacture a patrol/static field shift.
- Workshop remains the owner of job start/completion, materials, stock and
  client invoice lines. The roster may estimate wages but must not generate a
  second client charge or a made-up margin for that time. Internal orders remain
  internal because they have no client, not because client jobs were classified
  as internal roster work.

### Owner direction 2026-10-26: patrol routes and seeded source truth

- Seeded patrol-log labour belongs on the Blenheim or Nelson patrol route, not
  in per-client holding units. Dave Porter is the usual Blenheim officer; Dan
  Douglas is the usual Nelson officer. `patrol_routes.primary_staff_id`
  (admin-only, audited `set_patrol_route_primary_officer`) records each
  route's usual officer; other staff may still cover the route.
- Each place belongs to the route whose usual officer attends it most. Places
  neither usual officer attends go to the nearest route working area, then to
  a single existing route zone list. A shift follows the majority of its
  places, then the officer's dated route assignment, then the officer's usual
  route. Each slot keeps its client and the basis for its routing. Routing changes
  the roster calendar and route coverage list only, not pay, payroll, invoices
  or future patrol stops.
- Every job seeded from R&M's spreadsheets is already verified truth. Those
  sheets are R&M's source of record for reporting and billing until R&M
  operate in FCM. Seeded jobs have no geofence requirement. They are billed by
  their source and are not billing, quote or geofence exceptions. Roster
  readiness reports them as `source_verified`. Seeded sources are an explicit list
  (`roster_slot_is_source_truth`). Other tagged slots, such as Bob's tentative
  blocks, are not source truth. New FCM-operated work keeps every normal gate.

### Owner direction 2026-10-20: as-attended patrols and recorded travel

- R&M source-backed places completed by Dave Porter belong on Blenheim Forestry
  Patrol; those completed by Dan Douglas belong on Nelson Forestry Patrol.
  Source performer identities and original attribution are preserved. A place
  attended by both may be covered by both routes; the rule does not transfer
  place ownership or assign a future shift to either person.
- **As attended** is an explicit schedule mode, distinct from an unstaffed or
  open shift and from a scheduled visit with an unrestricted time window. It
  has no planned visit count, minimum dwell or arrival/departure deadline, and
  is excluded from contracted stop generation. Real attendance is still
  recorded through the normal governed arrival/departure path.
- Named source places may be registered without geometry at this build stage.
  Their canonical identity and client house remain mandatory; unplaced and
  unverified are honest states, not fabricated pins or verified geofences.
  This does not waive source identity, agreement, role, safety or access checks.
- Actual between-stop kilometres are recorded separately from estimated route
  distance. A measured entry or non-decreasing odometer pair identifies the
  departed origin and arrived destination in the same assigned shift. Replay,
  correction version and audit evidence are required. Unknown distance is not
  zero, and estimated distance is never relabelled as an actual journey. Source
  job kilometres and cumulative trip readings retain their distinct provenance.
  Travel recording does not itself create payroll or invoice charges.

### Base toolkit (shared, always on)

Every guard, every module, has the same first-class, evidence-anchored field-report
tools, each anchored to shift + stop + place + GPS + officer + time:

- incident report
- health & safety report
- maintenance report
- suspicious vehicle
- suspicious person
- verification point (site round proof)
- photo / short video evidence

Suspicious vehicle / person can **promote** into canonical entity intelligence
(VOI / POI / LOI flags) — the seam into the vehicle-compliance family.

> **Owner ruling 2026-09-16 — provisional CCTV person profiles.** CCTV inference
> creates or reuses a canonical profile for each credible face/body portfolio.
> An unidentified profile is named `Unknown Person #N` within the operating
> organisation and carries its source observations, embeddings and provenance.
> This is a growing profile, not verified identity: it remains
> `manual_review_required` until a human reviews the footage and names or merges
> the existing profile. A model never asserts a known name, marks a profile
> verified, or creates an enforcement consequence.

> **Owner ruling 2026-10-11 — human-authored operational records are
> observations.** A person or vehicle mentioned in a report, patrol log,
> incident entry, suspicion record, or issued trespass notice is a valid
> observation because a human recorded what they saw, received, or issued. It
> does not require a second human verification step before entering the
> observation and evidence spines. Explicit source identifiers such as a stated
> name, registration plate, notice recipient, source job number, date, place,
> and author may create or link the corresponding tenant projection and
> canonical entity with full provenance. This ruling does not turn an
> allegation into a proved fact, infer an unstated identity, merge ambiguous
> people, or authorize an enforcement consequence: observation type, source
> wording, confidence, allegation/status, and notice state must remain distinct.

### Specialty tools (plug-ins)

Activated by place-capability ∩ assignment-grant. Two verdict styles + static:

- **Vehicle compliance** (FC, parking) — subject is a plate; ALPR identity; verdict
  = time/place rule (nights / overstay / SCV); enforcement = infringement / NTV /
  tow. Two-observation patterns (FC overnight, parking chalk return-verify).
- **RMA / environmental** (noise, smoke, biosecurity) — subject is a place/activity;
  verdict = measurement/matrix + escalation ladder; enforcement = direction /
  abatement / seizure notices.
- **Static** — no specialty tool; base toolkit only.

Compliance specialty tools produce **observation -> verdict -> breach -> enforcement
ladder** on the shared substrate (`observations`, `breach_alerts`, `notices_to_vacate`,
`infringement_notices`, `enforcement_cases`, immutable `enforcement_case_events`,
atomic counters). **Freedom Camping is the reference build for the vehicle style**
(see the FC compliance redesign epic + `docs/FREEDOM_CAMPING_IMPLEMENTATION_BLUEPRINT.md`).

### PTT — call-sign hierarchy (channel topology DEFERRED)

Call-sign tree mirrors the assignment tree:

```
[optional group channel]   e.g. "Nelson Patrol" (type = general patrol)
  +- parent assignment     base call sign "Alpha" -> channel
       +- child Alpha 1     (guard position)
       +- child Alpha 2     (guard position)
```

Parent dictates the channel; children share it as Alpha 1 / Alpha 2. The channel
ROUTING / monitoring / emergency-broadcast topology is DEFERRED to the PTT design —
it derives from this tree but must express child -> parent -> optional type-group,
supervisor cross-assignment monitoring, and SOS cross-assignment broadcast.

### Ad-hoc dispatch — OPEN / RESEARCH

Reactive path (needs more research before build):

- Job in -> dispatch selects existing site/zone OR creates one via the onboarding
  wizard (place may not exist yet — links the rapid ad-hoc site-create work).
- Dispatch selects the reason (noise, alarm, FC, ...) -> a **response template**
  pre-populates the job with the required tools + legal basis + SLA.
- Routed to the correct assignment by **type**; becomes an **ad-hoc stop** on that
  assignment (or spawns a one-stop assignment when none is nearby).
- The template is the **tool-grant authority for the ad-hoc job** (grants a tool the
  guard was not pre-granted). Open questions: ad-hoc-stop vs spawn-assignment;
  type enum vs capability-derived; fast site/zone create-on-the-fly.

### Naming reconciliation

- **`patrol_routes` -> `assignments`** — the current name leaks "patrol" (movement/
  sequence/patrol-module) but the concept is just the bucket of places for a shift.
  Rename adds: `name` (unique per org among active), `call_sign` base (unique per org
  among active), `type`, `parent_assignment_id` (self-referencing parent/child).
  `shift_stops` stays. `patrol_checkpoint_visits` = presence. Tracked as its own
  additive migration + code-sweep (not bundled into FC).

---


## NZ Legal Framework

| Law | Relevance |
|---|---|
| Freedom Camping Act 2011 (FCA) | Primary enforcement act for freedom camping |
| FCA s.20 | Infringement offence, $200 fine |
| FCA s.32 | Notice to Vacate authority |
| Resource Management Act 1991 (RMA) | Noise control, smoke complaints |
| RMA s.38 | Noise Control Officer warrant |
| RMA s.326 | Abatement Notice |
| RMA s.327 | Enforcement Notice |
| RMA s.17A | Smoke complaint authority |
| Biosecurity Act 1993 | Biosecurity inspections |
| Privacy Act 2020 | Data handling, PII access log |
| Local Government Act 2002 | Bylaw authority |
| Summary Proceedings Act 1957 | Court proceedings |

---

## Key Design Principles

1. **Officer portal is glove-safe** — 44px minimum touch targets, night-readable, single task at a time
2. **Offline-first** — scans queue in IndexedDB, sync on reconnect
3. **GPS auto-detects zone** — officer never manually selects zone during patrol
4. **Bob is advisory** — high-impact actions require human approval
5. **Tenant isolation is absolute** — no data from Org A reaches Org B
6. **Audit log is append-only** — no edits or deletes
7. **Secrets never in code** — all credentials via approved secret management
8. **One function per job** — no duplicate edge functions
9. **PostGIS for all spatial** — zone boundaries, GPS, geofencing
10. **RLS on all tables** — no exceptions

---

## Owner-approved direction 2026-11-16: patrol responsibility and site charging

The existing location **Operational setup** is the workspace for patrols,
work areas, checkpoints and site charging. Do not introduce another top-level
patrol configuration page. Selecting responsibility means an ongoing named run
and its rosterable work unit, not one dated officer shift.

Operational allocation is versioned by effective NZ service date. A confirmed
preview may update only the selected schedule's safe future unstarted plans.
Other contracts' stops, started or evidenced work, attendance, GPS, completed
visits and financial snapshots remain intact. Lock and revalidate the previewed
work against officer starts and source changes; retries return the original
audited receipt without generating stops again. Initial roster publication and
ad-hoc shift creation remain supported; they are not permission to regenerate
an existing historical or evidenced plan.

The operational workspace does not silently vary contractual visit counts,
days, service windows, dwell requirements or SLA. Show those commitments and
direct contractual changes through the existing agreement/variation authority.
As ruled in [ORG_SERVICE_MODEL.md](ORG_SERVICE_MODEL.md), client invitation or
acceptance governs disclosure, not the provider's authority to deliver service.
An authorized location awaiting a patrol schedule is an incomplete setup, not
automatically a permission error.

Reuse agreement commercial terms and scoped billing rate rules; do not copy
monetary values into another rate store. The source may be the client's
agreement, an existing applicable charge rate, or a governed new charge rate.
The supported fixed bases are a completed visit, a root patrol shift at the
place, and an NZ service day. Existing monthly/agreement-period settlement
continues separately without duplicate fees.

Hourly billing requires an explicit per-place/agreement choice: **officer-hours**
sums qualified officer presence, while **site coverage** unions simultaneous
presence so two officers together for an hour produce one coverage hour.
Neither basis is an implicit default. Use existing raw GPS capture and an
explicit versioned evidence policy with accuracy and maximum-gap limits.
Uncertain, missing, gapped or unverified-boundary evidence requires review;
manual arrive/depart buttons do not manufacture billable GPS hours. Preserve
source, boundary and policy provenance, compute money from raw qualified
seconds before final cents rounding, and leave payroll independent.

These are delivery requirements, not a claim that the complete charging path
is already deployed or exercised.

## Live status against this model (verified 2026-09-14, project `dotczcyyzgabmtmnglqj`)

| Model element | Live truth | Reading |
|---|---|---|
| Assignment bucket (parent/child, call sign, type) | `patrol_routes` carries `call_sign`, `guards_required`, `assignment_type`, `parent_assignment_id`; 4 rows. No `assignments` table. | Concept landed on the legacy table; the `patrol_routes -> assignments` rename is still owed. |
| Stops (site XOR zone) | `shift_stops` has `site_id`, `zone_id`, `module_key`, `is_adhoc`, `dispatch_job_id`, SLA columns. | Present and wired; static = 1 stop, patrol = N stops is expressible today. |
| Three-gate tool resolution | `user_profiles.module_access` (person), `organization_modules` + `site_services(module_key, site_id XOR zone_id)` (place), roster/`shift_stops.module_key` (assignment). | All three gates exist as data; the intersection is computed in UI hooks, not yet as one server-side resolver. |
| Presence | `patrol_checkpoint_visits`, `officer_gps_log`, `shift_stops.actual_arrived_at` | Present. |
| Base toolkit | `officer_field_reports` (incident / H&S / maintenance), suspicious vehicle/person via `entity_flags`/canonical links, checkpoint QR visits, `evidence_items`. | Present; governed by `submit_officer_field_report` and `process-officer-scan`. |
| Specialty verdict spine | `observations` (3,128 rows), `breach_alerts`, `notices`, `infringement_notices`, `enforcement_cases`, `vehicle_overnight_sessions`. | Present. `observations` is the access-doctrine keystone (see `ALIGNMENT_LEDGER.md`). |
| Unified event stream (reverified 2026-10-25) | `location_events` has populated patrol-import records with site/zone/checkpoint anchors and `module_key`. The schema contains the governed `stage_patrol_import_chunk_unlocked` writer and source-sync RPCs. | Present and wired: Atlas records real read/write edges, including Operational Continuity reads. Read-only inspection and rollback-only correction tests provide invocation evidence for the inspected paths, not proof that every module writes the stream. This replaces the 2026-09-14 dormant assessment. |
