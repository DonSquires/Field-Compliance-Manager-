# Rebuild Plan — bringing the build to the canon

Status: active. Owner: Don Squires. Order of authority: `docs/canon/README.md`.
This replaces the scattered per-topic TODOs as the top-level sequence; the
detailed backlogs (`ENTERPRISE_SAAS_TODO.md`, `PROTOTYPE_GAP_AUDIT.md`,
`MODULE_BASELINE_REQUIREMENTS.md`) hang off the workstreams below.

Completion language is strict, as in the lineage: **merged ≠ deployed ≠
glass-proven.** A workstream item is done only when its evidence gate is met.

Live service-area finding 2026-10-11: R&M organisation settings could preview a
canonical council boundary, then told the user Bob would send it to Approvals
"when you are ready", but exposed no submission action. The page also carried a
hardcoded council-name list despite the geofence ruling that canonical
Territorial Authority names come from the live reference table. The repaired
flow reads `canonical_ta_names`, keeps preview read-only, and creates a pending
`set_org_jurisdiction` action through `bob-propose-org-jurisdiction`; approval,
execution, and visual verification remain separate. Bob's previously unwired
friction-triage organ is now available through the Conductor so a page-level
contradiction can be recorded and routed, while Bob explicitly distinguishes
"reported/routed" from "being worked on" until a Builder job receipt exists.

Live acceptance finding 2026-10-11: an owner build request successfully ran
repository and Atlas inspection but then stopped at a future-tense prose plan.
The conductor now converts that narrow post-evidence outcome into the existing
two-turn `create_builder_job` proposal. Rank enforcement, separate human
confirmation, isolated execution, draft-PR output, and the protected
merge/deploy boundary remain unchanged.

RFQ drafting hardening 2026-10-11: Bob's generic document-draft tool now has an
R&M-specific `rm_rfq` source mode. It binds the draft to the latest completed
inventory run for the caller's approved local-folder source, limits references
to eligible RFQ/proposal paths, preserves manifest IDs, run IDs, relative paths,
hashes, capability and extraction status, and always leaves unresolved
`[HUMAN INPUT REQUIRED: ...]` fields under the existing human-review gate.
Inventory is still metadata, not extraction; Bob must not represent an
unextracted manifest entry as verified source content.

Release acceptance hardening 2026-10-11: the Builder human-test driver now
refuses unexpected approval types, fails on any unsuccessful workspace/commit/
publish/PR response, and verifies that workspace, published, and pull-request
head SHAs are identical. The protected release lane now refreshes Atlas
exercise evidence after the normal Atlas wiring refresh and blocks the lane if
that runtime-evidence refresh fails. These receipts prove the gates; they do
not grant Bob unattended merge or deployment authority.

Owner ruling 2026-10-12: routine self-heal is monitored and automatic rather
than admiral-initiated. Signed-in web runtime errors and unhandled rejections
produce bounded, redacted before/during/after friction packets. Only
high-confidence software bugs with no stop-line or protected/consequential
signals enter the routine Builder queue. The control plane claims them,
commit-pins a Builder job, runs the existing verification/review/autopilot
lane, and may auto-merge only under the existing clean non-evidential marker.
Redesigns, new builds, new capabilities, migrations/schema/RLS/auth,
dependencies/environment, privacy, safety, legal, identity, enforcement,
finance, payroll, and evidential work remain Grandmaster-gated. Expansion
beyond eight changed files also stops at the gate.

Owner ruling 2026-10-12: GitHub is the source repository only; no GitHub Actions
CI, coding agent, Gitea mirror, or release workflow runs. Bob's VPS directly
polls the pinned GitHub `main` SHA, runs the isolated web build/unit/source-guard
and Playwright smoke checks, and opens bounded Builder repair jobs for
test-only baseline failures. Auto-merge requires the existing clean
non-evidential gate plus the exact failing-guard allowlist. The VPS remains
fail-closed until its durable GitHub write credential and repository identity
are configured; no ephemeral Codespaces token may be persisted or repurposed.

