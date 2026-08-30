import { expect, type Page } from '@playwright/test';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OFFICER_ID = '22222222-2222-4222-8222-222222222222';
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
        : [{ id: ADMIN_ID, display_name: 'Morgan Reed', email: user.email }, { id: OFFICER_ID, display_name: 'Ana Ngata', email: 'ana@fcm.test' }];
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

export function monitorBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('WebSocket')) errors.push(message.text());
  });
  return errors;
}