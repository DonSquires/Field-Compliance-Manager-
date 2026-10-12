# Dr. Bob Human Testing

This is the rebuilt human-test layer from the Freedom Camping testing approach. It uses a real browser session to look at the rendered application, click visible controls, type into safe fields, capture screenshots, and produce a structured JSON report.

## Run locally

```bash
cd apps/web
npm run test:e2e:human
```

The default run uses the existing Supabase fixtures. It covers the admin shell and officer entry point on the configured desktop and mobile Playwright projects.

## Run through Bob

An admiral can ask Bob to start a Dr Bob human test. Bob calls the governed
Builder control room, which starts the existing browser worker against a
commit-pinned checkout and immediately returns a durable run ID. The run is
persisted through control-plane restarts with one of these states:
`queued`, `running`, `succeeded`, `failed`, `timeout`, or `interrupted`.

Bob may say a review is running only when the control plane returns a real run
ID in `queued` or `running` state. Asking for the human-test status returns that
run, its pinned source SHA, pass/fail/skip counts, and the retained artifact
inventory. A second start request while a run is active returns the existing
receipt instead of creating duplicate work.

Fixture-backed runs use a bounded four-worker browser pool. Live runs remain
serial and require `HUMAN_TEST_BASE_URL` plus the dedicated
`GRANDMASTER_TEST_EMAIL` and `GRANDMASTER_TEST_PASSWORD` test identity. Bob
does not retrieve or reuse an arbitrary user's password, token, browser
session, or MFA factor.

## Run against the deployed app

```bash
cd apps/web
HUMAN_TEST_LIVE=true \
GRANDMASTER_TEST_EMAIL="$GRANDMASTER_TEST_EMAIL" \
GRANDMASTER_TEST_PASSWORD="$GRANDMASTER_TEST_PASSWORD" \
npm run test:e2e:human:live
```

Set `HUMAN_TEST_BASE_URL` to point at another deployment. Live mode performs navigation and observation only. It does not submit, save, approve, resolve, publish, assign, delete, or sign out.

## Deployment preflight

Before a live human journey, Bob performs a server-side deployment preflight. If
`VERCEL_TOKEN` and `VERCEL_PROJECT_ID` are available to the test process, it
checks the target production deployment state and compares its Git SHA with
`HUMAN_TEST_EXPECTED_SHA` or `GITHUB_SHA`. Set
`HUMAN_TEST_REQUIRE_DEPLOYMENT_MATCH=true` when a stale deployment must block
the test rather than produce a warning. Vercel credentials never enter the
browser context.

## Evidence

Each test produces:

- A screenshot after login, every discovered admin navigation item, safe tab, and final state.
- Console output describing the visible heading, fields, buttons, links, and page text.
- A `human-test-report.json` attachment containing steps, URLs, findings, console errors, and failed requests.
- Playwright traces and failure screenshots when the configured Playwright policy retains them.

Reports and images are available through the Playwright HTML report:

```bash
npx playwright show-report
```

## Issue tracking

Bob should create a repository issue for a reproducible, actionable defect,
not for every warning. First deduplicate against existing issues, then attach
the human-test evidence and add Atlas, schema, and approved live-read findings.
Use the policy and issue packet in `docs/BOB_ISSUE_TRIAGE.md`.

An issue must include the deployment URL, browser/viewport, role context,
reproduction steps, expected and actual behavior, evidence links, diagnosis or
explicit uncertainty, one smallest next move, and acceptance criteria. Redact
production names, contact details, GPS, HR/legal, financial, and credential
data before publication.

## Safety model

The human runner deliberately skips controls whose labels indicate a state-changing or destructive action, including save, submit, approve, resolve, assign, publish, delete, and sign out. It still types into the first non-password field so field ergonomics and controlled inputs are exercised without committing a record.

The runner treats browser errors and failed interactions as failures. The fixture-only missing Realtime websocket is filtered because the local fixture server intentionally does not provide Supabase Realtime.

## Implementation

- `apps/web/e2e/human-test-runner.ts` contains the reusable session, evidence capture, safe-action policy, and report generation.
- `apps/web/e2e/dr-bob-human-test.spec.ts` drives the admin and officer journeys.
- `apps/web/run-manual-walkthroughs.sh` lists and documents the manual suites.
- `bob-control-plane-server.js` persists asynchronous run receipts and retained artifact metadata.
- `worker-executor.js` owns the isolated fixture and live worker profiles.

This complements workflow-specific tests such as the CRM, welfare, and dispatch walkthroughs. The workflow tests verify known data contracts; this human test verifies that a person can actually see and move through the product.

## Bob-Owned Verification

Bob's VPS polls the GitHub main SHA, runs the web build, full unit/source-guard
suite, and bounded Playwright smoke suite in an isolated worker, then records a
durable result per SHA. On a red baseline, Bob opens a constrained Builder
repair, verifies and reviews it, and automatically merges only the approved
low-risk test-only case. GitHub is the source host; it runs no CI or agent
workflows.

Bob also owns the expansive human/visual pass, which produces screenshots, UX
findings, HTTP evidence, traces, and before/during/after workflow reports:

```bash
cd apps/web
npm run test:e2e
npm run test:e2e:human
```

Run the live human suite separately with the approved test identity and deploy
freshness preflight. A cancelled CI browser job does not erase Bob's evidence;
it indicates the broad suite belongs in the dedicated Bob run.
