import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test('an officer records an access-control event and receives the governed receipt', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page, { officerModules: ['access_control'] });
  await page.route('**/rest/v1/service_agreement_locations*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ service_agreement_id: '24242424-2424-4424-8424-242424242424', site_id: null, zone_id: '67676767-6767-4767-8767-676767676767', status: 'active' }]),
    });
  });
  await page.route('**/rest/v1/location_zones*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: '67676767-6767-4767-8767-676767676767', name: 'North Gate Access Zone', zone_type: 'access_control', location_id: '65656565-6565-4565-8565-656565656565', organization_id: '33333333-3333-4333-8333-333333333333', is_active: true }]),
    });
  });
  await page.route('**/rest/v1/user_profiles*', async (route) => {
    const url = new URL(route.request().url());
    const select = url.searchParams.get('select') ?? '';
    if (url.searchParams.get('id') !== 'eq.22222222-2222-4222-8222-222222222222' || !select.includes('module_access')) return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata', email: 'ana@fcm.test', role: 'officer', organization_id: '33333333-3333-4333-8333-333333333333', employer_organization_id: '33333333-3333-4333-8333-333333333333', module_access: ['patrol', 'freedom_camping', 'biosecurity', 'parking', 'smoke_control', 'access_control'], deactivated_at: null }]),
    });
  });
  await page.addInitScript(() => {
    const position = { timestamp: new Date('2026-08-30T09:30:00+12:00').getTime(), coords: { latitude: -41.274, longitude: 173.283, accuracy: 8 } };
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (success: (position: unknown) => void) => success(position),
        watchPosition: (success: (position: unknown) => void) => { success(position); return 1; },
        clearWatch: () => undefined,
      },
    });
  });
  await page.route('**/rest/v1/rpc/resolve_active_rules', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ organization_id: '33333333-3333-4333-8333-333333333333', module_key: 'access_control', enabled: true }]) });
  });
  let submitted: Record<string, unknown> | null = null;
  await page.route('**/functions/v1/submit-access-control-event', async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        event_id: 'acacacac-acac-4cac-8cac-acacacacacac',
        received_at: '2026-08-30T09:35:00.000Z',
        officer_decision: 'record_only',
        evidence_state: 'not_provided',
        recognition_review_state: 'not_requested',
        geofence_status: 'resolved',
        recognition: { status: 'not_requested' },
      }),
    });
  });

  await signInAsOfficer(page, '/officer/access_control');
  await expect(page.getByRole('heading', { name: 'Access control' })).toBeVisible();
  const placeChoice = page.getByRole('group', { name: 'Access-control place' }).getByRole('button', { name: 'North Gate Access Zone Access-control zone' });
  await expect(placeChoice).toBeVisible();
  await placeChoice.click();
  await expect(page.getByRole('heading', { name: 'Event at North Gate Access Zone' })).toBeVisible();
  await page.getByLabel('Officer notes').fill('Synthetic gate check; credential not presented.');
  await page.getByRole('button', { name: 'Record access event' }).click();

  await expect(page.getByText('Event received', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Receipt acacacac' })).toBeVisible();
  await expect(page.getByText('No photo was submitted; no machine candidate was created.')).toBeVisible();
  expect(submitted).toMatchObject({
    site_id: null,
    zone_id: '67676767-6767-4767-8767-676767676767',
    event_kind: 'entry_request',
    subject_kind: 'person',
    officer_decision: 'record_only',
    decision_basis: 'no_decision',
    notes: 'Synthetic gate check; credential not presented.',
    image_base64: null,
  });
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
