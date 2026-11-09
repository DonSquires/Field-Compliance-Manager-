import { expect, test, type Page } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin } from './fixtures';

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

test('Timesheets page exports the selected organization and date range through the approved payroll batch', async ({ page }) => {
  let batchRequest: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/timesheets**', async route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/rpc/get_timesheet_shift_rows', async route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/rpc/get_operating_branch_roster_staff', async route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ staff_id: '22222222-2222-4222-8222-222222222222', user_id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata' }]) }));
  await page.route('**/rest/v1/rpc/create_payroll_export_batch', async route => {
    batchRequest = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([receipt]) });
  });
  await page.route('**/rest/v1/rpc/get_timesheet_payroll_export', async route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { timesheet_id: 'sheet-1', staff_id: '22222222-2222-4222-8222-222222222222', period_start: '2026-08-24', period_end: '2026-08-29', payroll_snapshot: { pay_code: 'NORMAL', hours: 8, overtime_hours: 0, hourly_rate: 30, gross_amount: 240, evidence_kind: 'officer_work' } },
  ]) }));
  await useEmployerPayrollContext(page);
  await signInAsAdmin(page, '/admin/timesheets');
  await page.getByLabel('From', { exact: true }).fill('2026-08-24');
  await page.getByLabel('To', { exact: true }).fill('2026-08-29');
  await page.getByRole('button', { name: 'Submitted periods', exact: true }).click();
  await page.getByRole('button', { name: 'Export approved to payroll' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create payroll batch' });
  await expect(dialog.getByLabel('Period from')).toHaveValue('2026-08-24');
  await expect(dialog.getByLabel('Period to')).toHaveValue('2026-08-29');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Create payroll batch' }).click();
  expect((await download).suggestedFilename()).toBe(`payroll-${receipt.batch_id}.csv`);
  expect(batchRequest).toMatchObject({ p_organization_id: '33333333-3333-4333-8333-333333333333', p_period_from: '2026-08-24', p_period_to: '2026-08-29', p_format: 'csv' });
  await expect(page.getByRole('status').filter({ hasText: 'Payroll batch recorded' })).toContainText('2 timesheets, 12.50 hours');
  await expect(page.getByRole('button', { name: 'Download last batch' })).toBeVisible();
});

test('Timesheets page blocks organization-wide payroll export when a staff filter is active', async ({ page }) => {
  await page.route('**/rest/v1/timesheets**', async route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/rpc/get_timesheet_shift_rows', async route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/rpc/get_operating_branch_roster_staff', async route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ staff_id: '22222222-2222-4222-8222-222222222222', user_id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata' }]) }));
  await useEmployerPayrollContext(page);
  await signInAsAdmin(page, '/admin/timesheets');
  await page.getByLabel('Filter shift hours by staff member').selectOption('22222222-2222-4222-8222-222222222222');
  await page.getByRole('button', { name: 'Submitted periods', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export approved to payroll' })).toBeDisabled();
  await expect(page.getByRole('note')).toContainText('Clear the staff filter before exporting');
});

test('Timesheets approval uses a popup and records the reviewer note through the guarded RPC', async ({ page }) => {
  let reviewRequest: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/timesheets*', async route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { id: '38383838-3838-4838-8838-383838383838', organization_id: '33333333-3333-4333-8333-333333333333', staff_id: '22222222-2222-4222-8222-222222222222', period_start: '2026-08-17', period_end: '2026-08-23', scheduled_hours: 40, actual_hours: 42, overtime_hours: 2, status: 'submitted' },
  ]) }));
  await page.route('**/rest/v1/rpc/review_timesheet', async route => {
    reviewRequest = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: '38383838-3838-4838-8838-383838383838', status: 'approved' }) });
  });
  await useEmployerPayrollContext(page);
  await signInAsAdmin(page, '/admin/timesheets');
  await page.getByRole('button', { name: 'Submitted periods', exact: true }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Ana Ngata/ });
  await dialog.getByLabel('Approval note (optional)').fill('Reviewed against the roster and work record.');
  await dialog.getByRole('button', { name: 'Approve timesheet' }).click();
  await expect.poll(() => reviewRequest).toMatchObject({ p_decision: 'approved', p_review_notes: 'Reviewed against the roster and work record.' });
});

