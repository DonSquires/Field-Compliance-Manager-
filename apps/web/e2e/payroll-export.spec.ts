import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin } from './fixtures';

const receipt = { batch_id: 'abababab-abab-4bab-8bab-abababababab', timesheet_count: 2, total_hours: '12.5' };
const failure = { message: 'Synthetic payroll response lost', code: 'XX000' };

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/rpc/get_timesheet_payroll_export', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
});

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
