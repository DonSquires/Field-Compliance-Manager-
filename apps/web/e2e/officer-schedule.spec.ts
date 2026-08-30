import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('officer schedule and coverage claim are visually correct and operational', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page);
  await expect(page.getByRole('heading', { name: 'My schedule' })).toBeVisible();
  await expect(page.getByText('North district patrol')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.officer-schedule')).toHaveScreenshot('officer-schedule-assigned.png');

  await page.getByRole('tab', { name: /Open coverage/ }).click();
  await expect(page.getByText('Civic Events Centre')).toBeVisible();
  await page.getByRole('button', { name: 'Review claim' }).click();
  const dialog = page.getByRole('dialog', { name: 'Claim this shift?' });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds && viewport && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height).toBe(true);
  await expect(dialog).toHaveScreenshot('officer-schedule-claim-dialog.png');
  await dialog.getByRole('button', { name: 'Confirm claim' }).click();
  await expect(page.getByText('Coverage claim confirmed.')).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});