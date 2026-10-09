import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const ORG_ID = '33333333-3333-4333-8333-333333333333';
// The admin fixture operates the Northern Branch context; the page scopes writes to the operating organisation (same as Rate rules).
const OPERATING_ORG_ID = '41414141-4141-4141-8141-414141414141';
const CLIENT_ID = '40404040-4040-4040-8040-404040404040';
const WO_ID = 'cafecafe-cafe-4afe-8afe-cafecafecafe';
const STEEL_ID = 'beefbeef-beef-4eef-8eef-beefbeefbeef';
const LOCATION_ID = 'dadadada-dada-4ada-8ada-dadadadadada';

const summaryRow = (status: string, extra: Record<string, unknown> = {}) => ({
  id: WO_ID, organization_id: ORG_ID, order_number: 'WO-202608-0001', kind: 'fabrication', status, title: 'Lockbox for Civic Events depot', description: 'One standard lockbox, powder-coated.',
  client_organization_id: CLIENT_ID, client_name: 'Civic Events Ltd', service_agreement_id: '24242424-2424-4424-8424-242424242424', client_site_id: null, site_name: null, asset_id: null, asset_name: null,
  inventory_location_id: LOCATION_ID, stock_location_name: 'Workshop', bom_template_id: null, template_name: null, assigned_user_id: null, assigned_name: null, scheduled_for: null,
  started_at: null, completed_at: null, cancelled_at: null, completion_note: null, created_at: '2026-08-29T20:00:00.000Z', updated_at: '2026-08-29T20:00:00.000Z',
  line_count: 2, charge_total: 440, cost_total: 235, uninvoiced_total: status === 'completed' ? 440 : 0, ...extra,
});

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00')); await installSupabaseFixtures(page); });

