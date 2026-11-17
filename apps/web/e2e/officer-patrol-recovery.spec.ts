import { expect, test, type Page } from '@playwright/test';
import { installOfficerScheduleFixtures, signInAsOfficer } from './fixtures';

test.use({ timezoneId: 'UTC' });

const overnightId = '11111111-aaaa-4111-8111-111111111111';
const laterId = '22222222-aaaa-4222-8222-222222222222';
const missingId = '33333333-aaaa-4333-8333-333333333333';
const overnight = {
  id: overnightId, service_type: 'patrol', status: 'in_progress',
  scheduled_start: '2026-08-29T22:00:00.000Z', scheduled_end: '2026-08-30T04:00:00.000Z',
  patrol_route_id: 'route-1', zone_id: 'zone-1', zone: null, route: { name: 'Overnight route', route_code: 'N1' },
};
const later = {
  ...overnight, id: laterId, scheduled_start: '2026-08-30T02:00:00.000Z',
  status: 'accepted', patrol_route_id: 'route-2', route: { name: 'Later route', route_code: 'N2' },
};
const officerId = '22222222-2222-4222-8222-222222222222';
const organizationId = '33333333-3333-4333-8333-333333333333';
const patrolId = (shiftId: string) => shiftId === overnightId ? 'patrol-1' : 'patrol-2';
const sessionRead = (shiftId: string, visits: Array<Record<string, unknown>> = []) => ({
  shift_id: shiftId,
  session: { id: patrolId(shiftId), status: 'in_progress', started_at: '2026-08-29T22:00:00.000Z', ended_at: null },
  visits,
});
const assignedShift = (shift: typeof overnight) => ({
  id: shift.id, officer_user_id: officerId, organization_id: organizationId,
  service_type: shift.service_type, status: shift.status, scheduled_start: shift.scheduled_start,
  scheduled_end: shift.scheduled_end, zone_id: shift.zone_id, patrol_route_id: shift.patrol_route_id,
  location_id: null, service_agreement_location_id: null, service_agreement_module: null,
  zone_name: null, route_name: null, route_code: null, created_at: shift.scheduled_start,
  updated_at: shift.scheduled_start, context_status: 'available', shift_stops: [],
});
type JourneyCheckpoint = {
  id: string; kind: 'route' | 'site'; name: string; required: boolean; visited: boolean;
  sequence_order: number | null; site_id: string | null; zone_id: string | null; stop_ids: string[];
  auto_geofence_status: 'verified' | 'unverified' | 'missing_or_invalid_geofence' | 'unavailable_route';
};
const checkpoint = (id = 'checkpoint-1', name = 'Checkpoint'): JourneyCheckpoint => ({
  id, kind: 'route', name, required: true, visited: false, sequence_order: 1,
  site_id: null, zone_id: null, stop_ids: [], auto_geofence_status: 'unavailable_route',
});
const journey = (shiftId: string, checkpoints: JourneyCheckpoint[] = [checkpoint()]) => ({
  shift_id: shiftId, patrol_id: patrolId(shiftId), checkpoint_requirement: 'route',
  route_geometry: null, route_geometry_status: 'unavailable', stops: [], checkpoints,
});

async function setup(page: Page, role: 'officer' | 'admin_officer') {
  await page.clock.setFixedTime(new Date('2026-08-30T01:15:00.000Z'));
  await installOfficerScheduleFixtures(page);
  await page.route('**/rest/v1/user_profiles**', async (route) => {
    if (!new URL(route.request().url()).searchParams.get('select')?.includes('deactivated_at')) return route.fallback();
    await route.fulfill({ json: [{
      id: '22222222-2222-4222-8222-222222222222', display_name: 'Test officer',
      email: 'ana@fcm.test', role, organization_id: '33333333-3333-4333-8333-333333333333',
      module_access: ['patrol', 'site_guard'],
    }] });
  });
  const shiftQueries: URLSearchParams[] = [];
  await page.route('**/rest/v1/shifts**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (!query.get('select')?.includes('route_code')) return route.fallback();
    shiftQueries.push(query);
    const includesOvernight = query.get('or')?.includes('status.eq.in_progress') && query.get('or')?.includes('scheduled_start.lt.');
    await route.fulfill({ json: includesOvernight ? [overnight, later] : [later] });
  });
  await page.route('**/rest/v1/rpc/get_assigned_officer_shift_context', async (route) =>
    route.fulfill({ json: [assignedShift(overnight), assignedShift(later)] }));
  await page.route('**/rest/v1/rpc/get_assigned_patrol_session', async (route) =>
    route.fulfill({ json: sessionRead(route.request().postDataJSON().p_shift_id as string) }));
  await page.route('**/rest/v1/rpc/get_officer_patrol_journey', async (route) => route.fulfill({
    json: journey(route.request().postDataJSON().p_shift_id as string),
  }));
  const stopShiftIds: string[] = [];
  await page.route('**/rest/v1/rpc/get_officer_patrol_stops_sanitized', async (route) => {
    const id = route.request().postDataJSON().p_shift_id as string;
    stopShiftIds.push(id);
    await route.fulfill({ json: { shift: { id, status: 'in_progress', scheduled_start: overnight.scheduled_start, scheduled_end: overnight.scheduled_end, route_name: null }, stops: [] } });
  });
  return { shiftQueries, stopShiftIds };
}

