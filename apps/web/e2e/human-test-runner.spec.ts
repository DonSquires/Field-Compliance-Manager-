import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin } from './fixtures';
import { HumanTestSession } from './human-test-runner';

test('human button walkthrough visits duplicate labels and records guarded actions', async ({ page }, testInfo) => {
  await page.route('**/officer/modules', async (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body><main data-app-content><button type="button">Open detail</button><button type="button">Open detail</button><button type="button">End access</button><button type="button">Open standalone app</button><button type="button">Open Bob workspace</button></main></body></html>',
  }));
  await page.goto('/officer/modules');
  const session = new HumanTestSession(page, testInfo);

  await session.walkEveryVisibleButton('/officer/modules');

  expect(session.steps.map((step) => step.name)).toEqual([
    'button /officer/modules #0: Open detail',
    'button /officer/modules #1: Open detail',
    'button /officer/modules #3: Open standalone app',
    'button /officer/modules #4: Open Bob workspace',
  ]);
  expect(session.skippedActions).toEqual([
    { route: '/officer/modules', index: 2, label: 'End access', reason: 'write-or-destructive' },
  ]);
});

test('human button walkthrough resets a real Admin hub through SPA navigation', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await installSupabaseFixtures(page);
  await signInAsAdmin(page, '/admin/hub');
  const session = new HumanTestSession(page, testInfo);

  await session.walkEveryVisibleButton('/admin/hub');

  expect(session.steps.length).toBeGreaterThan(10);
  expect(session.steps.some((step) => step.name.includes('Sign out'))).toBe(false);
  await session.finish();
});

test('human button walkthrough backs out of a safe dialog without confirming it', async ({ page }, testInfo) => {
  await page.route('**/admin/hub', async (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body><main data-app-content><button type="button" onclick="document.getElementById(\'review-dialog\').hidden=false">Review details</button><section id="review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title" hidden><h2 id="review-title">Escalate follow-up</h2><button type="button" onclick="this.parentElement.hidden=true">Back</button><button type="button">Confirm action</button></section></main></body></html>',
  }));
  await page.goto('/admin/hub');
  const session = new HumanTestSession(page, testInfo);

  await session.walkEveryVisibleButton('/admin/hub');

  expect(session.steps.map((step) => step.name)).toEqual(['button /admin/hub #0: Review details']);
  await expect(page.locator('#review-dialog')).toBeHidden();
  expect(session.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
});

