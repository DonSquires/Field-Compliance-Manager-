import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, signInAsOfficer } from './fixtures';

test.use({ timezoneId: 'UTC' });

const work = (label: string, minutes: number) => [{
  source_type: 'shift',
  source_id: '12121212-1212-4212-8212-121212121212',
  work_status: 'completed',
  started_at: '2026-08-26T08:00:00.000Z',
  ended_at: '2026-08-26T16:00:00.000Z',
  calculated_minutes: minutes,
  label,
  metadata: {},
}];

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
  await page.route('**/rest/v1/timesheets**', async (route) => {
    await route.fulfill({ status: 200, json: [] });
  });
});

test('a late response cannot replace the selected period preview', async ({ page }) => {
  let releaseEarlier!: () => void;
  let signalEarlierRequested!: () => void;
  let signalEarlierFinished!: () => void;
  const earlierRequested = new Promise<void>((resolve) => { signalEarlierRequested = resolve; });
  const earlierFinished = new Promise<void>((resolve) => { signalEarlierFinished = resolve; });
  const holdEarlier = new Promise<void>((resolve) => { releaseEarlier = resolve; });

  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    const request = route.request().postDataJSON() as { p_period_start: string; p_period_end: string };
    if (request.p_period_start === '2026-08-25' && request.p_period_end === '2026-08-29') {
      signalEarlierRequested();
      await holdEarlier;
      await route.fulfill({ status: 200, json: work('Earlier patrol', 60) });
      signalEarlierFinished();
      return;
    }
    const latest = request.p_period_start === '2026-08-26' && request.p_period_end === '2026-08-29';
    await route.fulfill({ status: 200, json: latest ? work('Current patrol', 120) : work('Initial patrol', 480) });
  });

  await signInAsOfficer(page, '/officer/timesheet');
  await page.getByLabel('To').fill('2026-08-29');
  await expect(page.getByText('Initial patrol', { exact: true })).toBeVisible();
  await page.getByLabel('From').fill('2026-08-25');
  await earlierRequested;
  await page.getByLabel('From').fill('2026-08-26');
  await expect(page.getByText('Current patrol', { exact: true })).toBeVisible();
  releaseEarlier();
  await earlierFinished;
  await expect(page.getByText('Earlier patrol', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Current patrol', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send for approval' })).toBeEnabled();
});

test('a failed preview hides old work and must be retried before sending', async ({ page }) => {
  let failSelectedPeriod = true;
  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    const request = route.request().postDataJSON() as { p_period_start: string };
    if (request.p_period_start === '2026-08-26' && failSelectedPeriod) {
      await route.fulfill({ status: 503, json: { message: 'Unavailable' } });
      return;
    }
    await route.fulfill({ status: 200, json: work(request.p_period_start === '2026-08-26' ? 'Retried patrol' : 'Old patrol', 480) });
  });

  await signInAsOfficer(page, '/officer/timesheet');
  await page.getByLabel('To').fill('2026-08-29');
  await expect(page.getByText('Old patrol', { exact: true })).toBeVisible();
  await page.getByLabel('From').fill('2026-08-26');
  await expect(page.getByText(/could not load.*finished work/i)).toBeVisible();
  await expect(page.getByText('Old patrol', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send for approval' })).toBeDisabled();
  failSelectedPeriod = false;
  await page.getByRole('button', { name: 'Retry work preview' }).click();
  await expect(page.getByText('Retried patrol', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send for approval' })).toBeEnabled();
});

test('a malformed preview is not presented as an empty period', async ({ page }) => {
  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    await route.fulfill({ status: 200, json: null });
  });

  await signInAsOfficer(page, '/officer/timesheet');
  await expect(page.getByText(/could not load.*finished work/i)).toBeVisible();
  await expect(page.getByText('No finished shifts in this period yet.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send for approval' })).toBeDisabled();
});

test('submission retries keep their identity only while the inputs are unchanged', async ({ page }) => {
  const eventIds: string[] = [];
  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    await route.fulfill({ status: 200, json: work('Current patrol', 480) });
  });
  await page.route('**/rest/v1/rpc/submit_officer_timesheet_from_work', async (route) => {
    const request = route.request().postDataJSON() as { p_client_event_id: string };
    eventIds.push(request.p_client_event_id);
    if (eventIds.length < 3) {
      await route.fulfill({ status: 503, json: { message: 'Unavailable' } });
    } else {
      await route.fulfill({ status: 200, json: [{ id: 'abababab-abab-4bab-8bab-abababababab', actual_hours: 8, source_count: 1 }] });
    }
  });

  await signInAsOfficer(page, '/officer/timesheet');
  await expect(page.getByText('Current patrol', { exact: true })).toBeVisible();
  const send = page.getByRole('button', { name: 'Send for approval' });
  await send.click();
  await expect(page.getByText(/receipt was not confirmed/i)).toBeVisible();
  await send.click();
  await expect.poll(() => eventIds.length).toBe(2);
  await page.getByLabel('Anything payroll should know').fill('Revised handover note');
  await send.click();
  await expect(page.getByRole('status').filter({ hasText: 'Timesheet sent for approval' })).toBeVisible();
  expect(eventIds[1]).toBe(eventIds[0]);
  expect(eventIds[2]).not.toBe(eventIds[0]);
});

