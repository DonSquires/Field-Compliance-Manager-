import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

const staticPost = {
  shift: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'in_progress', scheduled_start: '2026-08-30T08:00:00.000Z', scheduled_end: '2026-08-30T16:00:00.000Z', notes: 'Gate coverage' },
  stop: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'en_route', sla_arrive_by: '2026-08-30T08:15:00.000Z', actual_arrived_at: null, actual_departed_at: null, officer_notes: null },
  module: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'active', started_at: null, completed_at: null },
  place: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Civic Events Centre', address: '1 Civic Square, Nelson', gps_lat: -41.274, gps_lng: 173.283, boundary_verified: true, risk_level: 'medium', site_brief: 'Maintain the controlled loading entrance.', access_instructions: 'Use the west gate.', hs_notes: 'Wear high-visibility clothing.' },
  attendance_evidence: { arrival: null, departure: null },
};

function briefing(post = staticPost, status = 'checked') {
  return {
    post: status === 'checked' ? post : { ...post, shift: { ...post.shift, notes: null }, stop: { ...post.stop, officer_notes: null }, place: { ...post.place, site_brief: null, access_instructions: null, hs_notes: null } },
    privacy: { status }, requirements: ['Site induction'],
    contacts: [{ id: 'contact', name: 'Authorised Contact', role: 'Duty manager', phone: '+64000000000', kind: 'Client primary contact' }],
    safety: status === 'checked' ? {
      shift_id: post.shift.id, stop_id: null, shift_status: post.shift.status, places: [], hazards: [], warnings: [], item_count: 0,
      briefing_hash: 'synthetic-private', acknowledgement_required: false, acknowledged: false, acknowledged_at: null, changed_since_acknowledgement: false, is_assigned_officer: true,
    } : null,
  };
}

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
  await page.route('**/functions/v1/officer-shift-briefing', async (route) => {
    expect(route.request().postDataJSON().shift_id).toBe(staticPost.shift.id);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(briefing()) });
  });
  let separateAttendanceCalled = false;
  await page.route('**/rest/v1/rpc/manage_officer_static_post', async (route) => {
    separateAttendanceCalled = true;
    await route.fulfill({ status: 400, contentType: 'application/json', body: '{"message":"Separate attendance is not the static shift workflow"}' });
  });
  await signInAsOfficer(page, `/officer/site_guard?shift=${staticPost.shift.id}`);
  await expect(page.getByRole('heading', { name: 'Civic Events Centre', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm arrival' })).toHaveCount(0);
  await expect(page.getByText('Authorised Contact')).toBeVisible();
  await expect(page.getByText('Site induction')).toBeVisible();
  await expect(page.getByRole('link', { name: '+64000000000' })).toHaveAttribute('href', 'tel:+64000000000');
  await expect(page.getByRole('link', { name: 'Navigate to site' })).toHaveAttribute('target', '_blank');
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
  await page.route('**/functions/v1/officer-shift-briefing', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(briefing({
    ...staticPost, shift: { ...staticPost.shift, status: 'in_progress' }, stop: { ...staticPost.stop, status: 'on_scene' },
  })) }));
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

test('accepted shift opens its own details and private-review failure cannot start work', async ({ page }) => {
  await installOfficerScheduleFixtures(page);
  const post = { ...staticPost, shift: { ...staticPost.shift, status: 'accepted', scheduled_start: new Date(Date.now() - 30 * 60_000).toISOString(), scheduled_end: new Date(Date.now() + 8 * 3_600_000).toISOString() } };
  await page.route('**/rest/v1/shifts**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ ...post.shift, service_type: 'static_guarding', total_stops: 1, ended_reason: null, shift_health: null }]) }));
  let privateRequests = 0, rawRequests = 0, starts = 0;
  await page.route('**/functions/v1/officer-shift-briefing', async (route) => {
    expect(route.request().postDataJSON().shift_id).toBe(post.shift.id);
    privateRequests += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(briefing(post, 'unavailable')) });
  });
  await page.route('**/rest/v1/rpc/get_shift_safety_briefing', async (route) => { rawRequests += 1; await route.fulfill({ status: 500, body: '{}' }); });
  await page.route('**/rest/v1/rpc/start_officer_shift', async (route) => { starts += 1; await route.fulfill({ status: 500, body: '{}' }); });
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'Open assigned site and job' }).click();
  await expect(page).toHaveURL(new RegExp(`site_guard\\?shift=${post.shift.id}`));
  await expect(page.getByText('Authorised Contact')).toBeVisible();
  await expect(page.getByText('Site induction')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Navigate to site' })).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('alert').filter({ hasText: /withheld/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await page.getByRole('button', { name: 'Open this shift in my schedule' }).click();
  const beforeStart = privateRequests;
  await page.getByRole('button', { name: 'Start shift', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /Safety details are withheld/ })).toBeVisible();
  expect(privateRequests).toBe(beforeStart + 1);
  expect(rawRequests).toBe(0);
  expect(starts).toBe(0);
});

test('changed safety acknowledgement reloads through private Oracle and cannot fall back to raw text', async ({ page }) => {
  await installOfficerScheduleFixtures(page);
  const post = { ...staticPost, shift: { ...staticPost.shift, status: 'accepted', scheduled_start: new Date(Date.now() - 30 * 60_000).toISOString(), scheduled_end: new Date(Date.now() + 8 * 3_600_000).toISOString() } };
  await page.route('**/rest/v1/shifts**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ ...post.shift, service_type: 'static_guarding', total_stops: 1, ended_reason: null, shift_health: null }]) }));
  let privateRequests = 0, rawRequests = 0, starts = 0;
  await page.route('**/functions/v1/officer-shift-briefing', async (route) => {
    privateRequests += 1;
    const result = briefing(post, privateRequests === 1 ? 'checked' : 'unavailable');
    const data = privateRequests === 1 ? { ...result, safety: { ...result.safety, item_count: 1, acknowledgement_required: true, hazards: [{
      id: 'hazard', title: 'Loading traffic', hazard_class: 'traffic_and_vehicles', risk_level: 'high', controls: ['Use the pedestrian route.'],
      details: null, status: 'active', origin: 'manual', version: 1, place_name: 'Civic Events Centre', place_kind: 'site',
      source_name: null, source_locator: null, source_as_of: null, has_source_document: false, recorded_by: 'Your organisation', updated_at: '2026-11-05T00:00:00Z',
    }] } } : result;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.route('**/rest/v1/rpc/acknowledge_safety_briefing', async (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Briefing changed', hint: 'briefing_changed', code: 'P0001' }) }));
  await page.route('**/rest/v1/rpc/get_shift_safety_briefing', async (route) => { rawRequests += 1; await route.fulfill({ status: 500, body: '{}' }); });
  await page.route('**/rest/v1/rpc/start_officer_shift', async (route) => { starts += 1; await route.fulfill({ status: 500, body: '{}' }); });
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'Start shift', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Loading traffic');
  await page.getByRole('button', { name: /I've read these risks/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Safety details are withheld pending private Oracle review');
  expect(privateRequests).toBe(2);
  expect(rawRequests).toBe(0);
  expect(starts).toBe(0);
});