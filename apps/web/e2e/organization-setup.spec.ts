import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

test('administrator configures the selected operating branch through governed controls', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/org-setup');
  await expect(page.getByRole('heading', { name: 'Organization Setup' })).toBeVisible();
  await expect(page.locator('.page-header').getByText('Harbour Compliance Services', { exact: true })).toBeVisible();
  const patrol = page.getByRole('heading', { name: 'patrol', exact: true }).locator('..');
  await expect(patrol).toHaveScreenshot('operating-branch-module.png');
  await patrol.getByRole('button', { name: 'Disabled' }).click();
  await expect(patrol.getByRole('button', { name: 'Enabled' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});