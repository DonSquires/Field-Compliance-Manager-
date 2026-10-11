import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

const staticPost = {
  shift: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'accepted', scheduled_start: '2026-08-30T08:00:00.000Z', scheduled_end: '2026-08-30T16:00:00.000Z', notes: 'Gate coverage' },
  stop: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'en_route', sla_arrive_by: '2026-08-30T08:15:00.000Z', actual_arrived_at: null, actual_departed_at: null, officer_notes: null },
  module: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'active', started_at: null, completed_at: null },
  place: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Civic Events Centre', address: '1 Civic Square, Nelson', risk_level: 'medium', site_brief: 'Maintain the controlled loading entrance.', access_instructions: 'Use the west gate.', hs_notes: 'Wear high-visibility clothing.' },
  attendance_evidence: { arrival: null, departure: null },
};

test('officer static guard confirms arrival only after a complete governed receipt', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: -41.274, longitude: 173.283 });
  await installOfficerScheduleFixtures(page);
  await page.route('**/functions/v1/linz-lookup', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ candidates: [] }),
  }));
  await page.route('**/rest/v1/rpc/get_officer_static_post', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staticPost) }));
  await page.route('**/rest/v1/rpc/manage_officer_static_post', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload).toMatchObject({ p_stop_id: staticPost.stop.id, p_expected_status: 'en_route', p_action: 'arrive', p_gps_lat: -41.274, p_gps_lng: 173.283 });
    expect(typeof payload.p_request_id).toBe('string');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reference: 'ARR-2048', action: 'arrive', occurred_at: '2026-08-30T09:30:00.000Z', gps_result: 'within_radius', timing_status: 'on_time', dwell_minutes: null, handover_recorded: false }) });
  });

  await signInAsOfficer(page, '/officer/site_guard');
  await expect(page.getByText('Civic Events Centre')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm arrival' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Arrival recorded' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Receipt ARR-2048' })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});