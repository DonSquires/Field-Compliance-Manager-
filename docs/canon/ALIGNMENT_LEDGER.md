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
