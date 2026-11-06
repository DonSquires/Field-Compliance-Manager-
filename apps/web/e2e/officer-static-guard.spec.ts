import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

const staticPost = {
  shift: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'accepted', scheduled_start: '2026-08-30T08:00:00.000Z', scheduled_end: '2026-08-30T16:00:00.000Z', notes: 'Gate coverage' },
  stop: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'en_route', sla_arrive_by: '2026-08-30T08:15:00.000Z', actual_arrived_at: null, actual_departed_at: null, officer_notes: null },
  module: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'active', started_at: null, completed_at: null },
  place: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Civic Events Centre', address: '1 Civic Square, Nelson', risk_level: 'medium', site_brief: 'Maintain the controlled loading entrance.', access_instructions: 'Use the west gate.', hs_notes: 'Wear high-visibility clothing.' },
  attendance_evidence: { arrival: null, departure: null },
};

test('selected static post opens its exact shift without a separate arrival action', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: -41.274, longitude: 173.283 });
  await installOfficerScheduleFixtures(page);
  await page.route('**/functions/v1/linz-lookup', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ candidates: [] }),
  }));
  await page.route('**/rest/v1/rpc/get_officer_static_post', async (route) => {
    expect(route.request().postDataJSON().p_shift_id).toBe(staticPost.shift.id);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staticPost) });
  });
  let separateAttendanceCalled = false;
  await page.route('**/rest/v1/rpc/manage_officer_static_post', async (route) => {
    separateAttendanceCalled = true;
    await route.fulfill({ status: 400, contentType: 'application/json', body: '{"message":"Separate attendance is not the static shift workflow"}' });
  });
  await signInAsOfficer(page, `/officer/site_guard?shift=${staticPost.shift.id}`);
  await expect(page.getByRole('heading', { name: 'Civic Events Centre', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm arrival' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Report an observation or incident' }).click();
  await expect(page).toHaveURL(new RegExp(`/officer/report\\?shift=${staticPost.shift.id}$`));
  await page.goBack();
  await page.getByRole('button', { name: 'Open this shift in my schedule' }).click();
  await expect(page).toHaveURL(new RegExp(`/officer/schedule\\?shift=${staticPost.shift.id}$`));
  expect(separateAttendanceCalled).toBe(false);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('single-site end records departure with the shift and requires an explained GPS exception', async ({ page }) => {
  await installOfficerScheduleFixtures(page);
  await page.route('**/rest/v1/rpc/get_officer_static_post', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ...staticPost, shift: { ...staticPost.shift, status: 'in_progress' }, stop: { ...staticPost.stop, status: 'on_scene' },
  }) }));
  await page.route('**/rest/v1/rpc/get_officer_attendance_readiness', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    shift_id: staticPost.shift.id, status: 'in_progress', scheduled_end: staticPost.shift.scheduled_end, actual_start: null,
    open_stops: [], open_stop_count: 0, open_required_task_count: 0, open_dispatch_job_count: 0,
    active_welfare_alert_count: 0, open_break_count: 0, single_site_attendance: true, debrief_submitted: true,
    blockers: [], can_end: true, can_end_after_debrief: true,
  }) }));
  await page.route('**/rest/v1/rpc/evaluate_static_shift_position', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"no_gps","verified_attendance":false}' }));
  let completed = 0;
  await page.route('**/rest/v1/rpc/complete_officer_static_shift', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ p_shift_id: staticPost.shift.id, p_expected_status: 'in_progress', p_off_site_reason: 'Synthetic indoor GPS exception' });
    completed++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ shift_id: staticPost.shift.id, shift_status: 'completed', completed_at: '2026-11-06T04:00:00Z' }]) });
  });
  await signInAsOfficer(page, `/officer/site_guard?shift=${staticPost.shift.id}`);
  await page.getByRole('button', { name: 'End shift and debrief' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'End shift', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter an attendance explanation');
  expect(completed).toBe(0);
  await dialog.getByRole('textbox', { name: /Attendance explanation/ }).fill('Synthetic indoor GPS exception');
  await dialog.getByRole('button', { name: 'End shift', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Shift completed at' })).toBeVisible();
  expect(completed).toBe(1);
});