Dr Bob acceptance finding 2026-10-12: Bob answered a combined Atlas, schema,
and human-test request after running only one paginated Atlas query, while the
Builder UI correctly showed that no work was running. The repaired path gives
Bob a governed `run_human_test` tool backed by the existing isolated browser
worker and a persisted control-plane receipt. Start and status responses carry
the run ID, pinned source SHA, lifecycle state, counts, and artifact inventory;
Bob may not use "running" or "ongoing" language without that receipt. Atlas gap
generation was also corrected to include production JavaScript at the
repository root and to ignore DDL-like SQL string literals. An Atlas `unwired`
classification remains a static-map finding, not proof of a broken feature,
until schema and caller evidence agree.

Natural-language Builder acceptance hardening 2026-10-13: Bob's deterministic
post-evidence Builder fallback now recognises ordinary owner language such as
"build me an app", "add a page", "make this workflow work", and "fix the UI",
without requiring the owner to know Bob's internal Builder term. Bob now carries
the selected mode into the durable job brief: no-code app generation
(user/role/job-to-be-done, schema-backed information architecture and governed
data path), AI-assisted chat-to-code (source-level change), or bounded
autonomous self-heal (reproduce and repair a confirmed defect within the
attempt ceiling). Builder chat exposes a plain-language starter for each mode.
Business-record creation remains outside this software-build classifier. The
same evidence, confirmation, isolated worker, review, protected merge/deploy,
and receipt gates remain unchanged.

Live Builder-monitoring finding 2026-10-13: a plain-language request to research
and redesign Bob Builder stopped at generic UI/UX prose and created no Builder
receipt. After the planner was trained on the three Builder modes, the in-house
model correctly selected web research but repeated the same tool instead of
advancing. The VPS planner now deterministically advances a grounded software
request from completed web research to repository inspection, then from source
evidence to the existing two-turn `create_builder_job` proposal. This guard does
not skip evidence, confirmation, isolated execution, review, or protected
release gates. A terse follow-up such as "proceed" now recovers the original
software request from the conversation, counts successful research subagent
steps as evidence, rejects vague or `not_found` repository searches, and
normalizes premature Builder calls into the actual job argument contract.

Owner ruling 2026-10-13: an admiral's explicit natural-language software-build
instruction authorizes Bob to research, inspect, refine, open, and drive the
isolated Builder job without repeated human "proceed" turns. Bob answers his
intermediate questions with read-only research, repository, Atlas/schema,
drafting, and review helpers. He interrupts only for a genuine specification
fork or a protected/consequential boundary. Merge, deployment, migrations,
auth/RLS, dependencies/environment, and evidential work retain their separate
human key.

Builder concurrency acceptance 2026-10-13: monitoring a live owner-requested
Builder redesign found that the control plane awaited the entire isolated
main-health suite before listing or advancing owner Builder jobs. A new source
SHA or control-plane restart could therefore leave a valid autopilot job at
intake for up to the 30-minute health timeout. Main-health now runs as an
independent single-flight lane with explicit failure recording, while routine
self-heal and owner Builder jobs continue through their existing bounded
governance paths. This is concurrency only: it does not weaken health checks,
verification, review, merge, deployment, or protected-path gates.

