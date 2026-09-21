import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const OFFICER_ON_SHIFT = '22222222-2222-4222-8222-222222222222';
const OFFICER_ALERTING = '23232323-2323-4323-8323-232323232324';
const OFFICER_NO_FIX = '24242424-2424-4424-8424-242424242425';

// The fixtures pin the browser clock (2026-08-29T12:00Z); the picture is built relative to that clock, not the test runner's.
const FIXTURE_NOW = new Date('2026-08-29T12:00:00.000Z');
/** A branch picture: one officer on a running shift with a fix, one alerting, one rostered with no fix yet. */
const picture = (now: Date) => ({
  organization_id: '41414141-4141-4141-8141-414141414141',
  reach: ['41414141-4141-4141-8141-414141414141'],
  since: new Date(now.getTime() - 4 * 3_600_000).toISOString(),
  refreshed_at: now.toISOString(),
  officers: [
    { officer_id: OFFICER_ON_SHIFT, officer_name: 'Ari Officer', home_organization_id: '41414141-4141-4141-8141-414141414141', gps_lat: -41.2706, gps_lng: 173.284, accuracy_meters: 8, heading: null, speed_kmh: 0, activity_type: 'gps_update', recorded_at: new Date(now.getTime() - 3 * 60_000).toISOString(), physical_address: '37 Halifax Street, Nelson', detected_zone_id: null, zone_name: 'Civic Event Operations Zone', position_organization_id: '41414141-4141-4141-8141-414141414141',
      shift: { id: '66666666-6666-4666-8666-666666666666', status: 'in_progress', scheduled_start: new Date(now.getTime() - 65 * 60_000).toISOString(), scheduled_end: new Date(now.getTime() + 3 * 3_600_000).toISOString(), organization_id: '41414141-4141-4141-8141-414141414141', organization_name: 'Northern Branch', service_type: 'patrol', zone_id: null, route_name: 'North District Patrol', work_unit_name: 'North District Patrol' },
      welfare: { enabled: true, check_interval_minutes: 30, last_checkin_at: new Date(now.getTime() - 10 * 60_000).toISOString() }, alert: null },
    { officer_id: OFFICER_ALERTING, officer_name: 'Bella Guard', home_organization_id: '41414141-4141-4141-8141-414141414141', gps_lat: -41.2745, gps_lng: 173.2795, accuracy_meters: 25, heading: null, speed_kmh: null, activity_type: 'sos', recorded_at: new Date(now.getTime() - 60_000).toISOString(), physical_address: null, detected_zone_id: null, zone_name: null, position_organization_id: '41414141-4141-4141-8141-414141414141',
      shift: null, welfare: { enabled: true, check_interval_minutes: 30, last_checkin_at: null }, alert: { id: 'a1', alert_type: 'sos', status: 'pending', triggered_at: new Date(now.getTime() - 60_000).toISOString() } },
    { officer_id: OFFICER_NO_FIX, officer_name: 'Casey Patrol', home_organization_id: '41414141-4141-4141-8141-414141414141', gps_lat: null, gps_lng: null, accuracy_meters: null, heading: null, speed_kmh: null, activity_type: null, recorded_at: null, physical_address: null, detected_zone_id: null, zone_name: null, position_organization_id: null,
      shift: { id: '67676767-6767-4767-8767-676767676767', status: 'accepted', scheduled_start: new Date(now.getTime() - 40 * 60_000).toISOString(), scheduled_end: new Date(now.getTime() + 4 * 3_600_000).toISOString(), organization_id: '41414141-4141-4141-8141-414141414141', organization_name: 'Northern Branch', service_type: 'static_guarding', zone_id: null, route_name: null, work_unit_name: 'Civic Centre static post' },
      welfare: { enabled: true, check_interval_minutes: 30, last_checkin_at: null }, alert: null },
  ],
});