test('a sent receipt remains clear when the timesheet list fails to refresh', async ({ page }) => {
  let listState: 'initial' | 'failed' | 'recovered' = 'initial';
  let releaseRefresh!: () => void;
  let signalRefresh!: () => void;
  const refreshing = new Promise<void>((resolve) => { signalRefresh = resolve; });
  const holdRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  await page.route('**/rest/v1/timesheets**', async (route) => {
    if (listState === 'failed') {
      signalRefresh();
      await holdRefresh;
      await route.fulfill({ status: 400, json: { message: 'Unavailable' } });
    } else {
      await route.fulfill({ status: 200, json: listState === 'initial' ? [] : [{
        id: 'abababab-abab-4bab-8bab-abababababab',
        period_start: '2026-08-24',
        period_end: '2026-08-29',
        scheduled_hours: 8,
        actual_hours: 8,
        overtime_hours: 0,
        status: 'submitted',
        review_notes: null,
        approved_at: null,
        submitted_at: '2026-08-29T09:30:00Z',
      }] });
    }
  });
  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    await route.fulfill({ status: 200, json: work('Current patrol', 480) });
  });
  await page.route('**/rest/v1/rpc/submit_officer_timesheet_from_work', async (route) => {
    listState = 'failed';
    await route.fulfill({ status: 200, json: [{ id: 'abababab-abab-4bab-8bab-abababababab', actual_hours: 8, source_count: 1 }] });
  });

  await signInAsOfficer(page, '/officer/timesheet');
  await page.getByLabel('To').fill('2026-08-29');
  await expect(page.getByText('Current patrol', { exact: true })).toBeVisible();
  await expect(page.getByText(/Nothing sent yet/)).toBeVisible();
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Timesheet sent for approval' })).toBeVisible();
  await refreshing;
  await expect(page.getByText('Refreshing the timesheet list…')).toBeVisible();
  await expect(page.getByText(/Nothing sent yet/)).toHaveCount(0);
  releaseRefresh();
  await expect(page.getByText(/timesheet was sent, but the list could not be refreshed/i)).toBeVisible();
  await expect(page.getByText(/Nothing sent yet/)).toHaveCount(0);
  listState = 'recovered';
  await page.getByRole('button', { name: 'Retry timesheet list' }).click();
  await expect(page.locator('#officer-timesheet-abababab-abab-4bab-8bab-abababababab')).toContainText('Waiting for review');
});

test('a correction with a lost receipt refreshes its current status before retry', async ({ page }) => {
  let status = 'rejected';
  await page.route('**/rest/v1/timesheets**', async (route) => {
    await route.fulfill({ status: 200, json: [{
      id: '38383838-3838-4838-8838-383838383838',
      period_start: '2026-08-24',
      period_end: '2026-08-29',
      scheduled_hours: 8,
      actual_hours: 8,
      overtime_hours: 0,
      status,
      review_notes: null,
      approved_at: null,
      submitted_at: '2026-08-29T09:30:00Z',
    }] });
  });
  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    await route.fulfill({ status: 200, json: work('Current patrol', 480) });
  });
  await page.route('**/rest/v1/rpc/resubmit_rejected_timesheet_from_work', async (route) => {
    status = 'submitted';
    await route.fulfill({ status: 503, json: { message: 'Receipt unavailable' } });
  });

  await signInAsOfficer(page, '/officer/timesheet');
  await expect(page.getByText('Current patrol', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send corrected timesheet' }).click();
  await expect(page.getByText(/correction receipt was not confirmed/i)).toBeVisible();
  await expect(page.locator('#officer-timesheet-38383838-3838-4838-8838-383838383838')).toContainText('Waiting for review');
  await expect(page.getByRole('button', { name: 'Send for approval' })).toBeDisabled();
  await expect(page.getByText('Timesheet sent for approval', { exact: false })).toHaveCount(0);
});

