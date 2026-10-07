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
  if (!isMobile) {
    await expect(navigation.getByRole('button', { name: 'Guarding & Patrol', exact: true })).toBeVisible();
    await expect(navigation.getByRole('button', { name: 'HR & Rostering', exact: true })).toBeVisible();
    await navigation.getByRole('button', { name: 'CRM & Clients', exact: true }).click();
    navigation = page.getByRole('navigation', { name: 'Workspace sections', exact: true });
  } else {
    await expect(navigation.getByText('Clients & Delivery')).toBeVisible();
  }
  await expect(navigation.getByRole('button', { name: 'Client Portfolios' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Set up a new client' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Start delivery' })).toBeVisible();
  if (isMobile) {
    await expect(navigation.getByText('Finance', { exact: true })).toBeVisible();
    await expect(navigation.getByRole('button', { name: 'Finance home' })).toBeVisible();
  }

  await navigation.getByRole('button', { name: 'Set up a new client' }).click();
  await expect(page.getByRole('heading', { name: 'Set up a new client' })).toBeVisible();
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.locator(isMobile ? '.admin-mobile-drawer' : '.admin-workspace-bar').getByRole('button', { name: 'Start delivery' }).click();
  await expect(page.getByRole('heading', { name: 'Start delivery' })).toBeVisible();
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    if (!isMobile) await page.getByRole('navigation', { name: 'Admin workspaces' }).getByRole('button', { name: 'Finance', exact: true }).click();
    else await page.locator('.admin-mobile-drawer').getByRole('button', { name: 'Finance home' }).click();
  await expect(page.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible();
  if (!isMobile) {
    await expect(page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('button', { name: 'Pay & charge rules' })).toBeVisible();
    await page.getByRole('navigation', { name: 'Admin workspaces' }).getByRole('button', { name: 'Guarding & Patrol', exact: true }).click();
    const sections = page.getByRole('navigation', { name: 'Workspace sections' });
    await sections.getByRole('button', { name: 'Dispatch console', exact: true }).click();
    await expect(page).toHaveURL(/area=dispatch/);
    await sections.getByRole('button', { name: 'Patrol operations', exact: true }).click();
    await expect(page).toHaveURL(/area=patrol/);
    await page.reload();
    await expect(sections.getByRole('button', { name: 'Patrol operations', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.admin-workspace-selector button[aria-current="page"]')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Patrol evidence', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/admin-workspace-desktop.png', fullPage: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
