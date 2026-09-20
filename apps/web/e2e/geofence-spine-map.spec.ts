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
  await expect(map.getByText('Read-only LINZ land-lot preview')).toBeVisible();
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
  // The stored schedule {days:[1..5], start 18:00, end 06:00} reads as words, Monday first, overnight named.
  const schedule = page.getByRole('region', { name: 'Zone active schedule' });
  await expect(schedule).toContainText('Mon–Fri, 18:00–06:00 (overnight)');
  await expect(page.locator('.zone-facts article').filter({ hasText: 'Active schedule' })).toContainText('Mon–Fri, 18:00–06:00 (overnight)');
  await schedule.getByRole('button', { name: 'Edit schedule' }).click();
  const form = schedule.getByRole('form', { name: 'Edit active schedule' });
  await form.getByRole('button', { name: 'Weekends' }).click();
  await form.locator('.zone-schedule-toggles.is-months label').filter({ hasText: 'Dec' }).click();
  await form.locator('.zone-schedule-toggles.is-months label').filter({ hasText: 'Jan' }).click();
  await expect(form.locator('.zone-schedule-preview')).toContainText('This zone will be: Sat, Sun, 18:00–06:00 (overnight), Dec, Jan');
  await form.locator('label:has(> span:text-is("Until")) input').fill('');
  await expect(form.locator('.zone-schedule-preview')).toContainText('Give both a start and an end time');
  await expect(form.getByRole('button', { name: 'Save schedule' })).toBeDisabled();
  await form.locator('label:has(> span:text-is("Until")) input').fill('06:00');
  await form.getByRole('button', { name: 'Save schedule' }).click();
  await expect(schedule.getByRole('status')).toContainText('Saved: Sat, Sun, 18:00–06:00 (overnight), Dec, Jan (version 2). Outside this schedule the zone does not trigger static guarding and officers cannot pick it by hand.');
  await expect(schedule.locator('header')).toContainText('Sat, Sun, 18:00–06:00 (overnight), Dec, Jan');
  await expect(page.getByText('Version 3')).toBeVisible();
  await expect(page.getByText('Operations administrator verified the council boundary on the map')).toBeVisible();
  await expect(page.getByText(/council_gis · verification/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Map for Civic Events House' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});