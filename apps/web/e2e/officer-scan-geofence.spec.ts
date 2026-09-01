import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T20:00:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('officer scan keeps rule verdict and Zone closure evidence distinct', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/freedom_camping');

  await expect(page.getByRole('heading', { name: 'Vehicle scan' })).toBeVisible();
  await page.getByLabel(/Plate number/).fill('ABC123');
  await page.getByLabel(/Zone/).selectOption('66666666-6666-4666-8666-666666666666');
  await page.getByRole('button', { name: 'Process scan' }).click();

  await expect(page.getByText('Compliant', { exact: true })).toBeVisible();
  const warning = page.getByRole('alert').filter({ hasText: 'Zone closure in force' });
  await expect(warning).toContainText('restricted');
  await expect(warning).toContainText('Controlled loading access only');
  await expect(warning).toContainText('compliance verdict remains rule-derived');
  expect(errors, errors.join('\n')).toEqual([]);
});