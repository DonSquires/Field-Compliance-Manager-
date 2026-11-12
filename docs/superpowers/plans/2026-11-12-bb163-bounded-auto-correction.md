# BB-163 Bounded Auto-Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let BB-163 make at most three same-job correction-and-verification rounds, then park it for Don without bypassing existing review gates.

**Architecture:** The control plane will discover only the blocked BB-163 acceptance-gap job and ask a service-only database RPC to atomically either reopen the correction workflow or park it after three rounds. The durable round count and history live in `autopilot_report` and audit events, survive ordinary report updates, and do not reset step attempt counts.

**Tech Stack:** Node.js, `node:test`, Supabase/PostgreSQL migrations, Bob control-plane autopilot.

**Spec:** `docs/superpowers/specs/2026-11-12-bb163-bounded-auto-correction-design.md`

## Global Constraints

- Apply the exception only to BB-163; other jobs retain the existing owner-confirmation rule.
- Count a round only for a correction cycle responding to a recorded acceptance or review blocker, followed by worker verification and applicable acceptance checks.
- Persist correction count and history; scheduler or process restarts must not reset the limit.
- Preserve existing step attempt counts; do not create continuation jobs or bypass security, evidence, approval, independent-review, or release gates.
- Park after three unsuccessful correction rounds with the blocker, history, and verification evidence for Don.
- Regenerate `supabase/schema.sql` from the live catalog after migration application; never hand-edit the snapshot.

## Review Focus

- **A different job, source, or duplicate BB-163 reference:** it must not receive this exception. Test that the RPC rejects mismatched jobs and refuses ambiguous matches.
- **A non-acceptance failure on BB-163:** it must not be treated as permission to correct. Test that the RPC requires the recorded whole-job acceptance blocker and an idle, unpublished job.
- **Repeated scheduler calls or a process restart:** they must not spend multiple rounds for one transition or reset the durable count. Test the atomic update, report preservation, and duplicate call behavior.
- **Correction rounds one through three:** the same job must reopen the necessary implementation and verification steps without resetting attempt counts. Test the reopened step set and preserved counts.
- **The third correction still fails, or an earlier correction passes:** the former must park with no fourth correction; the latter must continue only through the existing gates. Test both outcomes.

---

### Task 1: Add a service-only, atomic BB-163 correction transition

**Files:**
- Create: `supabase/migrations/<timestamp>_builder_bb163_bounded_auto_correction.sql`
- Modify: `docs/canon/BOB_DOCTRINE.md`
- Create: `test/builder-bb163-bounded-auto-correction-migration.test.js`

**Interfaces:**
- Produces `builder_autopilot_begin_bb163_correction(_job_id uuid, _blockers text) RETURNS jsonb`, executable only by `service_role`.
- Return `{"outcome":"correcting","round":N}` for rounds 1–3 and `{"outcome":"parked","round":3}` once three rounds have already been attempted.
- On a correction, reopen the same job's implementation and downstream verification steps, preserve all `attempt_count` values, supersede prior final evidence that the new patch must replace, and write an audit event.
- On parking, keep the job unpublished and write the final blocker/history into the autopilot report and audit event.
- Require the exact BB-163 routine-monitor job, a recorded whole-job acceptance blocker, completed/idle prerequisites, and no active worker or model runs. Reject ambiguous matching jobs and all other cases.
- Preserve `bb163_auto_correction_rounds` and its history when `builder_autopilot_record` replaces ordinary autopilot reports.

- [ ] **Step 1: Write failing migration tests**

  Assert service-role-only execution; refusal of non-BB-163, non-routine, ambiguous, non-acceptance, active, or published jobs; same-job reopening for rounds 1–3; unchanged step attempts; durable reports and audit events; and parking without a fourth correction.

- [ ] **Step 2: Run the targeted tests and confirm they fail**

  Run: `node --test test/builder-bb163-bounded-auto-correction-migration.test.js`

  Expected: FAIL because the migration/RPC and policy exception do not exist.

