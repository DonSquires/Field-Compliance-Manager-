import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

for (const { module, routePath } of [
  { module: 'parking', routePath: '/officer/parking' },
  { module: 'freedom_camping', routePath: '/officer/freedom_camping' },
  { module: 'freedom_camping', routePath: '/modules/freedom_camping' },
  { module: 'parking', routePath: '/modules/parking_enforcement' },
]) {
  test(`${routePath} retains a rejected photo across reload and exposes the server error`, async ({ page }) => {
    const requests: Array<{ client_request_id: string; plate_number?: string }> = [];
    await installOfficerScheduleFixtures(page);
    await page.route('**/rest/v1/parking_chalk_records**', (route) => route.fulfill({ json: [] }));
    await page.route('**/rest/v1/location_zones**', (route) => route.fulfill({ json: [{ id: '66666666-6666-4666-8666-666666666666', name: 'Synthetic verified Zone' }] }));
    await page.route('**/functions/v1/process-officer-scan', (route) => {
      requests.push(JSON.parse(route.request().postData() ?? '{}'));
      return route.fulfill({ status: 400, json: { code: 'plate_confirmation_required', error: 'Keep this photo and confirm the plate manually.' } });
    });
    await signInAsOfficer(page, routePath);
    if (module === 'parking') await page.getByRole('button', { name: /Chalk Vehicle/ }).click();
    await page.locator('input[type="file"]').setInputFiles('node_modules/leaflet/dist/images/marker-icon.png');
    const zone = module === 'parking' ? page.getByLabel('Verified parking Zone') : page.locator('.fc-field select');
    await zone.selectOption('66666666-6666-4666-8666-666666666666');
    await page.getByRole('button', { name: module === 'parking' ? 'Chalk Vehicle' : 'Process scan', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Photo retained on this device.' })).toContainText('confirm the plate manually');
    await page.reload();
    const review = page.getByRole('button', { name: 'Review saved capture' });
    await expect(review).toBeVisible();
    await review.click();
    await expect(page.getByRole('img', { name: 'Vehicle evidence preview' })).toBeVisible();
    await page.getByPlaceholder('Use if ALPR cannot read').fill('SYN123');
    await page.getByRole('button', { name: module === 'parking' ? 'Chalk Vehicle' : 'Process scan', exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].client_request_id).toBe(requests[0].client_request_id);
    expect(requests[1].plate_number).toBe('SYN123');
  });
}

test('officer records parking chalk through the verified-Zone scan workflow', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installOfficerScheduleFixtures(page);
  await page.route('**/rest/v1/parking_chalk_records**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/location_zones**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '66666666-6666-4666-8666-666666666666', name: 'Civic Event Parking Zone' }]) }));
  await page.route('**/functions/v1/process-officer-scan', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload).toMatchObject({ zone_id: '66666666-6666-4666-8666-666666666666', module_key: 'parking_enforcement' });
    expect(payload.plate_number).toBeUndefined();
    expect(typeof payload.image_base64).toBe('string');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, chalk_record_id: '77777777-7777-4777-8777-777777777777', verdict: 'clear', effective_limit_minutes: 60, recommended_action: 'none', zone_name: 'Civic Event Parking Zone' }) });
  });

  await signInAsOfficer(page, '/officer/parking');
  await page.getByRole('button', { name: /Chalk Vehicle/ }).click();
  await expect(page.getByRole('button', { name: 'Chalk Vehicle' })).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles('node_modules/leaflet/dist/images/marker-icon.png');
  await page.getByLabel('Verified parking Zone').selectOption('66666666-6666-4666-8666-666666666666');
  await page.getByRole('button', { name: 'Chalk Vehicle' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Chalk recorded for Civic Event Parking Zone: clear. Return policy: 60 minutes.' })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('officer keeps a parking address candidate separate from the selected Working Zone', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installOfficerScheduleFixtures(page);
  await page.route('**/rest/v1/parking_chalk_records**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/location_zones**', async (route) => route.fulfill({ json: [{ id: '66666666-6666-4666-8666-666666666666', name: 'Resolved parking zone', location_id: '88888888-8888-4888-8888-888888888888', module_key: 'parking_enforcement' }] }));
  await page.route('**/functions/v1/linz-lookup', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload).toMatchObject({ action: 'address_autocomplete', q: 'Civic Square Wellington', max: 5 });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ label: '101 Wakefield Street, Te Aro, Wellington 6011', lat: -41.28886, lng: 174.77722, source: 'linz_address' }] }) });
  });
  await page.route('**/functions/v1/process-officer-scan', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload).toMatchObject({ gps_lat: -41.28886, gps_lng: 174.77722, location_source: 'address_candidate', zone_id: '66666666-6666-4666-8666-666666666666', location_id: '88888888-8888-4888-8888-888888888888', module_key: 'parking_enforcement' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, chalk_record_id: '77777777-7777-4777-8777-777777777777', verdict: 'clear', effective_limit_minutes: 60, recommended_action: 'none', zone_name: 'Resolved parking zone' }) });
  });

  await signInAsOfficer(page, '/officer/parking');
  await page.getByRole('button', { name: /Chalk Vehicle/ }).click();
  await page.locator('input[type="file"]').setInputFiles('node_modules/leaflet/dist/images/marker-icon.png');
  await page.getByLabel('Address').fill('Civic Square Wellington');
  await page.getByRole('button', { name: /Resolve/ }).click();
  await expect(page.getByText('101 Wakefield Street, Te Aro, Wellington 6011')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chalk Vehicle' })).toBeDisabled();
  await page.getByLabel('Verified parking Zone').selectOption('66666666-6666-4666-8666-666666666666');
  await page.getByRole('button', { name: 'Chalk Vehicle' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Chalk recorded for Resolved parking zone: clear. Return policy: 60 minutes.' })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});