for (const role of ['officer', 'admin_officer'] as const) {
    test(`${role}: patrol plan failure remains distinct from empty and can be retried`, async ({ page }) => {
      const { shiftQueries, stopShiftIds } = await setup(page, role);
      let recovered = false;
      await page.route('**/rest/v1/rpc/get_officer_patrol_journey', async (route) => {
        if (!recovered) return route.fulfill({ status: 403, json: { message: 'Fixture plan failure' } });
        await route.fulfill({ json: journey(overnightId, [checkpoint('checkpoint-1', 'Route checkpoint')]) });
      });

      await signInAsOfficer(page, `/officer/patrol?shift=${overnightId}`);
      if (role === 'admin_officer') {
        await page.getByRole('button', { name: /Field Portal/ }).click();
        await page.goto(`/officer/patrol?shift=${overnightId}`);
      }
      await expect(page.getByRole('alert').filter({ hasText: 'Patrol session or checkpoints could not be loaded' })).toBeVisible();
      await expect(page.getByText('No checkpoints are configured for this patrol.')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Complete Patrol Session' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Contracted stops' })).toContainText('No contracted stops on this shift');
      expect(stopShiftIds).toContain(overnightId);
      expect(shiftQueries[0].get('scheduled_end')).toBe('gte.2026-08-30T01:15:00.000Z');
      expect(shiftQueries[0].get('or')).toContain('scheduled_start.lt.2026-08-30T00:00:00.000Z');

      recovered = true;
      await page.getByRole('button', { name: 'Try loading patrol again' }).click();
      await expect(page.getByText('Route checkpoint', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Complete Patrol Session' })).toBeVisible();
    });
}

test('a missing requested shift never silently opens another assignment', async ({ page }) => {
  const { stopShiftIds } = await setup(page, 'officer');
  await signInAsOfficer(page, `/officer/patrol?shift=${missingId}`);
  await expect(page.getByRole('alert').filter({ hasText: 'The selected shift could not be confirmed here' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open my schedule' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete Patrol Session' })).toHaveCount(0);
  expect(stopShiftIds).toEqual([]);
});

test('late session responses cannot replace the newly selected shift', async ({ page }) => {
  await setup(page, 'officer');
  let releaseFirst: () => void = () => {};
  let markDelivered: () => void = () => {};
  const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstDelivered = new Promise<void>((resolve) => { markDelivered = resolve; });
  await page.route('**/rest/v1/rpc/get_assigned_patrol_session', async (route) => {
    const shiftId = route.request().postDataJSON().p_shift_id as string;
    const first = shiftId === overnightId;
    if (first) await firstResponse;
    await route.fulfill({ json: sessionRead(shiftId) });
    if (first) markDelivered();
  });
  await signInAsOfficer(page, '/officer/patrol');
  await expect(page.getByRole('status').filter({ hasText: 'Loading patrol session' })).toBeVisible();
  await page.getByRole('button', { name: /Later route/ }).click();
  await expect(page.locator('.patrol-session h2')).toHaveText('Later route');
  releaseFirst();
  await firstDelivered;
  await expect(page.locator('.patrol-session h2')).toHaveText('Later route');
});

