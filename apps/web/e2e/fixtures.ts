import { expect, type Page } from '@playwright/test';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OFFICER_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_OFFICER_ID = '2f2f2f2f-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';

const user = {
  id: ADMIN_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'admin@fcm.test',
  email_confirmed_at: '2026-08-01T00:00:00.000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  created_at: '2026-08-01T00:00:00.000Z',
};

const officerUser = { ...user, id: OFFICER_ID, email: 'ana@fcm.test' };

const reports = [
  {
    id: '44444444-4444-4444-8444-444444444444', organization_id: ORG_ID, officer_id: OFFICER_ID,
    report_type: 'health_safety', severity: 'critical', status: 'submitted', title: 'Unsafe access at North Yard',
    description: 'Gate lighting failed during the patrol. The officer used the alternate controlled entrance.',
    location_name: 'North Yard', address: '14 Harbour Road', immediate_action: 'Area isolated and supervisor notified.',
    follow_up_required: true, follow_up_notes: 'Facilities attendance required before the next night shift.',
    reviewed_by: null, reviewed_at: null, review_notes: null, reported_at: '2026-08-30T08:15:00.000Z',
  },
  {
    id: '55555555-5555-4555-8555-555555555555', organization_id: ORG_ID, officer_id: OFFICER_ID,
    report_type: 'incident', severity: 'medium', status: 'reviewed', title: 'After-hours gate contact',
    description: 'Contractor arrived outside the approved access window.', location_name: 'South Gate', address: null,
    immediate_action: 'Identity checked and access declined.', follow_up_required: false, follow_up_notes: null,
    reviewed_by: ADMIN_ID, reviewed_at: '2026-08-30T07:00:00.000Z', review_notes: 'Access log reconciled. No escalation required.',
    reported_at: '2026-08-30T06:30:00.000Z',
  },
];

function countFor(pathname: string): number {
  if (pathname.endsWith('/shifts')) return 4;
  if (pathname.endsWith('/dispatch_jobs')) return 7;
  if (pathname.endsWith('/welfare_alerts')) return 2;
  if (pathname.endsWith('/officer_field_reports')) return 1;
  return 0;
}

function fulfillJson(body: unknown, headers: Record<string, string> = {}) {
  return { status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) };
}

