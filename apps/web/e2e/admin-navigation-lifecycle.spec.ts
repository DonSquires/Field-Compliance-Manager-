import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await installSupabaseFixtures(page, { officerModules: ['dispatch', 'patrol', 'static_guarding'] }); });

test('admin navigation keeps client setup simple and follow-up work optional', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/hub');

  const isMobile = await page.evaluate(() => window.innerWidth < 768);
  if (isMobile) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const navigation = page.locator('.admin-mobile-drawer');
    await expect(navigation.getByText('Clients & Delivery')).toBeVisible();
    await expect(navigation.getByRole('button', { name: 'Clients' })).toBeVisible();
    await expect(navigation.getByRole('button', { name: 'Agreements & services' })).toBeVisible();
    await expect(navigation.getByRole('button', { name: 'Activation checklist' })).toBeVisible();
    await expect(navigation.getByRole('button', { name: 'Service handoffs' })).toBeVisible();
    await expect(navigation.getByRole('button', { name: 'Finance home' })).toBeVisible();
    await navigation.getByRole('button', { name: 'Clients' }).click();
  }
  else {
    const navigation = page.locator('.admin-sidebar');
    await expect(navigation.getByRole('button', { name: 'Guarding & Patrol', exact: true })).toBeVisible();
    await expect(navigation.getByRole('button', { name: 'HR & Rostering', exact: true })).toBeVisible();
    await navigation.getByRole('button', { name: 'CRM & Clients', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'Client directory' })).toBeVisible();
  await expect(page.locator('.workflow-rail, .workflow-rail-select')).toHaveCount(0);
  const followUp = page.getByRole('navigation', { name: 'Client follow-up work' });
  const viewportWidth = page.viewportSize()?.width ?? 0;
  for (const name of ['Agreements & services', 'Activation checklist', 'Service handoffs']) {
    const link = followUp.getByRole('button', { name });
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0), `${name} stays inside the viewport`).toBeLessThanOrEqual(viewportWidth);
  }
  await page.getByRole('button', { name: 'Set up a new client' }).click();
  await expect(page.getByRole('heading', { name: 'Add client' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Client details' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Locations' })).toBeVisible();

  await page.goto('/admin/crm');
  await expect(page.getByRole('heading', { name: 'Client directory' })).toBeVisible();
  await followUp.getByRole('button', { name: 'Activation checklist' }).click();
  await expect(page.getByRole('heading', { name: 'Clients being set up' })).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Workspace sections' });
  await expect(page.locator('.workflow-rail, .workflow-rail-select')).toHaveCount(0);
  if (isMobile) {
    const destinations = page.getByRole('combobox', { name: 'Workspace destination' });
    await expect(destinations.locator('option', { hasText: 'Activation checklist' })).toHaveCount(1);
    await expect(destinations.locator('option', { hasText: 'Service handoffs' })).toHaveCount(1);
    await destinations.selectOption({ label: 'Service handoffs' });
  } else {
    await expect(sections.getByRole('button', { name: 'Activation checklist' })).toBeVisible();
    await expect(sections.getByRole('button', { name: 'Service handoffs' })).toBeVisible();
    await sections.getByRole('button', { name: 'Service handoffs' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Start delivery' })).toBeVisible();

  if (isMobile) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.locator('.admin-mobile-drawer').getByRole('button', { name: 'Finance home' }).click();
  } else {
    await page.getByRole('navigation', { name: 'Admin workspaces' }).getByRole('button', { name: 'Finance', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'Finance' })).toBeVisible();
  if (!isMobile) {
    await page.getByRole('navigation', { name: 'Admin workspaces' }).getByRole('button', { name: 'Guarding & Patrol', exact: true }).click();
    const sections = page.getByRole('navigation', { name: 'Workspace sections' });
    await sections.getByRole('button', { name: 'Dispatch console', exact: true }).click();
    await expect(page).toHaveURL(/area=dispatch/);
    await sections.getByRole('button', { name: 'Patrol operations', exact: true }).click();
    await expect(page).toHaveURL(/area=patrol/);
    await page.reload();
    await expect(sections.getByRole('button', { name: 'Patrol operations', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.admin-workspace-selector button[aria-current="page"]')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Patrol evidence', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/admin-workspace-desktop.png', fullPage: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('mobile Finance operating-spine control opens Finance Home', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'Desktop Admin uses the workspace sidebar; the operating-spine ribbon is mobile-only.');
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/crm');
  const financeControl = page.getByRole('navigation', { name: 'Operating spine' }).getByRole('button', { name: 'Finance Rates & billing' });
  await expect(financeControl).toBeVisible();
  await financeControl.click();
  await expect(page).toHaveURL(/\/admin\/finance-bureau$/);
  await expect(page.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Field Operations navigation exposes enabled areas and explains disabled direct routes', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/organization_modules**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'abababab-abab-4bab-8bab-ababababab11', module_key: 'dispatch', enabled: true },
        { id: 'abababab-abab-4bab-8bab-ababababab12', module_key: 'cctv', enabled: false },
        { id: 'abababab-abab-4bab-8bab-ababababab13', module_key: 'welfare', enabled: false },
      ]),
    });
  });

  await signInAsAdmin(page, '/admin/field-ops?area=cctv-console');
  await expect(page).toHaveURL(/\/admin\/field-ops$/);
  await expect(page.getByRole('heading', { name: 'Field Operations' })).toBeVisible();
  await expect(page.locator('.admin-access-notice[role="alert"]')).toContainText('not enabled');

  const isMobile = await page.evaluate(() => window.innerWidth < 768);
  let navigation = page.getByRole('navigation', { name: 'Workspace sections' });
  if (isMobile) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    navigation = page.locator('.admin-mobile-drawer');
  }
  await expect(navigation.getByRole('button', { name: 'Dispatch console', exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Video evidence', exact: true })).toHaveCount(0);
  await navigation.getByRole('button', { name: 'Dispatch console', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/field-ops\?area=dispatch/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('retired Admin route does not silently render Overview under a stale URL', async ({ page }) => {
  await signInAsAdmin(page, '/admin/site-ownership');
  await expect(page).toHaveURL(/\/admin\/hub$/);
  await expect(page.getByRole('heading', { name: 'Today at a glance' })).toBeVisible();
  await expect(page.locator('.admin-access-notice[role="alert"]')).toContainText('page is unavailable');
});

test('legacy platform billing route opens a filterable provider ledger for a platform operator', async ({ page }) => {
  await page.route('**/rest/v1/user_profiles**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: '11111111-1111-4111-8111-111111111111', display_name: 'Platform Operator', email: 'admin@fcm.test', role: 'grand_master', organization_id: '33333333-3333-4333-8333-333333333333', employer_organization_id: '33333333-3333-4333-8333-333333333333', module_access: [] }]),
    });
  });
  await page.route('**/rest/v1/org_module_subscriptions**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { id: 'abababab-abab-4bab-8bab-ababababab21', organization_id: '33333333-3333-4333-8333-333333333333', module_key: 'dispatch', base_price: 100, per_seat_price: 5, per_site_price: 0, discount_pct: 0, billing_period: 'monthly', currency: 'NZD', status: 'active', started_at: '2026-01-01', updated_at: '2026-08-01T00:00:00.000Z', effective_from: null, effective_to: null, notes: 'Alarm response subscription' },
      { id: 'abababab-abab-4bab-8bab-ababababab22', organization_id: '33333333-3333-4333-8333-333333333333', module_key: 'patrol', base_price: 250, per_seat_price: 0, per_site_price: 10, discount_pct: 5, billing_period: 'annual', currency: 'NZD', status: 'suspended', started_at: '2025-01-01', updated_at: '2026-07-01T00:00:00.000Z', effective_from: null, effective_to: null, notes: 'Mobile patrol coverage' },
    ]) });
  });
  await page.route('**/rest/v1/organizations**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '33333333-3333-4333-8333-333333333333', name: 'Harbour Compliance Services' }]) });
  });
  await signInAsAdmin(page, '/admin/platform-billing');
  await expect(page).toHaveURL(/\/admin\/platform-subscriptions$/);
  await expect(page.getByRole('heading', { name: 'Iron Eagle Platform Billing' })).toBeVisible();
  await expect(page.getByText('Harbour Compliance Services').last()).toBeVisible();
  await expect(page.getByText('33333333-3333-4333-8333-333333333333')).toHaveCount(0);
  if (await page.evaluate(() => window.innerWidth < 768)) await expect(page.getByText('Scroll the table horizontally to review all pricing and actions.')).toBeVisible();
  const tableRegion = page.getByRole('region', { name: 'Provider module subscriptions' });
  await expect(tableRegion.getByRole('row')).toHaveCount(3);
  await expect(page).toHaveScreenshot('provider-billing-ledger.png');
  const search = page.getByRole('searchbox', { name: 'Search provider subscriptions' });
  await search.fill('dispatch');
  await expect(tableRegion.getByRole('row')).toHaveCount(2);
  await expect(tableRegion).toContainText('Dispatch');
  await search.fill('Alarm response subscription');
  await expect(tableRegion.getByRole('row')).toHaveCount(2);
  await expect(tableRegion).toContainText('Dispatch');
  await page.getByLabel('Filter by subscription status').selectOption('suspended');
  await expect(tableRegion).toContainText('No subscriptions match these filters.');
  await expect(page.getByRole('status')).toContainText('Showing 0 of 2 loaded subscriptions');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(tableRegion.getByRole('row')).toHaveCount(3);
  await tableRegion.getByRole('row').filter({ hasText: 'Dispatch' }).getByRole('button', { name: 'Terms' }).click();
  await expect(page.getByRole('dialog', { name: 'Dispatch for Harbour Compliance Services' })).toBeVisible();
  await page.getByRole('button', { name: 'Close subscription terms' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (await page.evaluate(() => window.innerWidth < 768)) {
    expect(await tableRegion.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  }
});
