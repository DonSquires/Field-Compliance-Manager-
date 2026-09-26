import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const enabledOperationalModules = ['dispatch', 'cctv', 'static_guarding', 'freedom_camping', 'parking_enforcement'];

test('admin officer receives enabled response and review tools', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.addInitScript(() => window.sessionStorage.setItem('fcm.admin_officer.portal', 'admin'));
  await installSupabaseFixtures(page, { adminRole: 'admin_officer', officerModules: enabledOperationalModules });
  await signInAsAdmin(page, '/admin/field-ops?area=landing');

  await expect(page.getByRole('heading', { name: 'Operations workspace' })).toBeVisible();
  await expect(page.getByText('Respond now', { exact: true })).toBeVisible();
  await expect(page.getByText('Review and investigate', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Dispatch console/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^CCTV & video/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Import camera footage/ })).toHaveCount(0);
  await expect(page.locator('.field-ops-workflow')).toHaveCount(11);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('NZSCV monitor sees only vehicle compliance tools and no team metrics', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { adminRole: 'nzscv_monitor', officerModules: enabledOperationalModules });
  await signInAsAdmin(page, '/admin/field-ops?area=landing');

  await expect(page.getByRole('heading', { name: 'Vehicle compliance' })).toBeVisible();
  await expect(page.locator('.field-ops-metrics')).toHaveCount(0);
  await expect(page.locator('.field-ops-workflow')).toHaveCount(3);
  await expect(page.getByRole('button', { name: /^Breach review/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Vehicle intelligence/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Observation search/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Dispatch console/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Welfare response/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^CCTV & video/ })).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
