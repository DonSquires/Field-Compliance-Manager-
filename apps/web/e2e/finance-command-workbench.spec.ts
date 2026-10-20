import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const september = { id: '66666666-6666-4666-8666-666666666666', name: 'September 2026', period_start: '2026-09-01', period_end: '2026-09-30', status: 'draft' };
const august = { id: '77777777-7777-4777-8777-777777777777', name: 'August 2026', period_start: '2026-08-01', period_end: '2026-08-31', status: 'closed' };

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/finance_pl_periods*', (route) => route.fulfill({ json: [september, august] }));
  await page.route('**/rest/v1/rpc/get_finance_pl_period_summary', (route) => {
    const id = route.request().postDataJSON().p_pl_period_id;
    return route.fulfill({ json: [{ pl_period_id: id, total_revenue: id === september.id ? 24800 : 10000, total_cost: id === september.id ? 16400 : 4000, gross_profit: id === september.id ? 8400 : 6000, cost_line_count: 3 }] });
  });
  await page.route('**/rest/v1/finance_tax_periods*', (route) => route.fulfill({ json: [{ id: 'tax-independent', period_start: '2026-07-01', period_end: '2026-08-31', status: 'open', net_tax_due: 500 }] }));
});

test('selected finance workflow owns the viewport with one real P&L bar', async ({ page }, testInfo) => {
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/finance-money');
  const root = page.locator('.finance-workbench');
  const bar = page.locator('.finance-period-bar');
  await expect(bar).toContainText('$8,400');
  await expect(bar).toContainText('$24,800');
  await expect(bar).toContainText('$16,400');
  await expect(page.locator('.finance-ops-kpis')).toHaveCount(0);
  await expect(page.locator('.finance-control-panel')).toHaveCount(0);
  await expect(page.locator('.finance-reconciliation')).toHaveCount(0);
  const rootBounds = await root.boundingBox();
  expect((rootBounds?.y ?? 0) + (rootBounds?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
  if (testInfo.project.name.startsWith('desktop')) {
    expect((await bar.boundingBox())?.height).toBe(40);
    expect((await page.locator('.finance-workflow-switcher').boundingBox())?.width).toBe(280);
  }
  await page.getByRole('button', { name: /Bank reconciliation/ }).click();
  await expect(page.locator('.finance-reconciliation')).toBeVisible();
  await expect(page.locator('.finance-ops-dashboard')).toHaveCount(0);
  await page.getByRole('button', { name: /Actual labour/ }).click();
  await expect(page.getByRole('heading', { name: 'Post approved shift hours into the money period' })).toBeVisible();
  await expect(page.locator('.finance-reconciliation')).toHaveCount(0);
  await page.getByRole('button', { name: /Tax preparation/ }).click();
  const tax = page.getByRole('combobox', { name: /^Tax period/ });
  await expect(tax).toHaveValue('tax-independent');
  await page.getByLabel('Active accounting period', { exact: true }).selectOption(august.id);
  await expect(bar).toContainText('$6,000');
  await expect(tax).toHaveValue('tax-independent');
  await expect(page.getByText('Tax filing dates are independent of the active accounting period.')).toBeVisible();
  await page.getByRole('button', { name: /Budgets Fiscal/ }).click();
  await expect(page.getByLabel('Fiscal year', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Reporting period', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Job BOM \/ cost entry/ }).click();
  await expect(page.getByRole('heading', { name: 'Add a job cost' })).toBeVisible();
  const primary = page.getByRole('button', { name: 'Save job cost' });
  await expect(primary).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(primary).toHaveCSS('background-color', 'rgb(30, 64, 175)');
  if (testInfo.project.name.startsWith('mobile')) {
    expect((await primary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await page.getByRole('button', { name: 'Materials', exact: false }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('job BOM categories filter only existing price records and require missing costs', async ({ page }) => {
  let costWrites = 0;
  await page.route('**/rest/v1/service_agreements*', (route) => route.fulfill({ json: [{ id: 'agreement-1', name: 'Test agreement' }] }));
  await page.route('**/rest/v1/shifts*', (route) => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/rpc/record_finance_service_cost', (route) => { costWrites += 1; return route.fulfill({ json: {} }); });
  await page.route('**/rest/v1/rate_rules*', (route) => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/finance_price_book*', (route) => route.fulfill({ json: [
    { item_id: 'material-1', organization_id: '33333333-3333-4333-8333-333333333333', sku: 'MAT-1', name: 'Cable', item_type: 'material', unit_of_measure: 'm', unit_cost: 3.5, unit_price: 5 },
    { item_id: 'equipment-1', organization_id: '33333333-3333-4333-8333-333333333333', sku: 'EQ-1', name: 'Camera', item_type: 'equipment_component', unit_of_measure: 'ea', unit_cost: null, unit_price: 100 },
  ] }));
  await signInAsAdmin(page, '/admin/finance-money');
  await page.getByRole('button', { name: /Job BOM \/ cost entry/ }).click();
  const picker = page.getByLabel('Pick from your price list (optional)');
  await page.getByRole('button', { name: 'Materials 1', exact: true }).click();
  await expect(picker.locator('option')).toHaveCount(2);
  await expect(picker).not.toContainText('Camera');
  await picker.selectOption('item:material-1');
  await expect(page.getByLabel('Cost each', { exact: true })).toHaveValue('3.50');
  await page.getByRole('button', { name: 'Equipment 1', exact: true }).click();
  await picker.selectOption('item:equipment-1');
  await expect(page.getByLabel('Cost each', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Where this number came from')).toHaveValue('EQ-1 · Camera');
  await expect(page.getByRole('combobox', { name: /^Cost type/ })).toHaveValue('equipment');
  await page.getByRole('combobox', { name: /^Customer agreement/ }).selectOption('agreement-1');
  await page.getByRole('button', { name: 'Save job cost' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a valid quantity and evidenced unit cost.');
  expect(costWrites).toBe(0);
});

test('reconciliation, tax, budget approval and close retain governed receipts', async ({ page }) => {
  const requests: { name: string; body: Record<string, unknown> }[] = [];
  let matched = false;
  let approved = false;
  let closed = false;
  await page.route('**/rest/v1/finance_pl_periods*', (route) => route.fulfill({ json: [{ ...september, status: closed ? 'closed' : 'draft' }] }));
  await page.route('**/rest/v1/finance_external_bank_transactions*', (route) => route.fulfill({ json: matched ? [] : [{ id: 'bank-1', transaction_date: '2026-09-03', description: 'Customer credit', direction: 'credit', amount: 100, external_transaction_id: 'bank-ref', reconciliation_status: 'unmatched' }] }));
  await page.route('**/rest/v1/bank_statement_lines*', (route) => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/payment_receipts*', (route) => route.fulfill({ json: matched ? [] : [{ id: 'receipt-1', invoice_id: 'invoice-1', payment_date: '2026-09-03', payment_amount: 100, payment_method: 'bank_transfer', transaction_reference: 'Customer receipt', reconciliation_status: 'unmatched' }] }));
  await page.route('**/rest/v1/finance_budgets*', (route) => route.fulfill({ json: [{ id: 'budget-1', name: 'FY operating', fiscal_year: 2027, status: approved ? 'approved' : 'draft', version: 1, approved_at: null }] }));
  await page.route('**/rest/v1/finance_budget_lines*', (route) => route.fulfill({ json: [{ id: 'line-1', budget_id: 'budget-1', pl_period_id: september.id, cost_type: 'operating', budget_amount: 200, notes: null }] }));
  for (const name of ['match_finance_external_bank_transaction', 'prepare_finance_tax_period', 'approve_finance_budget', 'close_finance_pl_period']) {
    await page.route(`**/rest/v1/rpc/${name}`, (route) => {
      requests.push({ name, body: route.request().postDataJSON() });
      if (name === 'match_finance_external_bank_transaction') matched = true;
      if (name === 'approve_finance_budget') approved = true;
      if (name === 'close_finance_pl_period') closed = true;
      return route.fulfill({ json: { net_tax_due: 500 } });
    });
  }
  await signInAsAdmin(page, '/admin/finance-money');
  await page.getByRole('button', { name: /Bank reconciliation/ }).click();
  await expect(page.getByRole('button', { name: 'Confirm payment match' })).toBeDisabled();
  await page.getByRole('button', { name: /Customer credit/ }).click();
  await page.getByRole('radio', { name: /Customer receipt/ }).check();
  await page.getByRole('button', { name: 'Confirm payment match' }).click();
  await expect(page.getByText(/was matched.*audited reconciliation record/)).toBeVisible();
  await page.getByRole('button', { name: /Tax preparation/ }).click();
  await page.getByRole('button', { name: 'Work out tax to set aside' }).click();
  await expect(page.getByText(/Nothing was filed with IRD/)).toBeVisible();
  await page.getByRole('button', { name: /Budgets Fiscal/ }).click();
  await page.getByRole('button', { name: 'Review and approve budget' }).click();
  expect(requests.some((request) => request.name === 'approve_finance_budget')).toBe(false);
  await expect(page.getByText('Approve FY operating?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve budget', exact: true }).click();
  await expect(page.getByText('FY operating approved and locked for operational comparison.')).toBeVisible();
  await page.getByRole('button', { name: /Period controls/ }).click();
  await page.getByRole('button', { name: 'Finish and lock this month' }).click();
  await expect(page.getByText('Monthly money check finished and saved.')).toBeVisible();
  await expect(page.getByLabel('Active accounting period', { exact: true })).toContainText('September 2026 · closed');
  await expect(page.getByRole('button', { name: 'Finish and lock this month' })).toBeDisabled();
  expect(requests).toEqual([
    { name: 'match_finance_external_bank_transaction', body: { p_transaction_id: 'bank-1', p_payment_receipt_id: 'receipt-1' } },
    { name: 'prepare_finance_tax_period', body: { p_tax_period_id: 'tax-independent' } },
    { name: 'approve_finance_budget', body: { p_budget_id: 'budget-1' } },
    { name: 'close_finance_pl_period', body: { p_pl_period_id: september.id } },
  ]);
});

test('labour posting uses the active eligible period and never silently switches it', async ({ page }) => {
  let posted: Record<string, unknown> | null = null;
  const agreement = '24242424-2424-4424-8424-242424242424';
  await page.route('**/rest/v1/timesheets*', (route) => route.fulfill({ json: posted ? [] : [{ id: 'sheet-1', staff_id: 'staff-1', shift_id: 'shift-1', period_start: '2026-09-03', period_end: '2026-09-03', actual_hours: 8, work_derived_hours: 8, status: 'approved' }] }));
  await page.route('**/rest/v1/finance_labour_cost_postings*', (route) => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/shifts*', (route) => route.fulfill({ json: [{ id: 'shift-1', service_type: 'static_guarding', work_unit_id: 'work-1', service_agreement_location_id: 'link-1', service_agreement_module_id: null }] }));
  await page.route('**/rest/v1/staff_profiles*', (route) => route.fulfill({ json: [{ id: 'staff-1', employee_number: 'TEST-01', role_code: 'guard' }] }));
  await page.route('**/rest/v1/service_agreements*', (route) => route.fulfill({ json: [{ id: agreement, name: 'Test agreement' }] }));
  await page.route('**/rest/v1/service_agreement_locations*', (route) => route.fulfill({ json: [{ id: 'link-1', service_agreement_id: agreement, status: 'active' }] }));
  await page.route('**/rest/v1/rate_rules*', (route) => route.fulfill({ json: [{ id: 'rate-1', amount: 30, pay_code: 'ORD', role_code: 'guard', service_type: 'static_guarding', effective_from: '2026-01-01', effective_to: null, priority: 1 }] }));
  await page.route('**/rest/v1/rpc/post_finance_timesheet_labour_cost', (route) => {
    posted = route.request().postDataJSON();
    return route.fulfill({ json: { hours: 8, hourly_rate: 30 } });
  });
  await signInAsAdmin(page, '/admin/finance-money');
  await page.getByRole('button', { name: /Actual labour/ }).click();
  await page.getByRole('button', { name: /TEST-01/ }).click();
  await page.getByLabel('Active accounting period', { exact: true }).selectOption(august.id);
  await expect(page.getByRole('button', { name: 'Post actual labour cost' })).toBeDisabled();
  await expect(page.getByText(/must be open and contain the entire timesheet/)).toBeVisible();
  expect(posted).toBeNull();
  await page.getByLabel('Active accounting period', { exact: true }).selectOption(september.id);
  await page.getByRole('button', { name: 'Post actual labour cost' }).click();
  await expect(page.getByText(/8.00 hours were posted at \$30.00 per hour/)).toBeVisible();
  expect(posted).toMatchObject({ p_timesheet_id: 'sheet-1', p_pl_period_id: september.id, p_service_agreement_id: agreement, p_work_unit_id: 'work-1' });
});
