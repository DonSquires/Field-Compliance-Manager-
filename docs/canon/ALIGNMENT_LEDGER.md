> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# ALIGNMENT LEDGER — the app vs the foundation

> Read `FOUNDATION.md` (repo root) first. This document is the **map of the gap**
> between what the foundation requires and what the schema currently enforces.
> It is a **read-only audit** — no policy is changed by this file. It is the test
> the re-anchoring work must satisfy, and it names the edges that need an owner
> ruling before any RLS moves.
>
> Method: every entity is sorted into one of three buckets against the anchor
> rule — *accountability anchors to the harmed party and the place of harm; the
> operator is custodian, not owner.* Distances are measured against the LIVE
> template already in the codebase: `has_location_access()` (0261) + the additive
> directional SELECT pattern (0263) + the Tier 1/2/3 visibility model.

---

## The one-sentence finding

**The machinery is built and live; it has reached the KEYSTONE and is now
reaching the rest of the fact tables.** The place layer (`client_sites`,
`location_zones`, `location_events`, `site_services`) is re-anchored via
`has_location_access` (0261/0263). **`observations` — the keystone — is now
ALSO re-anchored on the ACCESS side** (`user_has_task_entitlement` 0324 +
composed SELECT 0325 + site-anchored dispatch 0327 + batch resolver 0344),
oracle-proven in `supabase/tests/0325_observations_keystone_rls.sql`. The
remaining **accountability records** (the assessment tables, `incidents`,
`notices`, `breach_records`, and the enforcement-output tables) still gate on
`org_access_allowed(organization_id)` alone. Closing that — propagation, not
invention — is the core remaining work.