export async function installSupabaseFixtures(page: Page): Promise<void> {
  let adminSlotStatus = 'published';
  let adminSlotStaffId = OFFICER_ID;
  let holidayRegion = 'AUK';
  let hrLeaveStatus = 'pending';
  let hrTimesheetStatus = 'submitted';
  const hrCoverage = [{ id: '14141414-1414-4414-8414-141414141414', shift_date: '2026-09-05', start_time: '18:00:00', end_time: '23:00:00', required_staff_count: 2, urgency: 'high', status: 'open', notes: 'Event perimeter', site: null }];
  const workplaces = [{ id: '16161616-1616-4616-8616-161616161616', name: 'Operations Centre' }];
  const costCentres = [{ id: '17171717-1717-4717-8717-171717171717', code: 'OPS-01', name: 'Field Operations' }];
  const workUnits = [
    { id: '18181818-1818-4818-8818-181818181818', name: 'North District Patrol', work_unit_type: 'patrol', service_type: 'patrol', active: true, patrol_route_id: '19191919-1919-4919-8919-191919191919', service_agreement_location_id: null, service_agreement_module_id: null, workplace_id: null, team_id: null, cost_centre_id: null },
    { id: '20202020-2020-4020-8020-202020202020', name: 'Civic Centre Static Post', work_unit_type: 'static', service_type: 'static_guarding', active: true, patrol_route_id: null, service_agreement_location_id: '21212121-2121-4121-8121-212121212121', service_agreement_module_id: '22222222-2222-4222-8222-222222222229', workplace_id: null, team_id: null, cost_centre_id: null },
    { id: '23232323-2323-4323-8323-232323232323', name: 'Roster Administration', work_unit_type: 'internal', service_type: 'administration', active: true, patrol_route_id: null, service_agreement_location_id: null, service_agreement_module_id: null, workplace_id: workplaces[0].id, team_id: null, cost_centre_id: costCentres[0].id },
  ];
  await page.route('**/auth/v1/token?grant_type=password', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'e2e-access-token', refresh_token: 'e2e-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: 1893456000, user }) });
  });
  await page.route('**/auth/v1/user', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(user) }));
  await page.route('**/auth/v1/token?grant_type=refresh_token', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'e2e-access-token', refresh_token: 'e2e-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: 1893456000, user }) }));

  await page.route('**/rest/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const table = url.pathname.split('/').at(-1);
    if (request.method() === 'HEAD' || request.headers()['prefer']?.includes('count=exact')) {
      await route.fulfill({
        status: 200,
        headers: {
          'access-control-expose-headers': 'Content-Range',
          'content-range': `0-0/${countFor(url.pathname)}`,
        },
        body: '',
      });
      return;
    }
    if (table === 'user_profiles') {
      const select = url.searchParams.get('select') ?? '';
      const body = select.includes('organization_id')
        ? [{ id: ADMIN_ID, display_name: 'Morgan Reed', email: user.email, role: 'admin', organization_id: ORG_ID }]
        : [{ id: OFFICER_ID, display_name: 'Ana Ngata', email: 'ana@fcm.test', role: 'officer' }, { id: SECOND_OFFICER_ID, display_name: 'Jordan Lee', email: 'jordan@fcm.test', role: 'officer' }];
      await route.fulfill(fulfillJson(body));
      return;
    }
    if (table === 'organizations') {
      await route.fulfill(fulfillJson({ name: 'Harbour Compliance Services' }));
      return;
    }
    if (table === 'officer_field_reports') {
      await route.fulfill(fulfillJson(reports));
      return;
    }
    if (table === 'staff_profiles') {
      await route.fulfill(fulfillJson([{ id: OFFICER_ID, user_id: OFFICER_ID, employment_type: 'permanent', work_ready: true }, { id: SECOND_OFFICER_ID, user_id: SECOND_OFFICER_ID, employment_type: 'casual', work_ready: true }]));
      return;
    }
    if (table === 'staff_credentials') {
      await route.fulfill(fulfillJson([{ id: '34343434-3434-4434-8434-343434343434', staff_id: OFFICER_ID, credential_type: 'security_licence', credential_number: 'SL-2048', expiry_date: '2027-06-01', verified: true }, { id: '35353535-3535-4535-8535-353535353535', staff_id: SECOND_OFFICER_ID, credential_type: 'first_aid', credential_number: 'FA-1024', expiry_date: '2026-09-10', verified: true }]));
      return;
    }
    if (table === 'staff_availability') {
      await route.fulfill(fulfillJson([{ staff_id: SECOND_OFFICER_ID, day_of_week: null, specific_date: '2026-08-26', available_from: null, available_to: null, all_day: true, availability_type: 'unavailable' }]));
      return;
    }
    if (table === 'organization_calendar_settings') { await route.fulfill(fulfillJson([{ region_code: holidayRegion }])); return; }
    if (table === 'get_roster_commercial_readiness') { await route.fulfill(fulfillJson([{ slot_id: '32323232-3232-4232-8232-323232323232', pay_status: 'missing_rule', billing_status: 'not_applicable', quote_status: 'not_applicable', geofence_status: 'not_applicable', cost_centre_status: 'ready' }])); return; }
    if (table === 'shifts') {
      await route.fulfill(fulfillJson([{ id: '12121212-1212-4212-8212-121212121212', officer_user_id: OFFICER_ID, service_type: 'patrol', scheduled_start: '2026-08-25T20:00:00.000Z', scheduled_end: '2026-08-26T04:00:00.000Z', status: 'published', shift_health: null, total_stops: 8, notes: 'North district' }, { id: '13131313-1313-4313-8313-131313131313', officer_user_id: OFFICER_ID, service_type: 'site_guard', scheduled_start: '2026-08-27T08:00:00.000Z', scheduled_end: '2026-08-27T16:00:00.000Z', status: 'in_progress', shift_health: 'on_track', total_stops: 1, notes: null }]));
      return;
    }
    if (table === 'leave_requests') {
      const rosterQuery = url.searchParams.get('status') === 'eq.approved';
      await route.fulfill(fulfillJson(rosterQuery ? [{ staff_id: SECOND_OFFICER_ID, starts_on: '2026-08-28', ends_on: '2026-08-29', status: 'approved' }] : [{ id: '36363636-3636-4636-8636-363636363636', staff_id: OFFICER_ID, leave_type: 'annual', starts_on: '2026-09-14', ends_on: '2026-09-16', status: hrLeaveStatus, reason: 'Family commitment' }]));
      return;
    }
    if (table === 'shift_coverage_requests') {
      await route.fulfill(fulfillJson(hrCoverage));
      return;
    }
    if (table === 'shift_templates') { await route.fulfill(fulfillJson([{ id: '37373737-3737-4737-8737-373737373737', name: 'Night Patrol', shift_type: 'patrol', start_time: '20:00:00', end_time: '04:00:00', recurrence_type: 'weekly', required_staff_count: 2, is_active: true }])); return; }
    if (table === 'timesheets') { await route.fulfill(fulfillJson([{ id: '38383838-3838-4838-8838-383838383838', staff_id: OFFICER_ID, period_start: '2026-08-17', period_end: '2026-08-23', scheduled_hours: 40, actual_hours: 42, status: hrTimesheetStatus }])); return; }
    if (table === 'create_roster_shift') {
      await route.fulfill(fulfillJson({ id: '15151515-1515-4515-8515-151515151515', officer_user_id: OFFICER_ID, status: 'published' }));
      return;
    }
    if (table === 'roster_work_units') { await route.fulfill(fulfillJson(workUnits)); return; }
    if (table === 'roster_slots') { await route.fulfill(fulfillJson([{ id: '32323232-3232-4232-8232-323232323232', work_unit_id: '23232323-2323-4323-8323-232323232323', staff_id: adminSlotStaffId, scheduled_start: '2026-08-28T21:00:00.000Z', scheduled_end: '2026-08-29T01:00:00.000Z', status: adminSlotStatus, linked_shift_id: null, notes: 'Roster administration' }])); return; }
    if (table === 'patrol_routes') { await route.fulfill(fulfillJson([{ id: '19191919-1919-4919-8919-191919191919', name: 'North District Patrol' }])); return; }
    if (table === 'service_agreement_locations') { await route.fulfill(fulfillJson([{ id: '21212121-2121-4121-8121-212121212121', service_agreement_id: '24242424-2424-4424-8424-242424242424', site_id: '25252525-2525-4525-8525-252525252525', zone_id: null }])); return; }
    if (table === 'service_agreement_modules') { await route.fulfill(fulfillJson([{ id: '22222222-2222-4222-8222-222222222229', service_agreement_id: '24242424-2424-4424-8424-242424242424', module_key: 'static_guarding' }])); return; }
    if (table === 'client_sites') { await route.fulfill(fulfillJson([{ id: '25252525-2525-4525-8525-252525252525', name: 'Civic Centre' }])); return; }
    if (table === 'location_zones') { await route.fulfill(fulfillJson([])); return; }
    if (table === 'organization_workplaces') { await route.fulfill(fulfillJson(workplaces)); return; }
    if (table === 'teams') { await route.fulfill(fulfillJson([{ id: '26262626-2626-4626-8626-262626262626', name: 'Operations Support' }])); return; }
    if (table === 'cost_centres') { await route.fulfill(fulfillJson(costCentres)); return; }
    if (table === 'create_organization_workplace') { const row = { id: '27272727-2727-4727-8727-272727272727', name: 'Head Office' }; workplaces.push(row); await route.fulfill(fulfillJson(row)); return; }
    if (table === 'create_cost_centre') { const row = { id: '28282828-2828-4828-8828-282828282828', code: 'ADMIN', name: 'Administration' }; costCentres.push(row); await route.fulfill(fulfillJson(row)); return; }
    if (table === 'create_roster_work_unit') { const row = { id: '29292929-2929-4929-8929-292929292929', name: 'Head Office Administration', work_unit_type: 'internal', service_type: 'administration', active: true, patrol_route_id: null, service_agreement_location_id: null, service_agreement_module_id: null, workplace_id: '27272727-2727-4727-8727-272727272727', team_id: null, cost_centre_id: '28282828-2828-4828-8828-282828282828' }; workUnits.push(row); await route.fulfill(fulfillJson(row)); return; }
    if (table === 'create_roster_slot') { await route.fulfill(fulfillJson({ id: '30303030-3030-4030-8030-303030303030', status: 'published' })); return; }
    if (table === 'materialize_roster_slot') { await route.fulfill(fulfillJson([{ slot_id: '30303030-3030-4030-8030-303030303030', shift_id: '31313131-3131-4131-8131-313131313131', created: true }])); return; }
    if (table === 'manage_roster_slot') { adminSlotStatus = 'cancelled'; await route.fulfill(fulfillJson([{ slot_id: '32323232-3232-4232-8232-323232323232', slot_status: 'cancelled', shift_id: null, shift_status: null }])); return; }
    if (table === 'reassign_roster_slot') { adminSlotStaffId = SECOND_OFFICER_ID; adminSlotStatus = 'published'; await route.fulfill(fulfillJson([{ slot_id: '32323232-3232-4232-8232-323232323232', slot_status: 'published', staff_id: SECOND_OFFICER_ID, shift_id: null, shift_status: null }])); return; }
    if (table === 'set_organization_calendar_region') { holidayRegion = JSON.parse(request.postData() ?? '{}').p_region_code ?? ''; await route.fulfill(fulfillJson({ organization_id: ORG_ID, country_code: 'NZ', region_code: holidayRegion })); return; }
    if (table === 'review_leave_request') { hrLeaveStatus = JSON.parse(request.postData() ?? '{}').p_decision; await route.fulfill(fulfillJson({ id: '36363636-3636-4636-8636-363636363636', status: hrLeaveStatus })); return; }
    if (table === 'review_timesheet') { hrTimesheetStatus = JSON.parse(request.postData() ?? '{}').p_decision; await route.fulfill(fulfillJson({ id: '38383838-3838-4838-8838-383838383838', status: hrTimesheetStatus })); return; }
    if (table === 'create_shift_coverage_request') { const payload = JSON.parse(request.postData() ?? '{}'); const row = { id: '39393939-3939-4939-8939-393939393939', shift_date: payload.p_shift_date, start_time: payload.p_start_time, end_time: payload.p_end_time, required_staff_count: payload.p_required_staff_count, urgency: payload.p_urgency, status: 'open', notes: payload.p_notes }; hrCoverage.unshift(row); await route.fulfill(fulfillJson(row)); return; }
    await route.fulfill(fulfillJson([]));
  });
}

