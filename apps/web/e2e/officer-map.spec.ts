import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test('officer team map uses the latest device-captured GPS evidence for each colleague', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/officer_gps_log**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
    { officer_id: '22222222-2222-4222-8222-222222222222', gps_lat: -41.274, gps_lng: 173.283, recorded_at: '2026-08-30T08:20:00.000Z' },
    { officer_id: '22222222-2222-4222-8222-222222222222', gps_lat: -41.275, gps_lng: 173.284, recorded_at: '2026-08-30T08:10:00.000Z' },
  ]) }));
  await page.route('**/rest/v1/user_profiles**', async (route) => {
    const select = new URL(route.request().url()).searchParams.get('select') ?? '';
    const body = select === 'id, display_name'
      ? [{ id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata' }]
      : [{ id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata', email: 'ana@fcm.test', role: 'officer', organization_id: '33333333-3333-4333-8333-333333333333', module_access: [] }];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await signInAsOfficer(page, '/officer/map');
  await expect(page.getByRole('heading', { name: 'Team Map' })).toBeVisible();
  await expect(page.getByText('1 colleagues seen in the last hour')).toBeVisible();
  await expect(page.getByText('Ana Ngata')).toBeVisible();
  await expect(page.getByText('-41.27400, 173.28300')).toBeVisible();
  await expect(page.getByText(/^Device capture /)).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('officer team map distinguishes unavailable GPS data from an empty position feed', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/officer_gps_log**', async (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'GPS evidence is unavailable.' }) }));

  await signInAsOfficer(page, '/officer/map');
  await expect(page.getByRole('alert')).toContainText('GPS evidence is unavailable.');
  await expect(page.getByText('No recent GPS positions.')).toHaveCount(0);
  expect(browserErrors.filter((error) => !error.includes('status of 500'))).toEqual([]);
});