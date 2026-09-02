# Enterprise SaaS TODO

Status: active planning backlog
Owner: human product owner with Bob as the planning and evidence copilot

## Operating Rules

- Bob proposes work, collects evidence, and creates reviewable artifacts. A human approves consequential changes before execution.
- Before a shared schema, workflow, or component change: query Bob Atlas capability map, terrain edges, and blast radius; then verify the live schema and actual callers.
- `wired` is not proof that a feature has run. Keep proven flow reach separate from FK reach.
- Every workflow must preserve organization scope, RLS, immutable audit evidence, loading/error/empty states, and accessible desktop/mobile behavior.
- Do not connect UI to a capability that is only present in Atlas. Verify a real schema writer and an executable code path first.

## Track 1: Bob Control Plane

Goal: make Bob a governed enterprise copilot that can assess, propose, and prepare work without unapproved repository, infrastructure, or production changes.

### Foundation

- [ ] Define repository allowlist and action policy: repository, immutable ref, requested action, target environment, and caller identity must be explicit.
- [ ] Replace any shared administrative token path with authenticated Supabase user identity for human requests and narrowly scoped, short-lived worker credentials.
- [ ] Persist jobs, approvals, artifacts, leases, and audit events in Supabase; retain local JSON only as a development fallback.
- [ ] Enforce the job state machine: `requested -> queued -> leased -> running -> verifying -> completed|approval_required|failed|cancelled|rejected`.
- [ ] Persist immutable state-transition events with actor, job, repository, commit SHA, action, result, and timestamp.

### Safe Worker Execution

- [x] Launch each worker in a disposable non-root workspace with CPU, memory, wall-clock, and disk limits. `worker-executor.js` enforces read-only source mounts, bounded tmpfs work areas, CPU/memory/PID limits, and a fixed worker profile command.
- [x] Apply a command allowlist, network policy, secret-redaction layer, and automatic cleanup. The worker has no network, no Docker socket, dropped capabilities, `no-new-privileges`, redacted output, and handoff cleanup in `finally` blocks.
- [ ] Bind idempotency keys to job step, tool/action, immutable input reference, and worker attempt so retries cannot duplicate effects.
- [ ] Add verification adapters for focused tests, type checks, lint, dependency audit, secret scanning, and frontend build checks.
- [ ] Store logs and artifacts with checksums, retention policy, provenance, and job-scoped access control.

### Human Approval and First Vertical Slice

- [x] Expose existing `builder_approvals` request/response decisions in the authenticated Builder Control Room, with tenant-scoped approval lookup, caller-JWT decision RPCs, required human rationale, and refreshed canonical job state.
- [x] Add immutable seven-day approval expiry and fail-closed decision checks. Expired gates stay visible for audit but require a new evidence review before any decision.
- [ ] Add approval reminder, reassignment, and explicit cancellation policy to the existing immutable approval audit flow.
- [ ] Require approval before schema, auth/RLS, dependency, infrastructure, protected-branch, deployment, or destructive work.
- [x] Add model adapters with model identity, prompt version, sanitized input/output artifact references, timeout behavior, and usage evidence. Restricted and low-risk workloads route locally; model runs are idempotent by job, step, and request hash; artifacts are checksum-verified before registration.
- [ ] Implement Product Analyst and QA/Security Reviewer modes before any autonomous coding/deployment mode.
- [ ] Run one read-only assessment job against an allowlisted test repository: inventory -> product-analysis artifact -> human review -> `approval_required`.
- [ ] Run one approved isolated implementation job that stops at `release_ready`; deployment remains separately approved.

### Evidence Gate

- [ ] Bob Atlas: verify the `wf-*` functions and builder entities have proven live callers after integration.
- [ ] Security review: prove unauthorized callers cannot create jobs, retrieve artifacts, lease work, approve changes, or run arbitrary commands.
- [ ] Acceptance: a human can inspect the complete evidence chain from request through approval-required, without Bob making an unapproved change.

## Track 2: Operational Finance and Workforce Pay

Goal: ensure completed field work can produce accurate, auditable billing and workforce pay outcomes using governed rate rules.

### Resolve the Current Evidence Gap First

- [ ] Locate or recover the code referenced by Atlas for `rateEngine.ts`, `invoicePipeline.ts`, `resolvePayLines()`, and `computeTravelDistanceKm()`.
- [ ] Rebuild the Atlas capability map only after source recovery; do not treat stale feature metadata as an executable implementation.
- [ ] Confirm the authoritative completion event for dispatch work and the exact status transition that makes an outcome financially eligible.
- [ ] Query terrain edges and blast radius for `dispatch_jobs`, `dispatch_job_pay_lines`, `rate_rules`, invoice entities, timesheets, and payroll exports.
- [ ] Verify the schema contracts and RLS for `dispatch_job_pay_lines`, including idempotency indexes, officer ownership, organization scope, and correction/reversal rules.

