import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page, { officerModules: ['dispatch', 'patrol', 'static_guarding', 'cctv'] });
  await page.route('**/rest/v1/rpc/get_operating_organization_contexts', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ organization_id: '33333333-3333-4333-8333-333333333333', organization_name: 'Test organisation', authority_basis: 'organisation_home', role_at_branch: null, module_access: [], can_be_rostered: false, is_default: true }]),
  }));
});

test('admin console bounds the canvas and keeps grouped destinations accessible', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/field-ops');
  await expect(page.getByRole('heading', { name: 'Field Operations', exact: true })).toBeVisible();
  const dimensions = await page.evaluate(() => {
    const shell = document.querySelector('.admin-shell')!;
    const header = document.querySelector('.admin-shell-header, .admin-mobile-header')!;
    const place = document.querySelector('.place-context-banner.is-console')!;
    return {
      viewport: window.innerHeight,
      height: shell.getBoundingClientRect().height,
      header: header.getBoundingClientRect().height,
      place: place.getBoundingClientRect().height,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(dimensions.height).toBe(dimensions.viewport);
  expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  const mobile = dimensions.viewportWidth < 768;
  expect(dimensions.header).toBe(mobile ? 44 : 40);
  expect(dimensions.place).toBe(mobile ? 44 : 36);
  if (mobile) {
    const destination = page.getByRole('combobox', { name: 'Workspace destination' });
    expect(await destination.locator('optgroup').evaluateAll((groups) => groups.map((group) => group.label))).toEqual(['Live Ops', 'Evidence & Reports', 'Site & Spatial Setup']);
    await destination.selectOption('field-ops:dispatch');
    await expect(page).toHaveURL(/area=dispatch/);
  } else {
    await expect(page.locator('.admin-sidebar')).toHaveCSS('width', '200px');
    await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
    await expect(page.locator('.admin-sidebar')).toHaveCSS('width', '52px');
    const section = page.getByRole('combobox', { name: 'Guarding and patrol section' });
    await section.selectOption('Evidence & Reports');
    await expect(page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('button', { name: 'Video evidence', exact: true })).toBeVisible();
    await section.selectOption('Site & Spatial Setup');
    await page.getByText('Site & Spatial Setup', { exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('button', { name: 'Geofence Workbench', exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('console counts preserve failed reads and gate welfare rather than showing invented zeros', async ({ page }) => {
  const requests: URL[] = [];
  await page.route('**/rest/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'HEAD' || !['shifts', 'dispatch_jobs', 'breach_alerts', 'welfare_alerts'].some((table) => url.pathname.endsWith(`/${table}`))) return route.fallback();
    requests.push(url);
    if (url.pathname.endsWith('/dispatch_jobs')) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture unavailable' }) });
    return route.fulfill({ status: 200, headers: { 'access-control-expose-headers': 'Content-Range', 'content-range': '0-0/7' }, body: '' });
  });
  await signInAsAdmin(page, '/admin/field-ops');
  if ((page.viewportSize()?.width ?? 0) < 768) await page.getByText('Operations', { exact: true }).click();
  const metrics = page.getByRole('group', { name: /Operational counts/ });
  await expect(metrics.getByRole('button', { name: 'On duty 7', exact: true })).toBeVisible();
  await expect(metrics.getByRole('button', { name: 'Dispatch Unavailable', exact: true })).toBeVisible();
  await expect(metrics.getByRole('button', { name: 'Welfare · org 7', exact: true })).toBeVisible();
  expect(requests.length).toBeGreaterThanOrEqual(4);
  for (const url of requests) expect(url.searchParams.get('organization_id')).toBe('eq.33333333-3333-4333-8333-333333333333');

  await page.route('**/rest/v1/organization_modules**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ module_key: 'dispatch', enabled: true }, { module_key: 'welfare', enabled: false }]),
  }));
  requests.length = 0;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Field Operations', exact: true })).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) < 768) await page.getByText('Operations', { exact: true }).click();
  await expect(metrics.getByRole('button', { name: 'On duty 7', exact: true })).toBeVisible();
  await expect(metrics.getByRole('button', { name: /Welfare/ })).toHaveCount(0);
  expect(requests.some((url) => url.pathname.endsWith('/welfare_alerts'))).toBe(false);
});

test('CRM matrix routes replace both shell workflow rows and retain the flexible canvas', async ({ page }) => {
  await signInAsAdmin(page, '/admin/crm');
  for (const destination of ['crm', 'client-setup']) {
    if (destination === 'client-setup') await page.goto('/admin/client-setup');
    await expect(page.locator('.admin-shell-main')).toHaveClass(/is-workbench/);
    await expect(page.locator('.admin-workspace-bar')).toHaveCount(0);
    await expect(page.locator('.workflow-rail')).toHaveCount(0);
    const bounds = await page.locator('.admin-shell-main').evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      viewport: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
    }));
    expect(bounds.height).toBeGreaterThan(bounds.viewport / 2);
    expect(bounds.documentHeight).toBeLessThanOrEqual(bounds.viewport);
  }
});