test('a past-end shift is directed to schedule without loading its private stop details', async ({ page }) => {
  const { stopShiftIds } = await setup(page, 'officer');
  await page.route('**/rest/v1/rpc/get_assigned_officer_shift_context', async (route) =>
    route.fulfill({ json: [{ id: overnightId, officer_user_id: officerId, organization_id: organizationId,
      scheduled_start: overnight.scheduled_start, scheduled_end: '2026-08-30T01:00:00.000Z',
      status: 'in_progress', context_status: 'recovery_only' }, assignedShift(later)] }));
  await page.route('**/rest/v1/shifts**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (!query.get('select')?.includes('route_code')) return route.fallback();
    const overdue = { ...overnight, scheduled_end: '2026-08-30T01:00:00.000Z', route: { name: 'Private overdue route', route_code: null } };
    await route.fulfill({ json: query.has('scheduled_end') ? [] : [overdue] });
  });

  await signInAsOfficer(page, `/officer/patrol?shift=${overnightId}`);
  await expect(page.getByRole('alert').filter({ hasText: 'The selected shift could not be confirmed here' })).toBeVisible();
  await expect(page.getByText('Private overdue route')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open my schedule' })).toBeVisible();
  expect(stopShiftIds).toEqual([]);
});

test('a missing stop place reports an error instead of crashing the patrol', async ({ page }) => {
  await setup(page, 'officer');
  await page.route('**/rest/v1/rpc/get_officer_patrol_stops_sanitized', async (route) => route.fulfill({ json: {
    shift: { id: overnightId }, stops: [{ id: 'missing-place', place: null }],
  } }));
  await signInAsOfficer(page, `/officer/patrol?shift=${overnightId}`);
  await expect(page.getByRole('alert').filter({ hasText: 'assigned stop details could not be confirmed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh contracted stops' })).toBeVisible();
});

test('checkpoint recovery keeps an in-progress stop draft', async ({ page }) => {
  await setup(page, 'officer');
  let release: () => void = () => {};
  const checkpointResponse = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/rest/v1/rpc/get_officer_patrol_journey', async (route) => {
    await checkpointResponse;
    await route.fulfill({ json: journey(overnightId, []) });
  });
  await page.route('**/rest/v1/rpc/get_officer_patrol_stops_sanitized', async (route) => route.fulfill({ json: {
    shift: { id: overnightId, status: 'in_progress', scheduled_start: overnight.scheduled_start, scheduled_end: overnight.scheduled_end, route_name: null },
    stops: [{
      id: 'stop-1', stop_order: 1, visit_number: 1, visits_total: 1, status: 'on_scene',
      sla_status: 'on_track', sla_window_open: null, sla_arrive_by: null, sla_depart_by: null,
      required_dwell_minutes: 0, officer_instructions: null, actual_arrived_at: '2026-08-30T01:00:00Z',
      actual_departed_at: null, officer_notes: null, module_key: 'patrol', checks: [],
      place: { kind: 'site', name: 'Test place', address: null, access_instructions: null, hs_notes: null },
    }],
  } }));
  await signInAsOfficer(page, `/officer/patrol?shift=${overnightId}`);
  const notes = page.getByPlaceholder(/Gates locked/);
  await notes.fill('Checking the gate');
  release();
  await expect(page.getByRole('button', { name: 'Complete Patrol Session' })).toBeVisible();
  await expect(notes).toHaveValue('Checking the gate');
});

test('switching patrols protects checkpoint notes and keeps the selected shift in the URL', async ({ page }) => {
  await setup(page, 'officer');
  await signInAsOfficer(page, `/officer/patrol?shift=${overnightId}`);
  await page.getByRole('button', { name: 'Record Visit' }).click();
  const notes = page.getByPlaceholder(/Site secure/);
  await notes.fill('Gate needs attention');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: /Later route/ }).click();
  await expect(notes).toHaveValue('Gate needs attention');
  await expect(page).toHaveURL(new RegExp(`shift=${overnightId}$`));
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: /Later route/ }).click();
  await expect(page).toHaveURL(new RegExp(`shift=${laterId}$`));
  await expect(page.locator('.patrol-session h2')).toHaveText('Later route');
});

