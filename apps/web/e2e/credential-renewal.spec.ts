import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
});

test('administrator records a verified credential renewal and preserves source history', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/people-hr?tab=credentials&credential=35353535-3535-4535-8535-353535353535');

  await expect(page.getByRole('heading', { name: 'Credentials (2)' })).toBeVisible();
  const source = page.locator('#credential-35353535-3535-4535-8535-353535353535');
  await expect(source).toHaveClass(/is-context-focus/);
  await source.getByRole('button', { name: 'Record renewal' }).click();

  const dialog = page.getByRole('dialog', { name: 'Record renewal' });
  await expect(dialog.getByRole('button', { name: 'Confirm renewal' })).toBeDisabled();
  await dialog.getByLabel('Credential number').fill('FA-2027-1024');
  await dialog.getByLabel('Issuing authority').fill('Red Cross New Zealand');
  await dialog.getByLabel('Issued date').fill('2026-08-30');
  await dialog.getByLabel('New expiry date').fill('2027-09-10');
  await dialog.getByLabel('Verification evidence notes').fill('Renewal certificate checked against the issuing authority record.');
  await dialog.getByRole('button', { name: 'Confirm renewal' }).click();

  await expect(page.getByRole('status')).toContainText('Jordan Lee credential renewal recorded and verified · receipt 85858585.');
  await expect(page.getByRole('heading', { name: 'Credentials (3)' })).toBeVisible();
  await expect(page.getByText('FA-1024', { exact: true })).toBeVisible();
  await expect(page.getByText('FA-2027-1024', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});