### Governed Pay-Line Pipeline

- [ ] Define a server-side completion pipeline that resolves billing and pay separately from the same immutable work evidence.
- [ ] Calculate travel distance from verified operational coordinates only; record source points, method, timestamp, and unavailable/low-confidence cases.
- [ ] Resolve pay rules using effective dates, organization, service type, site/zone, worker, and role context.
- [ ] Write idempotent `dispatch_job_pay_lines` records keyed by organization, completed dispatch job, and pay code.
- [ ] Preserve rule ID/version, rate inputs, rate result, tax/allowance treatment, distance, and source event in each line's provenance.
- [ ] Handle no-rule, ambiguous-rule, missing-evidence, and reprocessing cases explicitly. Never silently produce a zero pay line.

### Approval, Corrections, and Exports

- [ ] Require a human approval or policy-backed review boundary before payroll export or irreversible financial posting.
- [ ] Implement adjustment, reversal, and supersession records rather than destructive updates to accepted pay lines.
- [ ] Surface a finance review queue with reasons for blocked or exceptional calculations.
- [ ] Reconcile pay-line totals with dispatch completion, invoices, timesheets, and payroll export batches.
- [ ] Add organization-scoped reporting for outstanding, approved, exported, rejected, and corrected lines.

### Evidence Gate

- [ ] Tests: duplicate completion events are idempotent; different organizations cannot read/write each other's lines; no-rule and distance-unavailable outcomes are visible; correction history is immutable.
- [ ] Atlas: verify real flow edges from completion event to pay lines, finance review, export, and audit log.
- [ ] Acceptance: a finance operator can explain every pay amount from the underlying completed field evidence and the effective rule that produced it.

## Track 3: Enterprise UX, Security, and Operational Governance

Goal: make every operational surface truthful, tenant-safe, accessible, and consistent under normal, unavailable, and high-risk conditions.

### Tenant and Access Boundaries

- [ ] Audit every page, deep link, mobile shortcut, notification route, and search result for role, organization, and module entitlement enforcement.
- [ ] Use `useEnabledModules`, `getModuleAccessMessage`, and `SafetyGate` for safety-sensitive data, subscriptions, controls, and direct entry points.
- [ ] Keep welfare safety states fail-closed until entitlement is positively confirmed; distinguish loading, unavailable, disabled, and enabled states.
- [ ] Confirm all tenant-scoped queries use the correct organization or contracted-service boundary and have a cross-tenant negative test.
- [ ] Ensure consequential writes use governed RPCs with expected-state concurrency checks and audit records.

### Truthful Operational States

- [ ] For every metric, queue, chart, table, upload, and action define loading, empty, unavailable, stale, retry, and success behavior.
- [ ] Preserve last successful values with freshness labels when appropriate; never coerce query failures into zeroes or healthy status.
- [ ] Replace static operational telemetry with live evidence, configured value, or explicitly unavailable status.
- [ ] Keep GPS recency, safety state, schedule health, and SLA status as distinct signals; do not use one as a proxy for another.
- [ ] Maintain separate supervisor acknowledgement and verified resolution lifecycle evidence for welfare alerts.

### Usability and Accessibility

- [ ] Audit desktop and mobile navigation for keyboard operation, focus visibility, current-page semantics, stateful control names, and no dead-end error states.
- [ ] Provide accessible nonvisual equivalents for charts, maps, severity color, and time-sensitive status indicators.
- [ ] Remove stale or misleading counts, placeholder claims, and UI controls whose query cannot support their displayed value.
- [ ] Keep form validation, optimistic updates, errors, retry paths, and disabled states consistent across all write workflows.
- [ ] Verify responsive layout and text overflow at narrow mobile and wide desktop viewports.

### Evidence Gate

- [ ] Add focused behavior and guard tests for each corrected operational claim, role boundary, and governed write path.
- [ ] Run the calibrated test command for narrow suites: `npx vitest run <files> --pool=threads --maxWorkers=1 --reporter=dot` from `apps/web`.
- [ ] Capture desktop and mobile evidence for user-facing workflow changes before release approval.
- [ ] Refresh Atlas after verified wiring changes; never manually claim a live edge that has not been exercised.

## Suggested Sequence

1. Complete Track 3's tenant, safety, and truthfulness controls across existing live pages.
2. Deliver Track 1's read-only Bob assessment and approval-required vertical slice.
3. Recover the missing Track 2 source evidence, then build the governed finance pipeline behind an approved design.

This order improves current operational trust first, gives Bob a safe way to help plan and review future work second, and prevents finance implementation from depending on stale or absent source code.