> **⚠️ TWO HALVES = the ratified W1 / W2 tracks (correction 2026-08-17, verified at source).**
> The FOUNDATION anchor rule has two limbs, and they are the two RATIFIED tracks
> named in `docs/design/EVIDENCE_RE_ANCHOR_LIFECYCLE.md` (the authority; read it
> before moving either):
> - **W2 — RECORD-SIDE (write contract):** the harmed/protected-party columns
>   that anchor the record. Live on noise (`0238`), smoke (`0335`), biosecurity
>   (`0336`) — but **ADDED-BUT-INERT**: nothing writes or reads them yet
>   (record-shape only, per each migration header). The anchor TARGET exists on
>   the row; it is dormant. Ratified per-module plans:
>   `docs/design/WRITE_CONTRACT_SLICE1_SMOKE.md` (smoke),
>   `docs/design/WRITE_CONTRACT_SLICE2_BIOSECURITY.md` (biosecurity).
>   NAMING is NOT uniform: noise + smoke use `complainant_site_id` /
>   `complaint_address`; **biosecurity uses `protected_land_site_id` /
>   `protected_land_address`** (0336, owner+Bob dual-place ruling 2026-08-03 —
>   biosecurity harm is a place, not a person).
> - **W1 — ACCESS-SIDE (RLS re-anchor):** the additive `has_location_access`
>   SELECT that lets the harmed party / place read the row. SHIPPED for
>   `observations` only; OWED for every other Bucket-B table.
>
> **OWNER RULING (noise W1, 2026-08-17) — the anchor that grants the read.**
> Per EVIDENCE doctrine ("the harmed-party anchor grants the accountability
> read"), the noise W1 access SELECT anchors through the HARMED PARTY
> (`complainant_site_id`), **NOT** the source (`site_id`). `site_id` remains the
> subject/source anchor for repeat-offender reasoning per ruling #157; it does
> NOT govern the W1 read. (Watch-log: an earlier engineer read wrongly proposed
> source-only; the ratified EVIDENCE matrix — noise as the positive-proof case —
> corrected it. Do not repeat that error.) Noise W1 is in flight via developer
> flow (workflow 6404433): additive PERMISSIVE SELECT ORed beside the preserved
> org gate, harmed-party anchor, writers untouched, Draft MR for owner merge.
>
> A table is only fully re-anchored when BOTH W1 and W2 are live. Completion
> language once W1 lands is fixed by doctrine as **"Operationally corrected /
> Doctrinally incomplete"** — never "done". This ledger's Bucket B below tracks
> each half separately per row.

---

## The live template (what "conformant" looks like)

- **`has_location_access(site_id, zone_id, direction)`** (0261) — access by
  ownership of the place OR an active `service_agreement_locations` row. Never by
  org equality. `security definer`, additive, isolation-safe.
- **Directional additive SELECT** (0263) — add a `has_location_access(...)`
  policy ALONGSIDE the existing `org_access_allowed` one. Nothing removed. The
  operator keeps custody; the place/agreement path is added.
- **Tier model** (0261): Tier 1 operational = shared to the client at their
  location; Tier 2 finance = shared by consent; Tier 3 notes = org-private, no
  override.

---

## Bucket A — CONFORMS (place + contract layer; leave as-is)

| Entity | State | Evidence |
|---|---|---|
| `client_sites` | Additive `has_location_access` SELECT | 0263 A |
| `location_zones` | Additive `has_location_access` SELECT (also fixed invisible-zones bug) | 0263 B |
| `location_events` | Tier-1 `client_reads_provider` SELECT | 0263 C |
| `site_services` | Additive `has_location_access` SELECT | 0263 D |
| `service_agreement_locations` | Provider+client read; provider write | 0261 (3) |
| `location_notes` | Tier-3 hard org-private, no override | 0261 (4) |
| **`observations`** | **ACCESS-SIDE DONE (keystone).** Composed SELECT: org paths OR `user_has_task_entitlement(auth.uid(), id)`; site-anchored dispatch; batch resolver | 0324 + 0325 + 0327 + 0344; oracle `supabase/tests/0325_observations_keystone_rls.sql` (real-RLS, no-leak/no-lockout, place-mismatch control) |

> **⚠️ `locations` drift (corrected 2026-08-17).** Previously listed here as
> conformant. **Atlas CONTROL_VIEW (live) shows `locations` gated by
> `is_admin_for_org, org_access_allowed` — NO `has_location_access`.** The four
> tables that actually carry the place-anchor at source are `client_sites`,
> `location_zones`, `location_events`, `site_services`. `locations` either still
> owes the access-side anchor OR is reached transitively via the site/zone that
> reference it — UNRESOLVED; verify before relying on it as conformant.
>
> **`observations` moved UP from Bucket B.** Its access-side re-anchor SHIPPED
> (see row above); it is no longer "the work". Its RECORD-SIDE harmed-party
> anchor is a separate question tracked with the assessment tables.

---

## Bucket B — VIOLATES (accountability records still operator-anchored; the work)

All of these gate SELECT (and usually INSERT/UPDATE) on
`org_access_allowed(organization_id)` ALONE. All already carry a place FK
(`location_id` / `client_site_id` / `zone_id`), so the anchor TARGET exists on
the row — the re-anchor is wiring, not re-modelling.

> **⚠️ `observations` REMOVED from this bucket (2026-08-17).** Its access-side
> re-anchor is DONE (0324/0325/0327/0344, oracle-green) — see Bucket A. The rows
> below are the ACTUAL remaining access-side work.
>
> **⚠️ RECORD-SIDE note (do not read "Add additive SELECT" as the whole job).**
> smoke/biosecurity/noise already have the harmed-party ANCHOR COLUMNS added
> (`0335`/`0336`/`0238`) but **INERT** — nothing writes or reads them yet. So
> each assessment table needs BOTH: (a) access-side `has_location_access` SELECT
> (below), AND (b) record-side wiring to populate + read the harmed-party anchor.
> This ledger's "Distance" column is the ACCESS-SIDE distance only.

| Entity | Current gate | Place FK present? | Distance to conformance (ACCESS-SIDE) |
|---|---|---|---|
| `noise_assessments` | `org_access_allowed` (0032/0003) | `location_id` | Add additive SELECT; source-anchor already lands site (0226 place-org). Lead module. RECORD-SIDE columns exist inert (0238). |
| `biosecurity_assessments` | `org_access_allowed` (0003) | `location_id` | Add additive SELECT. RECORD-SIDE columns exist inert (0336). |
| `smoke_assessments` | `org_access_allowed` (0003) | `location_id` | Add additive SELECT. |
| `noise_seizures` | `org_access_allowed` (0003) | via assessment | Follows noise_assessments. |
| `incidents` | `org_access_allowed` (0002/0005) | site/location | RULING NEEDED (see edges). |
| `notices` | `org_access_allowed` (0002/0005) | site/subject | RULING NEEDED (served-on-subject vs harmed-party visibility). |
| `breach_records` | `org_access_allowed` (0002/0005) | vehicle/location/officer | Add additive SELECT at the place. |
| `vehicle_observations` | `org_access_allowed` (0002/0005) | zone | Interrupt-tier (latent victim); confirm anchor = zone. |
| `parking_sessions` | `org_access_allowed` (0003) | zone | Interrupt-tier; confirm anchor = zone. |

---

## Bucket C — LEGITIMATELY OPERATOR-OWNED (do NOT re-anchor)

These ARE the operator's own accountability. Moving them would be an error.

| Entity | Why it stays operator-anchored |
|---|---|
| `timesheets`, `roster_*`, `shifts`, `staff_*`, `leave_requests` | The operator's own labour record — operator IS the accountable party. |
| `assets`, `asset_checks` | Operator's own equipment. |
| `invoices`, `invoice_line_items`, `dispatch_job_pay_lines`, `quotes`, `crm_commercial_settings` | Tier-2 finance — shared by consent, not re-anchored. |
| `bob_*` (conversations, memory, self_memory) | Operator/user working context. |
| `ptt_*`, `radio_*` | Operator comms; voice consent already governs. |
| `location_notes` | Tier-3, intentionally org-private. |

---

## Edges that need an OWNER RULING before any RLS moves

1. **`incidents` — anchor to whom?** An incident may be about the client's site
   (harmed party = client), about a member of the public, or about the officer
   (H&S). Ruling: does an incident anchor to the PLACE (Tier-1 to the client) in
   all cases, or are officer-H&S incidents operator-private (Bucket C)?

2. **`notices` — served-on-subject vs visible-to-harmed-party.** A notice is
   served on the SUBJECT (offender). The harmed party is separate. Ruling: is a
   notice a Tier-1 record at the place of harm, and does confidentiality (the
   noise rule: complainant never on the served document) hold at the DATA layer
   too, not just the document layer?

3. **Interrupt-tier anchor (`parking_sessions`, `vehicle_observations`).** The
   victim is latent (the commons, represented by the council). Ruling: anchor to
   the ZONE (and thereby the council-as-place-owner)? That makes
   `has_location_access` work unchanged for latent-victim modules.

4. **`observations.enforcement_exempt` interaction.** The keystone carries an
   exemption path (homeless_claims). Ruling/confirm: re-anchoring SELECT must not
   expose or alter the exemption semantics — verify before the keystone MR.

5. **Custodian read-back direction.** Confirm the general rule: the HARMED PARTY
   /place reads Tier-1 via `client_reads_provider`; the operator retains custody
   via the preserved `org_access_allowed` gate. Two paths, both true.

---

## Recommended staging (in the mission's own order: the timeline of harm)

1. **Keystone proof — `observations`** (read the exact current policies, confirm
   edge 4, add additive Tier-1 SELECT behind tests). One entity, end to end,
   proves the whole cut without touching isolation.
2. **Establish/Remedy modules** — `noise_assessments` (antibody already there via
   0226 place-org), then `smoke_`, `biosecurity_`, `noise_seizures`.
3. **Interrupt modules** — `parking_sessions`, `vehicle_observations` (after
   edge-3 ruling).
4. **Enforcement outputs** — `incidents`, `notices`, `breach_records` (after
   edge-1/2 rulings).
5. **Prove layer** — reporting/portal inherits corrected anchors automatically.

Each step: its own governed MR, additive-only (never remove the operator gate),
tested that the new path grants no MORE than intended and tenant isolation holds.
Never a big-bang RLS rewrite.

---

## What this ledger does NOT claim

- It is a SAMPLE of the RLS, not a byte-complete audit of all ~200 tables. The
  fact tables in Bucket B were each read at source; the long tail (Bucket C) is
  classified by role, not individually policy-audited.
- It changes NO behaviour. It is the map. The first policy move is a separate,
  reviewable, reversible MR taken with this ledger in hand and the owner rulings
  recorded.

---

## Rulings and live status recorded in this repository

### 2026-09-14 — Anchor ruling (Don Squires)

> "Yes: place of harm, and the person or vehicle doing the harming."

This settles edges 1, 2, 3 and confirms 5 above. Every accountability record has
**two anchors, kept separate**: the **place of harm** (the harmed party's site or
zone — this anchor grants the accountability read) and the **subject** (the
person or vehicle doing the harm — `person_id` / `vehicle_id` / the source
`site_id`; this anchor exists for repeat-subject reasoning and enforcement and
never grants the read to the subject's side). Concretely:

| Edge | Ruling applied |
|---|---|
| 1 `incidents` | Anchor to the place (Tier-1 to the harmed party at `client_site_id` / `zone_id`). Officer-H&S incidents stay operator-private through `is_staff_sensitive`. |
| 2 `notices` | Served on the **subject** (`vehicle_id` / `person_id`); **visible to the harmed party at the place of harm**. Data-layer confidentiality holds: the complainant never appears on the served document and the subject's side never gains the read. |
| 3 interrupt tier (`parking_sessions`, `vehicle_observations`, `breach_records`) | The victim is latent (the commons, represented by the council as place owner): anchor = **zone**; subject = vehicle. |
| 5 custodian read-back | Confirmed: harmed party reads Tier-1 via `client_reads_provider`; operator retains custody via the preserved `org_access_allowed` gate. Two paths, both true. |

### Live status of Bucket B (verified against project `dotczcyyzgabmtmnglqj`, 2026-09-14)

The 2026-08-17 table above is stale relative to the live database; W1 has moved
on every row but two.

| Entity | W1 access-side (live) | W2 record-side | Owed |
|---|---|---|---|
| `observations` | keystone: `observations_task_entitlement_select` + `observations_client_org_select` | harmed-party anchor question tracked with assessments | — |
| `incidents` | `incidents_place_reachable_select` — `is_staff_sensitive = false AND has_location_access(client_site_id, zone_id, 'client_reads_provider')` | — | — (edge 1 implemented) |
| `breach_records` | `br_zone_reachable_select` on `zone_id` | — | — (edge 3 implemented) |
| `parking_sessions` | `ps_zone_reachable_select` on `zone_id` | — | — (edge 3 implemented) |
| `vehicle_observations` | `vo_zone_reachable_select` on `zone_id` | — | — (edge 3 implemented) |
| `noise_assessments` | officer situational read only (`na_task_entitlement_select` → `resolve_access_basis`); **no harmed-party read** | `complainant_site_id` present, inert | harmed-party SELECT anchored on `complainant_site_id` — drafted in `supabase/migrations/20260914100000_harmed_party_read_assessments.sql`, guard test `test/harmed-party-read-assessments.test.js`; **not applied** (protected path, owner applies) |
| `smoke_assessments` | as noise (`sa_task_entitlement_select`) | `complainant_site_id` present, inert | same migration |
| `biosecurity_assessments` | as noise (`ba_task_entitlement_select`) | `protected_land_site_id` present, inert | same migration (anchor = protected land) |
| `noise_seizures` | operator gate only | no place columns (follows the assessment) | same migration: readable when the parent assessment is readable |
| `notices` | operator gate only | has `vehicle_id`, `person_id` (subject) and a bare `location_id` with **no FK**; no site/zone anchor; 0 rows | needs a place-of-harm anchor before W1: derive via `breach_id → breach_records.zone_id` for interrupt-tier notices and add `client_site_id` for RMA notices, then an additive harmed-party SELECT. Design slice, not yet drafted. |

Reading: because the harmed-party columns are unpopulated, the drafted policies
widen no read on the day they are applied (`has_location_access(NULL, NULL, …)`
grants nothing beyond `grand_master`). They become live the moment W2 populates
the anchors — which is why the W2 write contracts must land with the
13-scenario oracle green, and why completion language stays
"operationally corrected / doctrinally incomplete" until both halves are live.

### 2026-09-14 (later) — Clarification of the anchor ruling for dual-place modules (Don Squires)

> "The place of harm is the address the officer attends to conduct the job. The
> tricky one is noise control, and potentially smoke and biosecurity: record the
> complainant address and the address the noise is coming from and ensure both
> are associated. The officer assesses as close to the complainant's address as
> possible without giving away who complained. The noise address is where the
> officer does most of the work, records the assessment against, and issues the
> END or seizure. Where the officer needs to talk to the complainant, record that
> interaction too, linked, so the client report reflects exactly what happened.
> Each location needs a geofence so there is verification the officer was on site."

How this composes with the anchor rule above (no contradiction):

- **Two places, both attended, both geofenced, one job.** The *harmed party's*
  place (complainant / protected land) remains the anchor that grants the
  accountability read (W1). The *subject's* place (the source) is the work
  anchor: the assessment, END and seizure are recorded against it and all
  repeat-offender logic keys off it (lineage rule #157). Neither replaces the
  other; the job carries both and every attendance is a geofence-verified stop.
- **Confidentiality holds at the data layer.** Complainant identity is readable
  only through a guarded, audited path; served documents and the source-side
  reader see only the source. The assessment position is recorded as a distance
  to the complainant's boundary, never as the complainant's address.
- **Statute agrees** (RMA 1991, read at source 2026-09-14): s.326 defines
  excessive noise by its effect on a person *other than* one at the emitting
  place; s.327(1) requires a received complaint and an investigation before an
  END; s.328(3) requires a constable for officer-led seizure; s.327(3) now binds
  for **8 days** (amended 21 Aug 2025 — the "72 hours" in this repo's earlier
  documents is superseded and must be held as an effective-dated rule).

Design and build slice: `docs/canon/NOISE_CONTROL_TWO_PLACE_MODEL.md`;
migration `20260914110000_noise_two_place_attendance_model.sql` (drafted, not
applied); truth table `supabase/tests/20260914110000_noise_two_place_rls.sql`
(green in the disposable database). Smoke and biosecurity take the same shape.

### 2026-09-15 — Platform-owner boundary ruling (Don Squires)

> "Iron Eagle is the owner of this app. R&M or any provider subscribes to the
> app, which is owned by Iron Eagle, who receives the subscription and the
> finances and can manage the subscription (suspending, cancelling, monitoring
> activity) but should not have access to that org's operational or financial
> data — but can send invites to new master users, or reset passwords if they
> get locked out. Basically the same kind of subscription system as GitHub or
> other SaaS apps."

Recorded in `ORG_SERVICE_MODEL.md` § "Platform-owner boundary". Effect on the
access layer: the Layer-1 **financial** agreement stops conferring
`org_access_allowed` visibility (clause 5 becomes operational-only);
`grand_master` reach narrows to the platform-control surface; subscriber
provisioning moves to a governed grand_master-only RPC. Live at ruling time:
R & M Security and Investigation (`e96d71c9-…`) is a `private_enterprise`
CRM prospect under Iron Eagle with no dependents and must be reclassified as an
own-rooted `service_provider` subscriber.

### 2026-09-15 (later) — grand_master, Bob's reach, and the H&S exception (Don Squires)

> "The only grand master is me and Bob in Iron Eagle; no other org should have
> grand master access. Bob has full access regardless of who is talking to him,
> but Conductor and Oracle dictate what Bob can pass on to the user, keeping in
> line with the Privacy Act in New Zealand. The only exception is H&S: if another
> org has flagged a H&S risk for a person, vehicle or site, it is flagged
> globally with redacted details, again in line with the Privacy Act and the
> H&S Act in New Zealand."

Recorded in `ORG_SERVICE_MODEL.md` (three sub-sections under "Platform-owner
boundary"). Live at ruling time: four `grand_master` profiles — Don Squires and
Bob `…b0b0` (Iron Eagle) plus two unreferenced duplicate Bob identities created
2026-08-21, one inside First Security Guard Services LTD; both duplicates are to
be downgraded/deactivated. `entity_flags` is org-scoped today (Privacy Act
comment on the table) with a `bob_full_read` policy; a redacted platform-wide
H&S read model is not yet built.

**Live status (2026-09-16, migration `20260916100000`, applied to
`dotczcyyzgabmtmnglqj`).** The H&S read model is built. `entity_flags` gained
`hazard_class` (violence_or_aggression, weapons, dangerous_dog,
hazardous_substances, unsafe_structure_or_ground, vehicle_defect,
medical_or_welfare, other), `resolved_by` and an idempotency key.
`get_safety_warnings(p_entity_type, p_entity_ids)` returns every organisation's
*active* hazard-classed flags on a vehicle, person or place (sites and zones
resolve to their house's canonical place) redacted to hazard class, severity,
the raising organisation and its contact path; the narrative (`reason`) and the
raiser are returned only to the raising organisation. `raise_entity_flag` /
`resolve_entity_flag` are the governed, audited write paths (a safety warning
must carry a short note; resolve is raiser-or-org-admin). Table RLS on
`entity_flags` is unchanged — no organisation can read another's flags
directly. Truth table: `supabase/tests/20260916100000_safety_warnings_rls.sql`
(21 checks). Surfaces: officer Vehicle Lookup, admin Vehicle Search, Site
overview (`SafetyWarningsPanel`).

Same migration, plate registry: `canonical_vehicles` / `canonical_scv` carried
only a `bob_full_read` policy, so real users saw **0 of 8,975** plates. Two
definer projections — `canonical_vehicle_public` (identity, make/model,
rego/WoF/CoF status, `homeless_status`; no `registered_owner_name`, no
`homeless_notes`) and `canonical_scv_public` — are now the read path for the
field and admin vehicle pages and observation search. Verified live as the R&M
master: 8,975 rows through the projection, 0 through the base table.

### 2026-09-19 — Canonical people are a global registry, like places and vehicles (Don Squires)

> "Canonical people should be treated the same as canonical places and
> vehicles: it is a global canonical record with observations attached."

**Ruling.** The three canonical registries — `canonical_places`,
`canonical_vehicles`, `canonical_people` — are **platform-wide identity
records**, readable by every authenticated user regardless of organisation. What
stays tenant-scoped is everything *attached* to them: the observations
(`cctv_entity_observations`, `observations`, `location_events`,
`canonical_person_links`, `person_records`), the biometric templates that
suggest a match (org-scoped in `find_cctv_portfolio_matches`, never readable by
browser roles — migration `20260918140000`), and the flags and notes an
organisation raises. A person seen by two organisations is one canonical record;
each organisation sees only its own sightings of them.

**Live status (verified 2026-09-19).** Already conformant; no schema change was
needed. `canonical_people_select` is `USING (true)` (116 rows, all named, metadata
= provenance only: source ids, first-seen, origin, CCTV unknown-person number).
`canonical_places_select` is `USING (true)`. `canonical_vehicles` reaches every
user through the redacted `canonical_vehicle_public` projection (2026-09-16
ruling above) — the same global-read outcome, with `registered_owner_name` and
`homeless_notes` held back because those are about the person, not the vehicle.
The same restraint applies to people: should `canonical_people` ever gain
attributes beyond identity and provenance (welfare, health, legal status), they
move behind a projection or a definer read path, and the registry row stays
global.

**Consequence for review surfaces.** The CCTV console's "same or similar on
record" candidates and `review_cctv_entity_observation`'s `link_person` /
`new_person` may resolve to a canonical person minted by another organisation.
That is the intended behaviour, not a leak: the identity is global, the evidence
behind it is not.

### 2026-10-20 — Any organisation may correct shared vehicle facts; owners are canonical people (Don Squires)

> "For the canonical record, any organisation should be able to update the
> vehicle details as long as it is audited and states in the record when it was
> last updated and by what org."

**Ruling.** A canonical vehicle's descriptive and expiry facts (make, model,
year, colour, body type, rego/WoF/CoF expiry) are shared facts. An
administrator of **any** organisation may correct them; there is no
"observed by this organisation" or grand-master gate on this path. Every change
writes `audit_log` action `vehicle_profile_details_updated` with before/after
values, and the record carries `details_updated_at`,
`details_updated_by_org_id` and `details_updated_by`, exposed through
`canonical_vehicle_public.details_updated_by_org_name`. The registration, VIN,
chassis/engine identifiers and owner stay on their governed identity paths
(`manage_identity_vehicle`, NZTA MVR review) and are unchanged. Migration
`20261020170000`.

**Owners.** Recording an owner always resolves to a tenant `person_records` row
and its global `canonical_people` row, joined to the vehicle by an
`entity_links` person→vehicle edge (`registered_owner` when sourced from an
NZTA motor-vehicle-register check, otherwise `owner`). Owner edges are written
only through `record_vehicle_owner` / `end_vehicle_owner_link`, readable
through `get_vehicle_owner_links`, and NZTA-sourced owners are flagged
`nzta_restricted` so the UI states the restriction. Migration `20261020171000`.

**Owner access is an authorisation, not a role (owner correction, 2026-10-20).**
> "any user that has authorisation can access the details, so we should add that
> as a skill and maybe a check box for users, also we probably should not
> display the full address but put in the suburb and city the vehicle is
> registered to not the street or street number"

Owner identity is the `vehicle_owner_identity` area of the access matrix
(`staff_area_grants` + access presets via `resolve_access_grants`), checked by
`can_access_vehicle_owner_identity(org, record)`: organisation administrators
always hold it; `view` reads owners, `adjust`/`manage` also records and ends
them. An administrator switches it per user with the audited
`set_vehicle_owner_access` (Users → person → Restricted information), or
bundles it into a preset. The owner reader returns `locality` (suburb, town/city
from `vehicle_owner_locality`) and never the street address; a street address
may be stored on the person record but is not shown with the vehicle. NZTA
identity-check evidence documents (`get_vehicle_identity_checks`) remain
administrator-only. Migration `20261020180000`.

**Tiered owner details; drivers and associated people (owner correction, 2026-10-20).**
> "autherised users should still be able to see the details of the owner in any
> screen that presents them but unautherised users can only see the suberb and
> town/city and that the organisation has identified the owner or person
> responsible for the vehicle ... the owner and the driver are not the same
> person so we need to be able to have people associated with the vehicle also"

`get_vehicle_owner_links` now serves every user of the organisation: authorised
callers (`can_access_vehicle_owner_identity`) receive full details including the
street address; others receive the relationship, source, dates and locality only
(`details_visible = false`). This supersedes the locality-only display above for
authorised users. People link to a vehicle as `owner`/`registered_owner` (one
current), `driver` or `associated_person` (many) through the audited
`record_vehicle_person`, optionally at a sighting (`evidence.observation_ids`);
NZTA can only establish the registered owner. Direct `entity_links` writes for
these relationships are blocked. `observations.person_record_id` stays reserved
for verified identities (`link_observation_entities`), so unreviewed people are
never made a sighting's identity of record. Migration `20261020190000`.

**Original records stay immutable.** Follow-up notes, follow-up requests and
resolutions, and H&S concerns on an observation or patrol visit are appended to
`record_updates` (append-only, audited, same access as the source record);
photos use the existing org-scoped record-evidence path.

### 2026-10-26 — Person search, NZTA people and notice expiry (Don Squires)

> "we need to pull person information from R&M and create add them to the
> canonical person record ... R&M do not have a system that advised when a
> treaspass notice is about to expire or has expried ... fcm has this system
> already built and we should be utalising it ... people infromation will come
> from NZTA screenshots as the primary sauce then followed up by treaspass notice"

Rulings, and how the build honours them:

- **NZTA screenshots are the primary person source.** A screenshot whose OCR
  reads a consistent plate, name and query date is approved without a second
  reviewer (2026-10-26); anything unread or inconsistent is held. People are
  filed under the provider (R&M) and projected to `canonical_people`; the
  registered-owner edge is written through the governed vehicle-person path, and
  a document containing conflicting facts on a shared vehicle stays pending
  behind the existing grand-master review gate rather than being approved with
  those facts silently omitted. NZTA address, check history and protected
  owner/driver vehicle relationships are returned only
  to users holding `can_access_vehicle_owner_identity`.
- **Notices follow the NZTA person source.** R&M trespass and warning notices
  are to be associated with canonical people and used with the existing expiry
  register; notice import and any additional notice types remain subject to
  source review and confirmed rules before a seed or migration is applied.
- **Access.** Person search and the notice-expiry register are restricted to
  active operations roles at both the UI and RPC boundary. Address and NZTA
  check history remain additionally restricted by
  `can_access_vehicle_owner_identity`.

### 2026-10-31 — Historical notice expiry and NZTA owner observations

The owner confirmed the existing notice-expiry rules and the interpretation of
NZTA checks for the historical import:

- **Expiry.** Trespass and warning notices use an explicit register expiry
  when one is recorded; otherwise they expire two years after issue. Permit
  refusal and contact request letters remain correspondence and do not create
  an entry restriction.
- **Owner history.** NZTA source-check dates establish when an owner was
  observed, not a legal transfer date. The latest source-time observation is
  the current registered-owner link; earlier observations remain as previous
  links. A shared-vehicle conflict may confirm the person evidence while
  keeping conflicting mechanical vehicle facts pending review.
- **Evidence boundary.** NZTA identity and owner metadata stay restricted to
  users with `can_access_vehicle_owner_identity`; ambiguous or unread evidence
  remains held rather than being promoted into canonical records.

**Owner matching (migration `20261101100000`).** A notice whose plate is on
file is attributed to the vehicle's registered owner at the notice date only
when the names agree; a shared family name alone does not attribute a named
family member's notice to the owner. The notice's family name must be the
owner's family name (the last word of two or more letters on both sides, titles
stripped). When the notice also gives a given name, its first given name must
equal the owner's first given name, be its initial or share a 3+ letter prefix
with it, or exactly equal one of the owner's middle names; a notice that names
only a surname (for example "Mr Alder") still resolves to the registered owner
with that family name. Names carrying a generational suffix (Jr, Sr, II to IV)
are never matched to the owner. A notice that fails these checks falls through
to a unique exact-name match, then to a person verified by the notice itself,
linked to the vehicle as an associated person; genuine spelling duplicates are
joined with the governed Merge records action.

**Live state (verified read-only 2026-10-27).** Migrations `20261031090000`,
`20261031100000`, `20261031110000` and `20261101100000` are applied and
ledgered. The governed NZTA name repair renamed 2,627 people whose display name
had been read from a screenshot heading, merged 85 resulting duplicates and left
47 heading-named records for manual review. The historical register import
read 555 notices and letters: 546 imported (466 warnings, 54 trespass notices,
14 permit refusals and 12 contact requests) and 9 held for review (3 ambiguous
people, 6 names too incomplete to create a person). Of the 546, 166 resolved to
the registered owner at the notice date, 63 to a unique exact name and 317 to a
person created from the notice; 110 associated-person vehicle links were
recorded through `record_vehicle_person`, and 169 notices name a plate not yet
on file. A replay reported all 546 as already present. Across all imported
notices (including 11 trespass rows imported on 2026-10-11), 42 are in force, 9
warnings expire within 30 days, 472 have expired, 8 trespass notices are drafts
and the 26 letters carry no expiry; 50 of 517 people have a notice in force or
expiring.

**Acceptance correction (owner approved 2026-10-27).** A fresh live read matched
all 2,627 name repairs and 85 merges to their source plan, including 432 active
company-owner records with their company names and 196 records labelled
`Owner withheld by NZTA`. All expected labels and categories agree in the
organisation records and canonical records. The 546 imported notices persist
with their source hashes and person links; that batch covers 507 people (the
517 figure above includes earlier imports).

The signed-in Person search check exposed two unfinished Word templates that
the importer mistook for named warnings. Their addressee blocks contain
`name and address`, including one corrupted prefix; neither identifies a person.
The owner approved quarantine, not deletion or a claim that a real warning was
withdrawn. Migration `20261027032744` moves only those source-hash- and
import-key-bound notices to draft, marks their isolated synthetic identity
records rejected/retired, preserves source provenance and creates audit receipts.
It refuses changed or reused identities. Existing expiry notifications are
corrected rather than deleted or silently marked read. The parser now holds
unfinished addressee fields through the salutation, regardless of date position,
before any name fallback. A template filename alone does not exclude completed,
named correspondence. Release and live verification of this correction are required before
the two entries can be counted as removed from active expiry alerts.

### 2026-09-22 — The `persons` fork is closed; `canonical_people` is the only canonical person record (Don Squires)

> "We should only have 1 person canonical record, 1 vehicle canonical record and
> 1 location/place canonical record. This is the entire purpose of this app...
> everything has a home and each org, system, module all go to those places to
> get the data that is required for their purpose and writes to those canonical
> records as observations."

**Finding.** The 2026-09-19 ruling above named `canonical_people` as the global
registry, but a second, older design (`persons`: richer columns - welfare_flag,
homeless_status, date_of_birth - with real FKs from `notices`, `person_interactions`,
`person_vehicle_links`, `ems_devices`) had never been reconciled with it. Audit
found zero live dependency: no function anywhere ever INSERTs/UPDATEs a `persons`
row; `person_interactions` and `person_vehicle_links` have RLS enabled with no
INSERT policy at all (structurally unwritable, not just unwritten); neither
`generate-notice` nor `generate-parking-notice` ever touches `notices.person_id`;
no frontend page references `persons`, `person_interactions`, `person_vehicle_links`
or `ems_devices`. `persons`' own RLS (`org_access_allowed`, org-scoped) was also
inconsistent with the ratified global-canonical-plus-org-scoped-observations
shape - a further sign it was the abandoned design, not the current one.

**Ruling.** `persons` is retired. Its two enforcement-relevant fields migrate to
`canonical_people`, mirroring `canonical_vehicles`' existing pattern exactly:
`date_of_birth` and the `homeless_status` / `homeless_verified_at` /
`homeless_notes` trio (lifecycle none -> claiming -> investigating -> confirmed,
reconciled to a vehicle via `entity_links`). `welfare_flag` / `welfare_notes`
do NOT migrate: `entity_flags` (`hazard_class`, `get_safety_warnings`) already
replaced standalone `person_flags` for exactly this ("Replaces standalone
vehicle_flags/person_flags/location_flags, retired in 0115") - a person's welfare
concern is raised there, against `canonical_people.id`, not as a bespoke column.
Because `canonical_people` can now hold personal information, its RLS is brought
in line with `canonical_vehicles`: the base table is Bob-only, and
`canonical_person_public` (mirroring `canonical_vehicle_public`) is the read path
for everyone else - identity, review state, and `homeless_status` only;
`date_of_birth` and `homeless_notes` stay behind governed paths.

**Live status (migration `20260922050000`).** `notices.person_id`,
`person_interactions.person_id`, `person_vehicle_links.person_id` and
`ems_devices.person_id` now reference `canonical_people(id)`. `persons` is
dropped. Noted separately, not acted on here: `entity_links`' own comment says
it "generalises `person_vehicle_links`" - that table looks like further legacy
debt of the same shape, but retiring it is a separate decision.

### 2026-09-16 — Manufacturing & maintenance is its own module (Don Squires)

> "Let's put the materials in scope as we will need to create another module
> for manufacturing and maintenance." Asked how it should sit: **a new
> 'workshop' module on the existing work spine** (not folded into Dispatch, not
> a full MRP). First slice: fabrication work orders with a bill of materials from
> the price book; maintenance visits to a client place/asset (materials + labour
> + travel); strict inventory draw-down and stock-on-hand per workshop/van
> location; reusable BOM templates.

**Live status (2026-09-16, migration `20260916110000`, applied to
`dotczcyyzgabmtmnglqj`).** `module_catalog` row `workshop` (depends on
`finance` for the price book; enabled for R & M). Tables
`workshop_bom_templates(_lines)`, `workshop_work_orders`,
`workshop_work_order_lines` (org-scoped read via `org_access_allowed`, writes
only through RPCs). Ladder `draft → approved → in_progress → completed`
(cancel from any open state); the assigned worker may start/complete, an
administrator approves/cancels. Completion draws every material/equipment line
with a price-book item down from the order's stock location through
`record_finance_inventory_transaction` (idempotent on `workshop_line:<id>`) and
refuses with a plain message when stock is short — a maintenance visit with no
stock location completes with no stock movement. A maintenance order must name
a site or an asset (a facet of the place model, never a free-text address).
`generate_crm_invoice_from_completed_work` sweeps every completed, uninvoiced
workshop line **and** dispatch charge line for one client into a single draft
invoice (GST 15%) and stamps `invoice_line_item_id` on the sources — before this
migration nothing populated that column on `dispatch_job_charge_lines`, so
completed dispatch jobs were producing charge lines no invoice ever picked up.
Truth table: `supabase/tests/20260916110000_workshop_rls.sql` (40 checks).
Surface: admin `Workshop` page (work orders / templates / stock) under Field
Operations. Verified live as the R&M master (rolled back): template from a real
R&M material → `WO-202609-0001` with a priced line → completed.

### 2026-09-18 — Website-backed fuel price median (Don Squires)

> "For realtime pricing use the websites and get the median over an average of
> 3 months." The customer-facing per-kilometre default remains the **IRD
> recommended vehicle kilometre rate**, rather than being silently overwritten
> by retail fuel changes.

**Live status (migration `20260917070000`, applied to
`dotczcyyzgabmtmnglqj`).** `fuel_price_observations` retains a finance
administrator's cited website price, observation date, publisher, URL, published
date/reference/hash, and audit receipt. `get_median_fuel_price` calculates the
median of the trailing three-month observations for a fuel type and returns the
source names/URLs; `record_fuel_price_observation` is idempotent and
admin-only. The Rate Rules page now displays the median and sources and records
a reviewed website citation. It states plainly that this is a travel-planning
input and does **not** automatically alter R&M's IRD Tier 1 petrol default of
`$1.04/km` (effective 2025-04-01). Truth table:
`supabase/tests/20260917070000_fuel_price_observations_median.sql`; browser
acceptance covers entry and recalculation on desktop and mobile.

### 2026-09-18 — Approved website sources for fuel pricing

**Live status (migration `20260917080000`, applied to
`dotczcyyzgabmtmnglqj`).** Finance administrators approve or retire a named
public fuel-price source per organisation and fuel type. An observation selected
against an approved source must use a URL under that source's approved base URL;
the source, observation, and approval are all retained and audited. Historical
manual citations remain readable and recordable so prior evidence is not erased,
but the fuel panel now selects the URL-checked path for approved sources. This
is deliberately a governed review step, not an undocumented retail-site scraper.
Truth table: `supabase/tests/20260917080000_approved_fuel_price_sources.sql`.

### 2026-09-26 — Report packs require provider review before client delivery (Don Squires)

> "I would like it if the user could review and have ability to edit the
> report before it is sent to the client unless the client has a login to link
> into the live reporting system."

**Build status (migration `20260926010000`, pending live application).** Monthly
report generation now creates provider-private `draft` packs. A provider
administrator reviews and may edit only the bounded client-facing editorial
layer (title, executive summary, client notes, and follow-up); source-derived
metrics remain a separate immutable operational snapshot. Saving and publishing
use one audited, optimistic-lock RPC. Publication records the actor/time and
chooses `portal` when the client organisation has an active client login under
an agreement with reporting enabled, otherwise `email`. Client RLS exposes only
published/sent packs, never drafts. Portal-delivered packs refuse duplicate
email delivery; email packs require explicit publication; sent packs remain
immutable. Reviewed editorial content is used by PDF and email renderers. Truth
table: `supabase/tests/20260926010000_report_pack_review_and_delivery.sql`.

### 2026-10-27 — Permit holders are people, and one permit card serves every surface (Don Squires)

> "I just added xlsx file you can use to enrich person records and vehicle
> numberplates."

**Live status (migration `20261101110000`, verified 2026-10-27).** The
OFO "Permit Extract" workbook is the source of truth for the 112 forest-access
permits it contains. A new admin-only, audited `import_person_permit` RPC fills
blank permit, person-contact and vehicle fields from that workbook and inserts
permits that are not yet recorded. It never replaces a recorded value, never
changes a permit's holder, and refuses a holder whose email is already used by
a differently named canonical person. Those rows are held for review, not
merged. Replays are no-ops.

Permit validity is derived, not typed: `person_permit_validity` reads status
and the NZ calendar date. A finishing date is inclusive. The states are
revoked, suspended, expired, not started, dates not recorded, expiring within
30 days, and valid. `person_permits_fieldwork` exposes it as `validity_state`.
`search_people` now finds a person by an exact permit number and returns their
permits with linked vehicles. Firearm licence numbers stay in the locked base
table and are never returned to field users.

The Person, Vehicle and Officer vehicle lookup pages all render the same
`PermitAccessCard`. A permit's holder is shown as the permit holder, never as
the vehicle's owner: NZTA ownership remains the owner record. The TPFL
workbook supplies permit types, forms and rules, not holder or numberplate
records. The booking CSV is not imported as FCM login accounts; its password
and account-control fields are not identity evidence. Truth table:
`test/permit-holder-person-search-migration.test.js`.

**Source acceptance, 2026-10-27.** All 143 booking CSV permit numbers and all
112 OFO workbook permit numbers persist: 156 distinct permits for 140 holders,
with 110 permit-to-vehicle links across 95 canonical vehicles. All 112 workbook
date pairs match the source. Across the combined set, 105 permits are expired,
7 expire within 30 days, and 44 have no recorded dates.

The workbook contains 93 vehicle entries in 86 rows. One was initially reported
as unreadable because its make was in all caps. It contains a standard NZ plate,
and the booking CSV had already linked that vehicle to the same permit.
The parser now recognises standard three-letter/three-digit and
two-letter/four-digit plate boundaries before all-caps makes, without guessing
where an unseparated personalised plate ends. All 93 source entries are
accounted for; no duplicate vehicle or permit link is needed.

### 2026-10-27 — A permit holder's name comes from the permit that names them (Don Squires)

Owner decisions, recorded 2026-10-27: complete names the extract proves;
give each named holder in a merged record their own record; link new permits
by email and surname to the single matching holder and complete that name;
never merge family members who have different first names.

**Build status (migration `20261101120000`).** The RAMS booking import keyed
permit holders by surname and email. It therefore recorded 125 people by
surname alone and merged different people who share a surname. The OFO
extract names the holder of each permit and is the source of truth for that
name.

`attribute_permit_holder` is admin-only and audited. It takes a full name and
the permits that name it. If those permits are all of the record's permits,
the given names are added in front of the recorded name. The canonical key
stays, and the previous name is kept in the person's metadata. Otherwise
those permits move to a new draft person of their own, and the record keeps
the rest.

It refuses:

- a name that does not end with the recorded name;
- permits the person does not hold;
- renaming a person whom another organisation records;
- any person not positively recorded by surname alone.

It never deletes a person.

**Surname basis (review ruling, 2026-11-01).** "Recorded by surname alone" is
a positive marker, not a guess from word count. The migration marks
`metadata.name_basis = 'surname'` on every person the booking import created
(an import key and a permit from the RAMS bookings file); live, that is all
125 holders. A compound surname such as "Te Whare" is still a surname. Only
a marked person can be completed, separated, or linked by surname, and
completing a name removes the marker. A person who already carries a full
name is never renamed and never takes a related name's permit: "Jane Smith"
is not "Mary Jane Smith", so that permit is held for review rather than
linked or created.

**Two-way hold (clarification, 2026-10-27).** This came from the Copilot
pull-request review of #264. Don Squires accepted and delivered it under his
standing direction for the R&M import, in migration `20261101130000`. It
narrows the ruling above and does not widen it. The hold applies in both
directions: "Jane Smith" arriving under the email of an existing
"Mary Jane Smith" is held too. The only automatic link is a longer full
name that extends a surname-only record.

Names are compared by whitespace-separated parts
(`person_name_parts`), so a punctuated or accented single name such as
O'Neill, Smith-Jones or Müller is one part. It never passes as a full name,
and Jones never extends Jane Smith-Jones.

`import_person_permit` gains `p_create_holder`, which defaults to off. A new
permit links to a holder recorded by surname only when:

- the email agrees;
- the full name ends with that surname;
- exactly one such holder exists, and no other holder with that email has a
  related name, whether longer or shorter.

The caller then completes that holder's name. With `p_create_holder` on, a
named holder who matches no one is created as a new draft person. A
one-word name never creates a person. Audit metadata carries permit numbers
and identifiers, never names or emails.

The import still only fills empty fields on a recorded permit. Since
`20261101130000` it reports how the recorded values differ from the extract
field by field, through `person_permit_compare_value`:

- lists are compared as sets of entries, so `['North', 'East']` is not
  `['North East']`;
- email addresses are compared exactly, ignoring only case and surrounding
  spaces;
- telephone numbers are compared by their digits;
- the firearms licence number is compared by its letters and digits;
- other text is compared by its words.

Previously every separator was stripped, which hid such differences.

The repair script plans every step from a live snapshot and records the
expected outcome, the holder it lands on, and that holder's complete permit
set. A follow-up completion names its permits explicitly and never sweeps in
other permits that share the email. A new permit is held in the plan if a
permit with the same email is proven by the extract to belong to someone
else. The database rolls back and holds any step whose outcome, holder or
permit set differs from the plan, so the run cannot drift from the reviewed
plan.

Four extract permits for family members first appeared to share an email
with a differently named relative. They share it only with an older,
unnamed permit on the merged record. Once the named relative moves to their
own record, each family member is linked to that older permit by the
email-and-surname rule. This keeps the family members separate from the
relative without leaving a duplicate surname-only record.

Truth table: `test/permit-holder-identity-repair-migration.test.js`.

### 2026-11-01 — NZTA section 241 readiness for R&M (Don Squires)

R&M's section 241 authorisation covers two Motor Vehicle Register purposes:
trespass by a vehicle without a valid permit on a contracted property, and
entry or damage seen on CCTV or patrol against posted signage. The owner
ruled that a name alone is not restricted; the NZTA-sourced person-vehicle
link is, in both directions, and only `vehicle_owner_identity` holders see it,
after a purpose-stated, logged, 15-minute reveal. The client the notice was
issued for and the investigating user may use the data for that notice.
Retention is report-only. Anonymous reads of `canonical_person_public` are
removed. Full ruling: `ACCESS_MODEL.md` (owner ruling 2026-11-01); retention:
`RETENTION_DOCTRINE.md`. Live status: records written only through hardened
definer RPCs in `20261101160000_nzta_s241_readiness.sql`; direct table reads
of NZTA owner links and NZTA source documents are closed by RLS; historical checks
are listed without a purpose rather than back-filled; existing NZTA holders
show as not ready until training and confidentiality are recorded.
Review hardening (same migration): NZTA source attachments, evidence rows and
Storage files are reveal-gated; readiness is enforced by trigger on every grant
path; reveal windows are timed by the server clock and scoped to the revealing
organisation; notice follow-up requires an issued notice about the same subject;
the identity registry masks unrevealed NZTA records; historical checks can be
linked once to an explaining lookup.
Truth table: `test/nzta-s241-readiness.test.js`.