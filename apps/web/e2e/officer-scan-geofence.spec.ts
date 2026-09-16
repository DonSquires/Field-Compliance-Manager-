import { expect, test } from '@playwright/test';
import { installFreedomCampingFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-31T20:00:00+12:00'));
  await installFreedomCampingFixtures(page);
});

test('officer scan keeps rule verdict and Zone closure evidence distinct', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await page.route('**/functions/v1/process-officer-scan', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload.plate_number).toBeUndefined();
    expect(typeof payload.image_base64).toBe('string');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plate_number: 'ABC123', plate_source: 'alpr', compliance_status: 'compliant', is_compliant: true, compliance_reason: 'within_nightly_limits', nights_this_zone: 1, nights_this_month: 1, limit_consecutive: 2, limit_monthly: 10, is_scv: false, enforcement_exempt: false, exemption_reason: null, zone_id: '66666666-6666-4666-8666-666666666666', zone_name: 'Civic Event Operations Zone', on_site: false, in_operating_bounds: true, out_of_bounds_district: null, effective_rules: { nightly_limit_consecutive: 2 }, zone_closed: true, zone_closure: { closure_type: 'restricted', reason: 'Controlled loading access only', effective_from: '2026-08-31', effective_to: '2026-08-31' }, vehicle_make: null, vehicle_model: null, vehicle_colour: null, observation_id: '69696969-6969-4969-8969-696969696969', breach_alert_id: null, scan_window: 'evening', overnight_verification_status: null, requires_morning_verification: false }) });
  });
  await signInAsOfficer(page, '/officer/freedom_camping');

  await expect(page.getByRole('heading', { name: 'Vehicle scan' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Process scan' })).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles('node_modules/leaflet/dist/images/marker-icon.png');
  await page.getByLabel(/Zone/).selectOption('66666666-6666-4666-8666-666666666666');
  await page.getByRole('button', { name: 'Process scan' }).click();

  await expect(page.getByText('Compliant', { exact: true })).toBeVisible();
  const warning = page.getByRole('alert').filter({ hasText: 'Zone closure in force' });
  await expect(warning).toContainText('restricted');
  await expect(warning).toContainText('Controlled loading access only');
  await expect(warning).toContainText('compliance verdict remains rule-derived');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('officer scan shows another organisation\'s safety warning on the plate before anything else, redacted', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await page.route('**/functions/v1/process-officer-scan', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plate_number: 'ABC123', plate_source: 'alpr', compliance_status: 'compliant', is_compliant: true, compliance_reason: null, nights_this_zone: 1, nights_this_month: 1, limit_consecutive: 2, limit_monthly: 10, is_scv: false, zone_id: '66666666-6666-4666-8666-666666666666', zone_name: 'Civic Event Operations Zone', on_site: false, in_operating_bounds: true, out_of_bounds_district: null, zone_closed: false, zone_closure: null, vehicle_make: 'Toyota', vehicle_model: 'Hiace', vehicle_colour: 'White', observation_id: '69696969-6969-4969-8969-696969696969', breach_alert_id: null, scan_window: 'evening', overnight_verification_status: null, requires_morning_verification: false,
      safety_warnings: [{ id: 'w1', hazard_class: 'violence_or_aggression', alert_level: 'critical', raised_at: '2026-08-20T02:00:00.000Z', organization_name: 'Harbour City Security', contact_email: null, contact_phone: '04 555 0100', is_own_organization: false }] }) });
  });
  await signInAsOfficer(page, '/officer/freedom_camping');
  await page.locator('input[type="file"]').setInputFiles('node_modules/leaflet/dist/images/marker-icon.png');
  await page.getByLabel(/Zone/).selectOption('66666666-6666-4666-8666-666666666666');
  await page.getByRole('button', { name: 'Process scan' }).click();

  const hazard = page.getByTestId('scan-safety-warnings');
  await expect(hazard).toContainText('read before approaching');
  await expect(hazard).toContainText('Violence or aggression');
  await expect(hazard).toContainText('Critical — do not approach, call for support');
  await expect(hazard).toContainText('Raised by Harbour City Security · contact 04 555 0100');
  expect(errors, errors.join('\n')).toEqual([]);
});