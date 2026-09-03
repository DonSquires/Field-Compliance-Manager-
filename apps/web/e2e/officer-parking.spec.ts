import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test('officer records parking chalk through the verified-Zone scan workflow', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
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

  await expect(page.getByRole('status')).toContainText('Chalk recorded for Civic Event Parking Zone: clear. Return policy: 60 minutes.');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('officer can resolve a parking address into scan coordinates', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/parking_chalk_records**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/location_zones**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/functions/v1/linz-lookup', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload).toMatchObject({ action: 'address_autocomplete', q: 'Civic Square Wellington', max: 5 });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ label: '101 Wakefield Street, Te Aro, Wellington 6011', lat: -41.28886, lng: 174.77722, source: 'linz_address' }] }) });
  });
  await page.route('**/functions/v1/process-officer-scan', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload).toMatchObject({ gps_lat: -41.28886, gps_lng: 174.77722, module_key: 'parking_enforcement' });
    expect(payload.zone_id).toBeUndefined();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, chalk_record_id: '77777777-7777-4777-8777-777777777777', verdict: 'clear', effective_limit_minutes: 60, recommended_action: 'none', zone_name: 'Resolved parking zone' }) });
  });

  await signInAsOfficer(page, '/officer/parking');
  await page.getByRole('button', { name: /Chalk Vehicle/ }).click();
  await page.locator('input[type="file"]').setInputFiles('node_modules/leaflet/dist/images/marker-icon.png');
  await page.getByLabel('Address').fill('Civic Square Wellington');
  await page.getByRole('button', { name: /Resolve/ }).click();
  await expect(page.getByText('101 Wakefield Street, Te Aro, Wellington 6011')).toBeVisible();
  await page.getByRole('button', { name: 'Chalk Vehicle' }).click();

  await expect(page.getByRole('status')).toContainText('Chalk recorded for Resolved parking zone: clear. Return policy: 60 minutes.');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});