export async function installOfficerScheduleFixtures(page: Page): Promise<void> {
  let internalSlotStatus = 'published';
  await page.route('**/auth/v1/token?grant_type=password', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'officer-e2e-token', refresh_token: 'officer-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: 1893456000, user: officerUser }) });
  });
  await page.route('**/auth/v1/user', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(officerUser) }));
  await page.route('**/rest/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const resource = url.pathname.split('/').at(-1);
    const select = url.searchParams.get('select') ?? '';
    if (resource === 'user_profiles') {
      await route.fulfill(fulfillJson([{ id: OFFICER_ID, display_name: 'Ana Ngata', email: officerUser.email, role: 'officer', organization_id: ORG_ID }]));
      return;
    }
    if (resource === 'staff_profiles') {
      await route.fulfill(fulfillJson({ id: OFFICER_ID }));
      return;
    }
    if (resource === 'shifts') {
      if (select.includes('shift_stops')) {
        await route.fulfill(fulfillJson([]));
        return;
      }
      await route.fulfill(fulfillJson([
        { id: '66666666-6666-4666-8666-666666666666', organization_id: ORG_ID, officer_user_id: OFFICER_ID, service_type: 'patrol', scheduled_start: '2026-08-31T06:00:00.000Z', scheduled_end: '2026-08-31T14:00:00.000Z', status: 'accepted', notes: 'North district patrol', shift_health: null, total_stops: 8 },
        { id: '77777777-7777-4777-8777-777777777777', organization_id: ORG_ID, officer_user_id: OFFICER_ID, service_type: 'site_guard', scheduled_start: '2026-09-02T18:00:00.000Z', scheduled_end: '2026-09-03T02:00:00.000Z', status: 'published', notes: null, shift_health: null, total_stops: 1 },
      ]));
      return;
    }
    if (resource === 'shift_coverage_requests') {
      await route.fulfill(fulfillJson([
        { id: '88888888-8888-4888-8888-888888888888', shift_date: '2026-09-01', start_time: '18:00:00', end_time: '23:00:00', required_staff_count: 2, urgency: 'high', notes: 'Event perimeter support', site: [{ name: 'Civic Events Centre' }] },
      ]));
      return;
    }
    if (resource === 'roster_slots') {
      await route.fulfill(fulfillJson([
        { id: '33333333-3333-4333-8333-333333333334', work_unit_id: '44444444-4444-4444-8444-444444444445', scheduled_start: '2026-08-31T06:00:00.000Z', scheduled_end: '2026-08-31T14:00:00.000Z', status: 'published', linked_shift_id: '66666666-6666-4666-8666-666666666666', notes: null },
        { id: '55555555-5555-4555-8555-555555555556', work_unit_id: '77777777-7777-4777-8777-777777777778', scheduled_start: '2026-09-03T21:00:00.000Z', scheduled_end: '2026-09-04T01:00:00.000Z', status: internalSlotStatus, linked_shift_id: null, notes: 'Monthly roster reconciliation' },
      ]));
      return;
    }
    if (resource === 'roster_work_units') {
      await route.fulfill(fulfillJson([
        { id: '44444444-4444-4444-8444-444444444445', name: 'North District Patrol', work_unit_type: 'patrol', service_type: 'patrol' },
        { id: '77777777-7777-4777-8777-777777777778', name: 'Roster Administration', work_unit_type: 'internal', service_type: 'administration' },
      ]));
      return;
    }
    if (resource === 'shift_debriefs') {
      await route.fulfill(fulfillJson([]));
      return;
    }
    if (resource === 'officer_field_reports') {
      await route.fulfill(fulfillJson([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', report_type: 'maintenance', severity: 'medium', status: 'submitted', title: 'Damaged perimeter sign', description: 'Sign mount is loose at the eastern vehicle entrance.', location_name: 'East Gate', reported_at: '2026-08-30T06:00:00.000Z', follow_up_required: true }]));
      return;
    }
    if (resource === 'claim_shift_coverage') {
      await route.fulfill(fulfillJson({ id: '88888888-8888-4888-8888-888888888888', status: 'claimed', claimed_by: OFFICER_ID }));
      return;
    }
    if (resource === 'submit_shift_debrief') {
      await route.fulfill(fulfillJson([{ id: '99999999-9999-4999-8999-999999999999', created: true, submitted_at: '2026-08-30T09:30:00.000Z' }]));
      return;
    }
    if (resource === 'submit_officer_field_report') {
      await route.fulfill(fulfillJson([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', created: true, received_at: '2026-08-30T09:30:00.000Z' }]));
      return;
    }
    if (resource === 'respond_to_roster_slot') {
      internalSlotStatus = 'declined';
      await route.fulfill(fulfillJson([{ slot_id: '55555555-5555-4555-8555-555555555556', slot_status: 'declined', shift_id: null, shift_status: null }]));
      return;
    }
    await route.fulfill(fulfillJson([]));
  });
}

export async function signInAsAdmin(page: Page, destination = '/admin/field-ops?area=landing'): Promise<void> {
  await page.goto(destination);
  await page.getByLabel('Email address').fill(user.email);
  await page.getByLabel('Password').fill('playwright-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeHidden();
}

export async function signInAsOfficer(page: Page, destination = '/officer/schedule'): Promise<void> {
  await page.goto(destination);
  await page.getByLabel('Email address').fill(officerUser.email);
  await page.getByLabel('Password').fill('playwright-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeHidden();
}

export function monitorBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('WebSocket')) errors.push(message.text());
  });
  return errors;
}