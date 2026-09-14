> **Canonical copy.** Origin: GitLab `don-squires1/field-compliance-manager` `` @ `Main`, read 2026-09-14 via `scripts/gitlab-read.mjs`. This repository (`DonSquires/Field-Compliance-Manager-` `main`) is the authoritative home from now on; the GitLab text is lineage. Edit here and record the ruling — never fork the text. Links to files that do not exist in this repo refer to that lineage.

# Enterprise Readiness & Competitive Position Review

> Status: REVIEW ARTIFACT (recorded for owner + build agents). Design/review
> only -- no code, schema, or CI changes. Authored by GitLab Duo (chat
> orchestrator), 2026-07-23.
>
> Method + honesty note: the "what this app HAS / LACKS" side is REPO-GROUNDED
> (evidence cited: file paths, migrations, CI config). The "how it compares to
> competitors" side is KNOWLEDGE-BASED (from training, not live-verified -- I
> have no tool to browse competitor products). The two are kept separate on
> purpose so the verifiable half is not diluted by the memory-based half.
> Trust live code over this doc; re-verify before acting.

---

## 1. Executive summary

The Field Compliance Manager is an **architecturally strong, unusually
disciplined** build. Its differentiators (governed AI agent in the loop, a
load-bearing geofence resolution spine, a multi-council jurisdiction/compliance
engine, and a margin-protected three-layer billing model) are genuinely ahead
of the guard-tour / field-service category and, in combination, appear unique.

The exposure is NOT in the clever parts -- it is in the unglamorous
enterprise-hardening layer: automated test coverage of money-critical code,
observability, CI gate reliability, disaster recovery, single-point-of-failure
infrastructure, and enterprise identity/compliance. In blunt terms: **the edge
wins the demo; the hardening wins the contract.** A council or enterprise buyer
will disqualify on missing SSO / SOC2 / DR regardless of how good the agent is.

The good news: none of the gaps are architectural. They are additive hardening,
and -- consistent with the project's foundation-first principle -- several are
prerequisites the next major layer (finance wiring) should sit on top of, not
be retrofitted under.

---

## 2. The unique edge (protect and keep investing)

These four, in combination, are the moat. No single competitor known to this
review does all four:

1. **Governed AI agent in the operational + money path.** propose -> approve ->
   execute with full audit (`bob_agentic_actions`), impact classification, and
   structural governance (sensitive = governed; routine = direct-save + visual
   verify). Incumbents bolt on dumb automation, not a governed reasoning agent.
   Evidence: `docs/SECURITY_APPROVALS_AUDIT.md`, `docs/BOB_AGENTIC_CONTRACT.md`,
   `docs/BOB_DOORBELL_AND_DELEGATION.md`.

2. **Load-bearing geofence resolution spine.** One `resolve_context` funnel
   drives jurisdiction -> rules -> billing -> enforcement, with a first-class
   no-silent-fallback principle (P1) and a mandatory visual verification gate
   (P2). Most guard-tour products treat geofencing as a checkpoint feature;
   here it is the backbone. Evidence: `docs/design/GEOFENCE_SYSTEM_REDESIGN.md`,
   migration 0090 (`resolve_context`), 0280 (verification gate).

3. **Multi-council jurisdiction / compliance engine.** Per-council RMA rules
   (e.g. TDC noise matrix, NCC noise), canonical TA names from live NZTA data,
   council-boundary auto-switching. A real differentiator for the government
   enforcement niche. Evidence: `jurisdiction_rule_sets`, migration 0282
   (canonical_ta_names), `docs/APP_AUDIT_2026-07.md` (noise module).

4. **Margin-protected three-layer billing.** Cost-vs-charge is first-class at
   the line level (`quote_lines.unit_cost` vs `unit_charge`), with target
   margin, platform-fee pass-through treatment, SLA scaled-discount bands, and
   a Wilsar-style bureau rate engine. Closer to a billing platform than a
   guard app; most competitors have weak billing. Evidence: migrations
   0079 (rate_rules), 0253-0257 (three layers), `packages/shared/src/rateEngine.ts`.

**Design judgments worth stating:**
- Treating geofence as load-bearing (not a feature) is the correct, courageous
  call -- but it means geofence correctness = billing correctness = enforcement
  legality. That coupling concentrates risk and RAISES the bar on test coverage
  and operational overrides (sections 4, 5).
