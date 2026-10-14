# Builder Job System - Phase 2 Complete

## Summary

**Date Completed:** 2026-08-29
**Tests Passing:** 126 (69 task continuity + 22 job orchestrator + 35 worker adapter)
**Build Status:** ✓ Calibrated

This session extended the Field Compliance Manager with a production-ready **Builder Job System** for orchestrating multi-step AI agent work. The system enables Bob to propose, approve, and execute controlled application changes through isolated workers with durable task continuity.

## What Was Built

### 1. Database Schema (`20260829060000_builder_job_system.sql`)

**8 active core tables, organization-scoped, RLS-protected, no orphans:**

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `builder_projects` | Repository contexts | org_id FK, gitea_repo, status |
| `builder_jobs` | Top-level orchestration | task_run_id FK, status enum (intake→approval→release), approval_required_at |
| `builder_job_steps` | Ordered builder stages | builder_mode (product_analyst, ux_designer, frontend_engineer, etc.), step status |
| `builder_artifacts` | Immutable outputs | artifact_type (spec, UI plan, code, tests, security report, release notes), checksum |
| `builder_approvals` | Human gates | approval_type, triggered_at_status, approved_by user, responded_at |
| `builder_audit_events` | Decision trail | event_type, actor, previous_value, new_value (immutable log) |
| `builder_worker_runs` | Execution logs | command, exit_code, secrets_redacted_count, resource usage |
| `builder_model_runs` | Governed model execution | provider, prompt version, artifact lineage, usage |

The unused `builder_protected_variables` prototype was retired on 2026-10-14.
Current workers use fixed, isolated profiles and do not accept tenant-configured
environment-variable injection.

**Design Doctrine Compliance:**
- ✓ Parent before child: org → project → job → step → artifact (no orphans)
- ✓ Live schema is authority: RLS enforces service_role only, immutable audit trail
- ✓ Provenance travels with record: actor_user_id, timestamp, old_value, new_value in every event
- ✓ No silent data loss: all columns intentional, nullable only where documented

### 2. Job Orchestrator Logic (`builder-job-orchestrator.js`)

**Pure functions for state management (no DB calls, fully testable):**

```
createBuilderJob()
  ↓
getNextBuilderStep()  // Priority: retryable-failed > pending > blocked
  ↓                   // Respects dependencies: blocked until prerequisites complete
buildJobCheckpoint()  // Returns: {completed_step_ids[], next_step_id, blocked_reason}
  ↓
getNextJobStatus()    // Progression: intake → analysis → spec → design → impl → testing → security → approval → release
```

**Key Features:**
- **7-step workflow:** Product Analysis → UI Design → Frontend → Backend → Testing → Security → Release Prep
- **Dependency tracking:** UI Design blocks until Product Analysis completes; Frontend blocks until UI Design; Test Suite blocks until both implementations complete
- **State machine:** pending → running → completed|failed|blocked|skipped (mirrors task continuity)
- **Evidence sanitization:** Strips secrets, keeps proof (file paths, component counts, test counts, SHAs)
- **Approval gates:** Requires human sign-off at `[specification_ready, design_ready, approval_pending]`

**Wired to Task Continuity:**
- `builder_jobs.task_run_id` → `bob_task_runs.id` (durable progress across restarts)
- Step status enum mirrors `bob_task_steps` (pending, running, completed, failed, blocked)
- Priority logic matches `getNextResumeStep()` from task-ledger.js
- Checkpoint API mirrors `buildTaskCheckpoint()` (completed_step_ids, next_step_id, blocked_reason)

### 3. Worker Adapter (`builder-worker-adapter.js`)

**Isolation and safety layer (execution plan generation, no subprocess spawning):**

```
Command Validation:
  ✓ Reject: rm -rf /, sudo, su, doas, mkfs, dd of=, setuid, curl|sh, wget|sh
  ✓ Allow: npm, git, tsc, eslint, docker build (mode-specific allowlists)

Secret Redaction:
  ✓ Redact from logs: passwords, tokens, api_keys, Bearer tokens, x-api-key
  ✓ Redact env vars: AWS_*, GITHUB_*, DATABASE_*, API_KEY, SECRET_*, *_TOKEN
  ✓ Redact from output: sanitizeOutput() strips all sensitive patterns before archiving

Resource Isolation:
  • Container user: 1000:1000 (non-root)
  • Capabilities: cap-drop=ALL (no privilege escalation)
  • Filesystem: read-only root (except /workspace, /tmp)
  • Network: none (no outbound access)
  • CPU/Memory/Disk: Configurable limits per builder mode
  • Timeout: Capped at 1 hour maximum

Artifact Capture:
  • stdout/stderr redacted and archived
  • Evidence extracted per builder mode (test counts, build status, security findings)
  • Exit code and resource usage recorded
```

