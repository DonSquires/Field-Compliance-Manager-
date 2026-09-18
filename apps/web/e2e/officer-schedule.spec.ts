import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

test('officer standby keeps safety available and exposes only self-service work', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer');

  await expect(page.getByRole('heading', { name: 'Standby' })).toBeVisible();
  await expect(page.getByText('No shift assigned', { exact: true })).toBeVisible();
  await expect(page.getByText('You are not currently rostered for a shift. Contact your supervisor if this is incorrect.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check in now' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'SOS' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^My schedule/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Vehicle lookup/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^My credentials/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Field report/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Request leave/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Submit timesheet/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Patrol/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Dispatch/ })).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('officer standby keeps self-service and safety available when shift status cannot load', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/shifts**', async (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Roster service is unavailable.' }) }));
  await signInAsOfficer(page, '/officer');

  await expect(page.getByRole('alert')).toContainText('Roster service is unavailable.');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check in now' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^My schedule/ })).toBeVisible();
  expect(browserErrors.filter((error) => !error.includes('Roster service is unavailable.') && !error.includes('status of 500'))).toEqual([]);
});

test('an assigned urgent dispatch job is the officer’s first next action from home', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer');

  const nextJob = page.locator('.officer-next-job');
  await expect(nextJob).toContainText('Alarm response');
  await expect(nextJob).toContainText('Civic Operations Centre');
  await expect(nextJob.getByRole('button', { name: 'Open and acknowledge job' })).toBeVisible();
  await nextJob.getByRole('button', { name: 'Open and acknowledge job' }).click();
  await expect(page).toHaveURL(/\/officer\/dispatch$/);
  await expect(page.getByRole('heading', { name: 'Dispatch' })).toBeVisible();
  await expect(page.locator('#officer-dispatch-cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toContainText('Civic Operations Centre');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('officer schedule and coverage claim are visually correct and operational', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page);
  await expect(page.getByRole('heading', { name: 'My schedule' })).toBeVisible();
  await expect(page.getByText('North district patrol')).toBeVisible();
  const internalAssignment = page.getByText('Roster Administration', { exact: true }).locator('..').locator('..');
  await expect(internalAssignment).toBeVisible();
  await internalAssignment.getByRole('button', { name: 'Decline' }).click();
  const responseDialog = page.getByRole('dialog', { name: 'Decline assignment?' });
  await expect(responseDialog.getByRole('button', { name: 'Confirm decline' })).toBeDisabled();
  await responseDialog.getByLabel('Decline reason').fill('Unavailable due to approved training commitment.');
  await expect(responseDialog).toHaveScreenshot('officer-schedule-decline-dialog.png');
  await responseDialog.getByRole('button', { name: 'Confirm decline' }).click();
  await expect(page.getByText('Assignment declined with your recorded reason.')).toBeVisible();
  const receipt = page.getByRole('region', { name: 'Assignment ownership receipt' });
  await expect(receipt).toContainText('Roster slot 55555555 · workforce assignment');
  await receipt.getByRole('button', { name: 'Dismiss receipt' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.officer-schedule')).toHaveScreenshot('officer-schedule-assigned.png');

  await page.getByRole('tab', { name: /Open coverage/ }).click();
  await expect(page.getByText('Civic Events Centre')).toBeVisible();
  await page.getByRole('button', { name: 'Review claim' }).click();
  const dialog = page.getByRole('dialog', { name: 'Claim this shift?' });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds && viewport && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height).toBe(true);
  await expect(dialog).toHaveScreenshot('officer-schedule-claim-dialog.png');
  await dialog.getByRole('button', { name: 'Confirm claim' }).click();
  await expect(page.getByText('Coverage claim confirmed.')).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('linked assignment acceptance returns the shared roster and shift identity', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page);
  const fieldAssignment = page.getByText('North district patrol').locator('..').locator('..');
  await fieldAssignment.getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('dialog', { name: 'Accept assignment?' }).getByRole('button', { name: 'Confirm acceptance' }).click();

  const receipt = page.getByRole('region', { name: 'Assignment ownership receipt' });
  await expect(receipt).toContainText('accepted');
  await expect(receipt).toContainText('Roster slot 33333333 · field shift 66666666 accepted');
  await expect(page.getByText('Assignment accepted and confirmed.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('coverage finalization notification opens the exact roster assignment', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/schedule?slot=96969696-9696-4696-8696-969696969696');

  const assignment = page.locator('#officer-roster-slot-96969696-9696-4696-8696-969696969696');
  await expect(assignment).toHaveClass(/is-context-focus/);
  await expect(assignment).toContainText('Claimed festival patrol');
  await expect(assignment.getByText('published', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('active shift records and closes a governed rest break', async ({ page }) => {
  await page.route('**/rest/v1/shifts**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '12121212-1212-4212-8212-121212121212', service_type: 'patrol', scheduled_start: '2026-08-30T08:00:00.000Z', scheduled_end: '2026-08-30T16:00:00.000Z', status: 'in_progress', notes: 'Active patrol', shift_health: 'on_track', total_stops: 2 }]) });
  });
  await page.route('**/rest/v1/rpc/get_shift_break_entitlement', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ worked_hours: 4, rest_breaks_required: 1, meal_breaks_required: 1, rest_breaks_taken: 0, meal_breaks_taken: 0, compliant: false }]) });
  });
  await page.route('**/rest/v1/shift_breaks**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  await page.route('**/rest/v1/rpc/start_shift_break', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: '13131313-1313-4313-8313-131313131313', shift_id: '12121212-1212-4212-8212-121212121212', break_type: 'rest', started_at: '2026-08-30T10:00:00.000Z' }) });
  });
  await page.route('**/rest/v1/rpc/end_shift_break', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: '13131313-1313-4313-8313-131313131313', shift_id: '12121212-1212-4212-8212-121212121212', break_type: 'rest', started_at: '2026-08-30T10:00:00.000Z', ended_at: '2026-08-30T10:10:00.000Z' }) });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await expect(page.getByRole('button', { name: 'Start rest break' })).toBeVisible();
  await page.getByRole('button', { name: 'Start rest break' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Rest break started and recorded.' })).toBeVisible();
  await page.getByRole('button', { name: 'End rest break' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Break ended and duration recorded.' })).toBeVisible();
});

test('officer submits an open shift-swap request with a reason', async ({ page }) => {
  await page.route('**/rest/v1/rpc/request_shift_swap', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '14141414-1414-4414-8414-141414141414', status: 'pending', swap_type: 'open' }]) });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.locator('.officer-assigned-shift').first().getByRole('button', { name: 'Request swap' }).click();
  const dialog = page.getByRole('dialog', { name: 'Request shift swap?' });
  await dialog.getByLabel('Reason').fill('Approved family commitment prevents me working this assignment.');
  await dialog.getByRole('button', { name: 'Submit swap request' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Open shift swap request submitted for roster review.' })).toBeVisible();
});