test('only an approved unexported timesheet can be unapproved with an audited reason', async ({ page }) => {
  let reopenRequest: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/timesheets*', async route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { id: '38383838-3838-4838-8838-383838383838', organization_id: '33333333-3333-4333-8333-333333333333', staff_id: '22222222-2222-4222-8222-222222222222', period_start: '2026-08-17', period_end: '2026-08-23', actual_hours: 42, status: 'approved', revision: 7, payroll_export_batch_id: null },
  ]) }));
  await page.route('**/rest/v1/rpc/reopen_approved_timesheet', async route => {
    reopenRequest = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: '38383838-3838-4838-8838-383838383838', status: 'submitted', revision: 8 }) });
  });
  await useEmployerPayrollContext(page);
  await signInAsAdmin(page, '/admin/timesheets');
  await page.getByRole('button', { name: 'Submitted periods', exact: true }).click();
  await page.getByRole('button', { name: 'Unapprove', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Unapprove timesheet' });
  await dialog.getByLabel('Reason for reopening (kept in the audit trail)').fill('Reconcile with the corrected shift record.');
  await dialog.getByRole('button', { name: 'Reopen for review' }).click();
  await expect.poll(() => reopenRequest).toMatchObject({
    p_timesheet_id: '38383838-3838-4838-8838-383838383838',
    p_expected_revision: 7,
    p_reason: 'Reconcile with the corrected shift record.',
  });
});

test('an exported approved timesheet does not offer unapproval', async ({ page }) => {
  await page.route('**/rest/v1/timesheets*', async route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { id: '38383838-3838-4838-8838-383838383838', organization_id: '33333333-3333-4333-8333-333333333333', staff_id: '22222222-2222-4222-8222-222222222222', period_start: '2026-08-17', period_end: '2026-08-23', actual_hours: 42, status: 'paid', revision: 8, payroll_export_batch_id: '51515151-5151-4151-8151-515151515151' },
  ]) }));
  await useEmployerPayrollContext(page);
  await signInAsAdmin(page, '/admin/timesheets');
  await page.getByRole('button', { name: 'Submitted periods', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unapprove', exact: true })).toHaveCount(0);
});

test('timesheet PDF preview includes organization and place provenance and uses browser print', async ({ page }) => {
  await page.route('**/rest/v1/timesheets*', async route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { id: '38383838-3838-4838-8838-383838383838', organization_id: '33333333-3333-4333-8333-333333333333', staff_id: '22222222-2222-4222-8222-222222222222', period_start: '2026-08-24', period_end: '2026-08-29', scheduled_hours: 40, actual_hours: 38, overtime_hours: 0, adjustment_hours: 0, status: 'approved', review_notes: 'Reviewed against the roster.' },
  ]) }));
  await page.route('**/rest/v1/rpc/get_timesheet_provenance', async route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { timesheet_id: '38383838-3838-4838-8838-383838383838', organization_id: '33333333-3333-4333-8333-333333333333', organization_name: 'Harbour Compliance Services', operating_organization_id: '33333333-3333-4333-8333-333333333333', operating_organization_name: 'Harbour Compliance Services', shift_id: '56565656-5656-4656-8656-565656565656', service_type: 'static_guarding', work_unit_name: 'Civic Centre Static Post', location_name: 'Civic Events Centre', zone_name: 'North Pavilion Zone' },
  ]) }));
  await useEmployerPayrollContext(page);
  await signInAsAdmin(page, '/admin/timesheets');
  await page.getByRole('button', { name: 'Submitted periods', exact: true }).click();
  await expect(page.getByText('Harbour Compliance Services', { exact: true }).first()).toBeVisible();
  await page.evaluate(() => {
    const printableWindow = window as Window & { __printCalled?: boolean };
    printableWindow.__printCalled = false;
    printableWindow.print = () => { printableWindow.__printCalled = true; };
  });
  await page.getByRole('button', { name: 'Print / Save PDF' }).first().click();
  const preview = page.getByRole('dialog', { name: /Ana Ngata/ });
  await expect(preview).toContainText('Harbour Compliance Services');
  await expect(preview).toContainText('Civic Events Centre');
  await expect(preview).toContainText('North Pavilion Zone');
  await preview.getByRole('button', { name: 'Print / Save PDF' }).click();
  expect(await page.evaluate(() => (window as Window & { __printCalled?: boolean }).__printCalled)).toBe(true);
});
