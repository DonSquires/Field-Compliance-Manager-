import { expect, test, type Page } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const ZONE_ID = '66666666-6666-4666-8666-666666666666';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T08:45:00+12:00'));
  await installSupabaseFixtures(page);
});

async function openHouseCheckpoints(page: Page) {
  await signInAsAdmin(page, '/admin/sites');
  await expect(page.getByRole('heading', { name: 'Locations', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Geofence workbench' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage location' }).click();
  const manager = page.getByRole('dialog', { name: 'Manage Civic Events House' });
  await expect(manager).toBeVisible();
  await manager.getByRole('button', { name: /4\. Checkpoints/ }).click();
  return manager;
}

async function clickMap(page: Page, xFraction: number) {
  const map = page.locator('.place-manager-checkpoint-layout .house-map-canvas');
  await expect(map).toBeVisible();
  await map.scrollIntoViewIfNeeded();
  const bounds = await map.boundingBox();
  if (!bounds) throw new Error('Location House map has no visible bounds.');
  await page.mouse.click(bounds.x + bounds.width * xFraction, bounds.y + bounds.height * 0.53);
}

test('legacy Sites entry places and verifies a Site checkpoint in Location House', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  const manager = await openHouseCheckpoints(page);

  await manager.getByRole('button', { name: 'Add checkpoint' }).click();
  await manager.getByLabel('Checkpoint name').fill('House Site Gate');
  await clickMap(page, 0.48);
  await manager.getByRole('button', { name: 'Place checkpoint' }).click();
  await expect(manager.getByText('Checkpoint placed. It remains unverified until its position is inspected on the map.')).toBeVisible();
  await expect(manager.getByRole('button', { name: /House Site Gate/ }).getByText('Unverified')).toBeVisible();

  await manager.getByLabel('Position inspected on the map').check();
  await manager.getByRole('button', { name: 'Verify checkpoint' }).click();
  await expect(manager.getByRole('button', { name: /House Site Gate/ }).getByText('Verified')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Location House edits a boundary as an unverified proposal before explicit confirmation', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/sites');
  await page.getByRole('button', { name: 'Manage location' }).click();
  const manager = page.getByRole('dialog', { name: 'Manage Civic Events House' });
  await manager.getByRole('button', { name: /3\. Map boundaries/ }).click();
  const map = manager.getByRole('region', { name: 'Map for Civic Events House' });
  await expect(map.getByRole('button', { name: 'Adjust current boundary' })).toBeVisible();
  await map.getByRole('button', { name: 'Adjust current boundary' }).click();

  const vertex = map.locator('.leaflet-marker-icon.house-map-vertex:not(.is-midpoint)').first();
  const bounds = await vertex.boundingBox();
  if (!bounds) throw new Error('The selected boundary vertex is not visible on the map.');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 14, bounds.y + bounds.height / 2 + 9, { steps: 3 });
  await page.mouse.up();

  await map.getByRole('button', { name: 'Save boundary edit' }).click();
  await expect(map.getByRole('button', { name: 'Confirm this boundary' })).toBeVisible();
  await expect(map.getByRole('status')).toContainText('Review and confirm the revised shape');
  await map.getByRole('button', { name: 'Confirm this boundary' }).click();
  await expect(map.getByRole('status')).toContainText('Boundary confirmed. Officers can now use it for runtime location checks.');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Location House manages a Zone checkpoint on mobile and resets verification when it moves', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = monitorBrowserErrors(page);
  const manager = await openHouseCheckpoints(page);

  await manager.getByLabel('Checkpoint Site or Zone').selectOption(`zone:${ZONE_ID}`);
  await manager.getByRole('button', { name: 'Add checkpoint' }).click();
  await manager.getByLabel('Checkpoint name').fill('House Zone Checkpoint');
  await clickMap(page, 0.48);
  await manager.getByRole('button', { name: 'Place checkpoint' }).click();
  await manager.getByLabel('Position inspected on the map').check();
  await manager.getByRole('button', { name: 'Verify checkpoint' }).click();
  const checkpointRow = manager.getByRole('button', { name: /House Zone Checkpoint/ });
  await expect(checkpointRow.getByText('Verified')).toBeVisible();

  await checkpointRow.click();
  await manager.getByRole('button', { name: 'Move on map' }).click();
  await clickMap(page, 0.72);
  await manager.getByRole('button', { name: 'Save checkpoint' }).click();
  await expect(checkpointRow.getByText('Unverified')).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Verify checkpoint' })).toBeDisabled();
  expect(errors, errors.join('\n')).toEqual([]);
});