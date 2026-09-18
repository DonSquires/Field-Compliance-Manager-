import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

test('administrator creates a governed operating branch patrol rate rule', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/rate-rules');
  await expect(page.getByRole('heading', { name: 'Pay and charge rules' })).toBeVisible();
  await page.getByRole('button', { name: 'New pay or charge rule' }).click();
  const form = page.locator('form.assessment-form');
  await form.getByLabel('Name').fill('Patrol visit - branch standard');
  await form.getByLabel('How it is charged').selectOption('per_visit');
  await form.getByLabel('Amount').fill('42.50');
  await form.getByLabel('Service type').fill('patrol');
  await expect(form).toHaveScreenshot('operating-branch-rate-rule.png');
  await form.getByRole('button', { name: 'Create rate rule' }).click();
  await expect(page.getByText('Rate rule created and available to the resolver.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Patrol visit - branch standard', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit rule' }).click();
  const editForm = page.locator('form.assessment-form');
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
  await page.route('**/rest/v1/rpc/manage_fuel_price_source', async (route) => { const body = JSON.parse(route.request().postData() ?? '{}'); const source = { id: 'source-aa', name: body.p_name, source_url: body.p_source_url, fuel_type: body.p_fuel_type, refresh_guidance: body.p_refresh_guidance }; sources = [source]; await route.fulfill({ contentType: 'application/json', body: JSON.stringify(source) }); });
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
  expect(errors, errors.join('\n')).toEqual([]);
});