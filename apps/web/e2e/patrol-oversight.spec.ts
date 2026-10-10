import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page, { officerModules: ['patrol'] });
});

test('admin patrol route shows exact officer checkpoint evidence', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/field-ops?area=patrol');

  await expect(page.getByRole('heading', { name: 'Patrol evidence' })).toBeVisible();
  await expect(page).toHaveScreenshot('patrol-oversight-first-viewport.png');
  if ((page.viewportSize()?.width ?? 0) < 980) {
    await expect(page.locator('.patrol-oversight-scroll-cue')).toBeVisible();
    const tableSize = await page.locator('.patrol-oversight-table').evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
    expect(tableSize.scrollWidth).toBeGreaterThan(tableSize.clientWidth);
  }
  const verifiedVisit = page.getByText('North gate checkpoint').locator('..').locator('..');
  await expect(verifiedVisit).toBeVisible();
  await expect(verifiedVisit.getByText('Ana Ngata', { exact: true })).toBeVisible();
  await expect(verifiedVisit.getByText('Evidence ID 89898989', { exact: false })).toBeVisible();
  await expect(verifiedVisit.getByText('6 m', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'exception' }).click();
  await expect(page.getByText('Loading bay checkpoint')).toBeVisible();
  await expect(page.getByText('North gate checkpoint')).toBeHidden();
  await expect(page.getByText('Review required')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('patrol evidence follows the selected service site and wider date range', async ({ page }) => {
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) });
  const firstSiteId = '25252525-2525-4525-8525-252525252525';
  const secondSiteId = '26262626-2626-4626-8626-262626262626';
  const visitCheckpointFilters: string[] = [];
  await page.route('**/rest/v1/service_agreement_locations*', async (route) => await route.fulfill(json([
    { id: '21212121-2121-4121-8121-212121212121', service_agreement_id: '24242424-2424-4424-8424-242424242424', site_id: firstSiteId, zone_id: null, status: 'active' },
    { id: '27272727-2727-4727-8727-272727272727', service_agreement_id: '24242424-2424-4424-8424-242424242424', site_id: secondSiteId, zone_id: null, status: 'active' },
  ])));
  await page.route('**/rest/v1/client_sites*', async (route) => {
    const select = new URL(route.request().url()).searchParams.get('select') ?? '';
    if (select.includes('service_agreement_id')) {
      await route.fulfill(json([
        { id: firstSiteId, name: 'North Yard', address: '10 Wharf Road', site_type: 'commercial_premises', client_organization_id: '40404040-4040-4040-8040-404040404040', service_agreement_id: '24242424-2424-4424-8424-242424242424', active: true },
        { id: secondSiteId, name: 'South Yard', address: '12 Wharf Road', site_type: 'commercial_premises', client_organization_id: '40404040-4040-4040-8040-404040404040', service_agreement_id: '24242424-2424-4424-8424-242424242424', active: true },
      ]));
    } else await route.fallback();
  });
  await page.route('**/rest/v1/patrol_checkpoint_visits*', async (route) => {
    const requestUrl = new URL(route.request().url());
    const sinceFilter = requestUrl.searchParams.get('visited_at')?.replace(/^gte\./, '');
    const since = sinceFilter ? Date.parse(sinceFilter) : Number.NEGATIVE_INFINITY;
    const checkpointFilter = requestUrl.searchParams.get('checkpoint_id');
    if (checkpointFilter) visitCheckpointFilters.push(checkpointFilter);
    const checkpointIds = checkpointFilter?.match(/^in\.\((.*)\)$/)?.[1].split(',') ?? null;
    const visits = [
    { id: '89898989-8989-4989-8989-898989898989', organization_id: '33333333-3333-4333-8333-333333333333', patrol_id: '90909090-9090-4090-8090-909090909090', checkpoint_id: '91919191-9191-4191-8191-919191919191', officer_user_id: '22222222-2222-4222-8222-222222222222', shift_stop_id: null, visited_at: '2026-08-29T08:45:00.000Z', scan_method: 'qr_camera', gps_accuracy: 6, gps_distance_from_checkpoint: 4, within_radius: true, notes: 'Recent north yard visit.' },
    { id: '93939393-9393-4393-8393-939393939393', organization_id: '33333333-3333-4333-8333-333333333333', patrol_id: '90909090-9090-4090-8090-909090909090', checkpoint_id: '94949494-9494-4494-8494-949494949494', officer_user_id: '22222222-2222-4222-8222-222222222222', shift_stop_id: null, visited_at: '2026-08-15T08:30:00.000Z', scan_method: 'manual_code', gps_accuracy: null, gps_distance_from_checkpoint: null, within_radius: null, notes: 'Older north yard visit.' },
    { id: '95959595-9595-4959-8959-959595959595', organization_id: '33333333-3333-4333-8333-333333333333', patrol_id: '90909090-9090-4090-8090-909090909090', checkpoint_id: '96969696-9696-4969-8969-969696969696', officer_user_id: '22222222-2222-4222-8222-222222222222', shift_stop_id: null, visited_at: '2026-08-29T08:40:00.000Z', scan_method: 'qr_camera', gps_accuracy: 7, gps_distance_from_checkpoint: 3, within_radius: true, notes: 'South yard visit.' },
    ];
    await route.fulfill(json(visits.filter((visit) => Date.parse(visit.visited_at) >= since && (!checkpointIds || checkpointIds.includes(visit.checkpoint_id)))));
  });
  await page.route('**/rest/v1/patrol_checkpoints*', async (route) => {
    const checkpoints = [
      { id: '91919191-9191-4191-8191-919191919191', name: 'North gate checkpoint', client_site_id: firstSiteId, zone_id: null },
      { id: '94949494-9494-4494-8494-949494949494', name: 'Loading bay checkpoint', client_site_id: firstSiteId, zone_id: null },
      { id: '96969696-9696-4969-8969-969696969696', name: 'South gate checkpoint', client_site_id: secondSiteId, zone_id: null },
    ];
    if (route.request().method() === 'HEAD') {
      await route.fulfill({ status: 200, headers: { 'content-range': '0-2/3' }, body: '' });
      return;
    }
    const requestUrl = new URL(route.request().url());
    const siteId = requestUrl.searchParams.get('client_site_id')?.replace(/^eq\./, '');
    const zoneId = requestUrl.searchParams.get('zone_id')?.replace(/^eq\./, '');
    const requestedIds = requestUrl.searchParams.get('id')?.match(/^in\.\((.*)\)$/)?.[1].split(',');
    await route.fulfill(json(checkpoints.filter((checkpoint) => (!siteId || checkpoint.client_site_id === siteId) && (!zoneId || checkpoint.zone_id === zoneId) && (!requestedIds || requestedIds.includes(checkpoint.id)))));
  });
  await page.route('**/rest/v1/patrols*', async (route) => await route.fulfill(json([
    { id: '90909090-9090-4090-8090-909090909090', status: 'completed', shift_id: '66666666-6666-4666-8666-666666666666', zone_id: null },
  ])));

  await signInAsAdmin(page, '/admin/field-ops?area=patrol');
  await expect(page.getByText('Checkpoint attendance at North Yard · last 7 days.')).toBeVisible();
  expect(visitCheckpointFilters.at(-1)).toContain('in.(91919191-9191-4191-8191-919191919191,94949494-9494-4494-8494-949494949494)');
  await expect(page.getByText('North gate checkpoint')).toBeVisible();
  await expect(page.getByText('Loading bay checkpoint')).toBeHidden();
  await expect(page.getByText('South gate checkpoint')).toBeHidden();

  await page.getByRole('button', { name: '30 days' }).click();
  await expect(page.getByText('Loading bay checkpoint')).toBeVisible();
  await page.getByLabel('Service site or zone').selectOption(`site:${secondSiteId}`);
  await expect(page.getByText('Checkpoint attendance at South Yard · last 30 days.')).toBeVisible();
  expect(visitCheckpointFilters.at(-1)).toBe('in.(96969696-9696-4969-8969-969696969696)');
  await expect(page.getByText('South gate checkpoint')).toBeVisible();
  await expect(page.getByText('North gate checkpoint')).toBeHidden();
});