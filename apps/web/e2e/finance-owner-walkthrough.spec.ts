import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-12T09:30:00+12:00'));
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/finance_pl_periods*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'period-1', name: 'September 2026', period_start: '2026-09-01', period_end: '2026-09-30', status: 'draft' }]) }));
  await page.route('**/rest/v1/finance_pl_snapshots*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ total_revenue: 24800, total_cost: 16400, gross_profit: 8400, gross_margin_pct: 33.87, cost_line_count: 42 }]) }));
  await page.route('**/rest/v1/finance_tax_periods*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ period_end: '2026-08-31', filing_due_date: '2026-10-28', status: 'open', net_tax_due: 3720 }]) }));
  await page.route('**/rest/v1/finance_budget_variances*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ status: 'watch', variance_amount: 320, variance_pct: 4.1 }]) }));
  await page.route('**/rest/v1/payment_receipts*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ payment_amount: 8200, reconciliation_status: 'matched' }, { payment_amount: 4600, reconciliation_status: 'unmatched' }]) }));
  await page.route('**/rest/v1/rpc/get_finance_owner_brief', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ headline: 'Bob found 2 items worth your attention.', priorities: [{ kind: 'payments', title: '1 payment needs matching', detail: 'Bob can compare it with bank statement lines.' }, { kind: 'tax', title: 'Tax money is due by 28 Oct 2026', detail: 'Bob can prepare the figures; you approve filing and payment.' }], checked_at: '2026-09-12T09:30:00+12:00' }) }));
  await page.route('**/rest/v1/rpc/assess_bob_nz_finance_readiness', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ overall_score: 58, checks: [{ source_key: 'ird-gst-overview', title: 'GST calculation and period control', status: 'partial', score: 60 }, { source_key: 'ird-gst-records', title: 'GST evidence and record keeping', status: 'partial', score: 65 }, { source_key: 'ird-employers', title: 'Employer cost and staff finance controls', status: 'partial', score: 60 }, { source_key: 'ird-provisional-tax', title: 'Provisional tax planning', status: 'partial', score: 45 }, { source_key: 'ird-payroll', title: 'Payday filing integration', status: 'partial', score: 40 }, { source_key: 'xrb-nz-accounting-standards', title: 'Accounting standards and statutory reporting', status: 'partial', score: 45 }] }) }));
  await page.route('**/rest/v1/rpc/get_finance_tax_identity_summary', async (route) => await route.fulfill({ contentType: 'application/json', body: 'null' }));
  await page.route('**/rest/v1/rpc/save_finance_tax_identity', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ird_last_four: '4321', gst_registered: true, gst_basis: 'payments', gst_filing_frequency: 'two_monthly', tax_agent_name: 'Test Accountant', setup_status: 'accountant_review' }) }));
  await page.route('**/rest/v1/rpc/calculate_finance_quote_cost', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ true_cost: 1046, client_charge: 1394.67, gross_margin: 348.67, gross_margin_pct: 25, breakdown: { depreciation_annual: 2400 } }) }));
});

