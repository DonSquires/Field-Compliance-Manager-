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
