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
  await installSupabaseFixtures(page);
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