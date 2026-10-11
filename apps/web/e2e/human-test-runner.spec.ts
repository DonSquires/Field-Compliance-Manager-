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
  ]);
  expect(session.skippedActions).toEqual([
    { route: '/officer/modules', index: 2, label: 'End access', reason: 'write-or-destructive' },
    { route: '/officer/modules', index: 3, label: 'Open standalone app', reason: 'concurrent-owner' },
    { route: '/officer/modules', index: 4, label: 'Open Bob workspace', reason: 'concurrent-owner' },
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