test('workshop: a person can manually create a maintenance order for an agreed client place', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  const calls: Array<Record<string, unknown>> = [];
  const createdOrder = summaryRow('draft', {
    kind: 'maintenance',
    title: 'Inspect north gate camera mount',
    description: 'Check mounting bolts and weather seal.',
    client_site_id: '42424242-4242-4242-8242-424242424242',
    site_name: 'Civic Events Centre',
  });
  let orders: Array<Record<string, unknown>> = [];
  await page.route('**/rest/v1/workshop_work_order_summary**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(orders) }));
  await page.route('**/rest/v1/service_agreements**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '24242424-2424-4424-8424-242424242424', name: 'Civic Events Compliance Services', client_organization_id: CLIENT_ID, client: { name: 'Civic Events Ltd' } }]) }));
  await page.route('**/rest/v1/client_sites**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '42424242-4242-4242-8242-424242424242', name: 'Civic Events Centre', client_organization_id: CLIENT_ID, active: true }]) }));
  await page.route('**/rest/v1/rpc/create_workshop_work_order', async (route) => {
    calls.push(JSON.parse(route.request().postData() ?? '{}'));
    orders = [createdOrder];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: WO_ID }) });
  });

  await signInAsAdmin(page, '/admin/workshop');
  await page.getByRole('button', { name: 'New work order' }).click();
  const form = page.locator('form.workshop-card').filter({ hasText: 'New work order' });
  await form.getByLabel('What kind of job?').selectOption('maintenance');
  await form.getByLabel('Title').fill('Inspect north gate camera mount');
  await form.getByLabel('Client agreement (who gets billed)').selectOption('24242424-2424-4424-8424-242424242424');
  await form.getByLabel('Place').selectOption('42424242-4242-4242-8242-424242424242');
  await form.getByLabel('Scheduled for').fill('2026-09-05T18:30');
  const expectedSchedule = await form.getByLabel('Scheduled for').evaluate((element) => new Date((element as HTMLInputElement).value).toISOString());
  await form.getByLabel('Notes').fill('Check mounting bolts and weather seal.');
  await form.getByRole('button', { name: 'Create work order' }).click();

  await expect(page.getByText('Work order created.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inspect north gate camera mount' })).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    p_organization_id: OPERATING_ORG_ID,
    p_kind: 'maintenance',
    p_title: 'Inspect north gate camera mount',
    p_description: 'Check mounting bolts and weather seal.',
    p_client_organization_id: CLIENT_ID,
    p_service_agreement_id: '24242424-2424-4424-8424-242424242424',
    p_client_site_id: '42424242-4242-4242-8242-424242424242',
    p_scheduled_for: expectedSchedule,
  });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('workshop: a fabrication order is priced from the price book, completed with stock draw-down, and invoiced in one step', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  const calls: Array<{ rpc: string; body: Record<string, unknown> }> = [];
  let status = 'in_progress';
  await page.route('**/rest/v1/workshop_work_order_summary**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([summaryRow(status)]) }));
  await page.route('**/rest/v1/service_agreements**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '24242424-2424-4424-8424-242424242424', name: 'Civic Events Compliance Services', client_organization_id: CLIENT_ID, client: { name: 'Civic Events Ltd' } }]) }));
  await page.route('**/rest/v1/workshop_work_order_lines**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
    { id: 'l1', work_order_id: WO_ID, line_kind: 'material', item_id: STEEL_ID, description: '200x200mm box section (lockbox)', quantity: 2.5, unit_of_measure: 'm', unit_cost: 40, unit_price: 62, line_total: 155, inventory_transaction_id: status === 'completed' ? 'tx1' : null, invoice_line_item_id: null, position: 1 },
    { id: 'l2', work_order_id: WO_ID, line_kind: 'labour', item_id: null, description: 'Cut, weld, finish', quantity: 3, unit_of_measure: 'hr', unit_cost: 45, unit_price: 95, line_total: 285, inventory_transaction_id: null, invoice_line_item_id: null, position: 2 },
  ]) }));
  await page.route('**/rest/v1/finance_inventory_locations**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: LOCATION_ID, name: 'Workshop', location_type: 'warehouse', active: true }]) }));
  await page.route('**/rest/v1/finance_inventory_balances**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ item_id: STEEL_ID, location_id: LOCATION_ID, on_hand: 10, reserved: 0 }]) }));
  await page.route('**/rest/v1/finance_price_book**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ item_id: STEEL_ID, organization_id: ORG_ID, sku: 'BOX-200', name: '200x200mm box section (lockbox)', item_type: 'material', unit_of_measure: 'm', unit_cost: 40, unit_price: 62 }]) }));
  await page.route('**/rest/v1/rpc/advance_workshop_work_order_status**', async (route) => { const body = JSON.parse(route.request().postData() ?? '{}'); calls.push({ rpc: 'advance', body }); status = body.p_status; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(summaryRow(status)) }); });
  await page.route('**/rest/v1/rpc/add_workshop_work_order_line**', async (route) => { calls.push({ rpc: 'add_line', body: JSON.parse(route.request().postData() ?? '{}') }); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'l3' }) }); });
  await page.route('**/rest/v1/rpc/generate_crm_invoice_from_completed_work**', async (route) => { calls.push({ rpc: 'invoice', body: JSON.parse(route.request().postData() ?? '{}') }); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'inv1', invoice_number: 'INV-20260830-AB12', total_amount: 506 }) }); });

  await signInAsAdmin(page, '/admin/workshop');
  await expect(page.getByRole('heading', { name: 'Workshop', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lockbox for Civic Events depot' })).toBeVisible();
  await expect(page.getByText('Billed to Civic Events Ltd')).toBeVisible();
  await expect(page.locator('.workshop-totals').getByText('$440.00')).toBeVisible();
  await expect(page.locator('.workshop-totals').getByText('46.59%')).toBeVisible();

  // Add a material line from the price book: kind, price and cost prefill.
  const addLine = page.locator('form.workshop-card').filter({ hasText: 'Add a line' });
  await addLine.getByLabel('Pick from your price list').selectOption(`item:${STEEL_ID}`);
  await expect(addLine.getByLabel('Kind')).toHaveValue('material');
  await expect(addLine.getByLabel('Unit price (charge)')).toHaveValue('62');
  await addLine.getByLabel(/Quantity/).fill('1.5');
  await addLine.getByRole('button', { name: 'Add line' }).click();
  await expect(page.getByText('Line added.')).toBeVisible();
  expect(calls.find((c) => c.rpc === 'add_line')?.body).toMatchObject({ p_work_order_id: WO_ID, p_line_kind: 'material', p_item_id: STEEL_ID, p_quantity: 1.5, p_unit_price: 62, p_unit_cost: 40 });

  // Complete: the page explains the stock draw-down before the click.
  await expect(page.getByText(/1 stock line will be drawn down from Workshop; the lines become billable to Civic Events Ltd/)).toBeVisible();
  await page.getByLabel(/Note/).fill('Built, powder-coated and delivered');
  await page.getByRole('button', { name: 'Complete', exact: true }).click();
  await expect(page.getByText('Work order completed.')).toBeVisible();
  expect(calls.find((c) => c.rpc === 'advance')?.body).toMatchObject({ p_work_order_id: WO_ID, p_status: 'completed', p_note: 'Built, powder-coated and delivered' });
  await expect(page.locator('.workshop-totals').getByText('Still to invoice')).toBeVisible();
  await expect(page.getByText('stock drawn')).toBeVisible();

  // Invoice completed work in one step.
  await page.getByRole('button', { name: /Invoice completed work \(1\)/ }).click();
  await expect(page.getByLabel('Client', { exact: true })).toHaveValue(CLIENT_ID);
  await page.getByRole('button', { name: 'Create draft invoice' }).click();
  await expect(page.getByText(/Draft invoice INV-20260830-AB12 for \$506\.00 created/)).toBeVisible();
  expect(calls.find((c) => c.rpc === 'invoice')?.body).toMatchObject({ p_organization_id: OPERATING_ORG_ID, p_client_organization_id: CLIENT_ID });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('workshop: stock tab shows on-hand balances and records a receipt through the ledger RPC', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  let receipt: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/finance_inventory_locations**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: LOCATION_ID, name: 'Workshop', location_type: 'warehouse', active: true }]) }));
  await page.route('**/rest/v1/finance_inventory_balances**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ item_id: STEEL_ID, location_id: LOCATION_ID, on_hand: 7.5, reserved: 0 }]) }));
  await page.route('**/rest/v1/finance_price_book**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ item_id: STEEL_ID, organization_id: ORG_ID, sku: 'BOX-200', name: '200x200mm box section (lockbox)', item_type: 'material', unit_of_measure: 'm', unit_cost: 40, unit_price: 62 }]) }));
  await page.route('**/rest/v1/rpc/record_finance_inventory_transaction**', async (route) => { receipt = JSON.parse(route.request().postData() ?? '{}'); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'tx9' }) }); });

  await signInAsAdmin(page, '/admin/workshop');
  await page.getByRole('button', { name: /^Stock/ }).click();
  await expect(page.getByRole('cell', { name: 'BOX-200 · 200x200mm box section (lockbox)' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '7.5 m' })).toBeVisible();
  const form = page.locator('form.workshop-card').filter({ hasText: 'Record a stock receipt' });
  await form.getByLabel('Item received').selectOption(`item:${STEEL_ID}`);
  await form.getByLabel('Arrived at').selectOption(LOCATION_ID);
  await form.getByLabel('Quantity').fill('6');
  await expect(form.getByLabel('Unit cost paid')).toHaveValue('40');
  await form.getByLabel(/Supplier invoice/).fill('Steel & Tube INV-4471');
  await form.getByRole('button', { name: 'Record receipt' }).click();
  await expect(page.getByText('Stock receipt recorded.')).toBeVisible();
  expect(receipt).toMatchObject({ p_item_id: STEEL_ID, p_location_id: LOCATION_ID, p_transaction_type: 'receipt', p_quantity: 6, p_unit_cost: 40, p_source_reference: 'Steel & Tube INV-4471' });
  expect(typeof (receipt as Record<string, unknown> | null)?.p_idempotency_key).toBe('string');
  expect(errors, errors.join('\n')).toEqual([]);
});
