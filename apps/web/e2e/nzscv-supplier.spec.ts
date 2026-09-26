import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test('NZSCV supplier lands on aggregate usage and its public register', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'nzscv_monitor' });
  await signInAsAdmin(page, '/admin/hub');

  await expect(page).toHaveURL(/\/nzscv$/);
  await expect(page.getByRole('heading', { name: 'Registry use and data quality' })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('No client, officer, incident, location, photo, or raw source-row details are included.');
  await expect(page.getByText('58,902', { exact: true })).toBeVisible();
  await expect(page.getByText('1,873', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'ABC123' })).toBeVisible();
  await expect(page.locator('.admin-sidebar')).toHaveCount(0);

  await page.getByLabel('Search plate or certificate').fill('XYZ789');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'XYZ789' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'ABC123' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('grand master opens the supplier view from Platform Overview', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'grand_master' });
  await signInAsAdmin(page, '/admin/platform');

  await page.getByRole('button', { name: 'Open NZSCV supplier view' }).click();
  await expect(page).toHaveURL(/\/nzscv$/);
  await expect(page.getByRole('heading', { name: 'Registry use and data quality' })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('ordinary administrators cannot open the supplier portal', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'admin' });
  await signInAsAdmin(page, '/nzscv');

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Today at a glance' })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