test('human safe fields use Bob Test and 999 prefixes for data entry', async ({ page }, testInfo) => {
  const session = new HumanTestSession(page, testInfo);

  await page.setContent('<!doctype html><html><body><input aria-label="Observation" /></body></html>');
  expect(await session.fillSafeField()).toBe(true);
  await expect(page.locator('input')).toHaveValue('Bob Test human test observation');

  await page.setContent('<!doctype html><html><body><input aria-label="Risk score" type="number" /></body></html>');
  expect(await session.fillSafeField()).toBe(true);
  await expect(page.locator('input')).toHaveValue('999');

  await page.setContent('<!doctype html><html><body><input aria-label="Inspection date" type="date" /></body></html>');
  expect(await session.fillSafeField()).toBe(true);
  await expect(page.locator('input')).toHaveValue('2026-09-12');
  expect(session.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
});

const readOnlyPage = '<!doctype html><html><body><main data-app-content><div role="tablist"><button role="tab" type="button">Overview</button></div><button type="button" onclick="document.body.dataset.clicked=\'open\'">Open detail</button><form onsubmit="event.preventDefault();document.body.dataset.submitted=\'yes\'"><input aria-label="Observation" /><button type="submit" onclick="document.body.dataset.clicked=\'save\'">Save</button></form></main></body></html>';

test('live read-only walk observes production controls without clicking, typing, or submitting', async ({ page }, testInfo) => {
  await page.route('**/admin/hub', async (route) => route.fulfill({ status: 200, contentType: 'text/html', body: readOnlyPage }));
  await page.goto('/admin/hub');
  const session = new HumanTestSession(page, testInfo, { readOnly: true });

  await session.walkEveryVisibleButton('/admin/hub');
  await session.walkSafeTabsAndFields();

  expect(session.readOnly).toBe(true);
  await expect(page.locator('body')).not.toHaveAttribute('data-clicked', /.+/);
  await expect(page.locator('body')).not.toHaveAttribute('data-submitted', /.+/);
  await expect(page.getByLabel('Observation')).toHaveValue('');
  expect(await session.fillSafeField()).toBe(false);
  expect(await session.followThroughSafeSubmit()).toBe(false);
  expect(await session.clickSafe('Open detail')).toBe(false);
  expect(session.skippedActions.map((action) => [action.label, action.reason])).toEqual([
    ['Overview', 'live-read-only'],
    ['Open detail', 'live-read-only'],
    ['Save', 'live-read-only'],
  ]);
  expect(session.steps.some((step) => step.name.startsWith('button '))).toBe(false);
});

test('a live run is read-only even when a caller asks otherwise', async ({ page }, testInfo) => {
  const previous = process.env.HUMAN_TEST_LIVE;
  process.env.HUMAN_TEST_LIVE = 'true';
  try {
    expect(new HumanTestSession(page, testInfo, { readOnly: false }).readOnly).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.HUMAN_TEST_LIVE;
    else process.env.HUMAN_TEST_LIVE = previous;
  }
  expect(new HumanTestSession(page, testInfo).readOnly).toBe(previous === 'true');
});

test.describe('deployment preflight', () => {
  const keys = ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID', 'HUMAN_TEST_EXPECTED_SHA', 'HUMAN_TEST_REQUIRE_DEPLOYMENT_MATCH'] as const;
  const sha = 'a'.repeat(40);
  let saved: Partial<Record<(typeof keys)[number], string>> = {};
  let originalFetch: typeof globalThis.fetch;

  test.beforeEach(() => {
    saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    originalFetch = globalThis.fetch;
    Object.assign(process.env, { VERCEL_TOKEN: 'preflight-test-value', VERCEL_PROJECT_ID: 'prj_test', HUMAN_TEST_EXPECTED_SHA: sha, HUMAN_TEST_REQUIRE_DEPLOYMENT_MATCH: 'true' });
    delete process.env.VERCEL_TEAM_ID;
  });
  test.afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const respond = (routes: Record<string, unknown>) => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      requested.push(url);
      const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
      return key ? new Response(JSON.stringify(routes[key]), { status: 200 }) : new Response('{}', { status: 404 });
    }) as typeof globalThis.fetch;
    return requested;
  };

  test('matches the deployment the production alias serves', async ({ page }, testInfo) => {
    const requested = respond({ 'https://api.vercel.com/v13/deployments/www.example.test': { projectId: 'prj_test', readyState: 'READY', meta: { githubCommitSha: sha } } });
    const session = new HumanTestSession(page, testInfo);
    await session.verifyDeployment('https://www.example.test');
    expect(session.findings).toEqual([]);
    expect(requested.some((url) => url.startsWith('https://api.vercel.com/v6/'))).toBe(false);
  });

  test('fails closed when a required match has no serving commit SHA', async ({ page }, testInfo) => {
    respond({
      'https://api.vercel.com/v13/deployments/www.example.test': { projectId: 'prj_test', readyState: 'READY', meta: {} },
      'https://api.vercel.com/v6/deployments': { deployments: [{ state: 'READY', meta: {} }] },
    });
    const session = new HumanTestSession(page, testInfo);
    await session.verifyDeployment('https://www.example.test');
    expect(session.findings.map((finding) => [finding.severity, finding.message])).toEqual([
      ['error', 'Deployment preflight unavailable: the serving deployment has no Git commit SHA.'],
    ]);
  });

  test('reports a stale serving deployment', async ({ page }, testInfo) => {
    respond({ 'https://api.vercel.com/v13/deployments/www.example.test': { projectId: 'prj_test', readyState: 'READY', meta: { githubCommitSha: 'b'.repeat(40) } } });
    const session = new HumanTestSession(page, testInfo);
    await session.verifyDeployment('https://www.example.test');
    expect(session.findings.map((finding) => finding.message)).toEqual([`Deployment is stale: expected ${sha}, serving ${'b'.repeat(40)}.`]);
  });
});
