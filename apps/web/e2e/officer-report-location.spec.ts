import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test('officer report resolves a GPS address and submits it as location evidence', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: -41.274, longitude: 173.283 });
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/rpc/submit_officer_field_report', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload.p_address).toBe('1 Civic Square, Nelson 7010');
    expect(payload.p_gps_lat).toBe(-41.274);
    expect(payload.p_gps_lng).toBe(173.283);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', received_at: '2026-08-30T09:30:00.000Z', shift_id: null }]) });
  });

  await signInAsOfficer(page, '/officer/report');
  await page.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByText(/Address \((resolved|GPS resolved)\)/)).toBeVisible();
  await expect(page.getByLabel('Address')).toHaveValue('1 Civic Square, Nelson 7010');
  await page.getByLabel('Title').fill('Unsafe access lighting');
  await page.getByLabel('Description').fill('Lighting at the north access failed during the patrol and reduced visibility.');
  await page.getByRole('button', { name: 'Submit report' }).click();
  await expect(page.getByRole('status')).toContainText('Report confirmed');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});