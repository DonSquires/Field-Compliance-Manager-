import { expect, test } from '@playwright/test';
import { installClientPortalFixtures, installOfficerScheduleFixtures, installSupabaseFixtures, signInAsAdmin, signInAsClient, signInAsOfficer } from './fixtures';
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
    await expect(page.locator('.admin-shell, .admin-mobile-header, .admin-nav-item').first()).toBeVisible();
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

  const adminButtonRouteGroups = [
    { name: 'Mission Control', routes: ['/admin/hub', '/admin/approvals'] },
    { name: 'Field Operations core', routes: ['/admin/field-ops', '/admin/field-ops?area=dispatch', '/admin/field-ops?area=patrol', '/admin/field-ops?area=live-map', '/admin/field-ops?area=field-reports', '/admin/field-ops?area=officer-activity', '/admin/field-ops?area=welfare-alerts', '/admin/field-ops?area=breach-review', '/admin/field-ops?area=vehicle-search', '/admin/field-ops?area=observation-search', '/admin/field-ops?area=debrief-followup'] },
    { name: 'Field specialties', routes: ['/admin/field-ops?area=parking', '/admin/field-ops?area=noise-control', '/admin/field-ops?area=biosecurity', '/admin/field-ops?area=smoke-control'] },
    { name: 'Video evidence', routes: ['/admin/field-ops?area=cctv-console', '/admin/field-ops?area=cctv-triage', '/admin/field-ops?area=cctv-review', '/admin/field-ops?area=cctv-library', '/admin/field-ops?area=cctv-import'] },
    { name: 'Site and location workspaces', routes: ['/admin/site-360', '/admin/locations', '/admin/zones'] },
    { name: 'Geofence and Workshop', routes: ['/admin/sites', '/admin/workshop'] },
    { name: 'Clients and workforce', routes: ['/admin/crm', '/admin/relationships', '/admin/client-setup', '/admin/onboarding', '/admin/handoffs', '/admin/roster', '/admin/people-hr', '/admin/roster-targets', '/admin/users'] },
    { name: 'Finance reports and records', routes: ['/admin/finance-bureau', '/admin/finance-money', '/admin/finance-connections', '/admin/finance-costing', '/admin/finance-pricing', '/admin/rate-rules', '/admin/reports', '/admin/files', '/admin/investigations'] },
    { name: 'Platform settings', routes: ['/admin/access-control', '/admin/org-setup', '/admin/module-subscriptions', '/admin/testing', '/admin/test-data', '/admin/platform', '/admin/platform-subscribers', '/admin/platform-catalog', '/admin/platform-subscriptions'] },
    { name: 'Builder and Bob', routes: ['/admin/builder', '/admin/bob', '/admin/document-studio'] },
  ];
  for (const group of adminButtonRouteGroups) {
    test(`follows safe Admin controls: ${group.name}`, async ({ page }, testInfo) => {
      test.setTimeout(420_000);
      const session = new HumanTestSession(page, testInfo);
      await signInAsHuman(page, session);
      for (const route of group.routes) await session.walkEveryVisibleButton(route);
      await session.finish();
    });
  }

  const officerAuditModules = ['dispatch', 'patrol', 'static_guarding', 'welfare', 'freedom_camping', 'parking_enforcement', 'noise_control', 'biosecurity', 'smoke_complaints', 'workshop', 'cctv', 'ems', 'overnight_verification', 'checkpoint_scan'];
  const officerControlGroups = [
    { name: 'Self-service', routes: ['/officer/schedule', '/officer/report', '/officer/leave', '/officer/timesheet', '/officer/credentials', '/officer/vehicle_lookup', '/officer/modules'] },
    { name: 'Dispatch and patrol', routes: ['/officer/dispatch', '/officer/patrol', '/officer/site_guard', '/officer/debrief', '/officer/map', '/officer/overnight_verification', '/officer/checkpoint_scan'] },
    { name: 'Specialty modules', routes: ['/officer/noise_control', '/officer/parking', '/officer/biosecurity', '/officer/freedom_camping', '/officer/smoke_control', '/officer/ems', '/officer/workshop'] },
  ];
  for (const group of officerControlGroups) {
    test(`follows safe Officer controls: ${group.name}`, async ({ page }, testInfo) => {
      test.setTimeout(420_000);
      await installSupabaseFixtures(page, { officerModules: officerAuditModules });
      await page.route('**/rest/v1/user_profiles*', async (route) => {
        const query = new URL(route.request().url()).searchParams;
        if (query.get('id') !== 'eq.22222222-2222-4222-8222-222222222222') return route.fallback();
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata', email: 'ana@fcm.test', role: 'officer', organization_id: '33333333-3333-4333-8333-333333333333', module_access: officerAuditModules }]) });
      });
      const session = new HumanTestSession(page, testInfo);
      await signInAsOfficer(page, '/officer/schedule');
      for (const route of group.routes) await session.walkEveryVisibleButton(route);
      await session.finish();
    });
  }

  test('follows safe client controls across full-module agreement pages', async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    const session = new HumanTestSession(page, testInfo);
    await installClientPortalFixtures(page, { mode: 'full_modules', reportsEnabled: true, financeEnabled: true, role: 'client_admin' });
    await signInAsClient(page);
    for (const route of ['/client', '/client/delivery', '/client/sites', '/client/observations', '/client/reports', '/client/finance', '/client/people']) {
      await session.walkEveryVisibleButton(route);
    }
    await session.finish();
  });

  test('follows safe client controls for a scan-only agreement', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const session = new HumanTestSession(page, testInfo);
    await installClientPortalFixtures(page, { mode: 'scan_only', role: 'client_viewer' });
    await signInAsClient(page, '/client');
    await session.walkEveryVisibleButton('/client/scan');
    await session.finish();
  });
});
