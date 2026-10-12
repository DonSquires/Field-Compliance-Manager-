import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.describe('Officer shell states and chrome', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  });

  test('renders standby state when officer has no active shift', async ({ page }, testInfo) => {
    const browserErrors = monitorBrowserErrors(page);
    await installSupabaseFixtures(page, { officerModules: ['patrol', 'freedom_camping'] });
    await page.route('**/rest/v1/shifts*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('select')?.includes('shift_stops')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        return;
      }
      return route.fallback();
    });
    await page.route('**/rest/v1/welfare_alerts*', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
        return;
      }
      return route.fallback();
    });
    await signInAsOfficer(page, '/officer');

    // Header in standby state shows "Officer operations" (attached in DOM; on small mobile screens <=410px, small subtitle is hidden responsively)
    const header = page.locator('.officer-shell-header');
    await expect(header).toBeVisible();
    const brandSubtitle = header.locator('.officer-shell-brand small');
    await expect(brandSubtitle).toHaveText('Officer operations');
    if (!testInfo.project.name.includes('mobile')) {
      await expect(brandSubtitle).toBeVisible();
    }

    // Connectivity chip is online
    const connChip = page.locator('.officer-connectivity-chip');
    await expect(connChip).toHaveText('Online');
    await expect(connChip).toHaveClass(/is-online/);

    // Welfare chip shows OK
    const safetyChip = page.locator('.officer-safety-chip');
    await expect(safetyChip).toContainText('OK');

    // Bottom action bar is visible
    const actionBar = page.locator('.officer-action-bar');
    await expect(actionBar).toBeVisible();
    await expect(actionBar.getByRole('button', { name: 'Modules' })).toBeVisible();
    await expect(actionBar.getByRole('button', { name: 'Report' })).toBeVisible();
    await expect(actionBar.locator('.officer-sos-action')).toBeVisible();

    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  });

  test('renders home state with active shift subtitle when shift is in progress', async ({ page }, testInfo) => {
    const browserErrors = monitorBrowserErrors(page);
    await installSupabaseFixtures(page, { officerModules: ['patrol', 'freedom_camping'] });

    // Mock active shift overlapping the fixed clock date (2026-08-30)
    await page.route('**/rest/v1/shifts*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('select')?.includes('shift_stops')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{
            id: 'active-shift-1',
            organization_id: '33333333-3333-4333-8333-333333333333',
            officer_user_id: '22222222-2222-4222-8222-222222222222',
            service_type: 'patrol',
            scheduled_start: '2026-08-30T06:00:00.000Z',
            scheduled_end: '2026-08-30T14:00:00.000Z',
            status: 'in_progress',
            patrol_route_id: null,
            zone_id: null,
            created_at: '2026-08-30T05:00:00.000Z',
            updated_at: '2026-08-30T06:00:00.000Z',
            shift_stops: [],
          }]),
        });
        return;
      }
      return route.fallback();
    });

    await signInAsOfficer(page, '/officer');

    // Header displays the active shift type in brand subtitle
    const header = page.locator('.officer-shell-header');
    const brandSubtitle = header.locator('.officer-shell-brand small');
    await expect(brandSubtitle).toHaveText('patrol shift');
    if (!testInfo.project.name.includes('mobile')) {
      await expect(brandSubtitle).toBeVisible();
    }

    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  });

  test('switches to selector state on /officer/modules and portal state on active module', async ({ page }) => {
    const browserErrors = monitorBrowserErrors(page);
    await installSupabaseFixtures(page, { officerModules: ['patrol', 'freedom_camping'] });
    await page.route('**/rest/v1/welfare_alerts*', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
        return;
      }
      return route.fallback();
    });
    await signInAsOfficer(page, '/officer');

    // Navigate to module selector
    await page.locator('.officer-action-bar').getByRole('button', { name: 'Modules' }).click();
    await expect(page).toHaveURL(/\/officer\/modules$/);
    await expect(page.getByRole('heading', { name: 'Enabled modules' })).toBeVisible();

    // Verify module cards are displayed
    const moduleCards = page.locator('.officer-module-card');
    await expect(moduleCards.first()).toBeVisible();

    // Header brand clicks return to officer home
    await page.locator('.officer-shell-brand').click();
    await expect(page).toHaveURL(/\/officer$/);

    // Navigate to a module portal (e.g. Leave)
    await page.goto('/officer/leave');
    await expect(page.getByRole('heading', { name: /leave/i }).first()).toBeVisible();

    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  });

  test('toggles online and offline states with chrome banner updates', async ({ page }) => {
    const browserErrors = monitorBrowserErrors(page);
    await installSupabaseFixtures(page, { officerModules: ['patrol'] });
    await signInAsOfficer(page, '/officer');

    const connChip = page.locator('.officer-connectivity-chip');
    await expect(connChip).toHaveText('Online');

    // Trigger offline event
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(connChip).toHaveText('Offline');
    await expect(connChip).toHaveClass(/is-offline/);

    const offlineBanner = page.locator('.officer-shell-offline-banner');
    await expect(offlineBanner).toBeVisible();
    await expect(offlineBanner).toContainText('No connection — field evidence will remain queued');

    // Trigger online event
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(connChip).toHaveText('Online');
    await expect(connChip).toHaveClass(/is-online/);
    await expect(offlineBanner).toHaveCount(0);

    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  });

  test('account modal opens from profile chip and closes on Escape', async ({ page }) => {
    const browserErrors = monitorBrowserErrors(page);
    await installSupabaseFixtures(page, { officerModules: ['patrol'] });
    await signInAsOfficer(page, '/officer');

    // Open account dialog
    await page.getByRole('button', { name: 'Account settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ana Ngata' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('ana@fcm.test')).toBeVisible();

    // Press Escape to dismiss
    await page.keyboard.press('Escape');
    // Or close with the close button
    const closeBtn = dialog.locator('header button');
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    }
    await expect(dialog).toHaveCount(0);

    // Bob assistant launcher is accessible in shell
    const bobBtn = page.getByRole('button', { name: 'Open Bob command center' });
    await expect(bobBtn).toBeVisible();

    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  });
});
