# Rebuild Plan — bringing the build to the canon

Status: active. Owner: Don Squires. Order of authority: `docs/canon/README.md`.
This replaces the scattered per-topic TODOs as the top-level sequence; the
detailed backlogs (`ENTERPRISE_SAAS_TODO.md`, `PROTOTYPE_GAP_AUDIT.md`,
`MODULE_BASELINE_REQUIREMENTS.md`) hang off the workstreams below.

Completion language is strict, as in the lineage: **merged ≠ deployed ≠
glass-proven.** A workstream item is done only when its evidence gate is met.

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
  migrations, CSS contracts clean. Atlas dry-run on the truthful schema: 1,046
  capabilities / 3,814 edges (was 849 / 2,991). **Gate:** run
  `node scripts/atlas-refresh.js --apply` through the governed refresh path so
  Atlas reflects the truthful schema, then re-baseline the gap report.

## 2. Accountability and access conformance (FOUNDATION → ACCESS_MODEL)

The keystone is done: `observations` carries the composed SELECT
(`observations_task_entitlement_select` → `user_has_task_entitlement`). The rest
of Bucket B in `docs/canon/ALIGNMENT_LEDGER.md` still gates on
`org_access_allowed(organization_id)` alone.

1. Recover the 13-scenario RLS oracle from the lineage
   (`supabase/tests/0325_observations_keystone_rls.sql`) and run it here against a
   disposable Postgres (the `backend-verify` worker already boots the pinned image).
2. W1 access-side additive SELECTs, in timeline-of-harm order: `noise_assessments`
   (anchor = harmed party `complainant_site_id`, per the 2026-08-17 ruling) →
   `smoke_assessments` → `biosecurity_assessments` (anchor = `protected_land_site_id`)
   → `noise_seizures` → `parking_sessions` / `vehicle_observations` (needs the
   interrupt-tier ruling: anchor = zone) → `incidents`, `notices`, `breach_records`
   (need edge rulings 1 and 2).
3. W2 record-side: make the harmed-party columns live — the governed submit
   functions populate them and the review surfaces read them.
4. Access-basis UX: one shared "why can I see this?" chip + drawer rendering the
   §8 return shape (`resolve_access_basis` is live), applied across observations,
   dispatch, incidents, reports.
5. Model A W0 audit: prove own-rooted orgs (10 of 55 today) are fully operable —
   `get_descendant_organizations`, branch login, `create_client_org`, wizards W1/W2.

**Gate:** oracle green both directions (no leak, no lockout) per table; a
cross-tenant negative test per new policy; completion recorded as
"operationally corrected / doctrinally incomplete" until both W1 and W2 land.

## 3. Place convergence (LOCATION_HOUSE_MODEL, GEOFENCE_PRINCIPLES)

1. Every site/zone create path resolves-or-creates the house first; port
   `resolveOrCreateHouse` with its ownership-jump guard and tests from
   `docs/canon/reference/recovered/`.
2. Back-fill houses for the 69 sites and 1 zone without `location_id`
   (data migration with provenance, reviewed).
3. Canonical site-entry pipeline (Q10): inventory every address entry point in
   `apps/web` and route all of them through LINZ autocomplete → dedup → create.
   Dispatch included.
4. `resolution_status` audit: `process-officer-scan`, dispatch intake and the
   billing zone-tier must branch on the five outcomes; no boolean fallbacks.
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

1. Root-cause the planner's empty-reply turns (`callPlan` → VPS `/api/bob/plan`)
   using `bob_event_log`; the fallback text fix shipped 2026-09-14 is a stopgap.
2. Populate `bob_capability_map.exercised` from real invocation evidence
   (edge-function logs, `bob_event_log`, RPC stats); today it is 0 everywhere.
3. Owner rulings: governance lock vs LOW-tier `auto_in_context`; Tier-3 HSWA
   egress path end-to-end; re-prove the master rank gate.
4. Cockpit primitives: who-is-flying indicator, takeback, result-in-habitat.
5. Re-create the RunPod QA endpoint and run `full-page-audit` on Bob's
   infrastructure.

**Gate:** live `bob_messages` show no context-losing fallbacks; Atlas `exercised`
is populated from evidence, not asserted.

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
