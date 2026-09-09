import { expect, test } from '@playwright/test';
import { installSupabaseFixtures } from './fixtures';
import { HumanTestSession } from './human-test-runner';

const liveMode = process.env.HUMAN_TEST_LIVE === 'true';
const liveBaseUrl = process.env.HUMAN_TEST_BASE_URL || 'https://www.fcmanager.co.nz';
const email = process.env.GRANDMASTER_TEST_EMAIL || '';
const password = process.env.GRANDMASTER_TEST_PASSWORD || '';

async function openTarget(page: Parameters<typeof installSupabaseFixtures>[0], path: string) {
  await page.goto(liveMode ? `${liveBaseUrl}${path}` : path);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(400);
}

async function signInAsHuman(page: Parameters<typeof installSupabaseFixtures>[0], session: HumanTestSession) {
  await openTarget(page, '/admin');
  await session.observe('login or existing session');

  const emailField = page.getByLabel('Email address');
  if (!(await emailField.isVisible({ timeout: 1500 }).catch(() => false))) {
    await expect(page.locator('.admin-shell, .admin-mobile-header, .admin-nav-item').first()).toBeVisible();
    await dismissDesktopPrompt(page, session);
    return;
  }

  if (!email || !password) {
    throw new Error('Human test needs GRANDMASTER_TEST_EMAIL and GRANDMASTER_TEST_PASSWORD when no session exists.');
  }

  await session.step('type credentials manually', async () => {
    await emailField.fill(email);
    await page.getByLabel('Password').fill(password);
  });
  await session.step('press the sign-in button manually', async () => {
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForTimeout(1200);
  });
  await session.observe('authenticated application shell');
  await expect(page.locator('.admin-shell, .admin-mobile-header, .admin-nav-item').first()).toBeVisible();
  await dismissDesktopPrompt(page, session);
}

async function dismissDesktopPrompt(page: Parameters<typeof installSupabaseFixtures>[0], session: HumanTestSession) {
  const prompt = page.getByRole('dialog', { name: 'Use local hardware with FCM' });
  if (await prompt.isVisible({ timeout: 1000 }).catch(() => false)) {
    await session.step('dismiss the optional desktop companion prompt', async () => {
      await prompt.getByRole('button', { name: 'Not now', exact: true }).click();
    });
  }
}

test.describe("Dr. Bob's human browser test", () => {
  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(7000);
    if (!liveMode) await installSupabaseFixtures(page);
  });

  test('walks the rendered admin experience like a person', async ({ page }, testInfo) => {
    const session = new HumanTestSession(page, testInfo);
    console.log(`\n[HUMAN TEST MODE] ${liveMode ? `live: ${liveBaseUrl}` : 'fixture-backed local app'}`);

    await signInAsHuman(page, session);
    await session.step('explore the visible admin navigation', () => session.walkVisibleAdminNavigation());
    await session.step('open safe tabs and type into the first safe field', () => session.walkSafeTabsAndFields());
    await session.observe('final rendered state');
    await session.finish();
  });

  test('walks the field portal separately when a human chooses it', async ({ page }, testInfo) => {
    const session = new HumanTestSession(page, testInfo);
    await openTarget(page, '/officer');
    await session.observe('officer entry point');

    const loginField = page.getByLabel('Email address');
    if (await loginField.isVisible({ timeout: 1500 }).catch(() => false)) {
      if (!email || !password) throw new Error('Human test needs credentials for the officer entry point.');
      await loginField.fill(email);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForTimeout(1200);
    }

    await dismissDesktopPrompt(page, session);
    await session.observe('field portal after authentication');
    const safeModule = page.locator('button, a').filter({ hasText: /schedule|dispatch|map|report|patrol/i }).first();
    if (await safeModule.isVisible({ timeout: 1500 }).catch(() => false)) {
      await safeModule.click();
      await page.waitForTimeout(300);
      await session.observe('first field module selected');
    }
    await session.finish();
  });
});
