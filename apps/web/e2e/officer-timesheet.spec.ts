import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('timesheet decision notification opens the exact reviewed period', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/timesheet?timesheet=38383838-3838-4838-8838-383838383838');

  const timesheet = page.locator('#officer-timesheet-38383838-3838-4838-8838-383838383838');
  await expect(timesheet).toHaveClass(/is-context-focus/);
  await expect(timesheet.getByText('approved', { exact: true })).toBeVisible();
  await expect(timesheet.getByText(/Approved after reconciling the extended incident response/)).toBeVisible();
  await expect(timesheet.getByText(/30\/08\/2026/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});