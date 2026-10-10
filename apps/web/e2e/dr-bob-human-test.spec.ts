import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, installSupabaseFixtures, signInAsAdmin, signInAsOfficer } from './fixtures';
import { HumanTestSession } from './human-test-runner';

const liveMode = process.env.HUMAN_TEST_LIVE === 'true';
const liveBaseUrl = process.env.HUMAN_TEST_BASE_URL || 'https://www.fcmanager.co.nz';
const email = liveMode ? (process.env.GRANDMASTER_TEST_EMAIL || '') : 'admin@fcm.test';
const officerEmail = liveMode ? (process.env.GRANDMASTER_TEST_EMAIL || '') : 'ana@fcm.test';
const password = liveMode ? (process.env.GRANDMASTER_TEST_PASSWORD || '') : 'playwright-password';

async function openTarget(page: Parameters<typeof installSupabaseFixtures>[0], path: string) {
  await page.goto(liveMode ? `${liveBaseUrl}${path}` : path);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(400);
}

async function signInAsHuman(page: Parameters<typeof installSupabaseFixtures>[0], session: HumanTestSession) {
  if (!liveMode) {
    await signInAsAdmin(page, '/admin');
    await session.observe('authenticated application shell');
    await dismissDesktopPrompt(page, session);
    return;
  }
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
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
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
  const prompt = page.locator('.desktop-download-overlay [role="dialog"]');
  if (await prompt.isVisible({ timeout: 1000 }).catch(() => false)) {
    await session.step('dismiss the optional desktop companion prompt', async () => {
      await prompt.getByRole('button', { name: 'Not now', exact: true }).click();
    });
  }
}

test.describe("Dr. Bob's human browser test", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    if (!liveMode) {
      await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
      await installSupabaseFixtures(page);
    }
  });

  test('walks the rendered admin experience like a person', async ({ page }, testInfo) => {
    const session = new HumanTestSession(page, testInfo);
    console.log(`\n[HUMAN TEST MODE] ${liveMode ? `live: ${liveBaseUrl}` : 'fixture-backed local app'}`);

    if (liveMode) await session.verifyDeployment(liveBaseUrl);
    await signInAsHuman(page, session);
    await session.step('explore the visible admin navigation', () => session.walkVisibleAdminNavigation());
    await session.step('open safe tabs and type into the first safe field', () => session.walkSafeTabsAndFields());
    await session.observe('final rendered state');
    await session.finish();
  });

  test('walks the field portal separately when a human chooses it', async ({ page }, testInfo) => {
    if (!liveMode) await installOfficerScheduleFixtures(page);
    const session = new HumanTestSession(page, testInfo);
    if (!liveMode) {
      await signInAsOfficer(page, '/officer/schedule');
      await session.observe('field portal after authentication');
    } else {
      await openTarget(page, '/officer');
      await session.observe('officer entry point');

      const loginField = page.getByLabel('Email address');
      if (await loginField.isVisible({ timeout: 1500 }).catch(() => false)) {
        if (!officerEmail || !password) throw new Error('Human test needs credentials for the officer entry point.');
        await loginField.fill(officerEmail);
        await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForTimeout(1200);
      }

      await dismissDesktopPrompt(page, session);
      await session.observe('field portal after authentication');
    }
    const safeModule = page.locator('button, a').filter({ hasText: /schedule|dispatch|map|report|patrol/i }).first();
    if (await safeModule.isVisible({ timeout: 1500 }).catch(() => false)) {
      await safeModule.click();
      await page.waitForTimeout(300);
      await session.observe('first field module selected');
    }
    await session.finish();
  });

  test('observes every officer module route without executing writes', async ({ page }, testInfo) => {
    const session = new HumanTestSession(page, testInfo);
    await installSupabaseFixtures(page);
    await signInAsOfficer(page, '/officer/schedule');
    await session.observe('officer shell before module catalog');

    const modules = [
      'schedule', 'report', 'leave', 'timesheet', 'credentials', 'vehicle_lookup',
      'noise_control', 'parking', 'dispatch', 'biosecurity', 'freedom_camping',
      'overnight_verification', 'site_guard', 'debrief', 'map', 'patrol', 'bob', 'modules',
    ];
    for (const module of modules) {
      await session.step(`observe officer module: ${module}`, async () => {
        await page.goto(`/officer/${module}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(250);
        await session.observe(`officer module: ${module}`);
      });
    }
    await session.finish();
  });

  test('observes every admin route family without executing writes', async ({ page }, testInfo) => {
    const session = new HumanTestSession(page, testInfo);
    await installSupabaseFixtures(page);
    await signInAsAdmin(page, '/admin');
    const routes = [
      '/admin/hub', '/admin/approvals', '/admin/field-ops', '/admin/reports', '/admin/files',
      '/admin/investigations', '/admin/sites', '/admin/locations', '/admin/zones', '/admin/users',
      '/admin/access-control', '/admin/org-setup', '/admin/module-subscriptions', '/admin/relationships',
      '/admin/onboarding', '/admin/handoffs', '/admin/finance-bureau', '/admin/finance-connections',
      '/admin/finance-money', '/admin/finance-costing', '/admin/finance-pricing', '/admin/rate-rules',
      '/admin/roster', '/admin/people-hr', '/admin/roster-targets', '/admin/bob', '/admin/document-studio',
    ];
    for (const route of routes) {
      await session.step(`observe admin route: ${route}`, async () => {
        await page.goto(route);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(250);
        await session.observe(`admin route: ${route}`);
      });
    }
    await session.finish();
  });

  test('dismisses the desktop companion prompt so the next safe button remains usable', async ({ page }, testInfo) => {
    const session = new HumanTestSession(page, testInfo);
    await signInAsAdmin(page, '/admin');
    await session.walkEveryVisibleButton('/admin/hub');
    await expect(page.getByRole('button', { name: 'Open vehicle search' })).toBeVisible();
    await session.finish();
  });

  test('follows every safe button across every page route', async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    const session = new HumanTestSession(page, testInfo);
    await signInAsHuman(page, session);
    const adminRoutes = [
      '/admin/hub', '/admin/approvals', '/admin/field-ops', '/admin/reports', '/admin/files',
      '/admin/investigations', '/admin/sites', '/admin/locations', '/admin/zones', '/admin/users',
      '/admin/access-control', '/admin/org-setup', '/admin/module-subscriptions', '/admin/relationships',
      '/admin/onboarding', '/admin/handoffs', '/admin/finance-bureau', '/admin/finance-connections',
      '/admin/finance-money', '/admin/finance-costing', '/admin/finance-pricing', '/admin/rate-rules',
      '/admin/roster', '/admin/people-hr', '/admin/roster-targets', '/admin/bob', '/admin/document-studio',
    ];
    for (const route of adminRoutes) await session.walkEveryVisibleButton(route);
    await session.finish();
  });
});