test('the live officer map shows who is where, how safe they are, and keeps its view', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  const calls: Array<Record<string, unknown>> = [];
  await page.route('**/rest/v1/rpc/get_live_officer_positions', async (route) => {
    calls.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(picture(FIXTURE_NOW)) });
  });
  await page.route('**/functions/v1/linz-map-tile**', async (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') }));
  await signInAsAdmin(page, '/admin/field-ops?area=live-map');

  await expect(page.getByRole('heading', { name: 'Live officer map' })).toBeVisible();
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  expect(calls[0]).toMatchObject({ p_organization_id: '41414141-4141-4141-8141-414141414141', p_since_minutes: 240 });

  const map = page.getByRole('region', { name: 'Live officer map' });
  await expect(map.locator('.live-pin')).toHaveCount(2);
  await expect(map.locator('.live-pin.status-alerting')).toHaveCount(1);
  await expect(map.locator('.live-pin.status-ok')).toHaveCount(1);
  await expect(page.locator('.live-ops-summary .status-alerting strong')).toHaveText('1');
  await expect(page.locator('.live-ops-summary .status-ok strong')).toHaveText('1');
  await expect(page.locator('.live-ops-meta')).toContainText('3 officers on shift or seen in the last four hours');

  // Worst first: the alert, then the overdue check-in, then the officer who is fine; each row says the work, the branch,
  // the fix age and the safety clock in words.
  const rows = page.locator('.live-officer-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Bella Guard');
  await expect(rows.nth(0).locator('.live-safety-status')).toContainText(/Active alertSOS \d{2}:\d{2} [ap]m/);
  await expect(rows.nth(0)).toContainText('SOS raised');
  // 40 minutes into a 30-minute interval with no check-in: the shift started the clock, so this is overdue — not "unknown".
  await expect(rows.nth(1)).toContainText('Casey Patrol');
  await expect(rows.nth(1)).toContainText('Shift accepted \u00b7 Civic Centre static post');
  await expect(rows.nth(1)).toContainText('No fix');
  await expect(rows.nth(1)).toContainText('No position yet this shift');
  await expect(rows.nth(1).locator('.live-safety-status')).toContainText(/GPS offline \u00b7 check-in overdueNo check-in yet \u00b7 first due \d{2}:\d{2} [ap]m/);
  await expect(rows.nth(2)).toContainText('Ari Officer');
  await expect(rows.nth(2)).toContainText('On shift \u00b7 North District Patrol');
  await expect(rows.nth(2)).toContainText('Northern Branch');
  await expect(rows.nth(2)).toContainText('3m ago');
  await expect(rows.nth(2)).toContainText('37 Halifax Street, Nelson');
  await expect(rows.nth(2).locator('.live-safety-status')).toContainText(/Safety OKChecked in \d{2}:\d{2} [ap]m \u00b7 next due \d{2}:\d{2} [ap]m/);

  // Selecting from the list highlights the pin; the viewport is remembered for this branch.
  await rows.nth(2).locator('.live-officer-marker').click();
  await expect(rows.nth(2)).toHaveClass(/is-selected/);
  await expect(map.locator('.live-pin.is-selected')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('fcm.map.view:live-map:41414141-4141-4141-8141-414141414141'))).toMatch(/"zoom":\d+/);
  await expect(page.locator('.live-ops-layout')).toHaveScreenshot('live-officer-map.png', { maxDiffPixelRatio: 0.03 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('the live officer map says plainly when nobody is on shift and nothing has reported', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/rpc/get_live_officer_positions', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ organization_id: '41414141-4141-4141-8141-414141414141', reach: ['41414141-4141-4141-8141-414141414141'], since: new Date().toISOString(), refreshed_at: new Date().toISOString(), officers: [] }) }));
  await page.route('**/functions/v1/linz-map-tile**', async (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') }));
  await signInAsAdmin(page, '/admin/field-ops?area=live-map');
  await expect(page.locator('.live-ops-people')).toContainText('Nobody is on shift here now, and no officer has reported a position in the last four hours');
  await expect(page.getByRole('button', { name: 'Fit to everyone' })).toBeDisabled();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
