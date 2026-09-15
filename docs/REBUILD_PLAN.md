# Rebuild Plan — bringing the build to the canon

Status: active. Owner: Don Squires. Order of authority: `docs/canon/README.md`.
This replaces the scattered per-topic TODOs as the top-level sequence; the
detailed backlogs (`ENTERPRISE_SAAS_TODO.md`, `PROTOTYPE_GAP_AUDIT.md`,
`MODULE_BASELINE_REQUIREMENTS.md`) hang off the workstreams below.

Completion language is strict, as in the lineage: **merged ≠ deployed ≠
glass-proven.** A workstream item is done only when its evidence gate is met.

Owner ruling 2026-09-15: **Field Compliance Manager is the only product we are
building.** GitLab, FreedomCamp-Manager / FreedomCamp-Manager-App, Onspace
previews, and other historical repos are legacy/reference evidence only. Keep
their useful requirements, patterns, samples, and lessons; do not preserve their
architecture as a parallel target, and do not optimise this build for backward
compatibility with those projects.

## 0. Where the good bits come from

| Line | Keep | Do not port |
|---|---|---|
| GitLab `field-compliance-manager` (the live database *is* this build's database) | the constitution now in `docs/canon/`; `resolve_context` P1/P2; `has_location_access` / `user_has_task_entitlement` keystone; Model A; house model; module manifest shape; `PRODUCT_DESIGN`; recovered `rateEngine.ts`, `invoicePipeline.ts`, `resolveOrCreateHouse.ts` (+ tests) in `docs/canon/reference/recovered/` | its stale infra docs (Railway/RunPod/Ollama), the 13.7k-line watch log as authority, 4-digit migration numbering |
| This repository | Atlas / Caddie / Conductor / Oracle implementation; Builder control plane and worker isolation; governed single-transaction module submissions (biosecurity, noise, smoke, field reports); mobile governed scan + evidence/PTT/offline-package RPC contracts; CRM onboarding governance; canonical identity spine work; report packs; 556 root + web test suites; the human-test runner | the hybrid hand-appended `schema.sql` (replaced 2026-09-14); per-module pages that bypass shared spines |
| `FreedomCamp-Manager-App` (Expo prototype) | offline-first field patterns: local cache of zones/rules/flags, durable upload queue with retry, provisional local compliance labelled provisional, photo vault, GPS zone auto-detect, welfare inactivity timers | its tables (`vehicle_observations_v2`, `investigation_jobs`), delete-after-5-failures queue, client-side authority |
| `FreedomCamp-Manager` (web predecessor) | workflow breadth as requirements; governance-gate checkers (route/endpoint baselines); training feature; migration-repair runbook | its architecture wholesale |
| Onspace preview | task hierarchy and scanability only | table names, browser writes, role model |

## 1. Ground truth and guardrails (in place 2026-09-14; keep green)

- `supabase/schema.sql` regenerated from the live catalog (356 tables, 549
  functions, 860 policies) via `scripts/schema-snapshot-live.mjs`; hand-editing
  it is prohibited. **Gate:** the snapshot is re-run after every applied
  migration; a CI drift check is a follow-up once a PAT is available to CI.
- Canon imported and reconciled (`docs/canon/`), `FOUNDATION.md` at root.
- GitLab lineage readable read-only (`scripts/gitlab-read.mjs`).
- Baseline health: 556 root tests, web typecheck and lint clean, 393 unique
  migrations, CSS contracts clean. Atlas refreshed from the truthful schema on
  2026-09-14 under the owner's ruling that a refresh writes only Atlas's own
  tables (`bob_capability_map`, `bob_app_map_edges`): 46 capability upserts,
  90 edge upserts, 3 stale edges retired; live now 1,324 live capabilities /
  6,214 live edges / 1,906 wired / 0 exercised. **Gate (standing):** re-run the
  refresh after every schema or code change that touches shared terrain, and
  re-baseline the gap report.

## 2. Accountability and access conformance (FOUNDATION → ACCESS_MODEL)

The keystone is done: `observations` carries the composed SELECT
(`observations_task_entitlement_select` → `user_has_task_entitlement`). Live
verification on 2026-09-14 showed W1 is further along than the ledger's
2026-08-17 snapshot: `incidents`, `breach_records`, `parking_sessions` and
`vehicle_observations` already carry place-reachable SELECTs; the three
assessment tables carry officer situational entitlement but **no harmed-party
read**; `notices` and `noise_seizures` carry the operator gate only. The anchor
ruling of 2026-09-14 (place of harm grants the read; the person or vehicle doing
the harm is the separately anchored subject) is recorded in
`docs/canon/ALIGNMENT_LEDGER.md` and settles edges 1, 2, 3 and 5.

1. **Apply the drafted W1 slice** —
   `supabase/migrations/20260914100000_harmed_party_read_assessments.sql`
   (guard test `test/harmed-party-read-assessments.test.js`): additive
   harmed-party SELECTs on `noise_assessments` / `smoke_assessments`
   (`complainant_site_id`), `biosecurity_assessments`
   (`protected_land_site_id`), and `noise_seizures` (follows the parent). It
   widens no read until W2 populates the anchors. Applying a migration is a
   protected path: the owner applies it, then `scripts/schema-snapshot-live.mjs`
   is re-run and Atlas refreshed.
2. Recover the 13-scenario RLS oracle from the lineage
   (`supabase/tests/0325_observations_keystone_rls.sql`) and run it here against a
   disposable Postgres (the `backend-verify` worker already boots the pinned
   image) — required before any W2 write contract goes live.
3. W2 record-side: make the harmed-party columns live — the governed submit
   functions populate them (noise/smoke: complainant site; biosecurity: protected
   land) and the review surfaces read them. Lineage plans:
   `WRITE_CONTRACT_SLICE1_SMOKE.md`, `WRITE_CONTRACT_SLICE2_BIOSECURITY.md`.
4. `notices` place-of-harm anchor: derive via `breach_id → breach_records.zone_id`
   for interrupt-tier notices and add `client_site_id` for RMA notices (the live
   `location_id` has no FK and no site/zone); then the additive harmed-party
   SELECT. Subject anchors (`vehicle_id`, `person_id`) never grant the read.
5. Access-basis UX: one shared "why can I see this?" chip + drawer rendering the
   §8 return shape (`resolve_access_basis` is live), applied across observations,
   dispatch, incidents, reports.
6. Model A W0 audit: prove own-rooted orgs (10 of 55 today) are fully operable —
   `get_descendant_organizations`, branch login, `create_client_org`, wizards W1/W2.

**Gate:** oracle green both directions (no leak, no lockout) per table; a
cross-tenant negative test per new policy; completion recorded as
"operationally corrected / doctrinally incomplete" until both W1 and W2 land.

## 2b. Noise control — the two-place model (ruling 2026-09-14)

Design: `docs/canon/NOISE_CONTROL_TWO_PLACE_MODEL.md`. One job, two places
(complainant = harm anchor, protected; source = work anchor), both attended as
geofence-verified ad-hoc stops, complainant contact recorded, END period held as
a dated council rule under the statutory cap (8 days since 21 Aug 2025), seizure
gated on Police presence, and a client report that discloses by basis.

1. **Applied 2026-09-14 (owner-authorized)** — `20260914100000` and
   `20260914110000` are live and in the ledger (`scripts/apply-migrations-live.mjs`);
   schema re-snapshotted and Atlas refreshed. The latent defect (the re-issued
   `submit_officer_noise_assessment` writing a non-existent `shift_id`) is repaired.
2. **Truth table stays green** — `scripts/run-rls-oracle.sh … --oracle
   supabase/tests/20260914110000_noise_two_place_rls.sql` (41 checks, real RLS,
   disposable Postgres, `--network=none`). Any change to the noise RPCs or
   policies re-runs it before merge. The snapshot generator now emits
   `REVOKE ALL ON TABLE … FROM PUBLIC, anon, authenticated, service_role` before
   each table's grants, so a database restored from `supabase/schema.sql`
   carries the live privileges exactly (a fresh Supabase database's default
   privileges had been silently widening `dispatch_job_protected_parties`).
2a. **Direction particulars — applied live 2026-09-14 (owner-authorized)** —
   `20260914120000_noise_direction_particulars.sql` adds one governed command,
   `record_noise_direction_particulars`, writing only the columns `20260914110000`
   created: how the direction was given (oral/written, s.327(2)), to whom
   (occupier / responsible person / unoccupied — notice left), an
   officer-specified shorter period within the council rule (s.327(3);
   `end_expires_at` recomputed), and the s.328(5) entry notice, which is
   mandatory and must be written when no occupier was identified. Officer-owned
   (assessing officer or org admin), idempotent by `client_request_id`,
   audited. Guard: `test/noise-direction-particulars.test.js`; truth table
   extended by 7 checks. Ledger tip `20260914120000`; schema re-snapshotted;
   Atlas shows the RPC present + wired with `calls`/`reads`/`writes` edges
   (not `exercised` — no live invocation yet).
3. **Officer flow — built 2026-09-14** (`apps/web/src/pages/OfficerNoiseControlPage.tsx`,
   guard `OfficerNoiseControlPage.guard.test.ts`): job card with both places and
   the pre-arrival dossier → arrive (verification shown loudly, never blocking) →
   assess (position rule stated; distance recorded server-side) → action (END
   only with a complaint job; seizure only with Police present; statutory
   number required) → contact complainant (identity via the audited RPC only;
   in-person contact requires arrival at the complainant place) → depart (delay
   reason when the SLA was breached) → **direction particulars** (after an END
   or seizure: given orally/in writing, to whom, a shorter period within the
   council rule read from `noise_module_config.end_validity_hours`, and the
   s.328(5) notice when unoccupied — through `record_noise_direction_particulars`
   only; the form mirrors the statutory rules before the server enforces them).
   **Owed:** a human test with a real job on the live build (gate below).
4. **Dispatch intake — built 2026-09-14** (`DispatchConsolePage.tsx`): for
   noise jobs the intake captures the complainant place (known site or address)
   and identity, and writes them through `set_dispatch_job_harmed_party` after
   the job is created; identity never goes into briefing notes. **Site-entry
   seam applied live 2026-09-14 (owner-authorized)** —
   `20260914130000_dispatch_place_site_entry.sql` adds one internal
   resolve-or-create (`resolve_or_create_dispatch_place_site`: house first,
   dedup by address key within the owner org, a house under another org is
   flagged `needs_review` and never reused or forked, provisional centre and
   unverified boundary, audited) and puts both dispatch place writers on it:
   `set_dispatch_job_harmed_party` (re-issued with optional coordinates; a
   resolved address-only complainant place becomes a real site so arrival
   there is `unverified_boundary` with a distance rather than `no_geofence`;
   a supplied site must belong to the job's client or custodian because it
   grants the W1 read) and `create_dispatch_intake_job` (identical signature).
   Truth table 56 checks; guard `test/dispatch-place-site-entry.test.js`. The
   console sends the resolved coordinates and states resolved vs unresolved.
5. **Client report and oversight — built 2026-09-14** (`NoiseControlOversightPage.tsx`):
   the attendance report renders `get_noise_attendance_report` at the reader's
   disclosure level; the review queue flags END without a complaint job, seizure
   without Police present, unmeasured assessment position, and flagged
   attendances (`off_site` / `no_gps` / `unverified_boundary` / `no_geofence`),
   and shows a missing delay reason on a breached SLA loudly.
6. **Legacy import re-anchor** — split the Nelson export's inline complainant
   details into protected parties and two places; each historic attendance
   becomes a stop with its on-site/off-site times.
7. **Smoke and biosecurity** take the same shape (`harmed_party_site_id` on the
   job; `protected_land_site_id` for biosecurity; derived anchors on submit).

**Gate:** the human test in the design doc §7 passes end to end and the
source-side reader's report carries no complainant data.

## 3. Place convergence (LOCATION_HOUSE_MODEL, GEOFENCE_PRINCIPLES)

1. Every site/zone create path resolves-or-creates the house first; port
   `resolveOrCreateHouse` with its ownership-jump guard and tests from
   `docs/canon/reference/recovered/`.
2. Back-fill houses for the 69 sites and 1 zone without `location_id`
   (data migration with provenance, reviewed).
3. Canonical site-entry pipeline (Q10): inventory every address entry point in
   `apps/web` and route all of them through LINZ autocomplete → dedup → create.
   Dispatch included. **Dispatch slice applied live 2026-09-14** (see §2b item 4):
   both dispatch place writers now share `resolve_or_create_dispatch_place_site`,
   which resolves-or-creates the house first (§3.1 shape, SQL). Remaining entry
   points (CRM `create_crm_site`/`manage_crm_location`, the edge
   `houseResolve.ts` with its differently-normalised key, investigation and
   context site creates) still run their own paths.
4. `resolution_status` audit: `process-officer-scan`, dispatch intake and the
   billing zone-tier must branch on the five outcomes; no boolean fallbacks.
   **Scan pipeline conformed 2026-09-15 (G3; edge function redeployed v610):**
   `process-officer-scan` reads `resolution_status` + `governor_overlap_flag`,
   fails closed (503) on an absent resolver row, refuses an inconsistent match,
   records the status and a distinct loud notice per outcome on the
   observation's `geofence_context`, and returns them to both clients, which
   render each outcome distinctly (`test/geofence-p1-callers.test.js`). Rules
   are applied only on `resolved`; every other outcome stays compliance-unknown.
   Dispatch intake already requires resolved coordinates and creates a
   provisional site through the shared seam (§3.3); a billing zone-tier
   resolver does not exist live yet (no function matches) — it is built on the
   status when finance lands (§8), not retrofitted.

### 3a. Geofence workbench (GEOFENCE_PRINCIPLES P1/P2, Q2–Q7) — taken over 2026-09-15

- **G1 engine — live** (`20260914004000`, applied by the geofence session;
  restored verbatim into the checkout): `boundary_proposals` staging (RLS read
  within reach, no browser writes), `propose_boundary` (measure, area gate per
  `zone_type`, drift, supersede), `accept_boundary_proposal` (human-edited
  shape → live entity, provenance by source, optional verify, history),
  `reject_boundary_proposal` (reason required), `get_geofence_review_queue`
  (sites + zones, worst first), `find_existing_site_for_address` (Q10 dedup),
  browser boundary RPCs revoked from anon. Truth table
  `supabase/tests/20260914004000_geofence_workbench_rls.sql` (42 checks).
- **G1b hardening — applied live 2026-09-15 (owner-authorized; ledger tip
  `20260914140000`)**: `verify_boundary`
  refuses to certify missing/invalid geometry for all four tiers (checkpoint
  geometry derived from point + radius; versioned), pinned `search_path`,
  anon revoked from the verify/version/history helpers. Found by the truth
  table against the live schema: live `verify_boundary` certified "no geofence"
  as verified — the exact P1 collapse. Verified live post-apply.
- **G2 workbench UI — built** (`SiteBoundaryReviewPage.tsx`): queue → LINZ map
  inspection (current teal, proposal amber with draggable vertices) → source
  ladder (LINZ parcel/building via `linz-lookup boundary_for_point_escalating`
  → drawn → point + radius provisional) → accept (+ verify tick) or reject →
  history. No direct `client_sites`/`location_zones` writes. Guard + e2e +
  refreshed baselines.
- **G3 P1 callers — built; `process-officer-scan` redeployed 2026-09-15
  (v610, owner-authorized)** (see §3.4).
- **G4 Tier 4 checkpoints — applied live 2026-09-15 (owner-authorized;
  ledger tip `20260915100000`)** —
  `20260915100000_checkpoint_tier_workbench.sql`: `manage_patrol_checkpoint`
  (Q3 direct save at a site within reach, map position required, radius from
  `org_geofence_config.checkpoint_radius_m` else 5 m (Q8), idempotent create,
  versioned in `geofence_boundary_history` as point + radius (Q4), audited);
  a BEFORE INSERT/UPDATE trigger that forces every placement to land
  `unverified` and resets verification on any geometry change, whoever wrote
  it (structural P2 — RLS lets an org admin edit the table directly);
  `record_officer_checkpoint_visit` re-issued with its exact signature so the
  visit's distance and `within_radius` are measured by the server from the
  recorded point (the officer client's claim is audited, not stored) and the
  checkpoint's verification state is recorded on the visit
  (`checkpoint_verification_at_visit`). Before this, live had no checkpoint
  create path at all (0 rows), no P2 reset, and the visit writer stored what
  the client asserted. Truth table extended to 58 checks; guard
  `test/checkpoint-tier-workbench.test.js`. Workbench UI: a "Checkpoints
  (Tier 4)" panel on every selected site — list with state, place by picking
  a point on the map or typing coordinates, move/resize, (de)activate, and
  verify only after the "position inspected on the map" tick. Admin sidebar
  entry renamed to "Geofence Workbench".
- The snapshot generator now also emits `REVOKE ALL ON FUNCTION … FROM
  PUBLIC, anon, authenticated, service_role` before each function's grants
  (same fidelity gap as the table fix: default privileges in a fresh database
  had widened `_gbh_next_version` to anon/authenticated in the oracle only).
- **Remaining:** Tier 1 organisation
  jurisdiction through the governed proposal path (Q5) with map preview; Q6
  source registry rungs (council ArcGIS / NZTA) as proposal sources; backfill
  of the 75 unverified sites through the queue (human work, not a script);
  human test of the workbench on the live build (propose from LINZ → edit →
  accept → verify → place a checkpoint → scan resolves).
5. `location_events`: either land the governed writer (dual-write from the
   module submit functions) or keep it out of every UI as an explicit seam.

**Gate:** zero facets without a house; zero free-hand address inputs; the five
`resolution_status` outcomes each proven with a stress point; Atlas shows a real
`writes` edge into `location_events` before any surface reads it.

## 4. Field-operations spine (UNIFIED_FIELD_OPERATIONS_MODEL)

1. Server-side effective-toolset resolver: person eligibility ∩ place capability
   (`organization_modules`, `site_services`) ∩ assignment grant, plus the base
   toolkit — one RPC consumed by web and mobile instead of per-shell hooks.
2. `patrol_routes → assignments` rename as its own additive migration + code
   sweep (name, call sign, type, parent/child already exist as columns).
3. Roster staffing lifecycle states `unstaffed → offered (direct|open) → owned`
   with decline/withdraw, feeding presence, SLA, timesheets and welfare.
4. Presence proof identical for static and patrol (`shift_stops`,
   `patrol_checkpoint_visits`, GPS), surfaced to clients as "your site was
   serviced".

**Gate:** one guard, one shift, three tools, two places, end-to-end in the
human-test runner, with roster → arrive → work → evidence → report → invoice
line each leaving an audit receipt.

## 5. Module-as-data unwinding, Freedom Camping as the reference vertical

1. Register every module in one manifest with `requiresSpines` (target shape in
   `docs/canon/MODULE_INTEGRATION_CONTRACT.md`); reconcile
   `specialtyModules.ts`, `platformModuleManifest.ts` and
   `_shared/moduleProfiles.ts` into it.
2. Unwind the FC-first forks named in `PLATFORM_ENGINES_AND_MODULE_PROFILE.md`
   §7: one classify path with module prompt/model as data; template-driven
   notices with no hardcoded FCA HTML; profile-driven geometry create/update;
   bespoke detail tables only where the shared spine cannot express the fact.
3. Finish the FC blueprint sequence: SCV CSV import + NZSCV fallback, scanner
   modes (standard / zoom / detail / bulk), notice draft + on-site print behind
   the fire-control key, admin and client reporting.
4. Per-module settings surfaces wired to `module_rule_sets` /
   `jurisdiction_rule_sets` / `*_config` — no council-specific constants in code.

**Gate:** adding a module touches manifest + data only; the standalone
"login and scan" mode works with one module lit; FC breach → notice → report
proven with evidence chain intact.

## 6. Officer shell and court-readiness UI (PRODUCT_DESIGN)

1. Verify the four-state entry machine (standby / roster-first home / module
   selector / module portal) and the always-visible Field Safety Bar and PTT bar.
2. Evidence metadata strip under every photo; audit-trace footer on every detail
   page; skeleton and empty states everywhere; WCAG 2.2 AA.
3. Enforced enforcement ladder (warning → infringement → NTV), pre-arrival safety
   dossier acknowledgement, human fire-control key before print — all logged.

**Gate:** human-test report per shell with before/during/after evidence; the 107
walkthrough findings and the Playwright red list triaged to zero or to issues.

## 7. Mobile offline field client

Rebuild the prototype's offline depth on current contracts: server-issued data
package (`get_officer_data_package`), multi-type durable upload queue (never
delete on failure), provisional local compliance labelled provisional until the
server verdict, photo vault with SHA-256 registration, background GPS with
`record_officer_breadcrumb`, welfare timers on `officer_welfare_settings`, device
push via `officer_device_tokens`.

**Gate:** three days offline simulated; every queued item replays idempotently;
no record is authoritative until the server says so.

## 8. Finance and pay (ENTERPRISE_READINESS_REVIEW G1 first)

1. Re-implement `rateEngine` from the recovered source **with
   `rateEngine.test.ts` first** (resolution specificity, effective dating, money
   math, per-block billing, pay lines, SLA bands, determinism, no silent zero).
2. Completion pipeline → idempotent `dispatch_job_pay_lines` → finance review
   queue → invoices → Layer-2 on-charge; adjustments by supersession, never
   destructive updates.
3. Bureau/zone-tier pricing rides `resolve_context`; therefore Workstream 3.4
   precedes go-live.

**Gate:** every pay amount explainable from the completed evidence and the rule
version that produced it; duplicate completions idempotent; cross-tenant negative
tests.

## 9. Bob (BOB_DOCTRINE)

Ruling 2026-09-14 (recorded in `docs/canon/BOB_DOCTRINE.md` §9): the **chat
lane** is governed on what is shared with the user, by rank, owner unrestricted;
the **agentic lane** works as a coding agent works — plan, implement, verify,
iterate — with subagents supporting and verifying, stopping for a human only at
the protected paths (merge, deploy, migration/DDL, auth/RLS, dependencies,
destructive bulk operations).

1. Root-cause the planner's empty-reply turns (`callPlan` → VPS `/api/bob/plan`)
   using `bob_event_log`; the fallback text fix shipped 2026-09-14 is a stopgap.
2. Agentic lane: let the bounded Builder runner continue through implement →
   verify → repair loops on specialist evidence (independent code review and
   security review as the verifying subagents, different model identity from the
   author) instead of pausing for a human after each specialist action; stop at
   a protected path, a blocked state, an unrepairable verification failure, or
   the operational action ceiling. Keep `release_ready` as the hand-off to the
   human for merge and deploy.
3. Chat lane: re-prove the four-tier egress model per rank (the lineage's #324
   finding that a `master` reached full cross-org resolution), and wire the
   Tier-3 HSWA duty-to-warn path (`safetyFloor`) end-to-end. Operational writes
   from chat stay behind `isGovernanceLocked` until a separate ruling names the
   write classes.
4. Populate `bob_capability_map.exercised` from real invocation evidence
   (edge-function logs, `bob_event_log`, RPC stats); today it is 0 everywhere.
5. Cockpit primitives: who-is-flying indicator, takeback, result-in-habitat.
6. Re-create the RunPod QA endpoint and run `full-page-audit` on Bob's
   infrastructure.

**Gate:** live `bob_messages` show no context-losing fallbacks; a Builder job
runs implement → verify → repair without human touch and stops cleanly at
`release_ready`; egress proven per rank; Atlas `exercised` is populated from
evidence, not asserted.

## 10. Enterprise hardening (parallel track)

CI gates that actually block (unit + guard tests, migration snapshot drift, CSS
contracts); observability (error tracking, structured logs, alerting for a 24/7
dispatch system); DR with documented RPO/RTO and no single-VPS point of failure;
edge-function rate limiting; SSO/SCIM; compliance artifacts (Privacy Act
classification and retention confirmed by counsel); timestamped migration
discipline (already in place here).

## 11. What not to do (the recurring failure modes)

- No parallel place, org, status or evidence models inside a module.
- No per-module code branches where a data profile will do.
- No free-hand addresses; no silent geofence fallbacks.
- No hand-edited `schema.sql`; no Atlas edges asserted by hand; no "exercised"
  claims without evidence.
- No UI wired to a column nothing writes — use `ComingSoonPage` and say so.
- No Bob constraint without naming its rail or gate; no Bob write outside a
  governed, idempotent, audited path.
- No completion claims above the evidence: merged ≠ deployed ≠ glass-proven.