- [ ] **Step 3: Implement the migration and record the dated narrow ruling**

  Add the service-only RPC and required constraints/updates. Add a dated ruling to `docs/canon/BOB_DOCTRINE.md` that permits this bounded exception for BB-163 only and leaves all other correction and review rules unchanged.

- [ ] **Step 4: Run the migration tests**

  Run: `node --test test/builder-bb163-bounded-auto-correction-migration.test.js`

  Expected: PASS, including PostgreSQL-backed checks when `BOB_TEST_POSTGRES=1` is available.

- [ ] **Step 5: Commit the independently testable database and canon change**

  Commit the migration, its tests, and the doctrine ruling together.

### Task 2: Route BB-163 acceptance failures through the bounded correction flow

**Files:**
- Modify: `builder-autopilot.js`
- Modify: `bob-control-plane-server.js`
- Modify: `test/builder-autopilot.test.js`
- Modify: `test/bob-builder-runtime-coordinator.test.js` only if the acceptance gate requires a runtime-contract assertion

**Interfaces:**
- The job loader adds `human_reference` and loads a blocked BB-163 job only when it is a routine-monitor job with an unparked acceptance-incomplete report.
- `actions.beginBb163Correction(job, blockers)` invokes `builder_autopilot_begin_bb163_correction` and returns the RPC outcome.
- On `acceptance_incomplete`, autopilot calls that action only for BB-163. `correcting` returns a bounded outcome and lets the reopened same job run on the next tick; `parked` records an owner-facing stop. All other jobs keep their existing behavior.
- The report composer and database record RPC preserve `bb163_auto_correction_rounds` and correction history across subsequent status reports.

- [ ] **Step 1: Add failing autopilot tests**

  Cover BB-163 discovery while blocked, same-job correction for rounds 1–3, durable counts across report updates, park after the third unsuccessful correction, no correction for another job, and normal gate progression when acceptance passes before the limit.

- [ ] **Step 2: Run the targeted autopilot tests and confirm they fail**

  Run: `node --test test/builder-autopilot.test.js`

  Expected: FAIL because blocked BB-163 is not discovered or routed to the correction RPC.

- [ ] **Step 3: Wire the scoped job query and correction RPC**

  Select the exact reference/source/state, fail closed on ambiguity, invoke the service-only RPC, and keep the correction marker/history when writing later reports. Do not reset ordinary step-attempt counts.

- [ ] **Step 4: Run targeted unit tests and type/build checks**

  Run: `node --test test/builder-autopilot.test.js test/bob-builder-runtime-coordinator.test.js`

  Expected: PASS; acceptance success must still proceed through the existing gates.

- [ ] **Step 5: Commit the control-plane behavior and tests**

  Commit the autopilot wiring and tests together.

### Task 3: Ship and verify BB-163's bounded correction

**Files:**
- No additional source files; use the approved PR/release lane and existing live-read tooling.

- [ ] **Step 1: Run the focused regression suite**

  Run the migration tests and autopilot/runtime tests from Tasks 1–2. Expected: all pass, including PostgreSQL checks where available.

- [ ] **Step 2: Open a PR and wait for required CI**

  Use the verified GitHub identity and the repository's protected PR/release path. Rerun a failed CI job only after identifying an external/transient cause.

- [ ] **Step 3: Merge and wait for the governed release lane**

  Confirm the migration is applied and the control plane is live at the merged SHA; confirm Atlas/schema refresh follows the repository process.

- [ ] **Step 4: Verify live job state read-only**

  Confirm BB-163 remains the same job, each correction round is audited, attempt counts were not reset, and it either advances through the unchanged gates or parks after three unsuccessful rounds. Confirm no other job entered the exception.

- [ ] **Step 5: Report the outcome**

  Give Don the round count, blockers, verification evidence, current gate, and whether the job is parked or still progressing. Do not claim completion or release merely because an auto-correction succeeded.