- The three billing axes (entitlement = what you bought; capability = who can
  operate; visibility = what the client sees) are correctly ORTHOGONAL. Guard
  that separation -- conflating them is how billing systems become
  unmaintainable.

---

## 3. Gap register (repo-grounded, severity-ranked)

Severity: S1 = blocks enterprise sale / production-safety; S2 = serious;
S3 = important but not blocking.

| # | Gap | Severity | Evidence (what I looked at) |
|---|---|---|---|
| G1 | **Money-critical code is under-tested.** A Vitest suite + pattern EXISTS (`accessAreas.test.ts` and others in `packages/shared/src`), but `rateEngine.ts` -- the highest-consequence file -- has no `rateEngine.test.ts`. Quote/invoice/SLA/pay-policy math largely lives inline in SQL/UI and is not extracted into pure testable functions. | S1 | `packages/shared/src/__tests__/`, `accessAreas.test.ts` (Vitest), `rateEngine.ts` (no test), `0079_rate_engine.sql`, `0255/0256`. |
| G2 | **CI gate parity / integrity.** `validate` runs typecheck + lint only; tests (where they exist) do not appear to gate merge. Two MRs merged with defects that only surfaced on Main (Phase 2 unused-import lint; Phase 3 typecheck). Main can go red post-merge. | S1 | `.gitlab-ci.yml` stages; observed pipelines 5109/5121 vs Main lint failure this session. |
| G3 | **Observability.** No evidence of error tracking (Sentry-class), structured logging, uptime/alerting, or metrics for a 24/7 dispatch system. | S1 | No such config found in repo/CI; `docs/DEPLOYMENT.md`. |
| G4 | **Single point of failure + DR.** Whole stack (apps/api + inference) runs on ONE 2-vCPU Hostinger VPS shared with CI runners; no documented backup/restore/RPO/RTO. | S1 | `.gitlab-ci.yml` OOM/heap-cap comment (2 vCPU, concurrent=3, exit 137 history); no DR doc. |
| G5 | **Enterprise identity.** No evidence of SSO (SAML/OIDC) or SCIM provisioning -- table-stakes for council/enterprise procurement. | S2 | Supabase auth in use; no SSO/SCIM config found. |
| G6 | **Compliance artifacts.** No SOC2/ISO evidence, data-retention policy, or PII-handling doc beyond the (good) NZBN masking design. | S2 | `docs/` scan; NZBN masking in onboarding design only. |
| G7 | **Rate limiting / abuse protection** on public edge functions (e.g. alarm webhook, LINZ proxy). | S2 | `supabase/functions/alarmWebhook.ts`, `linz-lookup`; no rate-limit layer seen. |
| G8 | **Referential integrity of audit claims.** `bob_agentic_actions.result_record_id` can point at a deleted row (the #225 stale-applied artifact). "applied" can lie. | S3 | Issue #225; no FK/integrity job between action rows and their results. |
| G9 | **Doc drift.** `docs/DEPLOYMENT.md` still lists Railway/RunPod/Render (STAGING says decommissioned). Stale canonical docs are an enterprise-readiness smell. | S3 | `docs/DEPLOYMENT.md` vs `docs/STAGING.md` + `.gitlab-ci.yml`. |
| G10 | **Migration ledger is single-lane.** Sequential integer migrations force serialization across concurrent workstreams; 0279/0280 contested (#227), 0281 taken by a fix. Collision risk has already materialized twice. | S2 | Issue #227; migration numbering history this session. |

---

## 4. Deep-dive: G1 (money-code test coverage) -- the #1 gap

This is the highest-consequence gap because the finance-wiring layer is next and
will be built under time pressure. An enterprise finance module that can
SILENTLY MISPRICE is the single biggest liability in the app.

**Correction to an earlier verbal claim:** the project is NOT untested -- it has
a working Vitest suite and a proven co-located `*.test.ts` pattern. The precise
gap is that the MONEY code specifically is not covered, and much money math is
not yet extracted into pure, testable functions (it is embedded in SQL RPCs and
UI components). The fix REUSES the existing pattern; it does not build testing
from scratch.

### 4.1 Required coverage (each item = a concrete test case)

**A. Rate resolution (`resolveRate`, `matches`, `specificity`, `compareBest`)**
- Wildcard (`clientOrgId=null`) = Standard bureau card; matches any requester.
- Specific card (`clientOrgId=NCC`) outranks the wildcard for NCC (bureau override).
- No false match: a rule pinning a dimension the context lacks must NOT match
  (the silent-misprice branch).
- Tie-breaks: equal specificity -> higher priority; equal priority -> most
  recent effectiveFrom.
- Effective-dating: rate change resolves correctly by date, incl. boundary dates
  (on effectiveFrom, on effectiveTo, one day outside each).
- Distance bands: inclusion/exclusion at exact boundary km.
- active=false never matches.
- No match returns null (explicit unrateable; supports the Q6 warn-do-not-block
  ruling), never a silent zero.

**B. Money math (`applyRate`, `round2`, `sumLines`)**
- Each rate_type: flat/higher_duties_flat ignore qty; oncall_flat = amount*blocks;
  percentage = base*fraction; hourly/per_km/per_unit/per_visit/callout = amount*qty.
- Rounding: banker's-safe cents; classic float traps (0.1+0.2, 1.005); sumLines
  has no penny drift across many lines.
- Per-block billing (Q2): ceil(on_site_minutes / billing_increment_minutes),
  org-configurable increment (default 30): 1->1, 30->1, 31->2, 60->2.

**C. Pay side (`resolvePayLines`) + pay policy**
- One shift yields the SET (base + allowance + EMS + on-call + travel): best
  rule per payCode.
- pay_policy (max_of_both / fixed_rate / site_rate): correct choice when
  contracted vs site rate differ. (May not be wired yet -- the test reveals it.)
- overtime_multiplier / double_multiplier at the right hour thresholds.

**D. Cost-vs-charge / margin (quote + invoice math)**
- Per-line unit_cost vs unit_charge -> margin; a charge below cost is FLAGGED,
  never shipped silently.
- target_margin_pct + discount_pct + gst_rate -> totals reconcile exactly;
  order of operations (discount vs GST) pinned and tested.
- platform_fee_treatment (passthrough / passthrough_marked_up / absorb): each
  produces the correct client total; fee never double-counted.

**E. SLA scaled-band billing**
- Ordered over-SLA bands: on-time = full; each band applies its discount;
  100% band = non-billable (charge -> 0); attendance exactly on the SLA
  boundary; late-but-attended vs never-attended.

**F. Invariants (property-style)**
- No silent misprice: unresolved context -> null (unrateable), never $0-as-valid.
- Determinism: same inputs -> same output (money must be reproducible for audit).
- AI-not-last-actor: a Bob-proposed rate cannot become a final charge without
  the resolver + a human/rule gate.

### 4.2 Two tiers

- **Tier 1 (now, pure, high-ROI):** `rateEngine.test.ts` -- sections A, B, C12.
  Trivial against the existing Vitest pattern; gates nothing external.
- **Tier 2 (as finance wires up):** quote/invoice/SLA/pay-policy math. Requires
  first EXTRACTING that math out of SQL/UI into pure functions in
  `packages/shared` so it is testable. That extraction is itself a
  recommendation: money math should not be born inside RPCs/components.

### 4.3 CI gate

Add `vitest run` to the `validate` stage so tests actually BLOCK merge. Tests
that exist but do not gate are theatre (this also addresses G2).

---

## 5. Deep-dive: operational overrides on load-bearing gates (from G3/P1)

P1 (no silent fallback; unset/unverified is loud and blocks) is correct for
correctness. But in a 24/7 dispatch operation, "block the officer because the
geofence is unverified" cannot gate SAFETY OF LIFE. The security doc already
names an `emergency: supervisor-authorized override with audit timeline` level
-- that principle must be explicitly WIRED for the geofence/verification gates:
supervisor break-glass -> proceed now -> flagged for reconciliation, fully
audited. Design it deliberately; do not discover it in a 2am incident.

---

## 6. Competitive position (KNOWLEDGE-BASED -- not live-verified)

> Caveat: from training knowledge of the category, not a current, cited audit
> of competitor products. Directionally reliable; not a procurement-grade
> benchmark. Confidence: medium.

Category comparators: guard-tour / security-ops (TrackTik, Trackforce Valiant,
Silvertrac, GuardMetrics); field-service management (ServiceTitan, Jobber --
referenced in the codebase itself); dispatch/CAD; multi-tenant B2B billing
(Stripe Billing / Chargebee patterns).

**Where this app appears AHEAD / unusual:**
- Governed AI agent in the loop -- not seen in the incumbents.
- Unified load-bearing geofence spine -- more integrated than checkpoint-style
  guard-tour geofencing.
- Multi-council jurisdiction/compliance engine -- strong fit for govt enforcement.
- Margin-first, cost-vs-charge billing with SLA scaling -- billing depth beyond
  typical guard apps.

**Where incumbents are typically AHEAD (== this app's gap list):**
- SSO/SCIM, SOC2/ISO, mature native mobile, observability/alerting, DR/scale
  infrastructure, marketplace integrations.

**Strategic read:** the uniqueness is real and defensible; "cutting-edge and
unique" becomes "enterprise-grade" only once the section 3 hardening is in place.
Two parallel tracks: (a) protect/sharpen the edge; (b) close the hardening gaps.

---

## 7. Recommended sequence (foundation-first)

Ordered so hardening that the next layer depends on comes first, and nothing
blocks the feature roadmap unnecessarily.

1. **G1 Tier-1 + G2:** write `rateEngine.test.ts` (reuse the Vitest pattern) and
   add `vitest run` to `validate` so money logic gates merge. Foundation for the
   finance-wiring layer. Small, self-contained, high assurance.
2. **Geofence live-verify (owner):** #225 fresh-run + TA-gate activation --
   billing zone-tier pricing rides on `resolve_context`; confirm the spine
   before layering finance on it.
3. **Break-glass override design (section 5):** wire the emergency override for
   the load-bearing gates before real 24/7 operational load.
4. **Finance-wiring layer, foundation-up:** populate `dispatch_jobs.service_agreement_id`
   (requester -> agreement) -> rate wiring (resolveRate at dispatch) -> SLA
   scaling -> invoice generation -> Layer-2 on-charge. Extract each piece of
   money math into pure, tested functions (G1 Tier-2) as it is wired.
5. **W0 (own-rooted org operability):** prerequisite audit before the onboarding
   wizards ship (access layer was built on the old tree model).
6. **Enterprise hardening track (parallel, not blocking features):** G3
   observability -> G4 DR + remove single-VPS SPOF -> G7 edge rate-limiting ->
   G5 SSO/SCIM -> G6 compliance artifacts.
7. **Housekeeping:** G9 refresh `DEPLOYMENT.md`; G10 adopt a collision-safe
   migration-numbering convention (timestamp or reserved ranges) per #227; G8
   integrity job so `applied` audit rows cannot reference deleted results.

---

## 8. Open decisions for owner (small, gap-fill -- likely answerable from old-app behaviour)

1. **Billing bureau tables vs rate_rules:** `rate_rules` already implements the
   bureau concept (wildcard = Standard, pinned client_org = override, all
   dimensions present). Is a separate `billing_bureaus`/`bureau_charge_rates`
   table set needed, or is the bureau a naming/grouping VIEW over rate_rules
   plus a zone_tier dimension? (Lean: extend rate_rules; decide from how the
   old app / Wilsar structured it.)
2. **Static guard hours:** contracted vs actual on-site time -- higher-of /
   actual / per-bureau config? (audit open Q1)
3. **Patrol evidence threshold:** "check happened" = GPS/checkpoint scan or
   stop-marked-complete? (audit open Q2)
4. **Invoice cadence:** monthly per client/site aggregating all line-types over
   `invoices.service_period_*`? (audit open Q3; assumed yes)
5. **Migration numbering convention** (G10): timestamp vs reserved ranges.

---

## 9. What is explicitly NOT claimed here

- The competitor comparison (section 6) is not live-verified.
- Absence of evidence for a control (SSO, observability, DR) means it was not
  found in the repo/CI/docs during this review -- confirm before treating as
  definitively absent (it could exist outside the repo, e.g. Supabase dashboard
  config or Hostinger backups).
- This review measures readiness and position; it does not itself change any
  behaviour. It is a recorded reference for owner decisions and build sequencing.
