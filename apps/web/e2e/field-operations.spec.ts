import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page, { officerModules: ['dispatch', 'cctv', 'static_guarding', 'freedom_camping', 'parking_enforcement'] });
});

test('operations landing is visually stable and every command is interactive', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page);
  await expect(page.getByRole('heading', { name: 'Field Operations' })).toBeVisible();
  await expect(page.locator('.field-ops-metrics')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Dispatch console.*7 active/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Live operations.*4 on duty/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Welfare response.*2 active/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Field reports.*1 follow-up/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot('field-operations-first-viewport.png');
  await expect(page).toHaveScreenshot('field-operations.png', { fullPage: true });
  const finalCommand = page.getByRole('button', { name: /^Officer investigations/ });
  await finalCommand.scrollIntoViewIfNeeded();
  const mobileNavigation = page.locator('.admin-mobile-tabs');
  if (await mobileNavigation.isVisible()) {
    const commandBounds = await finalCommand.boundingBox();
    const navigationBounds = await mobileNavigation.boundingBox();
    expect(commandBounds && navigationBounds && commandBounds.y + commandBounds.height <= navigationBounds.y).toBe(true);
    await mobileNavigation.evaluate((element) => { element.style.visibility = 'hidden'; });
  }
  await expect(page.locator('.field-ops-workflows')).toHaveScreenshot('field-operations-workflows.png');
  if (await mobileNavigation.count()) await mobileNavigation.evaluate((element) => { element.style.visibility = ''; });

  const commands = [
    ['Dispatch console', 'dispatch'],
    ['Live operations', 'live-map'],
    ['Welfare response', 'welfare-alerts'],
    ['Patrol evidence', 'patrol'],
    ['Field reports', 'field-reports'],
    ['CCTV & video', 'cctv-console'],
    ['Debrief follow-up', 'debrief-followup'],
    ['Breach review', 'breach-review'],
    ['Vehicle intelligence', 'vehicle-search'],
    ['Observation search', 'observation-search'],
    ['Officer investigations', 'officer-activity'],
  ] as const;
  for (const [label, area] of commands) {
    await page.locator('.field-ops-workflow').filter({ hasText: label }).click();
    await expect(page).toHaveURL(new RegExp(`area=${area}`));
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Field Operations' })).toBeVisible();
  }
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('report review dialog is usable without overlap', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/field-ops?area=field-reports');
  await expect(page.getByText('Unsafe access at North Yard', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Review report' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review field report' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm review' })).toBeDisabled();
  await dialog.getByLabel('Supervisor review notes').fill('Facilities owns remediation before the next rostered patrol.');
  await expect(dialog.getByRole('button', { name: 'Confirm review' })).toBeEnabled();
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds && viewport && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height).toBe(true);
  await expect(dialog).toHaveScreenshot('field-report-review-dialog.png');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('supervisor records acknowledgement and verified resolution through the governed welfare lifecycle', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/field-ops?area=welfare-alerts');
  await expect(page.getByRole('heading', { name: 'Welfare response' })).toBeVisible();
  await expect(page.getByText('Ana Ngata', { exact: true }).first()).toBeVisible();
  await expect(page).toHaveScreenshot('welfare-response-first-viewport.png');

  await page.getByRole('button', { name: 'Acknowledge' }).click();
  const acknowledgement = page.getByRole('dialog', { name: 'Acknowledge alert' });
  await acknowledgement.getByLabel('Response plan').fill('Control room called Ana and dispatched the duty supervisor.');
  await acknowledgement.getByRole('button', { name: 'Confirm acknowledgement' }).click();
  await expect(page.getByRole('status')).toContainText('Alert acknowledged');
  await expect(page.getByText('acknowledged', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Morgan Reed · .*29\/08\/2026/)).toBeVisible();

  await page.getByRole('button', { name: 'Resolve' }).click();
  const resolution = page.getByRole('dialog', { name: 'Resolve alert' });
  await resolution.getByLabel('Verified safety outcome').fill('Duty supervisor made face-to-face contact and confirmed Ana was safe.');
  await resolution.getByRole('button', { name: 'Confirm resolution' }).click();
  await expect(page.getByRole('status')).toContainText('Alert resolved');
  await expect(page.getByText('resolved', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Morgan Reed · .*29\/08\/2026/)).toHaveCount(2);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('admin vehicle search presents only schema-backed registry and scoped evidence', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  const vehicleId = 'abababab-abab-4bab-8bab-abababababab';
  let privateVehicleTableRead = false;
  await page.route('**/rest/v1/canonical_vehicles**', async (route) => { privateVehicleTableRead = true; await route.fulfill({ contentType: 'application/json', body: '[]' }); });
  await page.route('**/rest/v1/canonical_vehicle_public**', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: vehicleId, plate_number: 'ABC123', make: 'Toyota', model: 'Hiace', year: 2018, colour: 'White', body_type: 'van', rego_status: 'current', rego_expiry: '2027-05-01', wof_status: 'expired', wof_expiry: '2026-08-01', cof_status: null, cof_expiry: null, homeless_status: 'confirmed' }]) }));
  await page.route('**/rest/v1/canonical_scv_public**', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', certificate_number: 'SCV-2048', certificate_status: 'active', expiry_date: '2027-02-01', issued_date: '2025-02-01' }]) }));
  await page.route('**/rest/v1/person_permits_fieldwork**', async (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/observations**', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'dededede-dede-4ede-8ede-dededededede', observed_at: '2026-08-30T08:20:00.000Z', is_compliant: false, compliance_reason: 'nightly_limit_exceeded', nights_this_zone: 3, zone: { name: 'Civic Event Operations Zone' } }]) }));
  await page.route('**/rest/v1/breach_alerts**', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'efefefef-efef-4fef-8fef-efefefefefef', breach_type: 'nightly_limit', status: 'open', nights_count: 3, notes: 'Supervisor review required.', created_at: '2026-08-30T08:20:00.000Z', zone: { name: 'Civic Event Operations Zone' } }]) }));
  await page.route('**/rest/v1/entity_flags**', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', flag_type: 'watchlist', alert_level: 'medium', reason: 'Supervisor review requested.', active: true, raised_at: '2026-08-29T20:00:00.000Z' }]) }));
  await page.route('**/rest/v1/rpc/get_safety_warnings**', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'fafafafa-fafa-4afa-8afa-fafafafafafa', entity_type: 'vehicle', entity_id: vehicleId, requested_id: vehicleId, hazard_class: 'dangerous_dog', alert_level: 'high', raised_at: '2026-09-01T02:00:00.000Z', organization_id: '77777777-7777-4777-8777-777777777777', organization_name: 'Harbour City Security', contact_email: 'control@harbourcity.test', contact_phone: '04 555 0100', is_own_organization: false, reason: null }]) }));

  await signInAsAdmin(page, '/admin/field-ops?area=vehicle-search');
  await expect(page.getByRole('heading', { name: 'Vehicle Search & Flags' })).toBeVisible();
  await page.getByPlaceholder(/Enter plate number/).fill('ABC123');
  await page.getByRole('button', { name: 'Search Plate' }).click();
  await expect(page.getByText('Toyota Hiace (2018)')).toBeVisible();
  await expect(page.getByText('WOF: EXPIRED')).toBeVisible();
  await expect(page.getByText(/Welfare: someone may be living in this vehicle \(CONFIRMED\)/)).toBeVisible();
  await expect(page.getByText('Supervisor review requested.')).toBeVisible();
  const warnings = page.getByTestId('safety-warnings');
  await expect(warnings.getByText('Dangerous dog')).toBeVisible();
  await expect(warnings.getByRole('link', { name: '04 555 0100' })).toHaveAttribute('href', 'tel:045550100');
  await expect(page.getByRole('heading', { name: 'Observation History (1)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Breach Alerts (1)' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const vehicleOverflow = await page.locator('.vehicle-search-page').evaluate((root) => Array.from(root.querySelectorAll('*')).filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => `${element.tagName.toLowerCase()}.${String(element.className).replaceAll(' ', '.')}: ${element.scrollWidth}/${element.clientWidth}`).slice(0, 8));
  expect(vehicleOverflow, vehicleOverflow.join('\n')).toEqual([]);
  expect(privateVehicleTableRead, 'Admin Vehicle Search must use the public projection, never the Bob-only canonical_vehicles table.').toBe(false);
  await expect(page.locator('.page-container')).toHaveScreenshot('admin-vehicle-search-results.png');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});