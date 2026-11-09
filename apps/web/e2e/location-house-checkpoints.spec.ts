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