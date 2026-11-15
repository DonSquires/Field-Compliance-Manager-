import { expect, test, type Page } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin } from './fixtures';
import { readFile } from 'node:fs/promises';
import type { ShiftHoursReviewRow } from '../src/lib/shiftHoursExport';

const receipt = { batch_id: 'abababab-abab-4bab-8bab-abababababab', timesheet_count: 2, total_hours: '12.5' };
const failure = { message: 'Synthetic payroll response lost', code: 'XX000' };

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/rpc/get_timesheet_payroll_export', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
});

async function useEmployerPayrollContext(page: Page): Promise<void> {
  await page.route('**/rest/v1/rpc/get_operating_organization_contexts', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { organization_id: '33333333-3333-4333-8333-333333333333', organization_name: 'Harbour Compliance Services', authority_basis: 'employer', role_at_branch: null, module_access: [], can_be_rostered: true, is_default: true },
    ]) });
  });
}

for (const timezoneId of ['UTC', 'Pacific/Auckland']) {
  test.describe(`payroll period in ${timezoneId}`, () => {
    test.use({ timezoneId });
    test('defaults to the complete local calendar month', async ({ page }) => {
      await page.clock.setFixedTime(new Date('2026-08-15T12:00:00Z'));
      await signInAsAdmin(page, '/admin/people-hr?tab=timesheets');
      await page.getByRole('button', { name: 'Create payroll batch' }).click();
      const dialog = page.getByRole('dialog', { name: 'Create payroll batch' });
      await expect(dialog.getByLabel('Period from')).toHaveValue('2026-08-01');
      await expect(dialog.getByLabel('Period to')).toHaveValue('2026-08-31');
      await expect(dialog).toContainText('This records the batch and downloads its CSV. Payment and IRD submission are not available here.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
}

test('retrying unchanged dates recovers the same request receipt after a lost response', async ({ page }) => {
  const requestIds: string[] = [];
  await page.route('**/rest/v1/rpc/create_payroll_export_batch', async (route) => {
    requestIds.push(route.request().postDataJSON().p_client_request_id);
    await route.fulfill({ status: requestIds.length === 1 ? 503 : 200,
      contentType: 'application/json', body: JSON.stringify(requestIds.length === 1 ? failure : [receipt]) });
  });
  await signInAsAdmin(page, '/admin/people-hr?tab=timesheets');
  await page.getByRole('button', { name: 'Create payroll batch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create payroll batch' });
  await dialog.getByRole('button', { name: 'Create payroll batch' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Retry the same dates to recover any saved batch receipt.');
  await expect(dialog.getByRole('button', { name: 'Create payroll batch' })).toBeEnabled();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Create payroll batch' }).click();
  expect((await download).suggestedFilename()).toBe(`payroll-${receipt.batch_id}.csv`);
  await expect(page.getByRole('status').filter({ hasText: 'Payroll batch recorded' })).toContainText('2 timesheets, 12.50 hours · receipt abababab');
  await expect(dialog).toHaveCount(0);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
});

test('changed dates use a new request rather than replaying another period', async ({ page }) => {
  const requests: { p_client_request_id: string; p_period_to: string }[] = [];
  await page.route('**/rest/v1/rpc/create_payroll_export_batch', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(failure) });
  });
  await signInAsAdmin(page, '/admin/people-hr?tab=timesheets');
  await page.getByRole('button', { name: 'Create payroll batch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create payroll batch' });
  await dialog.getByLabel('Period from').fill('2026-08-01');
  await dialog.getByLabel('Period to').fill('2026-08-07');
  await dialog.getByRole('button', { name: 'Create payroll batch' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel('Period to').fill('2026-08-14');
  await dialog.getByRole('button', { name: 'Create payroll batch' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0].p_client_request_id).not.toBe(requests[1].p_client_request_id);
  expect(requests.map((request) => request.p_period_to)).toEqual(['2026-08-07', '2026-08-14']);
});

test('malformed totals do not close the form or claim a batch receipt', async ({ page }) => {
  await page.route('**/rest/v1/rpc/create_payroll_export_batch', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ ...receipt, total_hours: 'not-a-number' }]) });
  });
  await signInAsAdmin(page, '/admin/people-hr?tab=timesheets');
  await page.getByRole('button', { name: 'Create payroll batch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create payroll batch' });
  await dialog.getByRole('button', { name: 'Create payroll batch' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Payroll batch receipt was not confirmed.');
  await expect(dialog.getByRole('button', { name: 'Create payroll batch' })).toBeEnabled();
  await expect(page.getByText(/^Payroll batch recorded:/)).toHaveCount(0);
});

test('a confirmed receipt survives a subsequent queue refresh failure', async ({ page }) => {
  let batchSaved = false;
  let failedRefreshes = 0;
  for (const endpoint of ['**/rest/v1/timesheets**', '**/rest/v1/rpc/get_branch_timesheet_queue']) {
    await page.route(endpoint, async (route) => {
      if (!batchSaved) { await route.fallback(); return; }
      failedRefreshes += 1;
      await route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ message: 'Synthetic queue refresh failed', code: 'XX000' }) });
    });
  }
  await page.route('**/rest/v1/rpc/create_payroll_export_batch', async (route) => {
    batchSaved = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([receipt]) });
  });
  await signInAsAdmin(page, '/admin/people-hr?tab=timesheets');
  await page.getByRole('button', { name: 'Create payroll batch' }).click();
  await page.getByRole('dialog', { name: 'Create payroll batch' }).getByRole('button', { name: 'Create payroll batch' }).click();
  await expect(page.getByText(/^Payroll batch recorded:/)).toContainText('receipt abababab');
  await expect(page.getByRole('dialog', { name: 'Create payroll batch' })).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: 'Failed to load roster data' })).toBeVisible();
  expect(failedRefreshes).toBeGreaterThan(0);
});