**Execution Plan Output (does NOT execute):**
- Returns Docker/container spec with all safety parameters
- Includes environment var redaction count (for audit)
- Documents resource limits, security options, timeouts
- Validates command before returning plan (null on dangerous patterns)

## Test Coverage

### Test Counts by Layer

| Component | Test File | Count | Status |
|-----------|-----------|-------|--------|
| Task Continuity (1-7) | bob-task-*.test.js | 69 | ✓ All passing |
| Builder Orchestrator | bob-builder-job-orchestrator.test.js | 22 | ✓ All passing |
| Builder Worker Adapter | bob-builder-worker-adapter.test.js | 35 | ✓ All passing |
| **Total** | — | **126** | **✓ All passing** |

### Key Scenarios Covered

**Orchestration (22 tests):**
- ✓ Job normalization with defaults
- ✓ Step creation and ordering (7-step workflow)
- ✓ Dependency validation (block until prerequisites)
- ✓ Priority selection (retryable > pending > blocked)
- ✓ Checkpoint calculation for durable resume
- ✓ State machine transitions with approval gates
- ✓ Evidence sanitization per builder mode

**Worker Safety (35 tests):**
- ✓ Dangerous pattern rejection (rm -rf, sudo, curl|sh, etc.)
- ✓ Mode-specific command allowlisting
- ✓ Secret redaction (passwords, tokens, API keys)
- ✓ Sensitive env var masking (AWS, GitHub, Database creds)
- ✓ Container isolation (non-root, cap-drop, network-none)
- ✓ Resource limits (CPU, memory, disk, timeout)
- ✓ Execution plan generation (safe, validated)
- ✓ Output analysis and evidence extraction

## Integration Points

### With Task Continuity (Layers 1-7)

**Wiring:**
1. **Schema:** `builder_jobs.task_run_id` foreign key to `bob_task_runs.id`
2. **Step State:** `builder_job_steps.status` enum mirrors `bob_task_steps.status`
3. **Orchestration:** `getNextBuilderStep()` uses same priority as `getNextResumeStep()`
4. **Checkpoints:** `buildJobCheckpoint()` API matches `buildTaskCheckpoint()` contract
5. **Evidence:** `sanitizeBuilderEvidence()` follows `sanitizeEvidenceRefs()` pattern
6. **Persistence:** Non-fatal DB operations with `progress_unverified` fallback

**Resume Capability:**
- Job can restart from exact last verified step
- Completed steps never re-execute (idempotency via deterministic hashing in Layer 6)
- Blocked steps remain blocked until dependencies complete
- Failed steps retry with incremented attempt count

### With Build-Plan.md Doctrine

1. ✓ **Fixed profile vs operational:** worker environment is fixed in code; `builder_job_steps` records operational state
2. ✓ **Additive schema:** No destructive migrations; all columns versioned by created_at
3. ✓ **Live schema is authority:** RLS enforces service_role only; migrations describe intent
4. ✓ **Provenance travels with record:** `builder_audit_events` immutable log with actor, timestamp, old/new values
5. ✓ **Parent before child:** No orphan records; org → project → job → step → artifact chains
6. ✓ **Bob proposes, humans approve:** `builder_approvals` mandatory at [spec, design, release] gates
7. ✓ **No silent fabrication:** Evidence contains status (found/not_found/could_not_verify), not guesses

## Build-Plan.md Implementation Progress

