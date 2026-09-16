import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

const ORG_ID = '33333333-3333-4333-8333-333333333333';
const OFFICER_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '42424242-4242-4242-8242-424242424242';
const WO_ID = 'cafecafe-cafe-4afe-8afe-cafecafecaf1';
const HINGE_ID = 'beefbeef-beef-4eef-8eef-beefbeefbee1';

const order = (status: string) => ({
  id: WO_ID, organization_id: ORG_ID, order_number: 'WO-202608-0007', kind: 'maintenance', status, title: 'Replace depot gate hinges', description: 'Client reports the gate drags and will not latch.',
  client_organization_id: '40404040-4040-4040-8040-404040404040', client_name: 'Civic Events Ltd', service_agreement_id: null, client_site_id: SITE_ID, site_name: 'Civic Events Depot', asset_id: null, asset_name: null,
  inventory_location_id: null, stock_location_name: null, bom_template_id: null, template_name: null, assigned_user_id: OFFICER_ID, assigned_name: 'Ana Ngata', scheduled_for: '2026-08-30T22:00:00.000Z',
  started_at: status === 'in_progress' ? '2026-08-30T21:50:00.000Z' : null, completed_at: null, cancelled_at: null, completion_note: null, created_at: '2026-08-29T20:00:00.000Z', updated_at: '2026-08-29T20:00:00.000Z',
  line_count: 1, charge_total: 120, cost_total: 60, uninvoiced_total: 0,
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page, { officerModules: ['workshop'] });
  // Grant the officer the workshop module (organisation entitlement comes from officerModules above).
  await page.route('**/rest/v1/user_profiles**', async (route) => {
    const select = new URL(route.request().url()).searchParams.get('select') ?? '';
    const identity = { id: OFFICER_ID, display_name: 'Ana Ngata', email: 'ana@fcm.test', phone: '021 555 0102', role: 'officer', organization_id: ORG_ID, employer_organization_id: ORG_ID, module_access: ['workshop'], deactivated_at: null, updated_at: '2026-08-29T20:00:00.000Z' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(select.includes('module_access') || select.includes('organization_id') ? [identity] : [{ id: OFFICER_ID, display_name: 'Ana Ngata' }]) });
  });
});

