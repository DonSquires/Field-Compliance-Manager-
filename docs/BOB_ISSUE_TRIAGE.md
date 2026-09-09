# Bob Issue Triage From Human Tests

Bob should create a tracked repository issue when a human-test finding is reproducible, actionable, and not already tracked. Issues are the durable work queue; Playwright reports remain the evidence record.

## Do not create an issue for

- A single transient network timeout without reproduction.
- Expected fixture-only noise.
- A warning that has no user or data impact.
- A duplicate of an open issue.
- A product question that has not been confirmed against schema, Atlas, or live read evidence.

Record those in the human-test report or ask for clarification instead.

## Create an issue when

At least one of these is true:

- A visible user action fails or is blocked.
- A browser/API error is reproducible at a stable URL.
- Data is missing, stale, unauthorized, or not persisted after a governed workflow.
- A schema/RPC contract mismatch is confirmed.
- An accessibility, responsive, or enterprise UX defect prevents the intended job.
- A migration or deployment mismatch blocks a live capability.

## Required issue packet

Every Bob-created issue should contain:

```text
Title: [surface] concise defect and user impact

Environment:
- deployment URL / commit if known
- browser and viewport
- tenant/role context, redacted
- timestamp

Observed:
- exact visible error or incorrect state
- URL and control/action used
- reproduction steps

Expected:
- user-visible and data-flow expectation

Evidence:
- Playwright report and screenshot/trace attachment
- browser console or network status
- Atlas capability state and relevant flow edges
- schema/migration/RPC/policy evidence
- scoped live-read result, if approved

Diagnosis:
- confirmed root cause, or explicitly "unconfirmed"
- distinguish symptom, inference, and source fact

Next move:
- one smallest discriminating check or proposed fix

Risk and acceptance:
- user/data/security impact
- regression test and human retest required
```

## Labels and ownership

Use stable labels where the repository host supports them: `human-test`, `bug`,
`data-flow`, `schema`, `migration`, `rls`, `accessibility`, `responsive`, or
`needs-evidence`. Assign the owning surface only after Atlas/schema inspection.
Do not assign a severity from appearance alone: safety, authorization, tenant
isolation, data loss, and blocked operational work outrank cosmetic issues.

## Creation boundary

Bob may draft an issue automatically from a completed human-test report. Creation
should be deduplicated against existing issues first and remain auditable. Bob
must not silently create an issue containing raw production names, contact data,
GPS, HR/legal content, credentials, service-role material, or unredacted files.
A human can approve or edit the draft before publication when the evidence is
sensitive or the impact is consequential.

The existing governed issue path is the repository maintainer API. Read existing
issues before creating one, use the repository's canonical project, and preserve
the issue URL/IID in the human-test report after creation.
