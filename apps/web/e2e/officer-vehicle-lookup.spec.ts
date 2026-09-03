import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
});

test('officer vehicle lookup keeps registry, safety flags, observations, and breaches distinct', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/canonical_vehicles**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'abababab-abab-4bab-8bab-abababababab', plate_number: 'ABC123', make: 'Toyota', model: 'Hiace', year: 2018, colour: 'White', body_type: 'van', rego_status: 'current', rego_expiry: '2027-05-01', wof_status: 'expired', wof_expiry: '2026-08-01', cof_status: null, cof_expiry: null, homeless_status: 'yes', homeless_notes: 'Engage through the outreach team before enforcement.' }]) }));
  await page.route('**/rest/v1/canonical_scv**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', certificate_number: 'SCV-2048', certificate_status: 'active', expiry_date: '2027-02-01', issued_date: '2025-02-01' }]) }));
  await page.route('**/rest/v1/entity_flags**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', flag_type: 'officer_safety', alert_level: 'high', reason: 'Supervisor contact required', active: true }]) }));
  await page.route('**/rest/v1/observations**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'dededede-dede-4ede-8ede-dededededede', observed_at: '2026-08-30T08:20:00.000Z', is_compliant: false, compliance_reason: 'nightly_limit_exceeded', nights_this_zone: 3, zone: { name: 'Civic Event Operations Zone' } }]) }));
  await page.route('**/rest/v1/breach_alerts**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'efefefef-efef-4fef-8fef-efefefefefef', breach_type: 'nightly_limit', status: 'open', nights_count: 3, notes: 'Supervisor review required.', created_at: '2026-08-30T08:20:00.000Z', zone: { name: 'Civic Event Operations Zone' } }]) }));

  await signInAsOfficer(page, '/officer/vehicle_lookup');
  await page.getByPlaceholder(/Enter plate number/).fill('abc123');
  await page.getByRole('button', { name: 'Search Plate' }).click();

  await expect(page.getByText('Toyota Hiace (2018)')).toBeVisible();
  await expect(page.getByText('WOF: EXPIRED')).toBeVisible();
  await expect(page.getByText('HOMELESS: YES')).toBeVisible();
  await expect(page.getByText('Supervisor contact required')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent Observations (1)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Compliance Breaches (1)' })).toBeVisible();
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