test('the assigned technician sees the visit brief and safety warnings, records what they used at book price, and completes the job', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  let status = 'approved';
  const calls: Array<{ rpc: string; body: Record<string, unknown> }> = [];
  const lines: Array<Record<string, unknown>> = [{ id: 'l1', work_order_id: WO_ID, line_kind: 'labour', item_id: null, description: 'Site visit', quantity: 1, unit_of_measure: 'visit', unit_cost: 60, unit_price: 120, line_total: 120, inventory_transaction_id: null, invoice_line_item_id: null, position: 1, created_by: 'admin' }];
  await page.route('**/rest/v1/workshop_work_order_summary**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([order(status)]) }));
  await page.route('**/rest/v1/workshop_work_order_lines**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lines) }));
  await page.route('**/rest/v1/client_sites**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: SITE_ID, name: 'Civic Events Depot', address: '1 Civic Square', hs_notes: 'Forklifts operate in the yard — hi-vis required.', access_instructions: 'Gate code 4471, sign in at the office.' }]) }));
  await page.route('**/rest/v1/rpc/get_safety_warnings**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'w1', entity_type: 'place', entity_id: 'p1', requested_id: SITE_ID, hazard_class: 'dangerous_dog', alert_level: 'high', raised_at: '2026-08-20T02:00:00.000Z', organization_id: '77777777-7777-4777-8777-777777777777', organization_name: 'Harbour City Security', contact_email: null, contact_phone: '04 555 0100', is_own_organization: false, reason: null }]) }));
  await page.route('**/rest/v1/finance_price_book**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ item_id: HINGE_ID, organization_id: ORG_ID, sku: 'HINGE-HD', name: 'Heavy duty gate hinge', item_type: 'part', unit_of_measure: 'ea', unit_cost: 18, unit_price: 32 }]) }));
  await page.route('**/rest/v1/rpc/advance_workshop_work_order_status**', async (route) => { const body = JSON.parse(route.request().postData() ?? '{}'); calls.push({ rpc: 'advance', body }); status = body.p_status; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(order(status)) }); });
  await page.route('**/rest/v1/rpc/add_workshop_work_order_line**', async (route) => { const body = JSON.parse(route.request().postData() ?? '{}'); calls.push({ rpc: 'add_line', body }); lines.push({ id: 'l2', work_order_id: WO_ID, line_kind: body.p_line_kind, item_id: body.p_item_id, description: 'Heavy duty gate hinge', quantity: body.p_quantity, unit_of_measure: 'ea', unit_cost: 18, unit_price: 32, line_total: 32 * Number(body.p_quantity), inventory_transaction_id: null, invoice_line_item_id: null, position: 2, created_by: OFFICER_ID }); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lines[1]) }); });

  await signInAsOfficer(page, '/officer/workshop');
  await expect(page.getByRole('heading', { name: 'Workshop' })).toBeVisible();
  await expect(page.getByText('1 job assigned to you')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Replace depot gate hinges' })).toBeVisible();

  // Before you go: site brief + another organisation's hazard, redacted.
  await expect(page.getByText('Forklifts operate in the yard — hi-vis required.')).toBeVisible();
  await expect(page.getByText('Gate code 4471, sign in at the office.')).toBeVisible();
  const warnings = page.getByTestId('safety-warnings');
  await expect(warnings.getByText('Dangerous dog')).toBeVisible();
  await expect(warnings.getByRole('link', { name: '04 555 0100' })).toBeVisible();

  // Start.
  await page.getByRole('button', { name: 'Start work' }).click();
  await expect(page.getByText('Job started.')).toBeVisible();
  expect(calls[0]).toMatchObject({ rpc: 'advance', body: { p_work_order_id: WO_ID, p_status: 'in_progress' } });

  // Record two hinges: the worker never types a price.
  await page.getByLabel('Item from the price list').selectOption(`item:${HINGE_ID}`);
  await page.getByLabel(/How many/).fill('2');
  await page.getByRole('button', { name: 'Add to this job' }).click();
  await expect(page.getByText('Recorded what you used.')).toBeVisible();
  expect(calls[1]).toMatchObject({ rpc: 'add_line', body: { p_work_order_id: WO_ID, p_line_kind: 'material', p_item_id: HINGE_ID, p_quantity: 2, p_unit_price: null, p_unit_cost: null } });
  await expect(page.getByRole('cell', { name: 'Heavy duty gate hinge', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Heavy duty gate hinge' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Site visit' })).toHaveCount(0);

  // Complete (no stock location on this visit, so the worker may complete).
  await expect(page.getByText(/no stock movement \(no stock location on this order\); the lines become billable to Civic Events Ltd/)).toBeVisible();
  await page.getByLabel(/What did you do/).fill('Replaced both hinges, gate swings and locks cleanly.');
  await page.getByRole('button', { name: 'Complete job' }).click();
  await expect(page.getByText(/Job completed/)).toBeVisible();
  expect(calls[2]).toMatchObject({ rpc: 'advance', body: { p_work_order_id: WO_ID, p_status: 'completed', p_note: 'Replaced both hinges, gate swings and locks cleanly.' } });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('an order that draws stock tells the technician the office completes it', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/workshop_work_order_summary**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ ...order('in_progress'), kind: 'fabrication', title: 'Lockbox build', client_site_id: null, site_name: null, inventory_location_id: 'loc1', stock_location_name: 'Workshop' }]) }));
  await page.route('**/rest/v1/workshop_work_order_lines**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'l1', work_order_id: WO_ID, line_kind: 'material', item_id: 'i1', description: '200x200mm box section', quantity: 2.5, unit_of_measure: 'm', unit_cost: 40, unit_price: 62, line_total: 155, inventory_transaction_id: null, invoice_line_item_id: null, position: 1, created_by: 'admin' }]) }));

  await signInAsOfficer(page, '/officer/workshop');
  await expect(page.getByRole('heading', { name: 'Lockbox build' })).toBeVisible();
  await expect(page.getByText(/This job draws stock from Workshop, so a workshop administrator completes it/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete job' })).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});
