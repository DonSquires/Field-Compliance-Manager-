import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

const shiftId = '66666666-6666-4666-8666-666666666666';
const stopA = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const stopB = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';

test('officer works the contracted stops of a shift one action at a time', async ({ page, context }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T22:30:00+12:00'));
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: -41.2705, longitude: 173.2840 });
  await installOfficerScheduleFixtures(page);
  const browserErrors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/rpc/get_assigned_patrol_session', async (route) =>
    route.fulfill({ json: { shift_id: route.request().postDataJSON().p_shift_id, session: null, visits: [] } }));
  for (const table of ['patrols', 'patrol_route_checkpoints', 'patrol_checkpoints', 'patrol_checkpoint_visits']) {
    await page.route(`**/rest/v1/${table}**`, async (route) => {
      const isSingle = route.request().headers()['accept']?.includes('vnd.pgrst.object+json');
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(isSingle ? null : []) });
    });
  }
  // The officer shell reverse-geocodes the granted position; keep it offline like officer-dispatch.spec.
  await page.route('**/functions/v1/linz-lookup', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ label: '10 Waimea Road, Nelson', lat: -41.2705, lng: 173.284, source: 'linz_address' }] }) }));

  let phase: 'pending' | 'on_scene' | 'done' = 'pending';
  const requests: Array<Record<string, unknown>> = [];
  const stops = () => [
    { id: stopA, stop_order: 1, visit_number: 1, visits_total: 2, status: phase === 'pending' ? 'pending' : phase === 'on_scene' ? 'on_scene' : 'completed', sla_status: phase === 'done' ? 'completed' : 'on_track', sla_window_open: '2026-08-30T10:00:00.000Z', sla_arrive_by: '2026-08-30T10:30:00.000Z', sla_depart_by: '2026-08-30T11:15:00.000Z', required_dwell_minutes: 10, officer_instructions: null, actual_arrived_at: phase === 'pending' ? null : '2026-08-30T10:31:00.000Z', actual_departed_at: phase === 'done' ? '2026-08-30T10:43:00.000Z' : null, arrival_verification: phase === 'pending' ? null : 'near_site', arrival_distance_m: phase === 'pending' ? null : 22.4, officer_notes: null, module_key: 'general_patrol', modules: [{ module_key: 'parking_enforcement', is_required: true, status: 'pending' }], place: { kind: 'site', name: 'Civic Centre', address: '10 Waimea Road, Nelson', access_instructions: null, hs_notes: null } },
    { id: stopB, stop_order: 2, visit_number: 1, visits_total: 1, status: 'pending', sla_status: 'on_track', sla_window_open: '2026-08-30T12:00:00.000Z', sla_arrive_by: '2026-08-30T12:30:00.000Z', sla_depart_by: null, required_dwell_minutes: 15, officer_instructions: null, actual_arrived_at: null, actual_departed_at: null, arrival_verification: null, arrival_distance_m: null, officer_notes: null, module_key: 'general_patrol', place: { kind: 'site', name: 'Trafalgar Park', address: null, access_instructions: null, hs_notes: null } },
  ];
  await page.route('**/rest/v1/rpc/get_officer_patrol_journey', async (route) => route.fulfill({ json: {
    shift_id: shiftId, patrol_id: null, checkpoint_requirement: 'route', route_geometry: null,
    route_geometry_status: 'unavailable', checkpoints: [], stops: stops().map((stop) => ({
      id: stop.id, stop_order: stop.stop_order, visit_number: stop.visit_number, status: stop.status,
      place: { kind: 'site', site_id: stop.id, zone_id: null, name: stop.place.name, address: stop.place.address, coordinates: null },
      clients: [{ id: 'fixture-client', name: 'Fixture client' }], client_attribution_complete: true,
    })),
  } }));
  await page.route('**/rest/v1/rpc/get_officer_patrol_stops_sanitized', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ shift: { id: shiftId, status: 'in_progress', scheduled_start: '2026-08-30T08:00:00.000Z', scheduled_end: '2026-08-30T16:00:00.000Z', route_name: null }, stops: stops().map((stop) => ({ ...stop, checks: [] })) }) }));
  let briefingAvailable = false;
  await page.route('**/functions/v1/officer-patrol-stop-briefing', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.shift_id).toBe(shiftId);
    expect([stopA, stopB]).toContain(body.stop_id);
    if (body.stop_id === stopA && !briefingAvailable) {
      await route.fulfill({ json: { shift_id: shiftId, stop_id: stopA, privacy: { status: 'unavailable', message: 'Private review unavailable.' },
        officer_instructions: null, access_instructions: null, hs_notes: null } });
      return;
    }
    await route.fulfill({ json: {
      shift_id: shiftId, stop_id: body.stop_id, privacy: { status: 'checked' },
      officer_instructions: body.stop_id === stopA ? 'Check the north loading doors and the ticket booth shutters.' : null,
      access_instructions: body.stop_id === stopA ? 'Use the north loading entrance.' : null,
      hs_notes: body.stop_id === stopA ? 'Boundary-first arrival check required.' : null,
    } });
  });
  await page.route('**/rest/v1/rpc/manage_officer_patrol_stop', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    requests.push(payload);
    const arriving = payload.p_action === 'arrive';
    phase = arriving ? 'on_scene' : 'done';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reference: arriving ? 'PS-ARRIVE01' : 'PS-DEPART01', action: payload.p_action, occurred_at: arriving ? '2026-08-30T10:31:00.000Z' : '2026-08-30T10:43:00.000Z', stop_status: arriving ? 'on_scene' : 'completed', sla_status: arriving ? 'on_track' : 'completed', arrival_verification: 'near_site', dwell_minutes: arriving ? null : 12, dwell_short: false, completed_stops: arriving ? 0 : 1, total_stops: 2 }) });
  });

  await signInAsOfficer(page, '/officer/patrol');
  const stopsCard = page.getByRole('region', { name: 'Contracted stops' });
  await expect(stopsCard).toContainText('0 of 2 stops done');
  const first = stopsCard.locator('li').filter({ hasText: 'Civic Centre' }).first();
  await expect(first).toHaveAttribute('aria-current', 'step');
  await expect(first).toContainText('Visit 1 of 2 · Arrive between');
  // The toolset at the stop comes from shift_stop_modules; a stop with only the legacy singular key falls back to it.
  await expect(first.locator('.patrol-stop-toolset')).toHaveText('Parking enforcement');
  await expect(stopsCard.locator('li').filter({ hasText: 'Trafalgar Park' }).locator('.patrol-stop-toolset')).toHaveText('General patrol');
  await expect(first.getByRole('alert')).toContainText('Private review unavailable.');
  await expect(first.getByRole('button', { name: 'Arrived at Civic Centre' })).toBeEnabled();
  expect(requests).toHaveLength(0);
  briefingAvailable = true;
  await first.getByRole('button', { name: 'Retry stop briefing' }).click();
  await expect(first).toContainText('Do here: Check the north loading doors and the ticket booth shutters.');
  await expect(first.getByRole('button', { name: 'Arrived at Civic Centre' })).toBeEnabled();
  await expect(first).toContainText('Access: Use the north loading entrance.');
  await expect(first).toContainText('Safety: Boundary-first arrival check required.');
  await expect(stopsCard.locator('li').filter({ hasText: 'Trafalgar Park' })).not.toContainText('Do here');
  await expect(stopsCard.getByRole('button', { name: /Leaving/ })).toHaveCount(0);
  await expect(first).toHaveScreenshot('officer-patrol-stops-confirmed-review-before.png');
  await first.getByText('Site information and checkpoints').click();

  let stopAcknowledged = false;
  await page.route('**/rest/v1/rpc/get_shift_safety_briefing', async (route) => {
    const args = route.request().postDataJSON();
    await route.fulfill({ json: {
      shift_id: shiftId, stop_id: args.p_stop_id, shift_status: 'in_progress', places: [],
      hazards: [{ id: 'synthetic-risk', title: 'Broken glass at the loading door', hazard_class: 'sharps', risk_level: 'high',
        controls: ['Use the front entrance'], details: null, status: 'reported', origin: 'officer_reported', version: 1,
        place_name: 'Civic Centre', place_kind: 'site', source_name: 'Synthetic safety plan', source_locator: 'Section 2',
        source_as_of: '2026-08-01', has_source_document: false, recorded_by: 'Fixture organisation', updated_at: '2026-08-30T00:00:00Z' }],
      warnings: [], item_count: 1, briefing_hash: 'stop-risk-v1', acknowledgement_required: true,
      acknowledged: stopAcknowledged, acknowledged_at: null, changed_since_acknowledgement: false, is_assigned_officer: true,
    } });
  });
  await page.route('**/rest/v1/rpc/acknowledge_safety_briefing', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ p_shift_id: shiftId, p_stop_id: stopA, p_briefing_hash: 'stop-risk-v1' });
    stopAcknowledged = true;
    await route.fulfill({ json: { acknowledged_at: '2026-08-30T10:30:00Z', briefing_hash: 'stop-risk-v1' } });
  });
  await stopsCard.getByRole('button', { name: 'Arrived at Civic Centre' }).click();
  const safetyDialog = page.getByRole('dialog', { name: 'Risks at Civic Centre' });
  await expect(safetyDialog).toContainText('Broken glass at the loading door');
  await expect(safetyDialog).toContainText('Reported — not yet reviewed');
  await expect(safetyDialog).toContainText('Section 2');
  expect(requests).toHaveLength(0);
  await safetyDialog.getByRole('button', { name: "I've read these risks - record arrival" }).click();
  const arrivalReceipt = stopsCard.getByRole('status').filter({ hasText: 'Arrival recorded' });
  await expect(arrivalReceipt).toContainText('GPS placed you near the site');
  expect(requests[0]).toMatchObject({ p_stop_id: stopA, p_expected_status: 'pending', p_action: 'arrive', p_gps_lat: -41.2705, p_gps_lng: 173.284 });
  expect(typeof requests[0].p_request_id).toBe('string');
  await expect(first).toContainText('On site since');

  await stopsCard.getByPlaceholder(/Gates locked/).fill('Doors secure, shutters down.');
  await stopsCard.getByRole('button', { name: 'Leaving Civic Centre' }).click();
  const departureReceipt = stopsCard.getByRole('status').filter({ hasText: 'Departure recorded' });
  await expect(departureReceipt).toContainText('12 min on site');
  expect(requests[1]).toMatchObject({ p_stop_id: stopA, p_expected_status: 'on_scene', p_action: 'depart', p_notes: 'Doors secure, shutters down.', p_sla_delay_reason: null });
  await expect(stopsCard).toContainText('1 of 2 stops done');
  await expect(first).not.toContainText('Your notes: Doors secure, shutters down.');
  await expect(stopsCard.locator('li').filter({ hasText: 'Trafalgar Park' })).toHaveAttribute('aria-current', 'step');
  await expect(stopsCard.getByRole('button', { name: 'Arrived at Trafalgar Park' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
