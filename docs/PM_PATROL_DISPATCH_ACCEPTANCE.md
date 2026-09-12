# PM Patrol and Dispatch Acceptance

This acceptance run is live-only. It must not install Supabase mocks or seed raw business rows from the browser.

## Required identities

Set distinct dedicated test identities in the Codespace environment:

- `PM_ADMIN_EMAIL` / `PM_ADMIN_PASSWORD`
- `PM_OFFICER_EMAIL` / `PM_OFFICER_PASSWORD`

The admin and officer identities must belong to the same test organisation, and the officer must be work-ready and entitled to patrol/dispatch.

## Run

```bash
cd apps/web
npx playwright test -c ./playwright.config.ts \
  e2e/live-patrol-dispatch-pm.spec.ts \
  --project=desktop-chromium \
  --project=mobile-chromium
```

Target is `https://www.fcmanager.co.nz` unless `HUMAN_TEST_BASE_URL` is set.

## Required evidence phases

1. Admin roster entry and visible workforce state.
2. Officer schedule entry and assigned shift state.
3. Admin operational geography: agreement/site/zone context.
4. Admin roster board: work unit, route, officer, shift, publication state.
5. Admin dispatch console: dispatch job/resource/SLA state.
6. Officer dispatch: assignment received, status transitions, outcome receipt.
7. Officer patrol: session start, checkpoint loading, visit proof, patrol completion.
8. Admin patrol oversight: persisted patrol/checkpoint evidence and downstream state.

Each phase captures a screenshot, URL, and visible-state summary. Browser console/page errors fail the run. The test does not approve, delete, or fabricate business records.

## Current blocker

The repository has an owner/grandmaster live identity but no distinct officer PM test identity configured. The test therefore skips rather than bypassing the roster and authorization boundaries with fixtures.
