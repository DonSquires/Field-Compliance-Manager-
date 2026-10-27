# Dr. Bob Human Testing

This is the rebuilt human-test layer from the Freedom Camping testing approach. It uses a real browser session to look at the rendered application, click visible controls, type into safe fields, capture screenshots, and produce a structured JSON report.

## Run locally

```bash
cd apps/web
npm run test:e2e:human
```

The default run uses the existing Supabase fixtures. It covers the admin shell and officer entry point on the configured desktop and mobile Playwright projects.

## Bob's automatic production verification

Owner ruling 2026-10-27 (Don Squires, owner): Bob runs Dr Bob himself after
production deploys. No owner or admiral request is required. The control plane
polls Vercel for the deployment serving the `HUMAN_TEST_BASE_URL` alias in the
configured project. It waits while the newest production deployment is still
queued or building, and acts only when the serving deployment is `READY` with a
Git SHA. A project mismatch, missing SHA or failed lookup is reported as
`unavailable`, never as a deployment to test. It waits for the release lane to
record that SHA, unless the lane has been stuck for 30 minutes, then waits for
Builder execution, main health and other Dr Bob runs to become idle. Each SHA
receives one `suite` run requested by `bob:production-verify`, using the
dedicated test identity and the read-only live phase. The live phase observes
`BOB_PRODUCTION_HUMAN_TEST_ROUTE`, which defaults to `/admin/builder`, so the
authenticated route check never silently skips.

Runs use private detached snapshots under the Builder workspace root, pinned to
the deployment commit. Shared checkout refreshes therefore cannot change files
under a running browser walk. `/health` reports `activeHumanTests` and the
latest production verification status without credentials. The release lane
does not restart the control plane while `activeHumanTests` is nonzero.

Passing or failing tests are recorded once per SHA. Interrupted, timed-out or
infrastructure-coded worker failures retry at most three times before
`gave_up`. A live phase that fails because its deployment preflight was
`unavailable`, `stale` or `unverified` is classified as infrastructure and
retried, not recorded as an application failure. The attempt is persisted
before the worker starts, so a control-plane crash during a start still spends
budget. If a different SHA is confirmed `READY` on production when the run
finishes, the older verdict becomes `superseded` and the newer SHA receives its
own run; a settling or unavailable deployment never supersedes. The newest 50
terminal verdicts are retained; pending and running states are never evicted.

Disable the monitor with `BOB_PRODUCTION_HUMAN_TEST=false`; adjust polling with
`BOB_PRODUCTION_HUMAN_TEST_INTERVAL_MS` (minimum 60 seconds) and the first check
after startup with `BOB_PRODUCTION_HUMAN_TEST_STARTUP_DELAY_MS` (1 second to 10
minutes, default 2 minutes). A failure is evidence for Builder investigation. It
is not an automatic repair, approval or release decision.

Known limits:

- Vercel credentials stay in the control plane. It resolves the deployment
  serving production before the live worker starts and again after it exits;
  the worker receives only the SHA the control plane verified, never
  `VERCEL_TOKEN`, `VERCEL_PROJECT_ID` or `VERCEL_TEAM_ID`. If the deployment is
  not the expected SHA beforehand, no worker starts and the test identity is
  not used. If it moved during the walk, the live phase fails.
- The live worker still runs repository test code from a commit that is
  already on `main`, and holds the dedicated test password in its Node process
  while it does. The password never reaches a receipt, and the browser context
  sees it only as typed login input. A short-lived, audited test-session broker
  would remove that remaining exposure.
- The release lane's idle check and the monitor's start are not one atomic
  reservation. Duplicate starts are refused synchronously inside the control
  plane, and the release lane defers while `/health.activeHumanTests` is
  non-zero. If a release still restarts the control plane during a start, the
  run is marked `interrupted` and retried within the bounded budget, and a
  newer production SHA supersedes it.

## Run through Bob

An admiral can also ask Bob to start a Dr Bob human test. Bob calls the governed
Builder control room, which starts the existing browser worker against a
commit-pinned checkout and immediately returns a durable run ID. The run is
persisted through control-plane restarts with one of these states:
`queued`, `running`, `succeeded`, `failed`, `timeout`, or `interrupted`.

Bob may say a review is running only when the control plane returns a real run
ID in `queued` or `running` state. Asking for the human-test status returns that
run, its pinned source SHA, pass/fail/skip counts, and the retained artifact
inventory. A second start request while a run is active returns the existing
receipt instead of creating duplicate work.

An explicit instruction to run Dr Bob is deterministically dispatched to this
tool even if the planner proposes research or prose instead. `suite` mode runs
the fixture-backed phase first and, only if it passes, runs the read-only live
phase under the same durable run ID. `live` and `suite` runs are refused with
HTTP 409 before any snapshot is created or credential is used unless the
commit is already merged to `main`; an unreviewed branch commit can only run in
`fixture` mode. The request can pin a 40-character `expected_sha` and an
approved admin route such as `/admin/builder`; a source
SHA mismatch fails before a browser worker starts unless the newer source and
deployed commits have the exact same `apps/web` Git tree. This permits
server-only Bob commits without pretending they changed the deployed web
artifact.

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

The browser runner enforces this. With `HUMAN_TEST_LIVE=true`, the session is
read-only and cannot opt out: safe-button clicks, field fills, submit
follow-through and button walks are skipped and recorded with the reason
`live-read-only`. Only tab and admin-navigation changes are performed. Checks
that depend on local Supabase fixtures (officer modules, admin route families,
desktop companion, officer and client control groups) are skipped in live mode.

## Deployment preflight

Before a live human journey, Bob performs a server-side deployment preflight.
For local and CI runs, if `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` are available
to the test process, it looks up the deployment serving the target hostname
(falling back to the project's production deployments), checks its state, and
compares its Git SHA with `HUMAN_TEST_EXPECTED_SHA` or `GITHUB_SHA`. Set
`HUMAN_TEST_REQUIRE_DEPLOYMENT_MATCH=true` when a stale or unverifiable
deployment must block the test rather than produce a warning; a serving
deployment without a Git SHA is then an error. The preflight prints a
`[HUMAN DEPLOYMENT PREFLIGHT] result=matched|stale|unavailable|unverified`
line. Vercel credentials never enter the browser context.

Bob's governed live and suite dispatch performs that lookup in the control plane
instead, so it requires `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` there. It starts
the live worker only when production is ready and serving the expected SHA,
passes the worker `HUMAN_TEST_DEPLOYMENT_VERIFIED_SHA` (no Vercel credentials),
and sets `HUMAN_TEST_REQUIRE_DEPLOYMENT_MATCH=true`. After the worker exits, the
control plane checks production again and records the worst of the before,
after and worker results as the phase's `deployment_preflight`. A stale,
unavailable or unverified result, or a failed fixture phase, is a failed run,
not a warning-shaped success.

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
low-risk test-only case. Under the expanded owner decision of 2026-10-24,
GitHub supports the primary Vibe Builder/Bob Builder systems with
credential-free PR/main verification and offline fixture evidence. Additional
governed support workflows are permitted. The current topology does not move
the repair agent or production migration writes into Actions; those remain on
the VPS, without a competing production writer.

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
