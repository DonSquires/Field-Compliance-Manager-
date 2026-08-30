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
      await route.fulfill(fulfillJson([{ id: OFFICER_ID, user_id: OFFICER_ID, employment_type: 'permanent', work_ready: true }, { id: SECOND_OFFICER_ID, user_id: SECOND_OFFICER_ID, employment_type: 'casual', work_ready: false }]));
      return;
    }
    if (table === 'staff_credentials') {
      await route.fulfill(fulfillJson([{ staff_id: OFFICER_ID, expiry_date: '2027-06-01', verified: true }, { staff_id: SECOND_OFFICER_ID, expiry_date: '2026-09-10', verified: true }]));
      return;
    }
    if (table === 'shifts') {
      await route.fulfill(fulfillJson([{ id: '12121212-1212-4212-8212-121212121212', officer_user_id: OFFICER_ID, service_type: 'patrol', scheduled_start: '2026-08-25T20:00:00.000Z', scheduled_end: '2026-08-26T04:00:00.000Z', status: 'published', shift_health: null, total_stops: 8, notes: 'North district' }, { id: '13131313-1313-4313-8313-131313131313', officer_user_id: OFFICER_ID, service_type: 'site_guard', scheduled_start: '2026-08-27T08:00:00.000Z', scheduled_end: '2026-08-27T16:00:00.000Z', status: 'in_progress', shift_health: 'on_track', total_stops: 1, notes: null }]));
      return;
    }
    if (table === 'leave_requests') {
      await route.fulfill(fulfillJson([{ staff_id: SECOND_OFFICER_ID, starts_on: '2026-08-28', ends_on: '2026-08-29', status: 'approved' }]));
      return;
    }
    if (table === 'shift_coverage_requests') {
      await route.fulfill(fulfillJson([{ id: '14141414-1414-4414-8414-141414141414', shift_date: '2026-08-29', urgency: 'high', required_staff_count: 2 }]));
      return;
    }
    if (table === 'create_roster_shift') {
      await route.fulfill(fulfillJson({ id: '15151515-1515-4515-8515-151515151515', officer_user_id: OFFICER_ID, status: 'published' }));
      return;
    }
    await route.fulfill(fulfillJson([]));
  });
}

export async function installOfficerScheduleFixtures(page: Page): Promise<void> {
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