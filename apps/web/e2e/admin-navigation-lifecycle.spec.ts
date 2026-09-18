import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await installSupabaseFixtures(page); });

test('admin navigation groups client delivery and finance in the order work happens', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/hub');

  const isMobile = await page.evaluate(() => window.innerWidth < 768);
  let navigation = page.locator('.admin-sidebar');
  if (isMobile) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    navigation = page.locator('.admin-mobile-drawer');
  }
  await expect(navigation.getByText('Clients & Delivery')).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Client Portfolios' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Set up a new client' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Start delivery' })).toBeVisible();
  await expect(navigation.getByText('Finance', { exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Finance home' })).toBeVisible();

  await navigation.getByRole('button', { name: 'Set up a new client' }).click();
  await expect(page.getByRole('heading', { name: 'Set up a new client' })).toBeVisible();
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.locator(isMobile ? '.admin-mobile-drawer' : '.admin-sidebar').getByRole('button', { name: 'Start delivery' }).click();
  await expect(page.getByRole('heading', { name: 'Start delivery' })).toBeVisible();
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.locator(isMobile ? '.admin-mobile-drawer' : '.admin-sidebar').getByRole('button', { name: 'Finance home' }).click();
  await expect(page.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