test('checkpoint progress excludes visits to checkpoints no longer on the assignment', async ({ page }) => {
  await setup(page, 'officer');
  await page.route('**/rest/v1/rpc/get_officer_patrol_journey', async (route) => route.fulfill({
    json: journey(overnightId, [checkpoint('checkpoint-current', 'Current checkpoint')]),
  }));
  await page.route('**/rest/v1/rpc/get_assigned_patrol_session', async (route) => route.fulfill({
    json: sessionRead(overnightId, [{ id: 'old-visit', checkpoint_id: null, route_checkpoint_id: 'checkpoint-old',
      visited_at: '2026-08-30T00:45:00Z', scan_method: 'manual_code', notes: null,
      within_radius: null, checkpoint_verification_at_visit: null }]),
  }));
  await signInAsOfficer(page, `/officer/patrol?shift=${overnightId}`);
  await expect(page.getByText('Checkpoints: 0 / 1 completed (0%)')).toBeVisible();
});

test('assigned clients and sites open their own checkpoints and planned stop map', async ({ page }) => {
  await setup(page, 'officer');
  let rawStopRequests = 0;
  await page.route('**/rest/v1/rpc/get_officer_patrol_stops', async (route) => {
    rawStopRequests++;
    await route.fulfill({ status: 403, json: { message: 'Raw stop projection must not be used by the browser' } });
  });
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (success) => success({
      coords: { latitude: -41, longitude: 174, accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) },
      timestamp: Date.now(), toJSON: () => ({}),
    });

  });
  const stops = [
    { id: 'stop-a', stop_order: 1, visit_number: 1, status: 'on_scene', place: { kind: 'site', site_id: 'site-a', zone_id: null, name: 'Site A', address: '1 Test Street', coordinates: { lat: -41, lng: 174, source: 'site_center' } }, clients: [{ id: 'client-a', name: 'Client A' }], client_attribution_complete: true },
    { id: 'stop-b', stop_order: 2, visit_number: 1, status: 'pending', place: { kind: 'site', site_id: 'site-b', zone_id: null, name: 'Site B', address: null, coordinates: null }, clients: [], client_attribution_complete: false },
    { id: 'stop-c', stop_order: 3, visit_number: 1, status: 'pending', place: { kind: 'site', site_id: 'site-c', zone_id: null, name: 'Site C', address: null, coordinates: { lat: -41.01, lng: 174, source: 'site_center' } }, clients: [{ id: 'client-a', name: 'Client A' }], client_attribution_complete: true },
  ];
  let visitRecorded = false;
  await page.route('**/rest/v1/rpc/get_assigned_patrol_session', async (route) => route.fulfill({ json: {
    shift_id: overnightId,
    session: { id: 'patrol-1', status: 'in_progress', started_at: overnight.scheduled_start, ended_at: null },
    visits: visitRecorded ? [{ id: 'visit-1', checkpoint_id: 'site-check', route_checkpoint_id: null,
      visited_at: '2026-08-30T01:15:00Z', scan_method: 'gps', notes: null,
      within_radius: true, checkpoint_verification_at_visit: 'verified' }] : [],
  } }));
  await page.route('**/rest/v1/rpc/get_officer_patrol_journey', async (route) => route.fulfill({ json: {
    ...journey(route.request().postDataJSON().p_shift_id as string, [{ id: 'site-check', kind: 'site', name: 'Gate checkpoint', required: true,
      visited: visitRecorded, sequence_order: null, site_id: 'site-a', zone_id: null, stop_ids: ['stop-a'], auto_geofence_status: 'verified' }]),
    checkpoint_requirement: 'site_zone', stops,
  } }));
  await page.route('**/rest/v1/rpc/get_officer_patrol_stops_sanitized', async (route) => route.fulfill({ json: {
    shift: { id: overnightId, status: 'in_progress', scheduled_start: overnight.scheduled_start, scheduled_end: overnight.scheduled_end, route_name: null },
    stops: stops.map((stop) => ({
      ...stop, visits_total: 1, sla_status: 'on_track', sla_window_open: null, sla_arrive_by: '2026-08-30T02:00:00Z',
      sla_depart_by: null, required_dwell_minutes: 0, officer_instructions: 'Unreviewed source must not display',
      actual_arrived_at: stop.id === 'stop-a' ? '2026-08-30T01:00:00Z' : null,
      actual_departed_at: null, arrival_verification: null, arrival_distance_m: null, officer_notes: null,
      module_key: 'general_patrol', checks: [], place: { ...stop.place, access_instructions: 'Unreviewed access', hs_notes: null },
    })),
  } }));
  await page.route('**/functions/v1/linz-map-tile**', async (route) => route.fulfill({
    contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1XQAAAABJRU5ErkJggg==', 'base64'),
  }));
  await page.route('**/functions/v1/officer-patrol-stop-briefing', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.shift_id).toBe(overnightId);
    expect(['stop-a', 'stop-b', 'stop-c']).toContain(body.stop_id);
    const incomplete = body.stop_id === 'stop-b';
    await route.fulfill({ json: {
      shift_id: overnightId, stop_id: body.stop_id, officer_instructions: incomplete ? null : 'Reviewed instruction',
      access_instructions: null, hs_notes: null,
      privacy: incomplete ? { status: 'unavailable', message: 'Assignment could not be confirmed.' } : { status: 'checked' },
    } });
  });
  await page.route('**/rest/v1/rpc/record_patrol_checkpoint_visit', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ p_patrol_id: 'patrol-1', p_checkpoint_kind: 'site', p_checkpoint_id: 'site-check' });
    visitRecorded = true;
    await route.fulfill({ json: [{ visit_id: 'visit-1', created: true, visited_at: '2026-08-30T01:15:00Z', scan_method: 'gps', notes: null }] });
  });
  await signInAsOfficer(page, `/officer/patrol?shift=${overnightId}`);
  const client = page.getByRole('region', { name: 'Client A' }).first();
  await expect(client).toContainText('Site A');
  await expect(page.getByRole('region', { name: 'Client organisation not confirmed' })).toContainText('Site B');
  await expect(page.locator('.patrol-stop-title strong')).toHaveText(['Site A', 'Site B', 'Site C']);
  await expect(page.getByText('1 stop has no mapped position and cannot be shown.')).toBeVisible();
  await page.getByRole('button', { name: 'Show stop map' }).click();
  await expect(page.getByRole('region', { name: 'Map of planned patrol stops' })).toBeVisible();
  const map = page.locator('.patrol-map-canvas');
  await map.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Account settings', exact: true }).click();
  expect(await map.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return Boolean(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      ?.closest('.officer-account-backdrop'));
  })).toBe(true);
  await page.getByRole('button', { name: 'Close account settings' }).click();
  await client.getByText('Site information and checkpoints').click();
  await expect(client.getByText('Reviewed instruction')).toBeVisible();
  await expect(page.getByText('Unreviewed source must not display')).toHaveCount(0);
  await expect(page.getByText('Unreviewed access')).toHaveCount(0);
  expect(rawStopRequests).toBe(0);
  await expect(client.getByText('Gate checkpoint')).toBeVisible();
  await expect(client.getByText('Required for patrol completion')).toBeVisible();
  await client.getByRole('button', { name: 'Record Visit' }).click();
  await client.getByRole('button', { name: /Confirm & Record Visit/ }).click();
  await expect(client.getByText(/Verified/)).toBeVisible();
  await expect(page.getByText('Checkpoints: 1 / 1 completed (100%)')).toBeVisible();
  for (const viewport of [{ width: 320, height: 640 }, { width: 375, height: 812 }, { width: 640, height: 320 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }, { width: 2560, height: 1440 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await page.locator('.patrol-page').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const shiftButton = page.locator('.patrol-page .shift-card').first();
    await shiftButton.scrollIntoViewIfNeeded();
    expect(await shiftButton.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.shift-card') === element;
    })).toBe(true);
  }
});

