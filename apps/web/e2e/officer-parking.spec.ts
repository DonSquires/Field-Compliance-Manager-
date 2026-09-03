import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test('officer records parking chalk through the verified-Zone scan workflow', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/parking_chalk_records**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/location_zones**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '66666666-6666-4666-8666-666666666666', name: 'Civic Event Parking Zone' }]) }));
  await page.route('**/functions/v1/process-officer-scan', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload).toMatchObject({ plate_number: 'ABC123', zone_id: '66666666-6666-4666-8666-666666666666', module_key: 'parking_enforcement' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, chalk_record_id: '77777777-7777-4777-8777-777777777777', verdict: 'clear', effective_limit_minutes: 60, recommended_action: 'none', zone_name: 'Civic Event Parking Zone' }) });
  });

  await signInAsOfficer(page, '/officer/parking');
  await page.getByRole('button', { name: /Chalk Vehicle/ }).click();
  await page.getByLabel('Plate').fill('abc123');
  await page.getByLabel('Verified parking Zone').selectOption('66666666-6666-4666-8666-666666666666');
  await page.getByRole('button', { name: 'Chalk Vehicle' }).click();

  await expect(page.getByRole('status')).toContainText('Chalk recorded for Civic Event Parking Zone: clear. Return policy: 60 minutes.');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});