Builder research-provenance acceptance 2026-10-13: monitoring the Builder
control-room redesign rejected a second product specification before design
because it named “research integration” but carried zero source URLs or observed
patterns. Research-driven natural-language jobs now preserve bounded research
output and source URLs in the durable brief, cannot open with fewer than four
sources, and require Product Analyst to return structured publisher, observation,
and applicability evidence using only supplied URLs. This is provenance, not
authority for a write; unsupported or invented sources fail validation. A live
owner retest then found that a three-source result ended in another question
instead of continuing the explicit build instruction. An owner-invoked research
build now makes at most one bounded follow-up when fewer than four safe sources
resolve and carries the combined evidence straight into Builder; it does not
weaken the source gate or permit autonomous research without the owner's request.
The next live job exposed a URL/path collision: a researched `/ai-apps/` URL was
read as a repository `apps/` path and incorrectly selected a backend-only lane.
Repository-lane inference now strips public URLs before recognizing source paths,
so research evidence cannot suppress the requested UI design/frontend stages. A
fresh retest then exposed the alternate `repo_search` → in-loop `web_research`
route ending in synthesized design prose. The explicit-owner-build completion
bridge now accepts that researched read route too (with the same bounded follow-up
and source gate) without adding web research to the general autonomous allowlist.
The following run reached Builder but showed `supplied_sources: 0` even though a
research subagent had returned six public sources: planner arguments had dropped
the delegated evidence. Job creation now preserves bounded findings and non-example
URLs from successful delegated `web_research` steps before applying the same gate.
The first fully sourced job then exposed a UX-grounding gap: the designer received
a file map but not canonical token or navigation evidence, and invented a route,
permission constant, Tailwind-like token set, generic approval state, and mobile
accordion. Pinned `PRODUCT_DESIGN.md`, `tokens.css`, and Builder AdminShell evidence
now enter design context. UX validation rejects unsupplied routes, access boundaries,
components and tokens, plus unresolved questions already answered by that evidence.
A subsequent planner variation inserted repository-research `docs/` paths into the
brief and again selected backend-only work. Builder lane scope is now derived only
from the owner's words and owner-named paths; planner prose, delegated findings,
and research URLs cannot authorize or suppress frontend/backend work.
Live UX acceptance then exposed a validator wiring regression: the repository-
grounded validation closure referenced `prompts.context` while the prompt binding
was singular, so all three providers produced output but failed on an undefined
identifier. The callback now uses the actual prompt context and its regression
test invokes the callback, rather than merely asserting that it was supplied.

Builder restart acceptance 2026-10-13: the same monitored redesign exposed a
second orphan class. A control-plane deployment landed after product analysis
claimed its durable step but before the model returned, leaving both the model
run and the step permanently `running`; only isolated worker leases had restart
recovery. On startup the control plane now claims model runs that predate the
new process, records them as interrupted, returns analyst/designer steps to the
existing retryable failure path, and completes that recovery before autopilot
planning. Active model work started by the current process is not touched.

