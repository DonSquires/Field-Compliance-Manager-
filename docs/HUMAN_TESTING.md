# Dr. Bob Human Testing

This is the rebuilt human-test layer from the Freedom Camping testing approach. It uses a real browser session to look at the rendered application, click visible controls, type into safe fields, capture screenshots, and produce a structured JSON report.

## Run locally

```bash
cd apps/web
npm run test:e2e:human
```

The default run uses the existing Supabase fixtures. It covers the admin shell and officer entry point on the configured desktop and mobile Playwright projects.

## Run against the deployed app

```bash
cd apps/web
HUMAN_TEST_LIVE=true \
GRANDMASTER_TEST_EMAIL="$GRANDMASTER_TEST_EMAIL" \
GRANDMASTER_TEST_PASSWORD="$GRANDMASTER_TEST_PASSWORD" \
npm run test:e2e:human:live
```

Set `HUMAN_TEST_BASE_URL` to point at another deployment. Live mode performs navigation and observation only. It does not submit, save, approve, resolve, publish, assign, delete, or sign out.

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

## Safety model

The human runner deliberately skips controls whose labels indicate a state-changing or destructive action, including save, submit, approve, resolve, assign, publish, delete, and sign out. It still types into the first non-password field so field ergonomics and controlled inputs are exercised without committing a record.

The runner treats browser errors and failed interactions as failures. The fixture-only missing Realtime websocket is filtered because the local fixture server intentionally does not provide Supabase Realtime.

## Implementation

- `apps/web/e2e/human-test-runner.ts` contains the reusable session, evidence capture, safe-action policy, and report generation.
- `apps/web/e2e/dr-bob-human-test.spec.ts` drives the admin and officer journeys.
- `apps/web/run-manual-walkthroughs.sh` lists and documents the manual suites.

This complements workflow-specific tests such as the CRM, welfare, and dispatch walkthroughs. The workflow tests verify known data contracts; this human test verifies that a person can actually see and move through the product.
