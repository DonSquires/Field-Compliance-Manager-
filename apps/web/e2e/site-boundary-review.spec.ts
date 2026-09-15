import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T08:45:00+12:00'));
  await installSupabaseFixtures(page);
});

test('operations proposes, inspects and verifies a site boundary through the geofence workbench', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/sites');
  const notice = page.locator('.boundary-message.is-success');

  await expect(page.getByRole('heading', { name: 'Geofence workbench' })).toBeVisible();
  await expect(page.getByText('No geometry', { exact: true }).locator('..').getByText('1')).toBeVisible();
  await expect(page.getByText('Open proposals').locator('..').getByText('0')).toBeVisible();

  await page.getByRole('button', { name: /North Pavilion/ }).click();
  await expect(page.getByText('Geometry required')).toBeVisible();
  await expect(page.getByText('unresolved_no_geofence')).toBeVisible();
  await expect(page.getByLabel('Boundary map for North Pavilion')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suggest boundary from LINZ' })).toBeEnabled();

  await page.getByRole('tab', { name: 'Point + radius' }).click();
  await page.getByLabel('Latitude').fill('-41.2762');
  await page.getByLabel('Longitude').fill('173.2817');
  await page.getByLabel('Radius in metres').fill('75');
  await page.getByRole('button', { name: 'Propose point-radius boundary' }).click();

  await expect(notice).toContainText('Point + radius (provisional) proposed for North Pavilion');
  await expect(page.getByText('Proposal awaiting decision')).toBeVisible();
  await expect(page.getByText('Open proposals').locator('..').getByText('1')).toBeVisible();
  await expect(page.getByText('Within band')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject proposal' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Accept boundary' })).toBeEnabled();

  await page.getByText('I inspected the full boundary against the site address.').click();
  await page.getByRole('button', { name: 'Accept and verify boundary' }).click();
  await expect(notice).toContainText('verified from visual map review');
  await expect(page.getByText('Verified boundary')).toBeVisible();
  await expect(page.getByText('provisional provenance')).toBeVisible();
  await expect(page.getByText('Boundary verified via visual map confirmation')).toBeVisible();
  await expect(page.getByText(/Accepted boundary proposal .* \(google_point_radius\)/)).toBeVisible();
  await page.getByRole('heading', { name: 'Geofence workbench' }).scrollIntoViewIfNeeded();
  await expect(page).toHaveScreenshot('site-boundary-review.png', { fullPage: true });
  expect(errors, errors.join('\n')).toEqual([]);
});