test('Timesheets page previews the selected organisation and dates without creating a payroll batch', async ({ page }) => {
  await openShiftReview(page, [shift()]);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/rpc/create_payroll_export_batch')) writes.push(request.url());
  });
  await expect(page.getByRole('button', { name: 'Submitted periods', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview payroll hours' }).click();
  const preview = page.getByRole('table', { name: 'Hours export preview' });
  await expect(preview).toContainText('Fixture workplace');
  await expect(preview).toContainText('30 minutes');
  await expect(page.getByText('Grand total: 8 hours', { exact: true })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download reviewed CSV' }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('payroll-hours-2026-08-24-2026-08-30.csv');
  const file = await download.path();
  if (!file) throw new Error('CSV download was not saved');
  const csv = await readFile(file, 'utf8');
  expect(csv).toContain('EMP-12');
  expect(csv).toContain('2026-08-28 20:00:00 +12:00');
  expect(csv).toContain('Grand total');
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('payroll handoff retains the selected staff scope instead of silently exporting everyone', async ({ page }) => {
  const requests: Record<string, unknown>[] = [];
  await openShiftReview(page, [shift()]);
  await page.route('**/rest/v1/rpc/get_timesheet_shift_rows', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: [shift()] });
  });
  await page.getByLabel('Filter shift hours by staff member').selectOption('22222222-2222-4222-8222-222222222222');
  await expect.poll(() => requests.at(-1)?.p_staff_id).toBe('22222222-2222-4222-8222-222222222222');
  await page.getByRole('button', { name: 'Preview payroll hours' }).click();
  await expect(page.getByRole('table', { name: 'Hours export preview' })).toBeVisible();
  expect(requests.at(-1)).toMatchObject({ p_organization_id: shift().organization_id,
    p_staff_id: shift().staff_id, p_from: '2026-08-24', p_to: '2026-08-30' });
});

test('hours approval keeps the same request after a lost response and uses source/review versions', async ({ page }) => {
  const rows = [shift({ review_status: 'needs_review', review_revision: 0 })];
  const requests: Record<string, unknown>[] = [];
  await openShiftReview(page, rows);
  await page.route('**/rest/v1/rpc/review_shift_timesheet_hours', async (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    if (requests.length === 1) { await route.fulfill({ status: 503, json: failure }); return; }
    rows[0] = shift();
    await route.fulfill({ json: { request_id: request.p_client_request_id, decision: 'approved',
      shift_count: 1, shift_ids: [rows[0].id] } });
  });
  await page.getByRole('button', { name: 'Select unapproved shown (max 100)' }).click();
  await page.getByRole('button', { name: 'Approve selected hours' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve shift hours' });
  await expect(dialog.getByRole('button', { name: 'Confirm hours approval' })).toBeDisabled();
  await dialog.getByLabel('Reason for hours review').fill('Verified roster, attendance and unpaid break.');
  await dialog.getByRole('button', { name: 'Confirm hours approval' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic payroll response lost');
  await dialog.getByRole('button', { name: 'Confirm hours approval' }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests[0].p_client_request_id).toBe(requests[1].p_client_request_id);
  expect(requests[1]).toMatchObject({ p_decision: 'approved', p_reason: 'Verified roster, attendance and unpaid break.',
    p_rows: [{ shift_id: rows[0].id, source_revision: 'a'.repeat(32), review_revision: 0 }] });
  await expect(page.getByRole('row').filter({ hasText: 'Fixture workplace' })).toContainText('Approval: Approved');
});

test('approved and rejected source hours offer correction but finalised evidence stays read-only', async ({ page }) => {
  await openShiftReview(page, [shift(), shift({ id: 'rejected', review_status: 'rejected' }),
    shift({ id: 'paid', review_status: 'finalised', can_edit_hours: false, can_review_hours: false })]);
  const records = page.getByRole('row').filter({ hasText: 'Fixture workplace' });
  await expect(records.nth(0).getByRole('button', { name: /Edit shift hours/ })).toBeVisible();
  await expect(records.nth(1).getByRole('button', { name: /Edit shift hours/ })).toBeVisible();
  await expect(records.nth(2).getByRole('button', { name: /Edit shift hours/ })).toHaveCount(0);
  await expect(records.nth(2).getByRole('button', { name: /Approve shift hours|Reject shift hours/ })).toHaveCount(0);
  await expect(records.nth(2)).toContainText('An amendment is required');
});

test('a corrected row offers approval and changes colour with the persisted human review decision', async ({ page }) => {
  const rows = [shift({ review_status: 'rejected' })];
  const corrections: Record<string, unknown>[] = [];
  await openShiftReview(page, rows);
  await page.route('**/rest/v1/rpc/correct_reviewed_timesheet_shift_hours', async route => {
    const request = route.request().postDataJSON();
    corrections.push(request);
    if (corrections.length === 1) {
      await route.fulfill({ status: 503, json: failure });
      return;
    }
    rows[0] = shift({ review_status: 'needs_review', hours_status: 'review', source_revision: 'b'.repeat(32) });
    await route.fulfill({ json: { shift_id: rows[0].id, staff_id: rows[0].staff_id, hours_status: 'review' } });
  });
  await page.route('**/rest/v1/rpc/review_shift_timesheet_hours', async route => {
    const request = route.request().postDataJSON();
    expect(request.p_rows).toEqual([{ shift_id: rows[0].id, source_revision: 'b'.repeat(32), review_revision: rows[0].review_revision }]);
    rows[0] = { ...rows[0], review_status: request.p_decision, review_revision: rows[0].review_revision + 1 };
    await route.fulfill({ json: { request_id: request.p_client_request_id, decision: request.p_decision,
      shift_count: 1, shift_ids: [rows[0].id] } });
  });
  const record = page.getByRole('row').filter({ hasText: 'Fixture workplace' });
  const rowColour = () => record.locator('td').first().evaluate(cell => getComputedStyle(cell).backgroundColor);
  const rejectedColour = await rowColour();
  await record.getByRole('button', { name: /Edit shift hours/ }).click();
  const edit = page.getByRole('dialog', { name: 'Payable shift hours' });
  await edit.getByRole('button', { name: 'Use roster dates and times' }).click();
  await edit.getByLabel('Reason for correction').fill('Use verified roster dates and times');
  await edit.getByRole('button', { name: 'Save for review' }).click();
  await expect(edit.getByRole('alert')).toContainText('Synthetic payroll response lost');
  await expect(edit.getByLabel('Reason for correction')).toHaveValue('Use verified roster dates and times');
  await edit.getByRole('button', { name: 'Save for review' }).click();
  await expect(edit).toHaveCount(0);
  expect(corrections[0].p_client_request_id).toBe(corrections[1].p_client_request_id);
  await expect(record).toContainText('Approval: Awaiting approval');
  const pendingColour = await rowColour();
  expect(pendingColour).not.toBe(rejectedColour);
  await record.getByRole('button', { name: 'Approve shift hours for Fixture staff', exact: true }).click();
  const approve = page.getByRole('dialog', { name: 'Approve shift hours' });
  await expect(approve.getByRole('button', { name: 'Confirm hours approval' })).toBeDisabled();
  await approve.getByLabel('Reason for hours review').fill('Roster and break checked');
  await approve.getByRole('button', { name: 'Confirm hours approval' }).click();
  await expect(approve).toHaveCount(0);
  await expect(record).toContainText('Approval: Approved');
  const approvedColour = await rowColour();
  expect(approvedColour).not.toBe(pendingColour);
  expect(approvedColour).not.toBe(rejectedColour);
  await page.reload();
  await expect(record).toContainText('Approval: Approved');
  expect(await rowColour()).toBe(approvedColour);
  await record.getByRole('button', { name: 'Reject shift hours for Fixture staff', exact: true }).click();
  const reject = page.getByRole('dialog', { name: 'Reject shift hours' });
  await reject.getByLabel('Reason for hours review').fill('Source needs another review');
  await reject.getByRole('button', { name: 'Confirm hours rejection' }).click();
  await expect(record).toContainText('Approval: Rejected');
  expect(await rowColour()).toBe(rejectedColour);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('client hours use an agreement client and exclude employee numbers, wages and private notes', async ({ page }) => {
  await openShiftReview(page, [shift()]);
  await page.getByRole('combobox', { name: 'Handoff', exact: true }).selectOption('client');
  await page.getByLabel('Client for hours export').selectOption('client-1');
  await page.getByRole('button', { name: 'Preview client hours' }).click();
  await expect(page.getByRole('table', { name: 'Hours export preview' })).toContainText('Fixture agreement client');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download reviewed CSV' }).click();
  const file = await (await downloading).path();
  if (!file) throw new Error('Client CSV download was not saved');
  const csv = await readFile(file, 'utf8');
  for (const privateValue of ['EMP-12', '31.27', '53.46', 'PRIVATE', 'Employee number']) expect(csv).not.toContain(privateValue);
  expect(csv).toContain('Fixture workplace');
  expect(csv).toContain('Grand total');
});

function shift(changes: Partial<ShiftHoursReviewRow> = {}): ShiftHoursReviewRow {
  return {
    id: '11111111-1111-4111-8111-111111111110', organization_id: '33333333-3333-4333-8333-333333333333',
    staff_id: '22222222-2222-4222-8222-222222222222', staff_name: 'Fixture staff', officer_user_id: '22222222-2222-4222-8222-222222222222',
    service_type: 'static_guarding', status: 'completed', updated_at: '2026-08-29T05:00:00Z',
    scheduled_start: '2026-08-28T08:00:00Z', scheduled_end: '2026-08-28T16:30:00Z',
    actual_start: '2026-08-28T08:00:00Z', actual_end: '2026-08-28T16:30:00Z',
    payable_start: '2026-08-28T08:00:00Z', payable_end: '2026-08-28T16:30:00Z',
    unpaid_minutes: 30, recorded_unpaid_minutes: 30, planned_unpaid_minutes: 30,
    correction_updated_at: null, correction_reason: 'PRIVATE correction', review_reason: 'PRIVATE review',
    hours_status: 'confirmed', start_mismatch: false, finish_mismatch: false, unpaid_break_mismatch: false,
    source_revision: 'a'.repeat(32), review_revision: 1, review_status: 'approved', can_edit_hours: true, can_review_hours: true,
    client_organization_id: 'client-1', client_name: 'Fixture agreement client', service_agreement_id: 'agreement-1',
    location_name: 'Fixture workplace', client_link_problem: null, payroll_adjustment_pending: false,
    employee_number: 'EMP-12', pay_rate: 31.27, charge_rate: 53.46, ...changes,
  };
}
async function openShiftReview(page: Page, rows: ShiftHoursReviewRow[]) {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await useEmployerPayrollContext(page);
  await page.route('**/rest/v1/rpc/get_timesheet_shift_rows', async (route) => route.fulfill({ json: rows }));
  await page.route('**/rest/v1/rpc/get_operating_branch_roster_staff', async (route) => route.fulfill({ json: [
    { staff_id: shift().staff_id, user_id: shift().officer_user_id, display_name: 'Fixture staff' },
  ] }));
  await signInAsAdmin(page, '/admin/timesheets');
  await expect(page.getByRole('row').filter({ hasText: 'Fixture workplace' }).first()).toBeVisible();
}
