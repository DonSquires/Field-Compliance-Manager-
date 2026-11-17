import { expect, test } from '@playwright/test';
import {
  installOfficerScheduleFixtures,
  installSupabaseFixtures,
  monitorBrowserErrors,
  signInAsAdmin,
  signInAsOfficer,
} from './fixtures';

test.describe('paired patrol and dispatch acceptance', () => {
  test('admin and officer complete a correlated dispatch handoff', async ({ browser }) => {
    const events: string[] = [];
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const officerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const admin = await adminContext.newPage();
    const officer = await officerContext.newPage();
    const adminErrors = monitorBrowserErrors(admin);
    const officerErrors = monitorBrowserErrors(officer);

    await installSupabaseFixtures(admin, { officerModules: ['dispatch'] });
    await installOfficerScheduleFixtures(officer);
    const job = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', job_type: 'alarm_response', priority: 'high', status: 'dispatched',
      briefing_notes: 'Verify the north loading entrance and record the outcome.', sla_minutes: 15, sla_respond_by: '2026-08-30T10:00:00.000Z', sla_breached: false,
      expected_dwell_minutes: 8, timing_source: 'dispatcher_override', shift_id: '66666666-6666-4666-8666-666666666666', client_site_id: '42424242-4242-4242-8242-424242424242',
      created_at: '2026-08-30T09:00:00.000Z', completed_at: null as string | null, outcome_notes: null as string | null,
      site: { name: 'Civic Operations Centre', address: '10 Waimea Road, Nelson', hs_notes: 'Boundary-first arrival check required.', access_instructions: 'Use the north loading entrance.' }, resource: { name: 'Unit N587' },
    };
    for (const page of [admin, officer]) {
      await page.route('**/rest/v1/dispatch_jobs**', async (route) => {
        const single = new URL(route.request().url()).searchParams.has('id');
        const active = !['completed', 'cancelled'].includes(job.status);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(single || active ? [job] : []) });
      });
    }
    const transitions: string[] = [];
    await officer.route('**/rest/v1/rpc/advance_dispatch_job_status', async (route) => {
      const payload = route.request().postDataJSON();
      expect(payload.p_job_id).toBe(job.id);
      expect(payload.p_expected_status).toBe(job.status);
      job.status = payload.p_next_status;
      job.outcome_notes = payload.p_outcome_notes;
      if (job.status === 'completed') job.completed_at = '2026-08-30T09:30:00.000Z';
      transitions.push(job.status);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: job.id, status: job.status, shift_id: job.shift_id, completed_at: job.completed_at }]) });
    });
    await Promise.all([
      signInAsAdmin(admin, '/admin/hub'),
      signInAsOfficer(officer, '/officer/dispatch'),
    ]);

    await expect(admin.locator('nav').first()).toBeVisible();
    events.push('admin-online');

    await expect(officer.getByRole('heading', { name: 'Dispatch', exact: true })).toBeVisible();
    await expect(officer.getByText('Alarm response', { exact: true })).toBeVisible();
    events.push('officer-received-dispatch');

    await officer.getByRole('button', { name: 'Acknowledge job' }).click();
    await officer.getByRole('button', { name: 'On my way' }).click();
    await officer.getByRole('button', { name: 'Arrived on site' }).click();

    const complete = officer.getByRole('button', { name: 'Complete job' });
    await expect(complete).toBeDisabled();
    await officer.getByLabel('Outcome notes').fill('Paired test: entrance checked, panel reset, supervisor notified.');
    await expect(complete).toBeEnabled();
    await complete.click();
    await expect(officer.getByRole('region', { name: 'Dispatch completion receipt' })).toContainText('Dispatch completed');
    await expect(officer.getByText('No active dispatch jobs right now.')).toBeVisible();
    events.push('officer-completed-dispatch');

    await admin.goto('/admin/field-ops?area=dispatch&job=cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    await expect(admin.getByLabel(/Dispatch details for/i)).toBeVisible();
    await expect(admin.getByText(/Verify the north loading entrance/)).toBeVisible();
    await expect(admin.getByLabel(/Dispatch details for/i)).toContainText('Completed');
    expect(transitions).toEqual(['acknowledged', 'en_route', 'on_scene', 'completed']);
    expect(job.outcome_notes).toBe('Paired test: entrance checked, panel reset, supervisor notified.');
    events.push('admin-verified-dispatch-receipt');

    expect(events).toEqual([
      'admin-online',
      'officer-received-dispatch',
      'officer-completed-dispatch',
      'admin-verified-dispatch-receipt',
    ]);
    expect(adminErrors, adminErrors.join('\n')).toEqual([]);
    expect(officerErrors, officerErrors.join('\n')).toEqual([]);
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await officer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await adminContext.close();
    await officerContext.close();
  });

  test('officer patrol exercises session, checkpoint, completion, and receipt states', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-08-30T09:30:00Z'));
    await installOfficerScheduleFixtures(page);
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (success) => success({
        coords: { latitude: -41.274, longitude: 173.283, accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) },
        timestamp: Date.now(), toJSON: () => ({}),
      });
    });
    const browserErrors = monitorBrowserErrors(page);
    let patrolStatus: 'not_started' | 'in_progress' | 'completed' = 'not_started';
    let visited = false;
    await page.route('**/rest/v1/shifts**', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'patrol-shift-0001', service_type: 'patrol', scheduled_start: '2026-08-30T08:00:00.000Z', scheduled_end: '2026-08-30T16:00:00.000Z', status: 'published', zone_id: 'zone-0001', patrol_route_id: 'route-0001', zone: { name: 'North District Patrol' }, route: { name: 'North District Patrol', route_code: 'NDP-01' } }]) });
    });
    await page.route('**/rest/v1/rpc/get_assigned_officer_shift_context', async (route) => route.fulfill({ json: [{
      id: 'patrol-shift-0001', organization_id: '33333333-3333-4333-8333-333333333333',
      officer_user_id: '22222222-2222-4222-8222-222222222222', service_type: 'patrol',
      scheduled_start: '2026-08-30T08:00:00.000Z', scheduled_end: '2026-08-30T16:00:00.000Z', status: 'published',
      zone_id: 'zone-0001', patrol_route_id: 'route-0001', location_id: null,
      service_agreement_location_id: null, service_agreement_module: null, shift_stops: [],
      created_at: '2026-08-30T08:00:00.000Z', updated_at: '2026-08-30T08:00:00.000Z',
      zone_name: null, route_name: null, route_code: null, context_status: 'available',
    }] }));
    await page.route('**/rest/v1/rpc/get_assigned_patrol_session', async (route) => {
      expect(route.request().postDataJSON().p_shift_id).toBe('patrol-shift-0001');
      await route.fulfill({ json: {
        shift_id: 'patrol-shift-0001',
        session: patrolStatus === 'not_started' ? null : {
          id: 'patrol-session-0001', status: patrolStatus, started_at: '2026-08-30T09:30:00.000Z',
          ended_at: patrolStatus === 'completed' ? '2026-08-30T09:40:00Z' : null,
        },
        visits: visited ? [{ id: 'visit-0001', checkpoint_id: null, route_checkpoint_id: 'checkpoint-0001',
          visited_at: '2026-08-30T09:35:00Z', scan_method: 'gps', notes: null,
          within_radius: true, checkpoint_verification_at_visit: null }] : [],
      } });
    });
    await page.route('**/rest/v1/rpc/get_officer_patrol_journey', async (route) => route.fulfill({ json: {
      shift_id: 'patrol-shift-0001', patrol_id: patrolStatus === 'in_progress' ? 'patrol-session-0001' : null, checkpoint_requirement: 'route', route_geometry: null,
      route_geometry_status: 'unavailable', stops: [], checkpoints: [{ id: 'checkpoint-0001', kind: 'route',
        name: 'North loading entrance', required: true, visited, sequence_order: 1, site_id: null, zone_id: null, stop_ids: [], auto_geofence_status: 'unavailable_route' }],
    } }));
    await page.route('**/rest/v1/rpc/get_officer_patrol_stops_sanitized', async (route) => route.fulfill({ json: {
      shift: { id: 'patrol-shift-0001', status: 'published', scheduled_start: '2026-08-30T08:00:00Z', scheduled_end: '2026-08-30T16:00:00Z', route_name: null }, stops: [],
    } }));
    await page.route('**/rest/v1/rpc/start_patrol_session', async (route) => {
      patrolStatus = 'in_progress';
      await route.fulfill({ json: { id: 'patrol-session-0001', status: 'in_progress', started_at: '2026-08-30T09:30:00.000Z', notes: null } });
    });
    await page.route('**/rest/v1/rpc/record_patrol_checkpoint_visit', async (route) => {
      expect(route.request().postDataJSON().p_notes).toBe('Gate secure; alarm panel normal.');
      visited = true;
      await route.fulfill({ json: [{ visit_id: 'visit-0001', created: true, visited_at: '2026-08-30T09:35:00Z', scan_method: 'gps', notes: null }] });
    });
    await page.route('**/rest/v1/rpc/complete_patrol_session', async (route) => {
      expect(visited).toBe(true);
      patrolStatus = 'completed';
      await route.fulfill({ json: { id: 'patrol-session-0001', status: 'completed', ended_at: '2026-08-30T09:40:00Z', notes: null } });
    });

    await signInAsOfficer(page, '/officer/patrol');
    const patrolPage = page.locator('.patrol-page');
    await expect(patrolPage.getByRole('heading', { name: 'Patrol shifts and stops' })).toBeVisible({ timeout: 30_000 });
    const shift = patrolPage.getByRole('button', { name: /North District Patrol|PATROL/i }).first();
    await expect(shift).toBeVisible();
    await shift.click();
    await expect(patrolPage.getByRole('button', { name: /Start Patrol Session/ })).toBeVisible();
    await patrolPage.getByRole('button', { name: /Start Patrol Session/ }).click();
    await expect(patrolPage.getByText('Other patrol checkpoints (1)', { exact: true })).toBeVisible();
    await patrolPage.getByRole('button', { name: 'Record Visit' }).click();
    await patrolPage.getByPlaceholder(/Site secure/).fill('Gate secure; alarm panel normal.');
    await patrolPage.getByRole('button', { name: '✓ Confirm & Record Visit' }).click();
    await expect(patrolPage.getByText(/Visited/)).toBeVisible();
    await expect(patrolPage.getByRole('button', { name: 'Complete Patrol Session' })).toBeVisible();
    await patrolPage.getByRole('button', { name: 'Complete Patrol Session' }).click();
    await patrolPage.getByRole('button', { name: 'Confirm & Complete' }).click();
    await expect(patrolPage.getByText('Patrol Completed', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
  });
});