test('officer requests a direct swap with an eligible replacement officer', async ({ page }) => {
  await page.route('**/rest/v1/staff_profiles**', async (route) => {
    const select = new URL(route.request().url()).searchParams.get('select') ?? '';
    const body = select.includes('user_id') ? [{ id: '22222222-2222-4222-8222-222222222222', user_id: '22222222-2222-4222-8222-222222222222', work_ready: true }, { id: '2f2f2f2f-2222-4222-8222-222222222222', user_id: '2f2f2f2f-2222-4222-8222-222222222222', work_ready: true }] : { id: '22222222-2222-4222-8222-222222222222' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/rest/v1/user_profiles**', async (route) => {
    const select = new URL(route.request().url()).searchParams.get('select') ?? '';
    const requestedId = new URL(route.request().url()).searchParams.get('id') ?? '';
    const body = requestedId.includes('22222222-2222-4222-8222-222222222222') ? [{ id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata', email: 'ana@fcm.test', role: 'officer', organization_id: '33333333-3333-4333-8333-333333333333' }] : [{ id: '2f2f2f2f-2222-4222-8222-222222222222', display_name: 'Jordan Lee', email: 'jordan@fcm.test' }];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/rest/v1/rpc/request_shift_swap', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload.p_swap_type).toBe('direct');
    expect(payload.p_swap_with_staff_id).toBe('2f2f2f2f-2222-4222-8222-222222222222');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '15151515-1515-4515-8515-151515151515', status: 'pending', swap_type: 'direct' }]) });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.locator('.officer-assigned-shift').first().getByRole('button', { name: 'Request swap' }).click();
  const dialog = page.getByRole('dialog', { name: 'Request shift swap?' });
  await dialog.getByLabel('Replacement officer (optional)').selectOption('2f2f2f2f-2222-4222-8222-222222222222');
  await dialog.getByLabel('Reason').fill('Jordan agreed to cover this assignment.');
  await dialog.getByRole('button', { name: 'Submit swap request' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Direct shift swap request submitted for roster review.' })).toBeVisible();
});

test('officer starts an accepted shift with GPS attendance evidence', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: -41.274, longitude: 173.283 });
  await page.route('**/rest/v1/rpc/start_officer_shift', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload.p_gps_lat).toBe(-41.274);
    expect(payload.p_gps_lng).toBe(173.283);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ shift_id: '66666666-6666-4666-8666-666666666666', shift_status: 'in_progress', started_at: '2026-08-30T09:30:00.000Z', created: true }]) });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.locator('.officer-assigned-shift').first().getByRole('button', { name: 'Start shift' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Shift started at' })).toBeVisible();
});

test('officer sees and reads a roster change notification', async ({ page }) => {
  await page.route('**/rest/v1/notifications**', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '16161616-1616-4616-8616-161616161616' }]) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '16161616-1616-4616-8616-161616161616', category: 'roster', severity: 'warning', title: 'Roster assignment updated', body: 'Your North District Patrol shift has changed.', link_page: 'schedule', link_payload: { shift_id: '66666666-6666-4666-8666-666666666666' }, read_at: null, created_at: '2026-08-30T09:20:00.000Z' }]) });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByTitle(/notifications/i).click();
  const panel = page.getByRole('region', { name: 'Notifications' });
  await expect(panel).toContainText('Roster assignment updated');
  await panel.getByRole('tab', { name: 'unread' }).click();
  await panel.getByRole('button', { name: /Roster assignment updated/ }).click();
});