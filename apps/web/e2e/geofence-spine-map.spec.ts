import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T10:00:00+12:00'));
  await installSupabaseFixtures(page);
});

test('house map separates LINZ source geometry from runtime geofence decisions', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/locations');

  await expect(page.getByRole('heading', { name: 'Locations', exact: true })).toBeVisible();
  const map = page.getByRole('region', { name: 'Map for Civic Events House' });
  await expect(map.getByText('1 verified runtime zone')).toBeVisible();
  await expect(map.getByText('1 facet need boundary review')).toBeVisible();
  const canvas = map.locator('.house-map-canvas');
  await expect(canvas).toBeVisible();
  expect(await map.locator('.leaflet-overlay-pane path').count()).toBeGreaterThanOrEqual(2);
  const mapBox = await canvas.boundingBox();
  expect(mapBox?.width ?? 0).toBeGreaterThan(260);
  expect(mapBox?.height ?? 0).toBeGreaterThan(250);
  await canvas.click({ position: { x: Math.floor((mapBox?.width ?? 300) / 2), y: Math.floor((mapBox?.height ?? 300) / 2) } });
  const resolution = map.locator('.house-map-resolution');
  await expect(resolution).toContainText('resolved');
  await expect(resolution).toContainText('Civic Event Operations Zone');
  await expect(resolution).toContainText('On site');
  await expect(resolution).toContainText('static guarding');
  await expect(resolution).toContainText('2 resolved values');
  await expect(resolution).toContainText('restricted · Controlled loading access only');

  await map.getByRole('button', { name: 'Preview LINZ boundary' }).click();
  await expect(map.getByText('Read-only LINZ preview')).toBeVisible();
  await expect(map.getByText(/Exact parcel/)).toBeVisible();
  await expect(page).toHaveScreenshot('geofence-house-runtime.png');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('Site page retains its canonical house and sibling Zone geometry', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/site-360?site=42424242-4242-4242-8242-424242424242');

  await expect(page.getByRole('heading', { name: 'Sites', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Map for Civic Events House' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Zone page retains legal authority, closure, and house geometry', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/zones?zone=66666666-6666-4666-8666-666666666666');

  await expect(page.getByRole('heading', { name: 'Zones', exact: true })).toBeVisible();
  await expect(page.getByText('Operations plan section 4')).toBeVisible();
  await expect(page.getByText('Controlled loading access only')).toBeVisible();
  await expect(page.getByText('admin first')).toBeVisible();
  await expect(page.getByText(/"start":"18:00"/)).toBeVisible();
  await expect(page.getByText('Version 3')).toBeVisible();
  await expect(page.getByText('Operations administrator verified the council boundary on the map')).toBeVisible();
  await expect(page.getByText(/council_gis · verification/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Map for Civic Events House' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});