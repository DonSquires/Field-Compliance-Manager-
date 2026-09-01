import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('leave decision notification opens the exact request and admin outcome', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/leave?leave=36363636-3636-4636-8636-363636363636');

  const request = page.locator('#officer-leave-36363636-3636-4636-8636-363636363636');
  await expect(request).toHaveClass(/is-context-focus/);
  await expect(request.getByText('declined', { exact: true })).toBeVisible();
  await expect(request.getByText(/Decision note:.*Coverage is already committed for these dates/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});