import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test('vehicle search opens in its own movable window without the admin navigation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'A second-screen window is a desktop workflow.');
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { officerModules: ['freedom_camping', 'parking_enforcement'] });
  await signInAsAdmin(page, '/admin/field-ops?area=vehicle-search');
  await expect(page.getByRole('heading', { name: 'Vehicle Search & Flags' })).toBeVisible();

  const [fromHeader] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: 'Open in new window' }).click(),
  ]);
  await expect.poll(() => fromHeader.url()).toContain('/admin/field-ops?area=vehicle-search&popout=1');
  expect(await fromHeader.evaluate(() => window.opener)).toBeNull();

  // The top-bar shortcut reuses the same named window instead of stacking new ones.
  const reused = page.waitForEvent('popup', { timeout: 1500 }).then(() => true).catch(() => false);
  await page.getByRole('button', { name: 'Open vehicle search in its own window' }).click();
  expect(await reused).toBe(false);
  await fromHeader.close();

  // The same URL, loaded with the session and fixtures, renders only the vehicle search page.
  await page.goto('/admin/field-ops?area=vehicle-search&popout=1');
  await expect(page.getByRole('heading', { name: 'Vehicle Search & Flags' })).toBeVisible();
  await expect(page.getByText('Separate window')).toBeVisible();
  await expect(page.locator('.admin-shell-main.is-vehicle-search-popout')).toBeVisible();
  await expect(page.locator('.admin-sidebar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open in new window' })).toHaveCount(0);
  await expect(page.getByLabel('Registration search')).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
