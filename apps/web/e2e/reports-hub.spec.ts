import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
});

test('administrator generates tenant report packs with a visible receipt', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/reports');

  await expect(page.getByRole('heading', { name: 'Reports & Analytics' })).toBeVisible();
  await expect(page.getByText('No report packs in this period')).toBeVisible();
  await page.getByRole('button', { name: 'Generate report packs' }).click();

  await expect(page.getByRole('status')).toContainText('1 report packs generated for the selected period.');
  const packs = page.getByRole('heading', { name: 'Monthly Report Packs (1)' }).locator('..');
  await expect(packs.getByText('Civic Events Compliance Services')).toBeVisible();
  await expect(packs.getByText('generated', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});