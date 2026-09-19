# Bob Automation, Geofence, and Module Testing

Bob's human testing must verify automation as a governed workflow, not assume that a button or module implies automation exists.

## Required flow

### Before

Verify the expected configuration and preconditions:

- Organization, branch, agreement, site, and zone context.
- Enabled module and module rules.
- SLA, client-submission, and `allows_auto_dispatch` settings.
- Staff entitlement, direct grant, credential/readiness state.
- Boundary source, verification state, schedule, closure, and jurisdiction.
- Whether the expected automation should be present, absent, or blocked.

### During

Perform the human action and inspect:

- Visible controls and labels.
- Geofence point resolution and matched site/zone/module.
- Effective rules, access mode, closure, schedule, SLA, and jurisdiction.
- Requests/RPCs, loading state, permission checks, and error handling.
- Whether an automatic action is offered only when configuration permits it.

### After

Verify:

- The resolved decision is visible and understandable.
- The next safe action is clear: auto-dispatch, manual review, officer action, or blocked state.
- Any write has a receipt, audit event, and live read-back.
- Downstream dispatch, roster, evidence, notification, and report views agree.
- Disabled or unentitled modules remain absent and cannot be reached through the UI.

## Expected versus present

Bob must write the matrix explicitly:

```text
Expected: static_guarding enabled, auto-dispatch disabled, verified runtime zone.
Present:  static_guarding enabled, auto-dispatch disabled, point resolved to zone.
Missing:  explicit UI explanation if the disabled automation is not visible.
Contradiction: any control offers automation despite the agreement/module rule.
```

A missing automation is not automatically a defect. It may be intentionally disabled by agreement, module, closure, role, credential, or safety policy. Bob should question the intent, explain the tradeoff, and offer alternatives before filing an issue.

## Automated walkthrough

```bash
cd apps/web
npx playwright test e2e/dr-bob-automation-geofence-module.spec.ts
```

The walkthrough is fixture-backed and safe: it does not create dispatch work or submit enforcement actions. It checks the visual geofence decision, module entitlement boundary, and the expected automation boundary.

## CCTV enterprise acceptance (live, staged)

`apps/web/e2e/cctv-acceptance.spec.ts` walks the reviewer's whole CCTV path on the
live build as a human would, and records JSON evidence lines (`{"stage": ...}`) plus
screenshots under `test-results/cctv-acceptance-*.png`.

| Stage | Gate | What it proves |
| --- | --- | --- |
| A1, A2 | always (needs the dedicated `GRANDMASTER_TEST_EMAIL/PASSWORD` identity) | Console renders for the organisation with custody badges; the Custody record reads through `cctv_evidence_custody`; the biometric governance readout states purpose and retention; the queue explains failures and shows GPU use against the daily budget; the receipt verifier refuses a malformed id and reports an unknown id as not found. No console errors, no failed requests. |
| B | `CCTV_ACCEPTANCE_IMPORT=true` | Imports one small owner-approved test recording through the real import page (place → camera → file → start) and sees it queued in the console. The fixture is fetched in the Node process with the service key from `CCTV_ACCEPTANCE_FIXTURE_PATH` (default: a 695 KB Dahua `.h265` from the approved test corpus); the key never reaches the browser. |
| C | `CCTV_ACCEPTANCE_WAIT_FOR_INFERENCE=true` | Waits for the live worker to finish, confirms the recording is hashed, issues a draft report from the queue, checks the printed page carries its receipt, and verifies the receipt through `verify_cctv_report_receipt`. |

```bash
cd apps/web
# Stage A only (read-only against the live build)
npx playwright test e2e/cctv-acceptance.spec.ts --project=desktop-chromium --workers=1
# Full lifecycle (creates an import labelled "ACCEPTANCE <timestamp>" in the test identity's organisation)
CCTV_ACCEPTANCE_WAIT_FOR_INFERENCE=true npx playwright test e2e/cctv-acceptance.spec.ts --project=desktop-chromium --workers=1
```

Stage B/C create test data (import, evidence, job, receipt) labelled `ACCEPTANCE …`
in the test identity's organisation; purge them with the CCTV test-data purge
under `app.evidence_delete_scope = 'test_dataset_purge'`. Verified live
2026-09-19: A1/A2/B/C all passed; the 6-second fixture produced zero motion frames,
so the receipt was `draft` with zero GPU calls metered — an honest result, not a
fault.
