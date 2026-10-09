import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

test('creating a branch pay rule sends the selected role code in the governed RPC', async ({ page }) => {
  const rules: Array<Record<string, unknown>> = [];
  let createPayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/reference_codes*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ code: 'field_security', name: 'Field Security' }]) }));
  await page.route('**/rest/v1/rate_rules*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rules) }));
  await page.route('**/rest/v1/rpc/manage_operating_branch_rate_rule', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    createPayload = payload;
    const rule = { id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', rule_kind: payload.p_rule_kind, name: payload.p_name, rate_type: payload.p_rate_type, amount: payload.p_amount, pay_code: payload.p_pay_code, service_type: payload.p_service_type, job_type: payload.p_job_type, day_category: payload.p_day_category, priority: payload.p_priority, role_code: payload.p_role_code, active: true, updated_at: '2026-08-30T10:10:00.000Z' };
    rules.push(rule);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rule) });
  });

  await signInAsAdmin(page, '/admin/rate-rules');
  await page.getByRole('button', { name: 'New pay or charge rule' }).click();
  const form = page.getByRole('dialog', { name: 'New pay or charge rule' });
  await form.getByLabel('Name').fill('Field security hourly pay');
  await form.getByLabel('Amount').fill('32.50');
  await expect(form.getByLabel('Payroll role')).toHaveCount(1);
  await form.getByLabel('Payroll role').selectOption('field_security');
  await form.getByRole('button', { name: 'Create rate rule' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Field security hourly pay' })).toContainText('Payroll role field_security');
  expect(createPayload).toMatchObject({ p_operating_organization_id: '41414141-4141-4141-8141-414141414141', p_action: 'create', p_rule_kind: 'pay', p_role_code: 'field_security' });
});

test('editing a branch pay rule sends its selected role code in the governed RPC', async ({ page }) => {
  const rules: Array<Record<string, unknown>> = [{ id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', rule_kind: 'pay', name: 'Existing hourly pay', rate_type: 'hourly', amount: 30, pay_code: null, service_type: 'guarding', job_type: null, day_category: null, priority: 0, role_code: null, active: true, updated_at: '2026-08-30T09:00:00.000Z' }];
  let updatePayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/reference_codes*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ code: 'field_security', name: 'Field Security' }]) }));
  await page.route('**/rest/v1/rate_rules*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rules) }));
  await page.route('**/rest/v1/rpc/manage_operating_branch_rate_rule', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    updatePayload = payload;
    Object.assign(rules[0], { role_code: payload.p_role_code, updated_at: '2026-08-30T10:10:00.000Z' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rules[0]) });
  });

  await signInAsAdmin(page, '/admin/rate-rules');
  await page.getByRole('button', { name: 'Edit rule Existing hourly pay' }).click();
  const form = page.getByRole('dialog', { name: 'Edit rate rule' });
  await expect(form.getByLabel('Payroll role')).toHaveCount(1);
  await form.getByLabel('Payroll role').selectOption('field_security');
  await form.getByRole('button', { name: 'Save rate rule' }).click();
  expect(updatePayload).toMatchObject({ p_operating_organization_id: '41414141-4141-4141-8141-414141414141', p_action: 'update', p_rate_rule_id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', p_role_code: 'field_security' });
});