Runtime acceptance 2026-10-11: the laptop vision watcher now writes an
independent liveness heartbeat and its Docker health check terminates only a
stale watcher process so `restart: unless-stopped` can recover it. Acceptance
forced both a watcher process crash and a stale heartbeat; each restarted in
one second and returned healthy. Live Bob acceptance also found and repaired
two false-stop paths: a scoped "do not write canonical business records"
boundary no longer blocks an explicitly requested conversation-only document
draft, and Builder autopilot recognizes the worker's `baseline: repository red
at the pinned commit` receipt as a repairable red-main condition. Canonical
promotion, protected merge, and deployment authority remain unchanged.

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

**Applied live 2026-09-15 (owner ruling; `20260915170000_place_model_convergence.sql`,
truth table `supabase/tests/20260915170000_place_model_convergence.sql`, guard
`test/place-model-convergence.test.js`):** `canonical_places` is the permanent
place registry (kind `site` keyed by address, `zone` keyed by house); every
house carries `canonical_place_id`; every site and zone has a house in its own
organisation, resolved-or-created by trigger on write (items 1 and 2 below are
done: 70 houses back-filled, identity preserved, 3,113 observations still on the
Lowburn registry row); places cannot be deleted (trigger + revoked grants;
`merge_canonical_place` converges duplicates); one SQL address key rule mirrored
by `_shared/addressKey.ts`; the zone→site link, zone nesting, zone address
columns, `client_site_zones` and `get_zone_for_gps` are removed as duplicates.
`resolve_context` now takes the site and owner from the matched zone's house.

1. ~~Every site/zone create path resolves-or-creates the house first~~ — done
   structurally: `zz_client_sites_place_house` / `zz_location_zones_place_house`
   triggers, with the ownership-jump guard, run for every writer.
2. ~~Back-fill houses for the 69 sites and 1 zone without `location_id`~~ — done
   (`location_id` is now `NOT NULL` on both facets).
3. Canonical site-entry pipeline (Q10): inventory every address entry point in
   `apps/web` and route all of them through LINZ autocomplete → dedup → create.
   Dispatch included. **Dispatch slice applied live 2026-09-14** (see §2b item 4):
   both dispatch place writers now share `resolve_or_create_dispatch_place_site`,
   which resolves-or-creates the house first (§3.1 shape, SQL). The edge
   `houseResolve.ts` key now matches the SQL rule and its cross-org hard stop is
   gone (same address in another organisation = same registry place). Remaining
   entry points (CRM `create_crm_site`, investigation and context site creates)
   still take free-text addresses; the key is exact, so they must move to LINZ
   canonical strings or they will create precision duplicates.
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
   (edge-function logs, `bob_event_log`, RPC stats). **Implemented 2026-10-11:**
   118 capabilities are supported by 11,289 invocation observations; static
   refresh preserves rather than invents those claims.
5. Cockpit primitives: who-is-flying indicator, takeback, result-in-habitat.
6. Re-create the RunPod QA endpoint and run `full-page-audit` on Bob's
   infrastructure.
7. Compile every document and media perception path into the shared evidence
   contract in
   [Bob enterprise agent architecture](BOB_ENTERPRISE_AGENT_ARCHITECTURE.md):
   deterministic
   candidates and conflicts, immutable-source/derivative receipts, typed
   confidence, human review state and guarded canonical promotion. Start with
   NZTA/plate OCR, then CCTV/ALPR, face candidates, person tracking, vehicle
   attributes, smoke/noise/biosecurity and Desktop V2.
8. Add verifier-level claim-to-evidence checks: every high-risk identifier in
   generated prose must equal a structured field with sufficient authority, or
   the turn returns review-required rather than a confident answer.

Phase B document-identity slice shipped 2026-10-11: the shared versioned
perception envelope, field candidates, calibration receipts and append-only
review history are live; NZTA OCR writes replay-safe source/model receipts; and
the deterministic verifier blocks unsupported plate claims. Raw candidate
reads are administrator-only pending the domain-specific task-entitlement
policies delivered with each Phase C adapter.

Phase C CCTV ALPR slice shipped 2026-10-11: plated CCTV observations now compile
into replay-safe shared perception envelopes after derivative persistence.
Original evidence/frame hashes, raw and corrected reads, source/enhanced
comparison, ALPR quality, crop width, minimum character confidence and temporal
consensus remain inspectable. Weak or conflicting reads cannot become verified
candidates. `cctv_entity_observations.review_state` remains the single human
decision and is projected into shared authority and review receipts. Raw access
remains administrator-only pending a separately tested CCTV task-entitlement
policy. Vehicle-attribute and vertical-module adapters remain.

Phase C CCTV person/face slice shipped 2026-10-11: source/frame custody,
presence, face-detection provenance and pseudonymous portfolio evidence now
compile into the shared envelope. Raw face/appearance templates, candidate
names and identity lists remain in the governed CCTV biometric store and are
not duplicated. Machine face similarity remains provisional because
relevant-condition and demographic calibration is absent. Existing CCTV review
approves presence; only an explicit human person link/new-person action creates
a human-approved shared identity reference. Vehicle attributes and
vertical-module adapters remain.

Phase C CCTV vehicle-attribute slice shipped 2026-10-11: make, model, colour,
body type and year now retain per-field provenance in replay-safe shared
receipts. Trained OpenVINO colour/type, heuristic fallback and vision-LLM
make/model sources remain distinguishable and always require human review.
Plate acceptance now creates or links vehicle identity without seeding visual
attributes. The dedicated attribute review is the only canonical promotion
path and records corrections without erasing the original candidate. The live
backfill recorded 190 envelopes from 177 jobs and replayed all 190
idempotently. Smoke, noise and other vertical-module adapters remain.

Phase C biosecurity-photo slice shipped 2026-10-11: the governed submission
retains structured classifier details, reasoning, confidence and model receipt,
then compiles species, density and threat-level candidates into replay-safe
shared evidence. Machine inference cannot confirm species or mutate notices or
MPI referrals. An explicit administrator field review is distinct from
operational workflow triage and preserves corrected machine candidates as
superseded evidence. The oversight surface now signs and displays private photo
evidence with custody and authority state. Production verification found one
legacy evidence link without a custody hash; two replay attempts both failed
closed as `missing_source_hash`, with no fabricated envelope. Smoke, noise and
other vertical-module adapters remain.

Phase C smoke-photo slice shipped 2026-10-11: before capture, an officer must
select the source place, confirm the observed source and provide any notice
number required by the chosen legal action. During capture, the caller-context
receipt preserves notes and structured model provenance while the service-only
projection creates advisory visible-source, visual-severity and
visibility-impact candidates only from hash-backed evidence. After capture,
photo classification, legal/operational action and workflow review remain
separate attributable decisions; machine inference cannot establish a breach,
notice, legal basis or closure. The responsive oversight surface shows
short-lived private evidence, custody, officer notes, confidence and model
provenance, and desktop/mobile Chromium acceptance passed without browser
errors. The mobile field surface now shows the captured image before submission,
supports replace/remove, sends separate officer notes, names every outstanding
requirement, uses glove-safe controls and repeats the machine-authority boundary
before the officer confirms the source. Evidence time is bound to successful
photo capture rather than form mount, and changing the observed address, source
type or photo revokes the previous source confirmation. After submission, the
mobile surface retains a durable receipt that separates the officer's legal and
operational record from Bob's candidate, confidence, reasoning and model
provenance, including an explicit unavailable state and supervisor-review next
action. Production presently has four legacy assessments but no evidence links;
two replay attempts for each returned `missing_evidence_link`, while a
nonexistent assessment raised the missing-record guard. This contradicts the
historical assumption that every assessment could be projected, so the records
remain visible as a custody gap rather than receiving fabricated envelopes.
Other remaining vertical-module adapters remain.

Phase C noise-photo slice shipped 2026-10-11:

- **Before:** the officer must have an active entitled profile, select the
  source place, preserve any complaint/harmed-party place already held by the
  dispatch job, and capture a private source/equipment evidence photo. The photo
  is supporting visual evidence only; it cannot supply an acoustic reading.
- **During:** the caller-context receipt retains the two-place, GPS, H&S,
  Police, matrix, action and notice gates. Original and watermarked evidence are
  hashed and privately stored before a service-only, replay-safe projection
  creates visible-source, equipment and visual-activity candidates. Invalid
  classifier output now fails explicitly rather than returning a
  success-shaped `unknown`.
- **After:** photo classification, the officer's acoustic/legal decision and
  workflow review remain separate attributable actions. Human photo review may
  confirm, correct or reject candidates but cannot change matrix scores,
  enforcement action, notice or END fields. The responsive oversight register
  uses practical narrow-screen cards, short-lived evidence links and full-width
  safe actions; desktop/mobile Chromium capture and review passed without
  browser errors.

Production has 76 legacy noise assessments, zero governed evidence links and
zero `noise_photo` envelopes. Two replay attempts per assessment returned
`missing_evidence_link`, the counts remained unchanged, and a nonexistent
assessment raised `Noise assessment is missing`. The expected-versus-present
gap is therefore explicit: historical rows remain usable as legacy operational
records but cannot be represented as hash-backed photo evidence, and no missing
complaint place, media or envelope is fabricated.

Phase C access-control slice implemented in source 2026-10-11:

- **Before:** physical access control existed in agreements, zones, module
  profiles and seeded customer configuration, but the visible “Access rules”
  page administered staff permissions rather than field access events. There
  was no typed officer event, shared perception adapter, officer field route or
  mobile capture workflow.
- **During:** the new service-only receipt validates actor, module and canonical
  place authority; writes a tenant-scoped access event, location projection,
  evidence custody links and audit receipt. A separate pre-decision endpoint
  uses deterministic local face, person/body, vehicle and plate inference plus
  the existing organization-scoped portfolio matcher to rank possible people
  and vehicles. Web and mobile show the probe beside available reference or
  prior-sighting images before the officer records the outcome. The durable
  receipt reruns recognition independently rather than trusting browser-supplied
  candidates, strips embeddings and projects ranked matches as review-required
  candidates. Optional photos preserve original and watermarked derivatives
  with separate hashes, and recognition failure remains explicit rather than
  inventing a fallback.
- **After:** source contracts, web/mobile TypeScript, both Deno functions and
  the production web build pass. Bob may discover and rank likely identities or
  vehicles, but cannot confirm identity, validate a credential, decide
  entitlement or grant entry. A disposable Supabase Postgres database on the
  private Tailscale VPS route loaded the live schema snapshot and protected
  migration and passed executable checks for receipt/perception replay,
  evidence custody, person/vehicle candidate projection, RLS, grants and
  indexes. That run found and corrected an ambiguous PL/pgSQL `id` reference
  and an invalid perception `value_type`. The migration and both access
  functions were then deployed through the linked Supabase project; the live
  migration ledger, Data API exposure and unauthenticated 401 boundary were
  verified, and `supabase/schema.sql` was regenerated from the live catalog.
  Deployment checks then found missing Edge Function inference bindings and an
  older VPS image without `/infer/enhance`. The project secrets were bound to
  the authenticated public inference endpoint; the old image was tagged for
  rollback; and only `fcm-inference` was rebuilt and recreated through the
  private Tailscale route. Docker health, public HTTPS health, OpenAPI route
  presence and authenticated route validation pass. A role-specific image
  workflow is not yet glass-proven because no dedicated access-control test
  identity is configured, and a real user's credentials were not used as a
  substitute. Offline mobile event replay, calibrated tenant matching and
  dedicated-test-identity acceptance remain intentionally open.

System-wide Bob acceptance gate shipped 2026-10-11:

- **Before:** Bob's domain checks existed as separate suites, so a plate guard,
  CCTV adapter, Desktop V2 rule or Builder ceiling could regress without one
  named release check proving the whole agent boundary.
- **During:** `npm run bob:enterprise-readiness` now executes the original
  `JJJ739`/`11739` regression directly, verifies every declared implementation
  and test path, and runs representative cross-domain tests. The inventory
  records each subsystem's authority boundary and present state.
- **After:** the current result is five implemented domains, five partial and
  no full gaps. Access control now has a source-complete field/evidence slice
  but still requires protected deployment, disposable-database proof, offline
  sync and calibrated tenant matching. Parking/freedom-camping projection,
  Desktop V2 offline receipts/reconciliation, cockpit UX and perception
  calibration also remain partial. Atlas exercise is now backed by invocation
  evidence rather than static inspection. The strict command fails while those
  declarations remain, so the repository cannot honestly claim complete
  enterprise Bob readiness yet. Grandmaster is retained as an authenticated
  server-owned rank, not exposed as an ungoverned client-selected Bob
  personality.

  Durable chat execution slice implemented in source 2026-10-11:

  - **Before:** the browser held the `onspace-ai-chat` request open while the
    planner, verifier and tools ran. A glass test returned correctly but remained
    on “Waiting for Bob” for about two minutes, near the hosted Edge Function
    request-idle ceiling.
  - **During:** `bob_turn_runs` now supports `queued`; the browser sends
    `operation: enqueue`; the Conductor returns `202 Accepted`, dispatches one
    protected background execution, and atomically claims only the matching
    queued run. The UI polls every four seconds and supports queued or running
    cancellation without resubmitting the prompt.
  - **After:** completed runs refresh the canonical persisted transcript.
    Reloading or reopening a conversation restores its newest active run and
    resumes polling without duplicate execution. Failed or cancelled runs
    remain explicit and recoverable. The original caller JWT, organization,
    conversation, workspace, rank and effect gates remain binding during
    background execution.
  - **Evidence state:** migration `20261011043559` and `onspace-ai-chat` are live;
    the schema snapshot and Atlas were refreshed. Focused durable-turn and
    BobPanel tests, including reload reconciliation without duplicate enqueue,
    full repository tests, web TypeScript and the production build pass. Two
    consecutive browser glass runs returned control immediately,
    showed the durable run progressing independently, automatically refreshed the
    transcript, and completed successfully in 35.627 s and 34.675 s. The live
    security advisor reported no finding related to `bob_turn_runs`; its broader
    pre-existing findings remain an enterprise-hardening backlog.

  Historical false-plate correction slice implemented 2026-10-11:

  - **Before:** one persisted Bob reply presented `11739` as a verified plate
    even though the supplied NZTA source showed `JJJ739`. Live read verification
    found no `11739` or `JJJ739` row in canonical vehicles, tenant vehicles or
    vehicle observations, so the false reply had not been promoted.
  - **During:** migration `20261011050735` keeps the original reply for audit,
    flags it, appends one source-grounded correction, and links both messages
    through metadata. The bounded migration is idempotent and creates no vehicle
    identity record.
  - **After:** BobPanel labels the original **Superseded by correction** and the
    appended message **Audit correction**. The correction requires source-image
    comparison before identity promotion. Focused BobPanel tests, TypeScript,
    the full 1,051-test repository suite and the production web build pass.

  Page-context and Studio truth slice implemented 2026-10-11:

  - **Before:** the browser supplied agreement, site, zone, workflow and page
    context, but the Operations conductor discarded every field except
    `agent_mode`. Studio treated every assistant reply, including a rank-block
    message, as a version of the selected RFQ/document type. Two-turn laptop
    and Builder proposals asked for yes/no only in prose.
  - **During:** Operations context now passes through a capped allowlist of
    page/workflow identifiers and safe entity summaries. Studio requests add an
    explicit artifact type and document kind, and the conductor persists those
    fields with the sanitized agent context. Proposal and blocked-action
    metadata carries selectable options and safe relative navigation actions.
  - **After:** Bob can reason from the page context already supplied by the app;
    Studio excludes ordinary answers and failures; confirmation choices render
    as buttons; blocked document work can open the pre-seeded document Studio.
    Builder receipts now state the protected truth: Bob creates a draft pull
    request but does not merge protected branches or deploy production.

  Organization-bound document source slice implemented 2026-10-11:

  - **Before:** the R&M corpus had an approved tenant-bound local source alias,
    but Atlas showed no reader/writer flow. The only live laptop capability was
    an admiral-only exact-command shell, unsuitable for a resumable 140,000-file
    corpus. Browser upload could not safely carry approximately 881 GB.
  - **During:** added a durable source-run queue with lease/cancel semantics,
    relative-path-only manifest entries, capability/sensitivity/quarantine
    classification, bounded hashing and deduplication receipts. Added a
    read-only laptop worker, Bob tool, and Files-workspace progress UI.
  - **After:** admin/master callers can ask Bob to inventory the approved source
    without arbitrary shell authority. The result is a staged evidence manifest
    for Bob's writer/creator lanes; no business truth is promoted by inventory
    itself, and consequential writes continue through governed proposals.

  Governed chat document creation slice implemented 2026-10-11:

  - **Before:** live acceptance proved Bob could inventory, investigate, reason,
    and plan, but a request to persist a custom draft was refused because the
    chat catalogue exposed no document-create tool.
  - **During:** exposed the existing audited `create_bob_document_draft` and
    `submit_bob_document_for_review` path as `create_document_draft`, with
    administrator scope, explicit-write refusal enforcement, title/type/content
    caps, escaped HTML, and conversation-only scope.
  - **After:** Bob can return verified document/version IDs and a safe Studio
    destination. Publication, output, signing, and business-record promotion
    remain separate human-reviewed effects.

  Owner/grandmaster Bob workspace acceptance implemented 2026-10-11:

  - **Before:** live owner acceptance found that Studio could report itself open
    while remaining hidden in compact mode. Expanding it preserved incidental
    side panes, compressing chat, Studio, and context into three narrow columns.
    Private source images were listed as a file count rather than shown in the
    conversation, and a successfully persisted document still appeared as
    `Documents 0` because Studio knew only prompt-originated artifact metadata.
  - **During:** the Studio control now expands the workspace and closes session
    and context panes; returning to compact mode closes those full-workspace
    surfaces. Conversation images use short-lived signed URLs, show source
    provenance and processing state, and provide an accessible full-size
    action. Successful `create_document_draft` receipts now carry the exact
    governed artifact title, type, and authored text already submitted to the
    document RPC.
  - **After:** chat can show private source-image thumbnails without exposing a
    storage object publicly; Studio is a deliberate two-surface workspace
    rather than an accidental three-pane squeeze; and persisted document drafts
    appear as Studio artifacts whose preview is the authored draft rather than
    the creation receipt. Desktop and mobile Playwright acceptance, 40 focused
    component tests, conductor contracts, TypeScript, and the production web
    build pass.
  - **Live R&M continuation:** the approved local source completed with 140,826
    discovered files and zero failures. Chat rendered a private source image;
    Studio rendered that media, a generated Mermaid diagram, and a newly
    persisted conversation-scoped document with Copy/Download actions. The
    acceptance pass also found and repaired two presentation defects: checking
    a live durable request could show `Failed/paused` beside `running`, and a
    large Mermaid graph was scaled below readable size. Native labels were also
    lost because the secure SVG sanitizer removed Mermaid's label containers.
    Active durable states now take precedence over stale transport messages,
    and diagrams retain a readable native width inside the scrollable Studio
    canvas while the sanitizer preserves a text-only Mermaid label allowlist
    and removes executable or embedded foreign content.
    Non-admiral
    document receipts now explain that references are rank-protected instead of
    presenting unexplained `[id]` placeholders.

  Guided app-operation bridge implemented 2026-10-11:

  - **Before:** Bob could file governed record proposals and the approval
    workbench could approve/apply them, but the chat stopped at prose telling
    the user to find the approval surface. The action was not preselected and
    the user could not see a persistent before/during/after workflow in the
    conversation.
  - **During:** successful proposal metadata now carries an exact tenant-safe
    `/admin/approvals?actionId=...` destination and a persistent three-stage
    workflow (`Proposal prepared` → `Human review` → `Apply and verify`). The
    approvals workbench consumes the action ID, opens the Decisions area,
    preselects the exact action, and retains the canonical `can_decide` check,
    required reasoning, and separate approve/apply executor.
  - **After:** Bob can visibly walk a user from a chat request to the precise
    review screen and its real buttons without pretending that navigation is a
    database write or bypassing rank. Application still occurs only through
    `bob-proposal-approver` / the governed executor, and the resulting record
    receipt remains visible in the approval activity.
  - Live R&M acceptance found and corrected a separate context-handoff defect:
    opening Bob from a selected approval routed to the command-centre page and
    replaced the source page with generic `page: bob` context. The command
    centre now carries a sanitized source snapshot and return path in router
    state; the conductor admits the exact `action_id` and source page path as
    descriptive context only. A repeated read-only question must therefore
    identify the selected action rather than an unrelated prior Studio draft.

  Autonomous repair and visible-operation bridge implemented 2026-10-11:

  - **Before:** a high-confidence `bob_friction_packets` route stopped at
    “repair ready,” so the user still needed to restate the request and confirm
    a separate Builder proposal. Builder could verify, review, auto-merge
    eligible non-evidential work, and release it, but the product specification
    did not require the repository-wide before/during/after, schema/Atlas, and
    human-glass evidence used by the app canon. Post-release Atlas/schema truth
    was also a manual follow-up. Ordinary navigation was a handful of
    one-off links rather than a bounded Bob capability.
  - **During:** when the platform owner explicitly asks Bob to fix/self-heal an
    app/code problem and `triage_friction` returns a repair route, the Conductor
    deterministically creates the existing governed Builder job in the same
    turn, preserving the friction packet ID and returning the real job/pinned
    commit receipt. This shortcut cannot be model-spoofed: it requires admiral
    rank, an explicit repair/build request in the human message, and the packet
    emitted by the triage function. Builder specifications now require
    expected-versus-present evidence for before/during/after, schema checks,
    Atlas capability and proven flow checks with FK/weak-reference separation,
    and a role/route/job-specific human acceptance path. Auto-merge now also
    requires the actual isolated worker log to prove the relevant schema/data
    path and targeted Playwright glass check. The release lane refreshes live
    Atlas after every code/schema release and, after migrations, regenerates a
    live-catalog snapshot and blocks completion if it disagrees with committed
    `supabase/schema.sql`.
  - **After:** Bob returns a visible four-stage repair progress card and an
    exact Builder destination. The new inline `navigate_app` capability maps
    ordinary-language destinations to bounded admin routes for rostering,
    people/HR, clients, dispatch, finance, reports, documents, places, settings,
    approvals, and Builder; the destination page remains authoritative for
    role and module access, and business writes still use specific governed
    workflows. “Triage routed,” “Builder created,” “verified,” “merged,”
    “deployed,” “Atlas refreshed,” “schema checked,” and “glass-proven” remain
    separate receipt states.

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
