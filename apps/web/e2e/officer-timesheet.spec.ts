import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('timesheet decision notification opens the exact reviewed period', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/timesheet?timesheet=38383838-3838-4838-8838-383838383838');

  const timesheet = page.locator('#officer-timesheet-38383838-3838-4838-8838-383838383838');
  await expect(timesheet).toHaveClass(/is-context-focus/);
  await expect(timesheet.getByText('approved', { exact: true })).toBeVisible();
  await expect(timesheet.getByText(/Approved after reconciling the extended incident response/)).toBeVisible();
  await expect(timesheet.getByText(/30\/08\/2026/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('officer timesheet derives hours from completed and partial work', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { source_type: 'shift', source_id: '12121212-1212-4212-8212-121212121212', work_status: 'completed', started_at: '2026-08-25T20:00:00.000Z', ended_at: '2026-08-26T04:00:00.000Z', calculated_minutes: 480, label: 'Night patrol', metadata: {} },
      { source_type: 'dispatch_job', source_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', work_status: 'partial', started_at: '2026-08-30T09:00:00.000Z', ended_at: '2026-08-30T09:30:00.000Z', calculated_minutes: 30, label: 'Alarm response', metadata: {} },
    ]) });
  });
  await page.route('**/rest/v1/rpc/submit_officer_timesheet_from_work', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload.p_period_start).toBe('2026-08-24');
    expect(payload.p_period_end).toBe('2026-08-30');
    expect(payload.p_adjustment_hours).toBe(0.5);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'abababab-abab-4bab-8bab-abababababab', actual_hours: 8.5, source_count: 2 }]) });
  });

  await signInAsOfficer(page, '/officer/timesheet');
  await page.getByLabel('Period start').fill('2026-08-24');
  await page.getByLabel('Period end').fill('2026-08-30');
  await page.getByLabel('Period end').blur();
  await expect(page.getByText(/Derived work: 8.5 hours across 2 records/)).toBeVisible();
  await expect(page.getByText(/Night patrol · completed · 480 minutes/)).toBeVisible();
  await expect(page.getByText(/Alarm response · partial · 30 minutes/)).toBeVisible();
  await page.getByLabel('Payroll adjustment hours').fill('0.5');
  await page.getByRole('button', { name: 'Submit derived hours for approval' }).click();
  await expect(page.getByRole('status')).toContainText('8.5 hours from 2 work records');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});