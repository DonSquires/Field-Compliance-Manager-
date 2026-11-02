import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.use({ timezoneId: 'UTC' });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('timesheet decision notification opens the exact reviewed period', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/timesheet?timesheet=38383838-3838-4838-8838-383838383838');

  const timesheet = page.locator('#officer-timesheet-38383838-3838-4838-8838-383838383838');
  await expect(timesheet).toHaveClass(/is-context-focus/);
  await expect(timesheet.getByText('Approved', { exact: true })).toBeVisible();
  await expect(timesheet.getByText(/Approved after reconciling the extended incident response/)).toBeVisible();
  await expect(timesheet.getByText(/30\/08\/2026/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('officer timesheet derives hours from completed work only', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { source_type: 'shift', source_id: '12121212-1212-4212-8212-121212121212', work_status: 'completed', started_at: '2026-08-25T20:00:00.000Z', ended_at: '2026-08-26T04:00:00.000Z', calculated_minutes: 480, label: 'Night patrol', metadata: {} },
    ]) });
  });
  await page.route('**/rest/v1/rpc/submit_officer_timesheet_from_work', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload.p_period_start).toBe('2026-08-24');
    expect(payload.p_period_end).toBe('2026-08-29');
    expect(payload.p_adjustment_hours).toBe(0);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'abababab-abab-4bab-8bab-abababababab', actual_hours: 8, source_count: 1 }]) });
  });

  await signInAsOfficer(page, '/officer/timesheet');
  // The period defaults to this week so far (the test browser runs in UTC, where the fixed clock is Sat 29 Aug) and previews on load.
  await expect(page.getByLabel('From')).toHaveValue('2026-08-24');
  await expect(page.getByLabel('To')).toHaveValue('2026-08-29');
  await expect(page.getByText(/Worked time: 8h 00m across 1 shift/)).toBeVisible();
  await expect(page.locator('.officer-timesheet-entries li').filter({ hasText: 'Night patrol' })).toContainText('8h 00m');
  await page.getByLabel('Adjustment (hours)').fill('0');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Timesheet sent for approval: 8 hours from 1 work record' })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('branch shifts reach the timesheet, unpaid breaks come off, and a shift ended by the next start says so', async ({ page }) => {
  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { source_type: 'shift', source_id: '12121212-1212-4212-8212-121212121212', work_status: 'completed', started_at: '2026-08-25T20:00:00.000Z', ended_at: '2026-08-26T04:00:00.000Z', calculated_minutes: 450, label: 'static_guarding', metadata: { organization_id: '8b860f57-83ce-4f95-aca3-df30522f0388', unpaid_break_minutes: 30, paid_break_minutes: 10, ended_reason: 'officer' } },
      { source_type: 'shift', source_id: '13131313-1313-4313-8313-131313131313', work_status: 'completed', started_at: '2026-08-27T06:00:00.000Z', ended_at: '2026-08-27T09:30:00.000Z', calculated_minutes: 210, label: 'patrol', metadata: { organization_id: '8b860f57-83ce-4f95-aca3-df30522f0388', unpaid_break_minutes: 0, ended_reason: 'superseded_by_next_shift' } },
      { source_type: 'dispatch_job', source_id: '14141414-1414-4414-8414-141414141414', work_status: 'completed', started_at: '2026-08-28T01:00:00.000Z', ended_at: '2026-08-28T02:00:00.000Z', calculated_minutes: 60, label: 'Alarm response', metadata: {} },
    ]) });
  });
  await signInAsOfficer(page, '/officer/timesheet');
  await expect(page.getByText('Worked time: 12h 00m across 2 shifts and 1 stand-alone job')).toBeVisible();
  const entries = page.locator('.officer-timesheet-entries li');
  await expect(entries.filter({ hasText: 'Static guarding' })).toContainText('7h 30m (30 min unpaid break taken off)');
  await expect(entries.filter({ hasText: 'Patrol' }).first()).toContainText('3h 30m · ended when your next shift started');
  await expect(entries.filter({ hasText: 'Alarm response' })).toContainText('1h 00m');
});

test('a period already covered by a sent timesheet cannot be sent twice', async ({ page }) => {
  await page.route('**/rest/v1/timesheets**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '38383838-3838-4838-8838-383838383838', period_start: '2026-08-24', period_end: '2026-08-30', scheduled_hours: 40, actual_hours: 39, overtime_hours: 0, status: 'submitted', review_notes: null, approved_at: null, submitted_at: '2026-08-30T08:05:00Z' }]) });
  });
  await signInAsOfficer(page, '/officer/timesheet');
  await expect(page.locator('.form-hint[role="note"]')).toContainText('You already sent a timesheet covering Mon, 24 Aug – Sun, 30 Aug (waiting for review). Pick dates outside it.');
  await expect(page.getByRole('button', { name: 'Send for approval' })).toBeDisabled();
  await expect(page.locator('.status-badge').filter({ hasText: 'Waiting for review' })).toBeVisible();
  // 08:05 UTC on 30 Aug is 8:05 pm the same day in New Zealand standard time.
  await expect(page.locator('#officer-timesheet-38383838-3838-4838-8838-383838383838')).toContainText(/Submitted 30 Aug.*8:05/);
});

test('officer resubmits a rejected period after correction', async ({ page }) => {
  await page.route('**/rest/v1/timesheets**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '38383838-3838-4838-8838-383838383838', period_start: '2026-08-17', period_end: '2026-08-23', scheduled_hours: 40, actual_hours: 39, overtime_hours: 0, status: 'rejected', review_notes: 'Please reconcile the signed attendance record.', approved_at: null }]) });
  });
  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ source_type: 'shift', source_id: '12121212-1212-4212-8212-121212121212', work_status: 'completed', started_at: '2026-08-18T08:00:00.000Z', ended_at: '2026-08-18T16:00:00.000Z', calculated_minutes: 480, label: 'Completed patrol', metadata: {} }]) });
  });
  await page.route('**/rest/v1/rpc/resubmit_rejected_timesheet_from_work', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload.p_timesheet_id).toBe('38383838-3838-4838-8838-383838383838');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '38383838-3838-4838-8838-383838383838', actual_hours: 8, source_count: 1 }]) });
  });
  await signInAsOfficer(page, '/officer/timesheet');
  await page.getByLabel('From').fill('2026-08-17');
  await page.getByLabel('To').fill('2026-08-23');
  await expect(page.getByRole('heading', { name: 'Send the corrected timesheet' })).toBeVisible();
  await page.getByRole('button', { name: 'Send corrected timesheet' }).click();
  await expect(page.getByRole('status').filter({ hasText: '8 hours from 1 work record' })).toBeVisible();
});