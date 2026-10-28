> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# ACCESS MODEL — the composed access constitution

> **Status: RATIFIED (owner-signed 2026-08-01). This is the authoritative
> implementation and test contract for record access.** It supersedes the
> proposal pack (!1210 `PROPOSAL_user_has_task_entitlement`, !1211
> `PROPOSAL_access_basis_ux`, !1212 `PROPOSAL_access_scenario_pack`). Those
> proposals are historical; this document is the source of truth.
>
> Sits BELOW `FOUNDATION.md` and `docs/ACCESS_DOCTRINE.md` (the principle layer)
> and BELOW them in authority; it is the executable expression of that doctrine.

## Owner ruling 2026-10-27: operational person lookup and private contacts

Field officers may search people to check trespass, warnings and permits only
after an organisation administrator explicitly authorises them. The
`person_search` area uses the existing staff grant/preset matrix at the user's
home organisation; the checkbox grants `view`, defaults off, and requires an
audited reason for grant or removal. It supplies functional authority, not
new tenant reach: every result still requires existing organisation access.
Inherited preset/ancestor grants and role access must be explained, not falsely
reported as revoked when only a direct checkbox is removed.

This permission is separate from `vehicle_owner_identity` (NZTA). It confers
neither NZTA rights nor identity editing. An inactive account has no lookup
authority. Person search in the officer portal is read-only; the bulk notice
review queue remains an operations-office workflow.

The owner explicitly confirmed that personal addresses and contact details
remain with **Admin, Admin officer, Master and Grand Master**, within their
authorised organisations, across **both Person and Vehicle lookup**, even
when a field officer has NZTA authorisation. This supersedes older rulings
allowing owner locality/address disclosure to non-administrators. Enforce it
in RPCs, projections and raw-record access, not just presentation. Permit
holders and vehicle owners remain distinct identities and relationships.

Vehicle search is a shared operational registry workflow, available to admins
independently of parking or freedom-camping subscriptions. This is not a grant
of platform powers or cross-tenant Master access.

## Owner ruling 2026-10-27 (later the same day): admin officer parity and simple module access

**Admin officer = admin.** An `admin_officer` is an admin person who also works
in the field. They hold exactly an admin's access — the same organisation reach,
approvals, people/identity management, payroll setup, notifications and admin
tools — and may additionally use the officer portal. Every database function,
policy, edge-function gate and web surface that grants something to `admin`
grants it to `admin_officer` (`20261101150000_admin_officer_parity.sql`,
`supabase/functions/_shared/auth.ts`, `apps/web/src/lib/roles.ts`). The portal
chooser only picks which workspace opens; it is not an access boundary.
An admin officer's authorised private contact fields remain available in the
field portal as well as the admin portal.
Inactive identities cannot approve actions or manage identities. A financial
subscription alone never grants operational approval authority over the
subscriber. Human entity writes must verify authority over the existing target
and its parent organisation, not rely on a service-role client to supply it.

**Module access is two switches, nothing else.** A person may open a module when:

1. the organisation has the module switched on (`organization_modules`; a safety
   module stays off until the organisation configures it, and an organisation
   with no module configuration yet sees its non-safety modules), and
2. the person is admin-tier (Grand Master, Master, Admin, Admin officer), or has
   that module ticked on their profile (`user_profiles.module_access`).

The single implementation is `canUseModule` in `apps/web/src/lib/moduleAccess.ts`;
module keys and their officer-route aliases (for example `parking_enforcement` /
`parking`, `static_guarding` / `site_guard`) resolve to the same switch and tick.
An explicitly configured canonical switch takes precedence over a historical
alias row, including when it is off. Organisation changes deny module access
until that organisation's switch state has loaded.
The directory uses this same decision; it must not hide a module that the
corresponding route permits. Core officer tools (including searches, schedule,
reports and the assigned-job inbox) remain reachable independently of specialty
module ticks; the separate person-search/NZTA authorisations still control
sensitive lookup data.

