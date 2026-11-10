import { expect, test, type Page } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const ZONE_ID = '66666666-6666-4666-8666-666666666666';

for (const moduleKey of ['parking_enforcement', 'freedom_camping']) {
  test(`working-zone setup saves and reloads a source-backed ${moduleKey} policy`, async ({ page }, testInfo) => {
    const policyZoneId = '98989898-9898-4898-8898-989898989898';
    let version = 1;
    let savedPolicy: Record<string, unknown> | null = null;
    const zone = { id: policyZoneId, name: 'Synthetic policy working zone', zone_type: moduleKey === 'parking_enforcement' ? 'parking' : 'freedom_camping', module_key: moduleKey,
      rule_type: moduleKey === 'parking_enforcement' ? 'restricted' : 'overnight_limited', is_active: true, configuration_version: 1,
      nightly_limit_consecutive: null, nightly_limit_monthly: null, scv_required: false, enforcement_workflow_override: null };
    await page.route('**/rest/v1/rpc/get_crm_operational_place_editor', (route) => route.fulfill({ json: {
      location: { id: '65656565-6565-4565-8565-656565656565', name: 'Civic Events House', organization_id: '40404040-4040-4040-8040-404040404040' },
      sites: [], zones: [{ ...zone, configuration_version: version }], modules: [{ module_key: moduleKey, display_name: moduleKey }], closures: [],
    } }));
    const receipt = () => ({ zone_id: policyZoneId, module_key: moduleKey, organization_id: '40404040-4040-4040-8040-404040404040', configuration_version: version, configured: savedPolicy !== null, policy_version: savedPolicy ? version : null, policy: savedPolicy ?? {} });
    await page.route('**/rest/v1/rpc/get_working_zone_policy', (route) => route.fulfill({ json: receipt() }));
    await page.route('**/rest/v1/rpc/save_working_zone_policy', async (route) => {
      const body = route.request().postDataJSON();
      expect(body.p_zone_id).toBe(policyZoneId);
      expect(body.p_expected_version).toBe(1);
      expect(body.p_policy.source_confirmed).toBe(true);
      expect(body.p_policy.source_ref).toBe('Synthetic council policy clause 4');
      savedPolicy = body.p_policy;
      version += 1;
      await route.fulfill({ json: receipt() });
    });
    await signInAsAdmin(page, '/admin/locations');
    await page.getByRole('button', { name: 'Manage location' }).click();
    let manager = page.getByRole('dialog', { name: 'Manage Civic Events House' });
    await manager.getByRole('button', { name: /2\. Work areas/ }).click();
    let policy = manager.getByRole('group', { name: moduleKey === 'parking_enforcement' ? 'Parking working-zone policy' : 'Freedom Camping working-zone policy' });
    await expect(policy.getByText('Policy not configured', { exact: true })).toBeVisible();
    if (moduleKey === 'parking_enforcement') {
      await policy.getByLabel('Posted limit in minutes').fill('90');
      await policy.getByLabel('Disabled-bay multiplier').fill('2');
      await policy.getByLabel('Photograph of posted sign').setInputFiles({ name: 'synthetic-sign.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('synthetic-fixture-sign') });
    } else {
      await policy.getByLabel('Consecutive-night limit').fill('2');
      await policy.getByLabel('Monthly-night limit').fill('4');
      await policy.getByLabel('Self-contained vehicle requirement applies').check();
      await policy.getByLabel('Policy wording / notes').fill('Synthetic test policy, not operational authority.');
    }
    await policy.getByLabel('Policy source / clause').fill('Synthetic council policy clause 4');
    await expect(policy.getByRole('button', { name: 'Save working-zone policy' })).toBeDisabled();
    await policy.getByRole('checkbox', { name: /I checked these rules/ }).check();
    await policy.getByRole('button', { name: 'Save working-zone policy' }).click();
    await expect(policy.getByText('Policy version 2', { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: 'Close operational setup' }).click();
    await page.getByRole('button', { name: 'Manage location' }).click();
    manager = page.getByRole('dialog', { name: 'Manage Civic Events House' });
    await manager.getByRole('button', { name: /2\. Work areas/ }).click();
    policy = manager.getByRole('group', { name: moduleKey === 'parking_enforcement' ? 'Parking working-zone policy' : 'Freedom Camping working-zone policy' });
    await expect(policy.getByLabel('Policy source / clause')).toHaveValue('Synthetic council policy clause 4');
    await expect(policy.getByLabel(moduleKey === 'parking_enforcement' ? 'Posted limit in minutes' : 'Consecutive-night limit')).toHaveValue(moduleKey === 'parking_enforcement' ? '90' : '2');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await policy.screenshot({ path: testInfo.outputPath(`${moduleKey}-working-zone-policy.png`) });
  });
}

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