test('owner can walk finance from simple home to final review boundary', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/finance-bureau');
  await expect(page.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible();
  await expect(page.getByRole('button', { name: /See how the business is doing/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Connect ANZ or IRD/ })).toBeVisible();
  await expect(page).toHaveScreenshot('finance-home-desktop.png');

  await page.getByRole('button', { name: /See how the business is doing/ }).click();
  await expect(page.getByRole('heading', { name: 'How is the business doing?' })).toBeVisible();
  await expect(page.getByText('Money left after costs')).toBeVisible();
  await page.goBack();

  await page.getByRole('button', { name: /Work out what a job should cost/ }).click();
  await expect(page.getByRole('heading', { name: 'What should this job cost?' })).toBeVisible();
  await page.goBack();

  await page.getByRole('button', { name: /Set prices and discounts/ }).click();
  await expect(page.getByRole('heading', { name: 'Prices and discounts' })).toBeVisible();
  await page.goBack();

  await page.getByRole('button', { name: /Connect ANZ or IRD/ }).click();
  await expect(page.getByRole('heading', { name: 'Connect your finance accounts' })).toBeVisible();
  await expect(page.getByText('We never ask for online-banking passwords')).toBeVisible();
  await page.getByRole('button', { name: /ANZ bank account/ }).click();
  await expect(page).toHaveScreenshot('finance-anz-connection-before-submit.png');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('owner can enter IRD details and calculate a job cost like a human', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/finance-bureau');
  await page.getByRole('button', { name: /Connect ANZ or IRD/ }).click();
  await page.getByRole('button', { name: /^IRD/ }).click();
  await page.getByLabel('Organisation IRD number').fill('123456789');
  await page.getByLabel('Organisation is GST registered').check();
  await page.getByLabel('GST accounting basis').selectOption('payments');
  await page.getByLabel('GST filing frequency').selectOption('two_monthly');
  await page.getByLabel('Accountant or tax agent (optional)').fill('Test Accountant');
  await page.getByRole('button', { name: 'Review details' }).click();
  await expect(page.getByText('IRD number ending 6789')).toBeVisible();
  await expect(page).toHaveScreenshot('finance-ird-review.png');
  await page.getByRole('button', { name: 'Save IRD details' }).click();
  await expect(page.getByText(/IRD details saved/)).toBeVisible();

  await page.getByRole('main').getByRole('button', { name: 'Finance home' }).click();
  await page.getByRole('button', { name: /Work out what a job should cost/ }).click();
  await page.getByLabel('Hourly pay rate').fill('42');
  await page.getByLabel('Gear purchase cost').fill('12000');
  await page.getByLabel('Equipment/evidence cost').fill('80');
  await page.getByLabel('Other job cost').fill('25');
  await page.getByRole('button', { name: 'Calculate job cost' }).click();
  await expect(page.getByText('Real cost')).toBeVisible();
  await expect(page.getByText('$1,046.00')).toBeVisible();
  await expect(page).toHaveScreenshot('finance-costing-result.png');
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByLabel('Hourly pay rate')).toHaveValue('');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('owner uses the three-month fuel median as an internal vehicle-cost suggestion', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/rpc/get_median_fuel_price', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ fuel_type: 'petrol', median_price_per_litre: 2.399, observation_count: 4, window_start: '2026-06-01', window_end: '2026-09-01', latest_observed_on: '2026-08-30', source_names: ['AA Fuel Prices'], source_urls: ['https://example.test/aa'] }]) }));

  await signInAsAdmin(page, '/admin/finance-costing');
  await expect(page.getByText('Website fuel median: $2.399/L')).toBeVisible();
  await page.getByLabel('Fuel use (L/100km)').fill('8.5');
  await page.getByLabel('Other running cost/km').fill('0.15');
  await expect(page.getByText(/suggested internal vehicle cost is \$0\.35\/km/)).toBeVisible();
  await page.getByRole('button', { name: 'Use suggested internal cost' }).click();
  await expect(page.getByLabel('Fuel and running cost/km')).toHaveValue('0.3539');
  await page.getByLabel('Hourly pay rate').fill('42');
  await page.getByLabel('Vehicle kilometres').fill('10');
  await page.getByRole('button', { name: 'Calculate job cost' }).click();
  await expect(page.getByText('Real cost')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('owner can run readiness check without submitting to IRD or bank', async ({ page }) => {
  await signInAsAdmin(page, '/admin/finance-bureau');
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByText('Readiness snapshot: 58%')).toBeVisible();
  await expect(page.getByText('not a legal compliance certificate')).toBeVisible();
  await expect(page.getByText('Human approval stays with you.')).toBeVisible();
});

test('global help explains the current workflow and can collapse its steps', async ({ page }) => {
  await signInAsAdmin(page, '/admin/finance-bureau');
  await page.getByRole('button', { name: /Open instructions for Using Finance/ }).click();
  await expect(page.locator('[role="dialog"]')).toContainText('How to use it');
  await expect(page.getByText('Start at Finance home')).toBeVisible();
  await page.getByRole('button', { name: 'How to use it' }).click();
  await expect(page.getByText('Start at Finance home')).toBeHidden();
  await page.getByRole('button', { name: 'Close instructions' }).click();
  await expect(page.getByRole('button', { name: /Open instructions for Using Finance/ })).toBeVisible();
});

test('finished work waiting to be billed becomes a draft invoice per client in one click', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  let invoiced: Record<string, unknown> | null = null;
  let swept = false;
  await page.route('**/rest/v1/workshop_work_order_summary*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify(swept ? [] : [
    { client_organization_id: '40404040-4040-4040-8040-404040404040', client_name: 'Civic Events Ltd', order_number: 'WO-202609-0003', uninvoiced_total: 440, completed_at: '2026-09-10T02:00:00.000Z' },
    { client_organization_id: '40404040-4040-4040-8040-404040404040', client_name: 'Civic Events Ltd', order_number: 'WO-202609-0004', uninvoiced_total: 142.5, completed_at: '2026-09-11T02:00:00.000Z' },
  ]) }));
  await page.route('**/rest/v1/dispatch_job_charge_lines*', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify(swept ? [] : [
    { client_organization_id: '40404040-4040-4040-8040-404040404040', source_dispatch_id: 'job-1', line_total: 38.87, created_at: '2026-09-09T20:00:00.000Z', client: { name: 'Civic Events Ltd' } },
  ]) }));
  await page.route('**/rest/v1/rpc/generate_crm_invoice_from_completed_work', async (route) => { invoiced = JSON.parse(route.request().postData() ?? '{}'); swept = true; await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'inv-1', invoice_number: 'INV-20260912-7C1D', total_amount: 714.58 }) }); });

  await signInAsAdmin(page, '/admin/finance-bureau');
  await expect(page.getByRole('heading', { name: '$621.37 waiting to be invoiced' })).toBeVisible();
  await expect(page.getByText('2 workshop jobs and 1 callout finished and not yet billed', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Create draft invoice' }).click();
  await expect(page.getByText(/Draft invoice INV-20260912-7C1D for Civic Events Ltd — \$714\.58 including GST/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Everything finished has been billed' })).toBeVisible();
  expect(invoiced).toMatchObject({ p_organization_id: '41414141-4141-4141-8141-414141414141', p_client_organization_id: '40404040-4040-4040-8040-404040404040', p_service_agreement_id: null });
  expect(errors, errors.join('\n')).toEqual([]);
});
