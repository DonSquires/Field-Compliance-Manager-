import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
});

test('officer vehicle lookup keeps registry, safety flags, observations, and breaches distinct', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  let baseTableRead = false;
  await page.route('**/rest/v1/canonical_vehicles**', async (route) => { baseTableRead = true; await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); });
  await page.route('**/rest/v1/canonical_vehicle_public**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'abababab-abab-4bab-8bab-abababababab', plate_number: 'ABC123', make: 'Toyota', model: 'Hiace', year: 2018, colour: 'White', body_type: 'van', rego_status: 'current', rego_expiry: '2027-05-01', wof_status: 'expired', wof_expiry: '2026-08-01', cof_status: null, cof_expiry: null, homeless_status: 'confirmed' }]) }));
  await page.route('**/rest/v1/canonical_scv_public**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', certificate_number: 'SCV-2048', certificate_status: 'active', expiry_date: '2027-02-01', issued_date: '2025-02-01' }]) }));
  await page.route('**/rest/v1/entity_flags**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', flag_type: 'officer_safety', alert_level: 'high', reason: 'Supervisor contact required', active: true }]) }));
  await page.route('**/rest/v1/rpc/get_safety_warnings**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'fafafafa-fafa-4afa-8afa-fafafafafafa', entity_type: 'vehicle', entity_id: 'abababab-abab-4bab-8bab-abababababab', requested_id: 'abababab-abab-4bab-8bab-abababababab', hazard_class: 'dangerous_dog', alert_level: 'high', raised_at: '2026-09-01T02:00:00.000Z', organization_id: '77777777-7777-4777-8777-777777777777', organization_name: 'Harbour City Security', contact_email: 'control@harbourcity.test', contact_phone: '04 555 0100', is_own_organization: false, reason: null }]) }));
  await page.route('**/rest/v1/observations**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'dededede-dede-4ede-8ede-dededededede', observed_at: '2026-08-30T08:20:00.000Z', is_compliant: false, compliance_reason: 'nightly_limit_exceeded', nights_this_zone: 3, zone: { name: 'Civic Event Operations Zone' } }]) }));
  await page.route('**/rest/v1/breach_alerts**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'efefefef-efef-4fef-8fef-efefefefefef', breach_type: 'nightly_limit', status: 'open', nights_count: 3, notes: 'Supervisor review required.', created_at: '2026-08-30T08:20:00.000Z', zone: { name: 'Civic Event Operations Zone' } }]) }));

  await signInAsOfficer(page, '/officer/vehicle_lookup');
  await page.getByPlaceholder(/Enter plate number/).fill('abc123');
  await page.getByRole('button', { name: 'Search Plate' }).click();

  await expect(page.getByText('Toyota Hiace (2018)')).toBeVisible();
  await expect(page.getByText('WOF: EXPIRED')).toBeVisible();
  await expect(page.getByText('HOMELESS: CONFIRMED')).toBeVisible();
  await expect(page.getByText('Supervisor contact required')).toBeVisible();
  // Another organisation's H&S warning: hazard, severity and contact path only.
  const warnings = page.getByTestId('safety-warnings');
  await expect(warnings.getByRole('heading', { name: 'Safety warnings (1)' })).toBeVisible();
  await expect(warnings.getByText('Dangerous dog')).toBeVisible();
  await expect(warnings.getByText('Raised by Harbour City Security', { exact: false })).toBeVisible();
  await expect(warnings.getByRole('link', { name: '04 555 0100' })).toHaveAttribute('href', 'tel:045550100');
  await expect(warnings.getByRole('button', { name: 'Mark resolved' })).toHaveCount(0);
  expect(baseTableRead, 'canonical_vehicles must never be read directly by the field').toBe(false);
  await expect(page.getByRole('heading', { name: 'Recent Observations (1)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Compliance Breaches (1)' })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('an officer raises a platform-wide safety warning through the governed RPC', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  const raised: Array<Record<string, unknown>> = [];
  await page.route('**/rest/v1/canonical_vehicle_public**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'abababab-abab-4bab-8bab-abababababab', plate_number: 'ABC123', make: 'Toyota', model: 'Hiace', year: 2018, colour: 'White', body_type: 'van', rego_status: 'current', rego_expiry: null, wof_status: 'current', wof_expiry: null, cof_status: null, cof_expiry: null, homeless_status: 'none' }]) }));
  await page.route('**/rest/v1/rpc/get_safety_warnings**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(raised.length === 0 ? [] : [{ id: 'fbfbfbfb-fbfb-4bfb-8bfb-fbfbfbfbfbfb', entity_type: 'vehicle', entity_id: 'abababab-abab-4bab-8bab-abababababab', requested_id: 'abababab-abab-4bab-8bab-abababababab', hazard_class: raised[0].p_hazard_class, alert_level: raised[0].p_alert_level, raised_at: '2026-09-16T01:00:00.000Z', organization_id: '33333333-3333-4333-8333-333333333333', organization_name: 'Civic Events Compliance', contact_email: null, contact_phone: null, is_own_organization: true, reason: raised[0].p_reason }]) }));
  await page.route('**/rest/v1/rpc/raise_entity_flag**', async (route) => { raised.push(JSON.parse(route.request().postData() ?? '{}')); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'fbfbfbfb-fbfb-4bfb-8bfb-fbfbfbfbfbfb' }) }); });

  await signInAsOfficer(page, '/officer/vehicle_lookup');
  await page.getByPlaceholder(/Enter plate number/).fill('ABC123');
  await page.getByRole('button', { name: 'Search Plate' }).click();

  const warnings = page.getByTestId('safety-warnings');
  await expect(warnings.getByText('No active safety warnings from any organisation.')).toBeVisible();
  await warnings.getByRole('button', { name: 'Raise a safety warning' }).click();
  await warnings.getByLabel('What is the hazard?').selectOption('weapons');
  await warnings.getByLabel('How serious?').selectOption('critical');
  await warnings.getByLabel(/What should staff expect/).fill('Occupant showed a machete to the last patrol. Do not approach alone.');
  await warnings.getByRole('button', { name: 'Confirm safety warning' }).click();

  await expect(warnings.getByText(/Safety warning raised/)).toBeVisible();
  expect(raised).toHaveLength(1);
  expect(raised[0]).toMatchObject({ p_entity_type: 'vehicle', p_entity_id: 'abababab-abab-4bab-8bab-abababababab', p_flag_type: 'safety_warning', p_alert_level: 'critical', p_hazard_class: 'weapons' });
  expect(typeof raised[0].p_client_request_id).toBe('string');
  await expect(warnings.getByText('Weapons')).toBeVisible();
  await expect(warnings.getByText(/Raised by your organisation .* Occupant showed a machete/)).toBeVisible();
  await expect(warnings.getByRole('button', { name: 'Mark resolved' })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('officer vehicle lookup refuses to present incomplete evidence as a result', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/observations**', async (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Observation history is unavailable.' }) }));

  await signInAsOfficer(page, '/officer/vehicle_lookup');
  await page.getByPlaceholder(/Enter plate number/).fill('ABC123');
  await page.getByRole('button', { name: 'Search Plate' }).click();

  await expect(page.getByRole('alert')).toContainText('Observation history is unavailable.');
  await expect(page.getByText(/No vehicle records, SCV certifications, or observations found/)).toHaveCount(0);
  expect(browserErrors.filter((error) => !error.includes('status of 500'))).toEqual([]);
});