test('a fresh location automatically records a verified checkpoint and refreshes the receipt', async ({ page }) => {
  await setup(page, 'officer');
  await page.addInitScript(() => {
    let update: PositionCallback | undefined;
    const makeFix = (latitude: number, accuracy: number): GeolocationPosition => ({
      timestamp: Date.now(),
      coords: { latitude, longitude: 174, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) },
      toJSON: () => ({}),
    });
    Object.defineProperty(navigator.geolocation, 'watchPosition', { value: (callback: PositionCallback) => { update = callback; return 1; } });
    Object.defineProperty(navigator.geolocation, 'clearWatch', { value: () => undefined });
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', { value: (callback: PositionCallback) => callback(makeFix(-42, 5)) });
    Object.defineProperty(window, 'testPatrolFix', { value: (latitude: number, accuracy: number) => update?.(makeFix(latitude, accuracy)) });
  });
  await page.route('**/rest/v1/shifts**', async (route) => {
    if (!new URL(route.request().url()).searchParams.get('select')?.includes('shift_stops')) return route.fallback();
    await route.fulfill({ json: [{ ...overnight, organization_id: '33333333-3333-4333-8333-333333333333',
      officer_user_id: '22222222-2222-4222-8222-222222222222', shift_stops: [], created_at: overnight.scheduled_start }] });
  });
  let recorded = false;
  await page.route('**/rest/v1/rpc/get_officer_patrol_journey', async (route) => route.fulfill({ json: {
    ...journey(route.request().postDataJSON().p_shift_id as string, [{ id: 'site-check', kind: 'site', name: 'Gate checkpoint', required: true,
      visited: recorded, sequence_order: 1, site_id: null, zone_id: 'zone-1', stop_ids: [], auto_geofence_status: 'verified' }]),
    checkpoint_requirement: 'site_zone',
  } }));
  let requests = 0;
  let failNext = false;
  await page.route('**/rest/v1/rpc/auto_record_patrol_checkpoints', async (route) => {
    const args = route.request().postDataJSON();
    expect(args.p_shift_id).toBe(overnightId);
    requests++;
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 503, json: { message: 'Unavailable' } });
      return;
    }
    const inside = args.p_gps_lat === -41;
    const newlyRecorded = inside && !recorded;
    if (newlyRecorded) recorded = true;
    await route.fulfill({ json: { status: 'processed', shift_id: overnightId, patrol_id: 'patrol-1',
      recorded_checkpoint_ids: newlyRecorded ? ['site-check'] : [], checkpoints: [{ checkpoint_id: 'site-check', status: inside ? newlyRecorded ? 'recorded' : 'already_recorded' : 'outside_geofence' }] } });
  });
  await page.route('**/rest/v1/rpc/get_assigned_patrol_session', async (route) => {
    const shiftId = route.request().postDataJSON().p_shift_id as string;
    await route.fulfill({ json: sessionRead(shiftId, recorded && shiftId === overnightId ? [{
      id: 'visit-auto', checkpoint_id: 'site-check', route_checkpoint_id: null, visited_at: '2026-08-30T01:15:00Z',
      scan_method: 'gps', notes: null, within_radius: true, checkpoint_verification_at_visit: 'verified',
    }] : []) });
  });
  await signInAsOfficer(page, `/officer/patrol?shift=${overnightId}`);
  await expect(page.getByText(/Automatic checkpoint recording is active/)).toBeVisible();
  await page.getByRole('button', { name: 'Record Visit' }).click();
  await page.getByLabel('Officer Observations / Notes (Optional)').fill('Unsubmitted observation');
  const priorRequests = requests;
  await page.evaluate(() => (window as unknown as { testPatrolFix: (lat: number, accuracy: number) => void }).testPatrolFix(-41, 100));
  await expect(page.getByText(/fresh, accurate GPS fix/)).toBeVisible();
  expect(requests).toBe(priorRequests);
  await page.evaluate(() => (window as unknown as { testPatrolFix: (lat: number, accuracy: number) => void }).testPatrolFix(-41, 5));
  await expect(page.getByText(/Verified 0?1:15/)).toBeVisible();
  await expect(page.getByLabel('Officer Observations / Notes (Optional)')).toHaveValue('Unsubmitted observation');
  await expect(page.getByText(/draft notes were not saved/)).toBeVisible();
  await expect(page.getByText(/Checkpoint verified and recorded/)).toBeVisible();
  await page.evaluate(() => (window as unknown as { testPatrolFix: (lat: number, accuracy: number) => void }).testPatrolFix(-41, 5));
  await expect.poll(() => requests).toBeGreaterThan(priorRequests + 1);
  await expect(page.getByText(/Verified 0?1:15/)).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: /Later route/ }).click();
  await expect(page.getByText('Automatic checkpoint recording monitors your active shift, not this selected shift.')).toBeVisible();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  failNext = true;
  await page.evaluate(() => (window as unknown as { testPatrolFix: (lat: number, accuracy: number) => void }).testPatrolFix(-41, 5));
  await expect(page.getByRole('alert').filter({ hasText: 'Automatic checkpoint recording could not be confirmed' })).toBeVisible();
  await page.getByRole('button', { name: 'Try location again' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Automatic checkpoint recording could not be confirmed' })).toHaveCount(0);
});
