# BB-163 bounded auto-correction design

## Intent

Let Bob correct BB-163's current whole-job acceptance gap without asking Don to
approve each correction. Stop after three correction rounds and park the job
with a clear report for Don.

## Current state

BB-163 is a routine `/admin/roster` repair parked at `security_review`. Its
acceptance report says the required outcomes lack a changed regression test
and a passing worker command that covers that test. The existing canon requires
owner confirmation before same-job corrections; this is a narrow, dated
exception to that rule.

## Goals and non-goals

- Apply only to BB-163; other jobs retain the existing owner-confirmation rule.
- Define a round as one correction cycle responding to a recorded acceptance
  or review blocker, followed by worker verification and the applicable
  acceptance checks. Model retries or individual test runs are not separate
  rounds.
- Persist the round count with the job so a restart cannot reset the limit.
- If acceptance succeeds before the limit, continue through the existing
  security, independent-review, approval, and release gates.
- After three unsuccessful rounds, park BB-163 for Don with the blocker,
  correction history, and verification evidence.
- Do not reset ordinary step-attempt counts, create continuation jobs, or
  bypass any existing security, evidence, approval, or release gate.

## Approaches

1. **Same-job, persisted correction rounds (recommended).** Keep one job and
   its evidence/audit history, count up to three complete correction cycles,
   then park it. This matches the bounded authorization and avoids the
   requester-authority failure seen in child-job continuations.
2. **Create a new continuation job for each correction.** This splits
   provenance, risks repeating the requester-authority failure, and makes the
   three-round limit harder to enforce across restarts. Not selected.
3. **Raise the existing step retry ceiling.** Step retries are not complete
   correction-and-verification cycles, so this could spend the limit without
   addressing acceptance and would not reliably park after three corrections.
   Not selected.

## Constraints and implementation calls

The exception is limited to BB-163 and the correction needed to satisfy its
recorded acceptance/review blockers. A passing acceptance check is not approval:
all existing downstream gates remain authoritative. The round counter must be
durable and auditable; implementation should reuse the existing job state and
audit mechanisms where possible, avoiding a schema change unless the current
mechanisms cannot safely represent the count and history.
