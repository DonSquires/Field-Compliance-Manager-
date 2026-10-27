import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin, signInAsOfficer } from './fixtures';
import { SPECIALTY_MODULES } from '../src/config/specialtyModules';

test('officer module directory requires both a direct grant and organisation entitlement', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  await signInAsOfficer(page, '/officer/modules');

  await expect(page.getByRole('heading', { name: 'Enabled modules' })).toBeVisible();
  await expect(page.getByText('No enabled field modules are available.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Welfare' })).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('enabled module cards keep actions in bounds and expose standalone routes only when supported', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { officerModules: ['patrol', 'freedom_camping', 'biosecurity', 'parking', 'smoke_control'] });
  await signInAsOfficer(page, '/officer/modules');

  const cards = page.locator('.officer-module-card');
  await expect(cards).toHaveCount(5);
  const layout = await cards.evaluateAll((elements) => elements.map((card) => {
    const cardBounds = card.getBoundingClientRect();
    const actions = Array.from(card.querySelectorAll('button')).map((button) => {
      const bounds = button.getBoundingClientRect();
      const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return {
        label: button.textContent?.trim(),
        contained: bounds.left >= cardBounds.left - 1 && bounds.right <= cardBounds.right + 1,
        receivesPointer: Boolean(target && button.contains(target)),
      };
    });
    return { label: card.querySelector('strong')?.textContent, actions };
  }));
  expect(layout.flatMap((card) => card.actions).every((action) => action.contained && action.receivesPointer)).toBe(true);

  const patrolCard = cards.filter({ hasText: 'Patrol' }).first();
  await expect(patrolCard.getByRole('button', { name: 'Open standalone app' })).toHaveCount(0);
  const campingCard = cards.filter({ hasText: 'Freedom Camping' });
  const standaloneButton = campingCard.getByRole('button', { name: 'Open standalone app' });
  await standaloneButton.click();
  await expect(page).toHaveURL(/\/modules\/freedom_camping$/);
  await expect(page.getByText('Standalone module')).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('the standalone access-control route renders its wired officer workflow', async ({ page }) => {
  await installSupabaseFixtures(page, { officerModules: ['access_control'] });
  await page.route('**/rest/v1/rpc/resolve_active_rules', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ organization_id: '33333333-3333-4333-8333-333333333333', module_key: 'access_control', enabled: true }]) });
  });
  await signInAsOfficer(page, '/modules/access_control');

  await expect(page.getByText('Standalone module')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Access control', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Access-control authority' })).toBeVisible();
});

test('the standalone access-control route does not expose officer event entry to admins', async ({ page }) => {
  await installSupabaseFixtures(page, { officerModules: ['access_control'] });
  await page.route('**/rest/v1/rpc/resolve_active_rules', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ organization_id: '33333333-3333-4333-8333-333333333333', module_key: 'access_control', enabled: true }]) });
  });
  await signInAsAdmin(page, '/admin/hub');
  await page.goto('/modules/access_control');

  await expect(page.getByText('Access-control event entry is not available in the Admin portal.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Capture access evidence' })).toHaveCount(0);
});

test('every advertised standalone specialty route renders officer page content', async ({ page }) => {
  await installSupabaseFixtures(page, {
    officerModules: SPECIALTY_MODULES.map((module) => module.integratedKey),
  });
  await page.route('**/rest/v1/rpc/resolve_active_rules', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SPECIALTY_MODULES.map((module) => ({
        organization_id: '33333333-3333-4333-8333-333333333333',
        module_key: module.key,
        enabled: true,
      }))),
    });
  });
  await page.route('**/rest/v1/rpc/get_officer_static_post', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  await signInAsOfficer(page, SPECIALTY_MODULES[0].standalonePath);

  for (const module of SPECIALTY_MODULES) {
    await page.goto(module.standalonePath);
    await expect(page.locator('.module-shell-title').getByText(module.label, { exact: true })).toBeVisible();
    await expect(page.locator('.module-shell-content').getByRole('heading').first()).toBeVisible();
  }
});

test('a canonical module tick opens the officer page instead of a dead end', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { officerModules: ['parking_enforcement'] });
  await signInAsOfficer(page, '/officer/modules');

  const cards = page.locator('.officer-module-card');
  await expect(cards).toHaveCount(1);
  await cards.getByRole('button', { name: /Parking Enforcement/ }).click();
  await expect(page).toHaveURL(/\/officer\/parking$/);
  await expect(page.getByRole('heading', { name: 'Parking', exact: true })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

for (const configured of [true, false]) {
  test(`admin officer can discover and open modules without personal ticks (configured: ${configured})`, async ({ page }) => {
    await page.addInitScript(() => window.sessionStorage.setItem('fcm.admin_officer.portal', 'officer'));
    await installSupabaseFixtures(page, { adminRole: 'admin_officer', officerModules: ['noise_control'] });
    if (!configured) {
      await page.route('**/rest/v1/organization_modules*', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      });
    }
    await signInAsAdmin(page, '/officer/modules');
    await expect(page.locator('.officer-module-card').getByRole('button', { name: /Person search/ })).toBeVisible();
    await page.locator('.officer-module-card').getByRole('button', { name: /Noise Control/ }).click();
    await expect(page).toHaveURL(/\/officer\/noise_control$/);
    await expect(page.getByRole('heading', { name: 'Noise Control', exact: true })).toBeVisible();
  });
}

test('place rules supply context but never block a ticked, organisation-enabled module', async ({ page }) => {
  await installSupabaseFixtures(page, { officerModules: ['noise_control'] });
  await page.route('**/rest/v1/rpc/resolve_active_rules', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ organization_id: '33333333-3333-4333-8333-333333333333', module_key: 'noise_control', enabled: false, policy_status: 'active', resolution_status: 'outside_all_geofences' }]) });
  });
  await signInAsOfficer(page, '/officer/noise_control');
  await expect(page).toHaveURL(/\/officer\/noise_control$/);
  await expect(page.getByRole('heading', { name: 'Noise Control', exact: true })).toBeVisible();

  await page.goto('/modules/noise_control');
  await expect(page.locator('.module-shell-title').getByText('Noise Control', { exact: true })).toBeVisible();
});

test('a canonical OFF switch cannot be overridden by an enabled route alias', async ({ page }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/organization_modules*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { module_key: 'parking_enforcement', enabled: false }, { module_key: 'parking', enabled: true },
    ]) });
  });
  await signInAsOfficer(page, '/officer/parking');
  await expect(page).toHaveURL(/\/officer$/);
  await page.goto('/modules/parking_enforcement');
  await expect(page).toHaveURL(/\/officer$/);
});

test('an organisation-enabled module without the personal tick stays closed', async ({ page }) => {
  // The fixture organisation enables workshop; the fixture officer holds no workshop tick.
  await installSupabaseFixtures(page);
  await signInAsOfficer(page, '/officer/workshop');
  await expect(page).toHaveURL(/\/officer$/);
  await page.goto('/officer/modules');
  await expect(page.getByText('No enabled field modules are available.')).toBeVisible();
});