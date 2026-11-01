import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const orders = [
  { id: '91919191-9191-4191-8191-919191919191', order_number: 'WO-101', title: 'Build lockboxes', kind: 'fabrication', client_organization_id: '40404040-4040-4040-8040-404040404040', client_name: 'Example client', status: 'approved' },
  { id: '92929292-9292-4292-8292-929292929292', order_number: 'WO-102', title: 'Repair gate', kind: 'maintenance', client_organization_id: '40404040-4040-4040-8040-404040404040', client_name: 'Example client', status: 'approved' },
];

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/workshop_work_order_summary**', (route) => {
    expect(new URL(route.request().url()).searchParams.get('client_organization_id')).toBe('not.is.null');
    return route.fulfill({ json: orders });
  });
});

for (const order of orders) {
  test(`creates roster labour linked to ${order.kind} for ${order.client_name ?? 'internal work'}`, async ({ page }) => {
    const errors = monitorBrowserErrors(page);
    let payload: Record<string, unknown> | undefined;
    await page.route('**/rest/v1/rpc/create_operating_workshop_roster_work_unit', async (route) => {
      payload = route.request().postDataJSON();
      const unit = { id: '93939393-9393-4393-8393-939393939393', name: order.title, work_unit_type: 'workshop', workshop_work_order_id: order.id, service_type: order.kind, workplace_id: payload?.p_workplace_id, required_skill_ids: [], required_skill_names: [], updated_at: '2026-10-25T00:00:00Z' };
      await page.route('**/rest/v1/roster_work_units**', (read) => read.fulfill({ json: [unit] }));
      await route.fulfill({ json: unit });
    });
    await signInAsAdmin(page, '/admin/roster-targets');
    await page.getByRole('button', { name: /New work unit/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Create work unit' });
    await dialog.getByRole('tab', { name: 'Manufacturing & maintenance' }).click();
    await expect(dialog.getByRole('button', { name: 'Create work unit', exact: true })).toBeDisabled();
    await dialog.getByLabel('Name', { exact: true }).fill(order.title);
    await dialog.getByRole('combobox', { name: 'Work order', exact: true }).selectOption(order.id);
    await expect(dialog.getByRole('combobox', { name: /^Kind of work / })).toHaveValue(order.kind);
    await expect(dialog.getByRole('combobox', { name: /^Kind of work / })).toHaveAttribute('readonly', '');
    await dialog.getByLabel('Provider workplace').selectOption({ index: 1 });
    await expect(dialog.getByText(/client billing follows the work order/)).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Create work unit', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: /created/ })).toBeVisible();
    await expect(page.locator('.targets-list strong').getByText(order.title, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open work order', exact: true })).toBeVisible();
    expect(payload?.p_work_order_id).toBe(order.id);
    expect(payload?.p_workplace_id).toBeTruthy();
    expect(payload).not.toHaveProperty('p_service_type');
    expect(payload).not.toHaveProperty('p_work_unit_type');
    expect(errors).toEqual([]);
  });
}

test('explains the missing-order prerequisite instead of creating an unlinked unit', async ({ page }) => {
  await page.route('**/rest/v1/workshop_work_order_summary**', (route) => route.fulfill({ json: [] }));
  await signInAsAdmin(page, '/admin/roster-targets');
  await page.getByRole('button', { name: /New work unit/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Create work unit' });
  await dialog.getByRole('tab', { name: 'Manufacturing & maintenance' }).click();
  await expect(dialog.getByText('No open work orders to link.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Open Workshop' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create work unit', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Open Workshop' }).click();
  await expect(page).toHaveURL(/\/admin\/workshop\?clientJob=1$/);
  await expect(page.getByLabel('Client agreement (who gets billed)')).toHaveAttribute('required', '');
  await expect(page.getByRole('heading', { name: 'New work order' })).toBeVisible();
});

test('keeps the form and exposes work-order permission or validation errors', async ({ page }) => {
  await page.route('**/rest/v1/rpc/create_operating_workshop_roster_work_unit', (route) => route.fulfill({ status: 400, json: { message: 'Open work order in this operating branch required' } }));
  await signInAsAdmin(page, '/admin/roster-targets');
  await page.getByRole('button', { name: /New work unit/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Create work unit' });
  await dialog.getByRole('tab', { name: 'Manufacturing & maintenance' }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Maintenance crew');
  await dialog.getByRole('combobox', { name: 'Work order', exact: true }).selectOption(orders[1].id);
  await dialog.getByLabel('Provider workplace').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: 'Create work unit', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Open work order in this operating branch required');
});