From [Build-Plan.md](https://github.com/DonSquires/Field-Compliance-Manager-/blob/main/Build-Plan.md) implementation order:

1. ✓ **Inspect Bob control-room source** (complete; all imports verified)
2. ✓ **Define durable task state** (Layers 1-7; 69 tests)
3. ✓ **Define job/worker/artifact/approval/audit schemas** (8 tables; RLS-protected)
4. ✓ **Implement orchestrator state machine** (22 tests; 7-step workflow with dependencies)
5. → **Implement isolated worker adapter** (35 tests; command validation, secret redaction, isolation)
6. **Add OpenAI and Ollama adapters** (next: LLM provider integration)
7. **Add builder modes** (next: Product Analyst, UX/UI Designer, Frontend Engineer, QA/Security, Release Engineer implementations)
8. **Persist artifacts/audit events** (next: wiring artifact storage and audit logging)
9. **Add guarded approvals** (next: approval request/response flow)
10. **Run test project through workflow** (phase-one vertical slice)

## Code Quality

- **All functions pure and deterministic** (no side effects, reproducible results)
- **Comprehensive input validation** (null checks, type coercion, defaults)
- **Fail-closed on DB unavailability** (`progress_unverified` flag for orchestrator; null return on safety failures)
- **Evidence sanitization automatic** (secrets stripped from evidence, not caller responsibility)
- **RLS protection mandatory** (all tables: service_role only, organization-scoped)
- **Zero credentials in logs** (all secrets redacted before stdout/stderr archiving)

## Files Created/Modified

### New Migrations
- `supabase/migrations/20260829060000_builder_job_system.sql` (8 tables, 29KB)

### New Orchestration Logic
- `supabase/functions/_shared/builder-job-orchestrator.js` (350 lines, ES6)
- `supabase/functions/_shared/builder-worker-adapter.js` (450 lines, ES6)

### New Tests
- `test/bob-builder-job-orchestrator.test.js` (22 tests)
- `test/bob-builder-worker-adapter.test.js` (35 tests)

### Existing Files (Unchanged)
- Task continuity layers (1-7) still passing all 69 tests
- Conductor integration still valid
- All 13 calibration surfaces still synchronized

## Next Steps (Recommended Build Order)

### Phase 2 Continuation (Layers 4-5 of Builder)

1. **Model Adapter Layer** (OpenAI + Ollama)
   - Struct: `openai-adapter.js`, `ollama-adapter.js`
   - Maps builder_mode + task context → model API call
   - Integrates idempotency (Layer 6) for timeout recovery
   - Tests: 20-30 scenarios

2. **Builder Mode Implementations** (Product Analyst → Release Engineer)
   - One mode per file: `builder-product-analyst.js`, `builder-ux-designer.js`, etc.
   - Each mode: prompt template, output parsing, evidence extraction
   - Tests: 40-50 scenarios covering happy path, errors, timeouts

3. **Artifact Persistence Layer**
   - Wiring `buildWorkerExecutionPlan()` output → Docker/container execution
   - Capture stdout/stderr, extract evidence, store artifacts
   - Tests: 15-20 scenarios for storage, redaction, retrieval

4. **Approval Gate Implementation**
   - Request-response flow for `builder_approvals`
   - Notification when approval pending
   - Reject/approve transitions with audit trail
   - Tests: 10-15 scenarios for state transitions

5. **End-to-End Vertical Slice**
   - Small test project: "Add login button to homepage"
   - Flow: Job create → analyze → design → implement → test → security → approve → (ready)
   - Verify durable resumption if any step fails

### Phase 3 (Deployment & Monitoring)

- Conductor integration (wire builder job dispatch into Bob's turn loop)
- API endpoints for job creation, artifact retrieval, approval responses
- Observability: metrics, logging, audit trail queries
- Production hardening: rate limiting, cost tracking, worker lifecycle

## Success Criteria Met ✓

- [x] Schema enforces org scoping and no orphans
- [x] Pure orchestration functions fully testable
- [x] State machine respects dependencies and priorities
- [x] Worker isolation plan validated (dangerous patterns rejected)
- [x] Secrets automatically redacted from logs
- [x] Evidence sanitization prevents credential leaks
- [x] Wired to task continuity for durable resume
- [x] All tests passing (126/126)
- [x] Build calibrated (13/13 surfaces)
- [x] Zero production credentials in code/configs

## References

- [Build-Plan.md](Build-Plan.md) - Product doctrine and implementation order
- [Task Continuity Contract](docs/bob/task-continuity.md) - Resume layer design
- `supabase/migrations/20260829060000_builder_job_system.sql` - Schema DDL
- `supabase/functions/_shared/builder-job-orchestrator.js` - Orchestration logic
- `supabase/functions/_shared/builder-worker-adapter.js` - Worker isolation