**Geofences and place are context, never a gate.** Place resolution, geofence
position, active place rules (`resolve_active_rules`), shift state and
assignment never stop a person from opening a module they are entitled to, or
from running a person or vehicle search they are authorised for. They still
choose which rules, evidence requirements and billing apply, and they still
appear as context (for example "outside all geofences"). Sections 0–7 below are
superseded to the extent they make place, geofence, shift or task state a gate on
opening a module or running an authorised search; they continue to describe
record disclosure depth only, and no new record-level gate may be built from
them without a fresh owner ruling.

**Kept:** the per-person person-search tick and the per-person NZTA
(`vehicle_owner_identity`) tick, both audited, both default off; personal
addresses and contact details stay with admin-tier roles; tenant reach
(`org_access_allowed`) is unchanged.

**Open item:** static guarding arrive/depart (`manage_officer_static_post`)
still requires the device position inside a verified site boundary. That is an
attendance evidence and billing rule, not module access, and is left in place
pending an owner ruling.

## Owner ruling 2026-10-28: core officer place capture

> Place workflow clarification, 2026-10-28: **Places** is a core officer tool,
> independent of specialty ticks, shift state and geofence position. Its reader
> and capture RPC require an active provider officer/admin-tier identity and a
> current accepted or provider-admin-confirmed operational engagement with the
> selected client (or the provider's own place). Branch authorisation must be
> current. Only administrators can create client organisations or edit the full
> site briefing, access, safety and commercial configuration. Field capture can
> name a place and record a map-confirmed 10 m reference zone; it cannot replace
> an existing perimeter or supply regulatory rules. Person-search and NZTA
> permissions are unaffected. See the organisation and place model rulings.

## Owner ruling 2026-11-01: NZTA section 241 readiness (R&M Security and Investigations)

R&M holds a section 241 authorisation (Gazette 2025-au4644) to use Motor
Vehicle Register information for two purposes only: a **vehicle on a
contracted property without a valid permit** (trespass) and **entry or damage
seen on CCTV or patrol against posted signage**. Permit vetting, general
investigations and marketing are not authorised purposes.

- **What is restricted.** A name on its own is not NZTA information. The
  NZTA-sourced *link* between a person and a vehicle, in either direction, is.
  It is shown only to people holding the `vehicle_owner_identity` tick, and only
  after they state a purpose and reason (`reveal_nzta_registered_person`). A
  reveal opens a 15-minute window for that user and that vehicle or person, and
  is written to `nzta_register_access_log`. The window is timed by the server
  clock (`get_nzta_reveal_seconds_remaining`); screens re-mask when it closes,
  whatever the device clock says. A reveal opens only the organisation it was
  made for: Person search shows NZTA links only from organisations with an open
  person reveal and asks for another reveal for the rest.
- **Notice follow-up.** A `notice_follow_up` reveal must name an issued
  trespass or warning notice about the same person or vehicle
  (`nzta_notice_matches_subject`, listed by `list_nzta_follow_up_notices`).
  The reveal is recorded against the notice's organisation, and a different
  organisation is refused.
- **Every read path is closed.** `entity_links_select` hides NZTA-restricted
  links without an open reveal; `person_identity_documents_select` never
  returns `nzta_mvr_record` source documents; `get_vehicle_identity_checks`
  returns only allow-listed vehicle facts until a reveal. The source file is
  gated the same way wherever it is stored: `bob_attachments_select`,
  `evidence_items_select` and the `identity_evidence_select` Storage policy
  refuse NZTA source attachments, evidence rows and files without an open
  reveal (`nzta_attachment_restricted`, `nzta_evidence_restricted`,
  `nzta_storage_object_restricted`). `get_identity_registry` returns an
  unrevealed NZTA record only as a masked stub (kind, review state, dates, plate
  and vehicle), so administrators reveal through the vehicle before reviewing.
- **The notice exception.** The client organisation a notice was issued for,
  and the investigating user, may use the data for that notice. This is not
  automatic: the notice still carries its own organisation scope, and the
  investigator uses a `notice_follow_up` reveal.
- **Readiness before a new grant.** A new `vehicle_owner_identity` grant
  requires current NZTA register training and a current confidentiality
  acceptance (`nzta_access_attestations`, each at most 12 months). This is
  enforced on every grant path: `set_vehicle_owner_access`, and the
  `trg_nzta_grant_readiness` trigger on `staff_area_grants`,
  `preset_assignments` and presets whose grants gain the area. These are
  personal: they are recorded against the person's home organisation and count
  wherever that person holds access. An administrator of an organisation the
  person holds access in may record them (`recorded_via_organization_id` is
  audited). Existing grants are not revoked; they are shown as not ready until
  recorded. The holder list mirrors the administrator rule (home, parent,
  operational-provider and platform administrators) plus direct and preset
  grants, including grants made at a parent scope.
- **Records NZTA can ask for.** Every Motochek lookup is entered in
  `nzta_register_lookups` with the individual Motochek user, purpose,
  explanation and outcome. Admin-tier roles review holders quarterly
  (`nzta_access_reviews`) and produce the annual summary with per-zone signage
  evidence (`get_nzta_s241_summary`). Historical checks imported before the
  register existed are listed without a purpose, never back-filled; an
  administrator may link one to the lookup that explains it
  (`link_nzta_register_lookup_check`, audited), and each check explains at
  most one lookup. Lists that reach their size cap say so and block export
  rather than exporting a partial record.
- **Anonymous access.** `canonical_person_public` is no longer readable by
  `anon`. `canonical_vehicle_public` and `canonical_scv_public` are unchanged
  pending a separate ruling.
- **Wording.** NZTA records show the *registered person at the check date*, not
  proof of ownership. Current status needs a new lawful check.

Workspace: Admin → Investigations & Evidence → **NZTA register (s241)**
(`apps/web/src/pages/NztaRegisterPage.tsx`). Migration
`20261101160000_nzta_s241_readiness.sql`; contract test
`test/nzta-s241-readiness.test.js`.

## 0. The re-founding — accountable service, not restriction (READ FIRST)

> Ruled 2026-08-01, owner + Bob. This is a CONSTITUTIONAL CORRECTION to the
> framing of everything below it — not wording polish. Recorded at the head of
> the model so no later reader mistakes the tone that follows for style. The
> mechanism is easy to keep and the reason easy to forget; this is the guard.

**The re-founding.** Access is **purpose-bound, situational, and accountable** —
granted by a live work basis, not held as an abstract, permanent possession. The
model was first composed in the grammar of restriction (deny-by-default,
fail-closed-as-virtue, `must-never`); that framing is the inverse of the app's
own method — teach, positively correct, reason — and re-installs
**operator-as-owner**, which the accountability re-anchor exists to demote to
**custodian**. The correction is one of framing and posture.

**What does NOT change.** The underlying controls remain necessary in full. Every
ratified rule below stands unchanged — the four states, the two place gates, the
basis-type logic, R1–R4, and the 13-scenario oracle. This is a re-founding of the
*lens*, not a relaxation of *outcomes*: "less punitive language" does not mean
"fewer constraints." Wrongful denial is a harm; so is wrongful disclosure. Both
are controlled — one by enablement, the other by depth and the hard-stops below.

**The governing sentence:**

> **You can see this because you are doing this job now.**

**Fuller form (Bob):** *this specific job, on this specific matter, at this
specific time.*

**The floor formula (Bob, verbatim):**

> The floor is not a lock. The floor is not merely a ledger. **The floor is a
> basis engine plus an honest ledger.**
> - The **engine** answers: what is the live purpose, what is the lawful /
>   operational basis, and what DEPTH of disclosure follows from it right now?
> - The **ledger** answers: who reached what, why, under which basis, and what
>   they did next?

**The interpretive grammar (how every rule below is now read):**
- **Enable by proved purpose** — the record flows to whoever serves its live
  accountable purpose; never a privilege handed to the operator for its own sake.
- **Limit by disclosure DEPTH, not blanket refusal** — the four states are
  *depths granted by basis*, not punitive caps. Grant the depth the basis
  justifies; withhold only the depth it does not.
- **Explain the basis to the worker** — "Why can I see this?" is a teaching
  surface, not a scolding one.
- **Record every meaningful access** — accountability is the control plane;
  generous access is safe because it is legible afterward.

**Hard-stops (design realities, not softness).** Restriction remains unavoidable,
and is not apologised for, in exactly these cases:
1. there is **no live work basis** at all;
2. the person **lacks standing authority** for that module or place;
3. the data is **existence- or safety-sensitive** enough that even confirming it
   would itself be a disclosure;
4. the request is for **narrative / historical depth** when only operational-only
   disclosure is justified by the live basis;
5. the record concerns a **protected escalation path** where broad visibility
   would create fresh harm.
Outside these, the posture is enable-and-teach, not prove-you-may.

**The mission line for this layer (Bob, verbatim):** make legitimate work easy,
illegitimate access difficult, and every meaningful access legible afterward.
Trust made accountable — and trust given shape.

> Everything below is read through this lens. Where the older text below still
> carries restriction-first phrasing, THIS section governs; the ratified RULES
> (four states, two gates, basis types, R1–R4, the 13-scenario oracle) are
> unchanged — only their framing is corrected from punitive cap to
> basis-granted depth.

## 0.1 Governing sentences (from `ACCESS_DOCTRINE.md`)

> Permanent module access authorises an officer to perform that class of work;
> geofence and task linkage determine whether they may access this specific
> record now.
>
> Presence at place does not itself confer entitlement to historical or narrative
> record content.
>
> The engine decides; the UI teaches; the refusal must not disclose more than the
> access decision itself lawfully permits.
>
> The system may explain why access was GRANTED more freely than why access was
> DENIED. Grant reasons strengthen accountability; denial reasons can leak target
> existence.

## 1. Standing authority vs situational entitlement

- **Standing authority** = permanent module access. *May this officer perform
  this class of work at all?* Unlocks the TOOL, not the case universe. Exists for
  five ordinary reasons: designated responders; self-initiation when work appears
  without dispatch; rotation across many sites/zones; continuity for follow-up /
  reporting / evidence; predictable capability coverage across shifts + after
  hours. It NEVER confers ambient read of a module's existing records.
- **Situational entitlement** = place + task linkage. *May they access THIS
  record now?*

## 2. The two place gates (never collapsed)

- **place_authority** — the work is legitimate at this site/zone for this org /
  module context. Mechanism: `has_location_access()` (0261). ORG-level.
- **place_relevance** — this officer is here now, where this access mode requires
  it. Mechanism: live GEOFENCE. OFFICER-level, live.

**Approach-radius rule:** for approach-based modules (noise, smoke, biosecurity)
place_relevance = within the operational approach radius of the source location,
not necessarily inside the parcel. Boundary inclusion applies to patrol, freedom
camping, static guarding, and similar site/zone work.

## 3. Geofence is basis-type-dependent (NOT a blanket gate)

The engine evaluates the access-basis TYPE first:
- **Presence-derived** (dispatch on-scene, rostered presence, backup attendance)
  — place_relevance (geofence) is REQUIRED.
- **Ownership-derived** (follow-up ownership, direct initiation, explicit claim)
  — geofence may be FALSE and access is still valid (report writing, QA, handover
  must not break).

## 4. Task signals (situational entitlement)

**Confirmed (6):**
1. **rostered_presence** — officer on a shift stop at the site/zone.
2. **dispatch_response** — dispatched officer at the LOI. Graduated: `operational_only`
   from **`dispatched_at`** (en route) → `full_access` on geofence match.
3. **supervisory_review** — scoped (see R2).
4. **follow_up_ownership** — assigned reviewer/QA/owner (ownership-derived).
5. **direct_module_initiation** — permanent grant + officer initiated OR explicitly
   CLAIMED this record (a logged act, never the bare grant). PTT/phone are how a
   job is LEARNED of; access still comes from initiating the record.
6. **backup_attachment** — formally attached to a live response (never proximity);
   graduated, see R1.

## 5. Ratified rulings (R1–R4) — strict default + named, logged exception

### R1 — backup_attachment: graduated presence basis
- Attached + en route → `operational_only`; on-scene / geofence match → `full_access`.
- End: detachment OR incident closure OR reassignment.

### R2 — supervision: scoped default; inversion only for officer-safety
- **Default (sensitive SUBJECT-matter):** `operational_only` unless the supervisor
  has direct review responsibility on THAT record.
- **Exception (officer-SAFETY: duress, welfare, man-down):** `full_access` for the
  explicitly responsible human in the escalation chain for THAT officer (named
  welfare authority / line supervisor / incident commander) — bound to the record,
  NOT to a role class.
- **Rejection test:** if the basis could be claimed by a supervisor NOT in this
  officer's escalation chain, the drafting is too broad.
- End: reporting/escalation responsibility ends OR event resolved.

### R3 — custody: narrow ordinary custody + separate logged lawful_production
- **Ordinary custody:** continuity, routing, assignment, closure admin. Container
  management, NOT narrative read.
- **lawful_production (separate NAMED, LOGGED basis):** discovery, Privacy Act
  response, complaint investigation, court-directed production. Reason-coded,
  audited (break-glass discipline).
- End: production task complete OR authority withdrawn.

### R4 — retention: state-based expiry
- End: case closed AND no active dispute/appeal AND outside any relevant
  challenge / statutory production window. Named expiry rule PER basis, not one
  universal number.

## 6. Final four rulings (settled 2026-08-01)

- **S3 start rule: `dispatched_at`.** Access begins at dispatch for the attached
  responder; `operational_only` en route; → `full_access` on geofence match.
  `acknowledged_at` would create a preventable safety blind spot (coherent with R1).
- **Q1 dispatch grace: 24 hours.** Write-up / continuity grace, not a casual read
  window. End: earlier of report completion, reassignment, or 24h expiry.
- **S5 handover overlap: until incoming acknowledges, capped at 1 hour.** Both
  named parties access during overlap. End: incoming ack, 1h cap, closure, or
  explicit reassignment reversal. If no ack before cap, the outgoing basis ends
  unless separately reattached by another valid basis.
- **Performance: numeric target DEFERRED to build-time measurement, but MANDATORY.**
  The helper must be benchmarked before live rollout; an explicit benchmark gate
  is required in the implementation/test plan. (Do not constitutionalise a number
  before the helper exists — but the measure-before-live requirement is ratified.)

## 7. Composition

```
visible =
    operator_custody                         -- separate named basis (ordinary) ; lawful_production is its own logged basis (R3)
  OR (
       module_grant                          -- standing authority (opens the tool)
       AND place_authority                   -- has_location_access (org-level)
       AND task_signal_matches               -- one of the confirmed signals (§4)
       AND ( basis_is_ownership_derived      -- follow-up / initiation / claim
             OR place_relevance )            -- else live geofence must match
     )
```
decision_state (full / operational_only / custodian / no_task_entitlement /
hard_stop) then sets content scope: presence-alone caps at operational_only;
en-route caps at operational_only until geofence/ownership upgrades to full.

## 7.1 Reading decision_state as disclosure DEPTH (per §0)

**Purpose.** This section introduces NO new state and alters NO field of the §8
return contract or the §9 oracle. It explains how the EXISTING `decision_state`
values are to be read under the §0 re-founding: each is a disclosure DEPTH
granted by a live basis — not a punitive cap, and not a permission withheld.

**Rule.** Each state names the depth of disclosure justified by a live basis in a
specific job, on a specific matter, at a specific time. The state is what the
basis EARNS, read forward from purpose — never a ceiling read backward from
suspicion.

**Mapping (existing values → depth read):**
- **`full_access`** — working depth: the live basis supports narrative / history
  (ownership-derived, or presence-derived with place_relevance met).
- **`operational_only`** — narrow operational depth justified by a live
  task / place / protective need, WITHOUT narrative history. A granted depth for
  live operational handling, not a punishment cap. (The "only" bounds the depth;
  it does not withhold a legitimate one.)
- **`custodian`** — continuity / holding depth justified by custody or transfer
  responsibility (R3 ordinary custody): container management and routing, not
  substantive narrative read.
- **`no_task_entitlement`** — there is no current live basis to disclose
  operational or narrative subject detail. A statement about absent basis, not a
  verdict on the reader. (Label retained per ruling A; a less penal name is
  deferred to the helper-build contract change, §11.)
- **`hard_stop`** — disclosure cannot be justified because confirming or showing
  the information would itself be wrongful or safety-sensitive (the §0
  hard-stops). An honest design reality, not the restriction reflex.

**Teaching line.** The UI / explanation answers **"why can I see this now?"** in
BASIS language, not denial language — the granted depth and the live basis that
earned it. Consistent with §0 ("explain the basis to the worker") and the §8
boundary (RLS gets the strict boolean; the UI gets the shaped object).

## 8. Return-shape contract (engine + UI aligned)

| Field | Values |
|---|---|
| decision_state | full_access \| operational_only \| custodian \| no_task_entitlement \| hard_stop |
| granted_basis | operator_custody \| lawful_production \| rostered_presence \| dispatch_response \| supervisory_review \| follow_up_ownership \| direct_module_initiation \| backup_attachment \| null |
| failed_gate | module_grant \| place_authority \| place_relevance \| task \| none |
| expiry_end_condition | explicit END rule for the granted basis (never null when access granted) |
| sensitivity_mode | informative \| quiet |
| message_key | stable UI token |

**Boundary:** RLS gets a strict boolean; the UI gets this shaped object. Never mix.

## 9. The 13 scenarios (the isolation + UX test oracle)

S1 no-live-task · S2 live dispatch · S3 arrival-before-acceptance (dispatched_at) ·
S4 backup attached (graduated) · S5 shift handover (ack-capped 1h) · S6 follow-up
ownership · S7 supervisor review (R2) · S8 custodian container-vs-narrative (R3) ·
S9 sensitive-existence quiet mode · S10 welfare exception (human escalation) ·
S11 inside-geofence-no-task (operational_only max, never history) · S12
outside-geofence-owns-record (full) · S13 dispatch en-route→on-scene (graduated).

These are asserted BOTH directions in the helper isolation tests: **no leak
(unrelated readers see nothing) AND no lockout (legitimate readers are not
blocked).** The full row detail lives in the superseded pack's history (!1212).

## 10. Break-glass

Forbidden in v1. Welfare/safety urgency escalates to a named human authority
(R2 exception + S10). Revisit only once the ordinary model is proven under shift
conditions.

## 11. Build sequence (after ratification — this doc is the contract)

1. Helper: `user_has_task_entitlement` (strict boolean) + `resolve_access_basis`
   companion (§8 shape) — with the 13 scenarios as automated isolation tests and
   the mandatory performance benchmark gate (§6).
2. Keystone: `observations` composed SELECT referencing the helper (additive;
   writes untouched; operator custody preserved as a named basis).
3. Shared UI: the access-basis chip + drawer + tiered denial, one component,
   applied across patrol / dispatch / incidents / observations.
4. Propagate through the accountability fact tables in timeline-of-harm order
   (per `docs/ALIGNMENT_LEDGER.md`).

## History trace

Derived across session 2026-07-31 (foundation) → 2026-08-01 (alignment + access
model). Authors: Don Squires (rulings + derivation), Bob (rigour, the friction
and handover findings, the four-question discipline), Rebekah Squires (the keeper
principle beneath it). Superseded proposals retained in MR history: !1209–!1212.