test('a correction cannot be retried while its current status is unavailable', async ({ page }) => {
  let listState: 'initial' | 'failed' | 'missing' | 'recovered' = 'initial';
  const timesheet = {
    id: 'abababab-abab-4bab-8bab-abababababab', period_start: '2026-08-24', period_end: '2026-08-29',
    scheduled_hours: 8, actual_hours: 8, overtime_hours: 0, review_notes: 'Clarify the handover',
    approved_at: null, submitted_at: '2026-08-29T09:30:00Z',
  };
  await page.route('**/rest/v1/timesheets**', async (route) => {
    if (listState === 'failed') {
      await route.fulfill({ status: 400, json: { message: 'Unavailable' } });
    } else if (listState === 'missing') {
      await route.fulfill({ status: 200, json: [] });
    } else {
      await route.fulfill({ status: 200, json: [{ ...timesheet, status: listState === 'initial' ? 'rejected' : 'submitted' }] });
    }
  });
  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    await route.fulfill({ status: 200, json: work('Current patrol', 480) });
  });
  await page.route('**/rest/v1/rpc/resubmit_rejected_timesheet_from_work', async (route) => {
    listState = 'failed';
    await route.fulfill({ status: 503, json: { message: 'Receipt unavailable' } });
  });

  await signInAsOfficer(page, '/officer/timesheet');
  await expect(page.getByRole('button', { name: 'Send corrected timesheet' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send corrected timesheet' }).click();
  await expect(page.getByText(/correction receipt was not confirmed.*list could not be refreshed/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send corrected timesheet' })).toBeDisabled();
  listState = 'missing';
  await page.getByRole('button', { name: 'Retry timesheet list' }).click();
  await expect(page.getByText(/unconfirmed correction could not be found/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send corrected timesheet' })).toBeDisabled();
  listState = 'recovered';
  await page.getByRole('button', { name: 'Retry timesheet list' }).click();
  await expect(page.locator('#officer-timesheet-abababab-abab-4bab-8bab-abababababab')).toContainText('Waiting for review');
  await expect(page.getByRole('button', { name: 'Send for approval' })).toBeDisabled();
  await expect(page.getByText('Timesheet sent for approval', { exact: false })).toHaveCount(0);
});

test('a timesheet cannot be sent until the existing list has loaded', async ({ page }) => {
  let listAvailable = false;
  await page.route('**/rest/v1/timesheets**', async (route) => {
    if (listAvailable) {
      await route.fulfill({ status: 200, json: [] });
    } else {
      await route.fulfill({ status: 400, json: { message: 'Unavailable' } });
    }
  });
  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    await route.fulfill({ status: 200, json: work('Current patrol', 480) });
  });

  await signInAsOfficer(page, '/officer/timesheet');
  await expect(page.getByText('Current patrol', { exact: true })).toBeVisible();
  await expect(page.getByText('Your timesheet list is unavailable.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send for approval' })).toBeDisabled();
  await expect(page.getByText(/Nothing sent yet/)).toHaveCount(0);
  listAvailable = true;
  await page.getByRole('button', { name: 'Retry timesheet list' }).click();
  await expect(page.getByRole('button', { name: 'Send for approval' })).toBeEnabled();
});

test('a linked staff profile with a different ID still shows the officer’s timesheet', async ({ page }) => {
  const officerId = '22222222-2222-4222-8222-222222222222';
  const organizationId = '33333333-3333-4333-8333-333333333333';
  const staffId = '45454545-4545-4545-8545-454545454545';
  let staffFilter = '';
  let staffOrganization = '';
  let timesheetFilter = '';
  let timesheetOrganization = '';
  await page.route('**/rest/v1/staff_profiles**', async (route) => {
    const url = new URL(route.request().url());
    staffFilter = url.searchParams.get('or') ?? '';
    staffOrganization = url.searchParams.get('organization_id') ?? '';
    await route.fulfill({ status: 200, json: [{ id: staffId }] });
  });
  await page.route('**/rest/v1/timesheets**', async (route) => {
    const url = new URL(route.request().url());
    timesheetFilter = url.searchParams.get('staff_id') ?? '';
    timesheetOrganization = url.searchParams.get('organization_id') ?? '';
    await route.fulfill({ status: 200, json: timesheetFilter === `in.(${staffId})` ? [{
      id: 'abababab-abab-4bab-8bab-abababababab', period_start: '2026-08-24', period_end: '2026-08-29',
      scheduled_hours: 8, actual_hours: 8, overtime_hours: 0, status: 'rejected', review_notes: null,
      approved_at: null, submitted_at: '2026-08-29T09:30:00Z',
    }] : [] });
  });
  await page.route('**/rest/v1/rpc/get_officer_timesheet_work', async (route) => {
    await route.fulfill({ status: 200, json: work('Current patrol', 480) });
  });

  await signInAsOfficer(page, '/officer/timesheet');
  await expect(page.getByRole('button', { name: 'Send corrected timesheet' })).toBeEnabled();
  expect(staffFilter).toContain(`id.eq.${officerId}`);
  expect(staffFilter).toContain(`user_id.eq.${officerId}`);
  expect(staffOrganization).toBe(`eq.${organizationId}`);
  expect(timesheetFilter).toBe(`in.(${staffId})`);
  expect(timesheetOrganization).toBe(`eq.${organizationId}`);
});
