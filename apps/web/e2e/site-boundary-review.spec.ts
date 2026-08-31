import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T08:45:00+12:00'));
  await installSupabaseFixtures(page);
});

test('operations triages and establishes provisional site boundary evidence', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/sites');

  await expect(page.getByRole('heading', { name: 'Boundary review' })).toBeVisible();
  await expect(page.getByText('Awaiting review').locator('..').getByText('1')).toBeVisible();
  await expect(page.getByText('No geometry').locator('..').getByText('1')).toBeVisible();

  await page.getByRole('button', { name: /North Pavilion/ }).click();
  await expect(page.getByText('Geometry required')).toBeVisible();
  await expect(page.getByText('No boundary to inspect')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify boundary' })).toBeDisabled();

  await page.getByLabel('Latitude').fill('-41.2762');
  await page.getByLabel('Longitude').fill('173.2817');
  await page.getByLabel('Radius in metres').fill('75');
  await page.getByRole('button', { name: 'Establish provisional boundary' }).click();

  await expect(page.getByRole('status')).toContainText('provisional point-radius boundary');
  await expect(page.getByText('Visual review required')).toBeVisible();
  await expect(page.getByText('Site geometry set via set_site_geometry')).toBeVisible();
  await expect(page.getByLabel('Boundary map for North Pavilion')).toBeVisible();
  await page.getByText('I inspected the full boundary against the site address.').click();
  await page.getByRole('button', { name: 'Verify boundary' }).click();
  await expect(page.getByRole('status')).toContainText('boundary verified from visual map review');
  await expect(page.getByText('Verified boundary')).toBeVisible();
  await expect(page.getByText('Boundary verified via visual map confirmation')).toBeVisible();
  await page.getByRole('heading', { name: 'Boundary review' }).scrollIntoViewIfNeeded();
  await expect(page).toHaveScreenshot('site-boundary-review.png', { fullPage: true });
  expect(errors, errors.join('\n')).toEqual([]);
});