test('branch rate ledger searches loaded rules and filters type and status without duplicate cards', async ({ page }) => {
  const rules = [
    { id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcd31', rule_kind: 'billing', name: 'Civic Events patrol visit', rate_type: 'per_visit', amount: 42.5, pay_code: null, role_code: null, service_type: 'patrol', job_type: null, client_org_id: '40404040-4040-4040-8040-404040404040', site_id: null, zone_id: null, day_category: null, effective_from: '2026-01-01', effective_to: null, priority: 5, active: true, updated_at: '2026-08-30T09:00:00.000Z' },
    { id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcd32', rule_kind: 'pay', name: 'Field officer hourly', rate_type: 'hourly', amount: 31, pay_code: 'FIELD-01', role_code: 'field_security', service_type: 'guarding', job_type: null, client_org_id: null, site_id: null, zone_id: null, day_category: 'weekday', effective_from: '2026-01-01', effective_to: null, priority: 1, active: false, updated_at: '2026-08-30T09:00:00.000Z' },
  ];
  await page.route('**/rest/v1/reference_codes*', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ code: 'field_security', name: 'Field Security' }]) }));
  await page.route('**/rest/v1/rate_rules**', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rules) }));
  await signInAsAdmin(page, '/admin/rate-rules');
  const register = page.getByRole('region', { name: 'Pay and charge rule register' });
  await expect(register.getByRole('row')).toHaveCount(3);
  await expect(register).toHaveScreenshot('rate-rules-ledger.png');
  await expect(page.locator('.rate-rules-ledger .contact-card')).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: 'Search pay and charge rules' });
  await search.fill('field_security');
  await expect(register.getByRole('row')).toHaveCount(2);
  await expect(register).toContainText('Field officer hourly');
  await expect(page.locator('.rate-rules-ledger').getByRole('status')).toContainText('Showing 1 of 2');
  await page.getByLabel('Filter by rule type').selectOption('billing');
  await expect(register).toContainText('No rules match these filters.');
  await expect(page.locator('.rate-rules-ledger').getByRole('status')).toContainText('Showing 0 of 2');
  await register.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Filter by rule type').selectOption('pay');
  await page.getByLabel('Filter by rule status').selectOption('inactive');
  await expect(register.getByRole('row')).toHaveCount(2);
  await register.getByRole('row').filter({ hasText: 'Field officer hourly' }).getByRole('button', { name: 'Edit rule Field officer hourly' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit rate rule' });
  await expect(editor.getByLabel('Payroll role')).toHaveValue('field_security');
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await expect(page.getByRole('button', { name: 'New pay or charge rule' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('administrator creates a governed operating branch patrol rate rule', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/rate-rules');
  await expect(page.getByRole('heading', { level: 1, name: 'Pay and charge rules' })).toBeVisible();
  await page.getByRole('button', { name: 'New pay or charge rule' }).click();
  const form = page.getByRole('dialog', { name: 'New pay or charge rule' });
  await form.getByLabel('Name').fill('Patrol visit - branch standard');
  await form.getByLabel('How it is charged').selectOption('per_visit');
  await form.getByLabel('Amount').fill('42.50');
  await form.getByLabel('Service type').fill('patrol');
  await expect(form).toHaveScreenshot('operating-branch-rate-rule.png');
  const dialogBounds = await form.boundingBox();
  const viewport = page.viewportSize();
  expect(dialogBounds && viewport && dialogBounds.x >= 0 && dialogBounds.y >= 0 && dialogBounds.x + dialogBounds.width <= viewport.width && dialogBounds.y + dialogBounds.height <= viewport.height).toBe(true);
  if ((viewport?.width ?? 0) < 640) expect(await form.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await form.getByRole('button', { name: 'Create rate rule' }).click();
  await expect(page.getByText('Rate rule created and available to the resolver.')).toBeVisible();
  const createdRule = page.getByRole('row').filter({ hasText: 'Patrol visit - branch standard' });
  await expect(createdRule).toBeVisible();
  await createdRule.getByRole('button', { name: 'Edit rule Patrol visit - branch standard' }).click();
  const editForm = page.getByRole('dialog', { name: 'Edit rate rule' });
  await expect(editForm.getByLabel('Amount')).toHaveValue('42.5');
  await editForm.getByLabel('Amount').fill('45.00');
  await editForm.getByRole('button', { name: 'Save rate rule' }).click();
  await expect(page.getByText('Rate rule updated with a new audit revision.')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('administrator records a cited website fuel price and sees the rolling three-month median', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  let recorded: Record<string, unknown> | null = null;
  let observationCount = 3;
  await page.route('**/rest/v1/rpc/get_median_fuel_price', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ fuel_type: 'petrol', median_price_per_litre: observationCount === 3 ? 2.399 : 2.42, observation_count: observationCount, window_start: '2026-05-30', window_end: '2026-08-30', latest_observed_on: '2026-08-24', source_names: ['AA Fuel Prices', 'BP Price Watch'], source_urls: ['https://example.test/aa', 'https://example.test/bp'] }]) }));
  await page.route('**/rest/v1/fuel_price_observations*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'fuel-1', fuel_type: 'petrol', observed_on: '2026-08-24', price_per_litre: 2.399, source_name: 'AA Fuel Prices', source_url: 'https://example.test/aa', source_published_at: null }]) }));
  await page.route('**/rest/v1/rpc/record_fuel_price_observation', async (route) => { recorded = JSON.parse(route.request().postData() ?? '{}'); observationCount = 4; await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'fuel-2' }) }); });

  await signInAsAdmin(page, '/admin/rate-rules');
  await expect(page.getByRole('heading', { name: 'Fuel price: three-month median' })).toBeVisible();
  const fuelPanel = page.locator('.fuel-price-panel');
  await expect(fuelPanel.locator('.fuel-price-panel__median strong')).toHaveText('$2.399/L');
  await expect(fuelPanel.getByText('3 cited prices in the three-month window. Latest price is 5 days old.')).toBeVisible();
  await expect(page.getByText(/does not automatically change the IRD \$1\.04\/km customer charge/)).toBeVisible();
  await page.getByRole('button', { name: 'Record website price' }).click();
  await page.getByLabel('Price per litre (NZD)').fill('2.461');
  await page.getByLabel('Website / publisher').fill('AA Fuel Prices');
  await page.getByLabel('Source URL').fill('https://example.test/aa/2026-08-30');
  await page.getByRole('button', { name: 'Save cited price' }).click();
  await expect(page.getByText('Website price recorded. The three-month median has been recalculated.')).toBeVisible();
  await expect(fuelPanel.locator('.fuel-price-panel__median strong')).toHaveText('$2.420/L');
  await expect(fuelPanel.getByText('4 cited prices in the three-month window. Latest price is 5 days old.')).toBeVisible();
  expect(recorded).toMatchObject({ p_organization_id: '41414141-4141-4141-8141-414141414141', p_fuel_type: 'petrol', p_price_per_litre: 2.461, p_source_name: 'AA Fuel Prices', p_source_url: 'https://example.test/aa/2026-08-30' });
  expect(typeof (recorded as Record<string, unknown> | null)?.p_client_request_id).toBe('string');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('administrator approves a fuel source before recording a current website price from it', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  let sources: Array<Record<string, unknown>> = [];
  let approvedObservation: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/fuel_price_sources*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify(sources) }));
  await page.route('**/rest/v1/rpc/manage_fuel_price_source', async (route) => { const body = JSON.parse(route.request().postData() ?? '{}'); const source = { id: 'source-aa', name: body.p_name ?? 'AA Fuel Prices', source_url: body.p_source_url ?? 'https://fuel.example.test/prices', fuel_type: body.p_fuel_type, refresh_guidance: body.p_refresh_guidance ?? 'Check weekly for Nelson petrol.' }; if (body.p_action === 'retire') sources = []; else sources = [source]; await route.fulfill({ contentType: 'application/json', body: JSON.stringify(source) }); });
  await page.route('**/rest/v1/rpc/record_approved_fuel_price_observation', async (route) => { approvedObservation = JSON.parse(route.request().postData() ?? '{}'); await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'fuel-approved' }) }); });

  await signInAsAdmin(page, '/admin/rate-rules');
  const fuelPanel = page.locator('.fuel-price-panel');
  await fuelPanel.getByRole('button', { name: 'Approve a source' }).click();
  await fuelPanel.getByLabel('Website / publisher').fill('AA Fuel Prices');
  await fuelPanel.getByLabel('Approved base URL').fill('https://fuel.example.test/prices');
  await fuelPanel.getByLabel('Review guidance (optional)').fill('Check weekly for Nelson petrol.');
  await fuelPanel.getByRole('button', { name: 'Approve source' }).click();
  await expect(fuelPanel.getByText('Fuel price source approved. New observations from it are checked against its URL.')).toBeVisible();
  await expect(fuelPanel.getByText('1 approved source for petrol.')).toBeVisible();
  await fuelPanel.getByRole('button', { name: 'Record website price' }).click();
  await fuelPanel.getByLabel('Approved source (recommended)').selectOption('source-aa');
  await fuelPanel.getByLabel('Price per litre (NZD)').fill('2.499');
  await fuelPanel.getByLabel('Source URL').fill('https://fuel.example.test/prices/nelson');
  await fuelPanel.getByRole('button', { name: 'Save cited price' }).click();
  expect(approvedObservation).toMatchObject({ p_source_id: 'source-aa', p_price_per_litre: 2.499, p_source_url: 'https://fuel.example.test/prices/nelson' });
  await fuelPanel.getByRole('button', { name: 'Retire source' }).click();
  await expect(fuelPanel.getByText('AA Fuel Prices retired. It stays in prior citations but cannot receive new observations.')).toBeVisible();
  await expect(fuelPanel.getByText('0 approved sources for petrol.')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});