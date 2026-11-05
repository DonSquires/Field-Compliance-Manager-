import { expect, test, type Page } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installOfficerScheduleFixtures(page);
});

async function installOverdueShift(page: Page, openStops: boolean, openDispatch = false) {
  const shift = {
    id: '45454545-4545-4454-8454-454545454545', service_type: 'patrol', status: 'in_progress',
    scheduled_start: '2026-08-27T20:00:00.000Z', scheduled_end: '2026-08-28T04:00:00.000Z',
    shift_health: 'on_track', total_stops: openStops ? 1 : 0, ended_reason: null,
  };
  const queries: URLSearchParams[] = [];
  const actions: Array<{ name: string; args: Record<string, unknown> }> = [];
  let active = true;
  await page.route('**/rest/v1/shifts**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (!query.get('select')?.includes('shift_health') || !query.has('scheduled_end')) return route.fallback();
    queries.push(query);
    await route.fulfill({ json: query.get('scheduled_end')?.startsWith('lt.') && active ? [shift] : [] });
  });
  await page.route('**/rest/v1/rpc/get_shift_end_readiness', async (route) => {
    expect(route.request().postDataJSON().p_shift_id).toBe(shift.id);
    await route.fulfill({ json: {
      shift_id: shift.id, status: shift.status, service_type: shift.service_type,
      scheduled_end: shift.scheduled_end, actual_start: shift.scheduled_start,
      open_stops: openStops ? [{ stop_id: 'stop-1', place: 'Test place', status: 'pending', module_key: 'general_patrol' }] : [],
      open_stop_count: openStops ? 1 : 0, open_required_task_count: 0,
      open_dispatch_job_count: openDispatch ? 1 : 0, active_welfare_alert_count: 0, debrief_submitted: false,
      blockers: openStops ? ['One stop remains open'] : openDispatch ? ['One dispatch job remains open'] : ['The debrief has not been recorded'],
      can_end: false, can_end_after_debrief: !openStops && !openDispatch,
    } });
  });
  await page.route('**/rest/v1/rpc/submit_shift_debrief', async (route) => {
    actions.push({ name: 'debrief', args: route.request().postDataJSON() });
    await route.fulfill({ json: [{ id: 'debrief-receipt', created: true, submitted_at: '2026-08-29T21:30:00.000Z' }] });
  });
  await page.route('**/rest/v1/rpc/complete_officer_shift', async (route) => {
    actions.push({ name: 'end', args: route.request().postDataJSON() });
    active = false;
    await route.fulfill({ json: [{ shift_id: shift.id, shift_status: 'completed', completed_at: '2026-08-29T21:30:00.000Z' }] });
  });
  await page.route('**/rest/v1/rpc/get_officer_patrol_stops', async (route) => {
    actions.push({ name: 'raw-stops', args: route.request().postDataJSON() });
    await route.fulfill({ json: null });
  });
  return { shift, queries, actions };
}

test('an overdue active shift can be found, debriefed and ended without loading its briefing notes', async ({ page }) => {
  const fixture = await installOverdueShift(page, false);
  await signInAsOfficer(page, '/officer/schedule');
  await expect(page.getByText('Briefing notes are not shown here; ask operations.')).toBeVisible();
  const overdueQuery = fixture.queries.find((query) => query.get('scheduled_end')?.startsWith('lt.'));
  expect(overdueQuery?.get('officer_user_id')).toBe('eq.22222222-2222-4222-8222-222222222222');
  expect(overdueQuery?.get('status')).toBe('eq.in_progress');
  expect(overdueQuery?.get('select')?.split(',')).not.toContain('notes');
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  await dialog.getByLabel('How did the shift go?').fill('Patrol completed and equipment returned.');
  await dialog.getByRole('button', { name: 'Record debrief and end shift' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Shift ended at' })).toBeVisible();
  expect(fixture.actions.map((action) => action.name)).toEqual(['debrief', 'end']);
  expect(fixture.actions[0].args.p_shift_id).toBe(fixture.shift.id);
  expect(fixture.actions[1].args).toMatchObject({ p_shift_id: fixture.shift.id, p_expected_status: 'in_progress' });
});

test('a saved overdue debrief stays recorded when ending the shift fails and is retried', async ({ page }) => {
  const fixture = await installOverdueShift(page, false);
  let debriefs = 0;
  let endAttempts = 0;
  await page.route('**/rest/v1/rpc/submit_shift_debrief', async (route) => {
    debriefs += 1;
    await route.fulfill({ json: [{ id: 'debrief-receipt', created: true, submitted_at: '2026-08-29T21:30:00.000Z' }] });
  });
  await page.route('**/rest/v1/rpc/get_shift_end_readiness', async (route) => {
    await route.fulfill({ json: {
      shift_id: fixture.shift.id, status: 'in_progress', service_type: 'patrol',
      scheduled_end: fixture.shift.scheduled_end, actual_start: fixture.shift.scheduled_start,
      open_stops: [], open_stop_count: 0, open_required_task_count: 0, open_dispatch_job_count: 0,
      active_welfare_alert_count: 0, debrief_submitted: debriefs > 0, blockers: [],
      can_end: debriefs > 0, can_end_after_debrief: true,
    } });
  });
  await page.route('**/rest/v1/rpc/complete_officer_shift', async (route) => {
    endAttempts += 1;
    if (endAttempts === 1) return route.fulfill({ status: 409, json: { message: 'Temporary end failure' } });
    await route.fulfill({ json: [{ shift_id: fixture.shift.id, shift_status: 'completed', completed_at: '2026-08-29T21:30:00.000Z' }] });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  await dialog.getByLabel('How did the shift go?').fill('Patrol completed and equipment returned.');
  await dialog.getByRole('button', { name: 'Record debrief and end shift' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your debrief was recorded');
  await expect(dialog.getByRole('alert')).toContainText('The shift end could not be confirmed');
  await expect(dialog.getByRole('alert')).toContainText('Temporary end failure');
  await expect(dialog.getByText('Debrief recorded', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'End shift' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Shift ended at' })).toBeVisible();
  expect(debriefs).toBe(1);
  expect(endAttempts).toBe(2);
});

test('an overdue shift status refresh failure offers a retry without hiding the end failure', async ({ page }, testInfo) => {
  if (testInfo.project.name.includes('mobile')) await page.setViewportSize({ width: 320, height: 600 });
  const fixture = await installOverdueShift(page, false);
  let debriefSubmitted = false;
  let statusAvailable = true;
  await page.route('**/rest/v1/rpc/submit_shift_debrief', async (route) => {
    debriefSubmitted = true;
    await route.fulfill({ json: [{ id: 'debrief-receipt', created: true, submitted_at: '2026-08-29T21:30:00.000Z' }] });
  });
  await page.route('**/rest/v1/rpc/get_shift_end_readiness', async (route) => {
    if (!statusAvailable) return route.fulfill({ status: 503, json: { message: 'Status temporarily unavailable' } });
    await route.fulfill({ json: {
      shift_id: fixture.shift.id, status: 'in_progress', service_type: 'patrol',
      scheduled_end: fixture.shift.scheduled_end, actual_start: fixture.shift.scheduled_start,
      open_stops: [], open_stop_count: 0, open_required_task_count: 0, open_dispatch_job_count: 0,
      active_welfare_alert_count: 0, debrief_submitted: debriefSubmitted, blockers: [],
      can_end: debriefSubmitted, can_end_after_debrief: true,
    } });
  });
  await page.route('**/rest/v1/rpc/complete_officer_shift', async (route) => {
    statusAvailable = false;
    await route.fulfill({ status: 503, json: { message: 'End temporarily unavailable' } });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  await dialog.getByLabel('How did the shift go?').fill('Patrol completed and equipment returned.');
  await dialog.getByRole('button', { name: 'Record debrief and end shift' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your debrief was recorded');
  await expect(dialog.getByRole('alert')).toContainText('End temporarily unavailable');
  await expect(dialog.getByRole('alert')).toContainText('Status temporarily unavailable');
  await expect(dialog.getByText('Checking what is still open…')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'End shift' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Check again' })).toBeVisible();
  const alertIcon = await dialog.getByRole('alert').locator('svg').boundingBox();
  expect(alertIcon && alertIcon.width >= 14).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('overdue-end-unconfirmed.png') });
  statusAvailable = true;
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await expect(dialog.getByText('Debrief recorded', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'End shift' })).toBeEnabled();
});

test('an unconfirmed debrief is retried with the same event before ending an overdue shift', async ({ page }) => {
  const fixture = await installOverdueShift(page, false);
  const eventIds: string[] = [];
  const summaries: string[] = [];
  let endAttempts = 0;
  await page.route('**/rest/v1/rpc/submit_shift_debrief', async (route) => {
    eventIds.push(route.request().postDataJSON().p_client_event_id);
    summaries.push(route.request().postDataJSON().p_summary);
    await route.fulfill({ json: eventIds.length === 1 ? [] : [{ id: 'debrief-receipt', created: false, submitted_at: '2026-08-29T21:30:00.000Z' }] });
  });
  await page.route('**/rest/v1/rpc/complete_officer_shift', async (route) => {
    endAttempts += 1;
    await route.fulfill({ json: [{ shift_id: fixture.shift.id, shift_status: 'completed', completed_at: '2026-08-29T21:30:00.000Z' }] });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  await dialog.getByLabel('How did the shift go?').fill('Patrol completed and equipment returned.');
  await dialog.getByRole('button', { name: 'Record debrief and end shift' }).click();
  await expect(dialog.getByRole('alert')).toContainText('The debrief could not be confirmed');
  await expect(dialog.getByLabel('How did the shift go?')).toBeDisabled();
  expect(endAttempts).toBe(0);
  await dialog.getByRole('button', { name: 'Record debrief and end shift' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Shift ended at' })).toBeVisible();
  expect(eventIds).toHaveLength(2);
  expect(eventIds[1]).toBe(eventIds[0]);
  expect(summaries[1]).toBe(summaries[0]);
  expect(endAttempts).toBe(1);
});

test('a rejected overdue debrief can be corrected before retrying', async ({ page }) => {
  const fixture = await installOverdueShift(page, false);
  let attempts = 0;
  await page.route('**/rest/v1/rpc/submit_shift_debrief', async (route) => {
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 400, json: { code: 'P0001', message: 'Please correct the debrief' } });
    expect(route.request().postDataJSON().p_summary).toBe('Corrected debrief after the rejection.');
    await route.fulfill({ json: [{ id: 'debrief-receipt', created: true, submitted_at: '2026-08-29T21:30:00.000Z' }] });
  });
  await page.route('**/rest/v1/rpc/complete_officer_shift', async (route) => {
    await route.fulfill({ json: [{ shift_id: fixture.shift.id, shift_status: 'completed', completed_at: '2026-08-29T21:30:00.000Z' }] });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  const summary = dialog.getByLabel('How did the shift go?');
  await summary.fill('An initial debrief with enough detail.');
  await dialog.getByRole('button', { name: 'Record debrief and end shift' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Correct the issue before trying again');
  await expect(summary).toBeEnabled();
  await summary.fill('Corrected debrief after the rejection.');
  await dialog.getByRole('button', { name: 'Record debrief and end shift' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Shift ended at' })).toBeVisible();
  expect(attempts).toBe(2);
});

test('a completion receipt for another shift is not shown as a successful end', async ({ page }) => {
  const fixture = await installOverdueShift(page, false);
  await page.route('**/rest/v1/rpc/complete_officer_shift', async (route) => {
    expect(route.request().postDataJSON().p_shift_id).toBe(fixture.shift.id);
    await route.fulfill({ json: [{ shift_id: 'a-different-shift', shift_status: 'completed', completed_at: '2026-08-29T21:30:00.000Z' }] });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  await dialog.getByLabel('How did the shift go?').fill('Patrol completed and equipment returned.');
  await dialog.getByRole('button', { name: 'Record debrief and end shift' }).click();
  await expect(dialog.getByRole('alert')).toContainText('The shift end could not be confirmed');
  await expect(page.getByRole('status').filter({ hasText: 'Shift ended at' })).toHaveCount(0);
});

test('wrong-shift and malformed readiness responses cannot enable ending an overdue shift', async ({ page }) => {
  const fixture = await installOverdueShift(page, false);
  let responseKind: 'wrong-shift' | 'malformed' | 'valid' = 'wrong-shift';
  await page.route('**/rest/v1/rpc/get_shift_end_readiness', async (route) => {
    await route.fulfill({ json: {
      shift_id: responseKind === 'wrong-shift' ? 'a-different-shift' : fixture.shift.id,
      status: 'in_progress', service_type: 'patrol', scheduled_end: fixture.shift.scheduled_end,
      actual_start: fixture.shift.scheduled_start, open_stops: responseKind === 'malformed' ? null : [],
      open_stop_count: 0, open_required_task_count: 0, open_dispatch_job_count: 0,
      active_welfare_alert_count: 0, debrief_submitted: false, blockers: [],
      can_end: false, can_end_after_debrief: true,
    } });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  await expect(dialog.getByRole('alert')).toContainText('Shift status could not be confirmed');
  await expect(dialog.getByLabel('How did the shift go?')).toHaveCount(0);
  responseKind = 'malformed';
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Shift status could not be confirmed');
  await expect(dialog.getByLabel('How did the shift go?')).toHaveCount(0);
  responseKind = 'valid';
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await expect(dialog.getByLabel('How did the shift go?')).toBeVisible();
  expect(fixture.actions).toEqual([]);
});

test('an overdue shift with open stops directs the officer to operations instead of another shift', async ({ page }, testInfo) => {
  if (testInfo.project.name.includes('mobile')) await page.setViewportSize({ width: 320, height: 600 });
  const fixture = await installOverdueShift(page, true);
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  await expect(dialog.getByRole('status')).toContainText('Contact operations to finish them');
  await dialog.getByRole('status').scrollIntoViewIfNeeded();
  const reason = await dialog.getByRole('status').boundingBox();
  const viewport = page.viewportSize();
  expect(reason && viewport && reason.x >= 0 && reason.x + reason.width <= viewport.width && reason.y >= 0 && reason.y + reason.height <= viewport.height).toBe(true);
  expect(await dialog.getByRole('status').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return topmost === element || (topmost !== null && element.contains(topmost));
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('overdue-open-stops.png') });
  await expect(dialog.getByRole('button', { name: 'Open stops' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Record debrief and end shift' })).toBeDisabled();
  expect(fixture.actions).toEqual([]);
});

test('an overdue shift with open dispatch work directs the officer to operations', async ({ page }) => {
  const fixture = await installOverdueShift(page, false, true);
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  await expect(dialog.getByRole('status')).toContainText('Dispatch jobs for this earlier shift cannot be opened here yet');
  await expect(dialog.getByRole('button', { name: 'Open dispatch' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Record debrief and end shift' })).toBeDisabled();
  expect(fixture.actions).toEqual([]);
});

test('an overdue-shift lookup failure is visible on the schedule', async ({ page }) => {
  await page.route('**/rest/v1/shifts**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('scheduled_end')?.startsWith('lt.')) {
      return route.fulfill({ status: 403, json: { message: 'Unfinished-shift lookup denied' } });
    }
    return route.fallback();
  });
  await signInAsOfficer(page, '/officer/schedule');
  await expect(page.getByRole('alert')).toContainText("We couldn't load unfinished shifts");
});

test('officer standby keeps safety available and exposes only self-service work', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer');

  await expect(page.getByRole('heading', { name: 'Standby' })).toBeVisible();
  await expect(page.getByText('A shift is waiting for your answer', { exact: true })).toBeVisible();
  await expect(page.getByText('Accept or decline it on your schedule.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Answer now' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check in now' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'SOS' })).toBeVisible();
  await page.getByText('More tools, open shifts and status').click();
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
  await page.getByText('More tools, open shifts and status').click();
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
  // A linked field shift is headlined by the work it covers, with the service type and notes underneath.
  const linkedShift = page.locator('#officer-roster-slot-33333333-3333-4333-8333-333333333334');
  await expect(linkedShift.locator('strong', { hasText: 'North District Patrol' })).toBeVisible();
  await expect(linkedShift).toContainText('patrol · 8 planned stops · North district patrol');
  const internalAssignment = page.getByText('Roster Administration', { exact: true }).locator('..').locator('..');
  await expect(internalAssignment).toBeVisible();
  await internalAssignment.getByRole('button', { name: 'Decline' }).click();
  const responseDialog = page.getByRole('dialog', { name: 'Decline assignment?' });
  await expect(responseDialog.getByRole('button', { name: 'Confirm decline' })).toBeDisabled();
  await responseDialog.getByLabel('Decline reason').fill('Unavailable due to approved training commitment.');
  await expect(responseDialog).toHaveScreenshot('officer-schedule-decline-dialog.png');
  await responseDialog.getByRole('button', { name: 'Confirm decline' }).click();
  await expect(page.getByText('Assignment declined with your recorded reason.')).toBeVisible();
  const receipt = page.getByRole('region', { name: 'Roster response recorded' });
  await expect(receipt).toContainText('Roster slot 55555555 · internal work, no field shift');
  await receipt.getByRole('button', { name: 'Dismiss receipt' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.officer-schedule')).toHaveScreenshot('officer-schedule-assigned.png');

  await page.getByRole('tab', { name: /Open coverage/ }).click();
  await expect(page.getByText('Civic Events Centre', { exact: true })).toBeVisible();
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
  const fieldAssignment = page.locator('#officer-roster-slot-33333333-3333-4333-8333-333333333334');
  await fieldAssignment.getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('dialog', { name: 'Accept assignment?' }).getByRole('button', { name: 'Confirm acceptance' }).click();

  const receipt = page.getByRole('region', { name: 'Roster response recorded' });
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
  await expect(assignment.getByText('Waiting for your answer', { exact: true })).toBeVisible();
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

const SOON_SHIFT = { id: '66666666-6666-4666-8666-666666666666', service_type: 'patrol', scheduled_start: '2026-08-29T22:00:00.000Z', scheduled_end: '2026-08-30T06:00:00.000Z', status: 'accepted', notes: 'North district patrol', shift_health: null, total_stops: 8, ended_reason: null };

test('Start shift is offered only from an hour before the rostered start; before that the card says when it opens', async ({ page }) => {
  await signInAsOfficer(page, '/officer/schedule');
  // fixture shift 66666666 starts 2026-08-31T06:00Z, well outside the window at the fixed clock
  const card = page.locator('.officer-assigned-shift').first();
  await expect(card.getByText(/^You can start from Mon, 31 Aug/)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Start shift' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Request swap' })).toBeVisible();
});

test('officer starts an accepted shift with GPS attendance evidence', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: -41.274, longitude: 173.283 });
  await page.route('**/rest/v1/shifts**', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([SOON_SHIFT]) }));
  await page.route('**/rest/v1/rpc/evaluate_shift_start_position', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload.p_gps_lat).toBe(-41.274);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'on_site', place_name: 'Civic Centre', distance_m: 0, advisory_radius_m: 250, route_shift: false }) });
  });
  await page.route('**/rest/v1/rpc/start_officer_shift', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload.p_gps_lat).toBe(-41.274);
    expect(payload.p_gps_lng).toBe(173.283);
    expect(payload.p_off_site_reason).toBeNull();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ shift_id: '66666666-6666-4666-8666-666666666666', shift_status: 'in_progress', started_at: '2026-08-30T09:30:00.000Z', created: true, position_status: 'on_site', place_name: 'Civic Centre', distance_m: 0 }]) });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.locator('.officer-assigned-shift').first().getByRole('button', { name: 'Start shift' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Shift started at' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'at Civic Centre.' })).toBeVisible();
});

test('starting a shift away from its place is advised, not blocked, and the reason travels with the start', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: -41.274, longitude: 173.283 });
  await page.route('**/rest/v1/shifts**', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([SOON_SHIFT]) }));
  await page.route('**/rest/v1/rpc/evaluate_shift_start_position', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'off_site', place_name: 'Civic Centre', distance_m: 3792, advisory_radius_m: 250, route_shift: false }) }));
  let startPayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/rpc/start_officer_shift', async (route) => {
    startPayload = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ shift_id: '66666666-6666-4666-8666-666666666666', shift_status: 'in_progress', started_at: '2026-08-30T09:30:00.000Z', created: true, position_status: 'off_site', place_name: 'Civic Centre', distance_m: 3792 }]) });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.locator('.officer-assigned-shift').first().getByRole('button', { name: 'Start shift' }).click();
  const dialog = page.getByRole('dialog', { name: "You're not at Civic Centre" });
  await expect(dialog.getByText(/You are about 3\.8 km from Civic Centre/)).toBeVisible();
  await expect(dialog.getByText(/You can still start; the start is recorded as away from site/)).toBeVisible();
  expect(startPayload).toBeNull();
  await dialog.getByLabel('Reason (optional)').fill('Starting from the depot, driving to site now.');
  await dialog.getByRole('button', { name: 'Start anyway' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'recorded as away from Civic Centre (about 3.8 km)' })).toBeVisible();
  expect(startPayload).toMatchObject({ p_off_site_reason: 'Starting from the depot, driving to site now.', p_gps_lat: -41.274 });
});

test('one shift at a time: starting the next shift while still on one is confirmed first, and the receipt says the earlier shift was ended', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: -41.274, longitude: 173.283 });
  const stillOn = { id: '12121212-1212-4212-8212-121212121212', service_type: 'patrol', scheduled_start: '2026-08-29T20:00:00.000Z', scheduled_end: '2026-08-30T04:00:00.000Z', status: 'in_progress', notes: 'Night patrol', shift_health: 'on_track', total_stops: 2, ended_reason: null };
  const next = { id: '77777777-7777-4777-8777-777777777777', service_type: 'site_guard', scheduled_start: '2026-08-29T22:00:00.000Z', scheduled_end: '2026-08-30T06:00:00.000Z', status: 'accepted', notes: null, shift_health: null, total_stops: 1, ended_reason: null };
  let started = false;
  await page.route('**/rest/v1/shifts**', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(started ? [{ ...stillOn, status: 'completed', ended_reason: 'superseded_by_next_shift' }, { ...next, status: 'in_progress' }] : [stillOn, next]) }));
  await page.route('**/rest/v1/rpc/evaluate_shift_start_position', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'on_site', place_name: 'Civic Centre', distance_m: 0, advisory_radius_m: 250, route_shift: false }) }));
  let startPayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/rpc/start_officer_shift', async (route) => {
    startPayload = JSON.parse(route.request().postData() ?? '{}');
    started = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ shift_id: next.id, shift_status: 'in_progress', started_at: '2026-08-29T22:05:00.000Z', created: true, position_status: 'on_site', place_name: 'Civic Centre', distance_m: 0, superseded_shift_id: stillOn.id, superseded_service_type: 'patrol', superseded_started_at: '2026-08-29T20:02:00.000Z' }]) });
  });
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'Start shift' }).click();
  const dialog = page.getByRole('dialog', { name: "You're still on another shift" });
  await expect(dialog.getByText(/Your patrol shift .* is still in progress\. You can only be on one shift at a time, so starting this one ends it now\./)).toBeVisible();
  expect(startPayload).toBeNull();
  await dialog.getByRole('button', { name: 'End it and start this one' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Shift started at' })).toContainText('Your earlier patrol shift was ended at');
  expect(startPayload).toMatchObject({ p_shift_id: next.id, p_expected_status: 'accepted' });
  await expect(page.locator('.officer-assigned-shift').filter({ hasText: 'ended when your next shift started' })).toHaveCount(1);
});

const ACTIVE_SHIFT = { id: '12121212-1212-4212-8212-121212121212', service_type: 'patrol', shift_type: 'patrol', scheduled_start: '2026-08-29T20:00:00.000Z', scheduled_end: '2026-08-30T04:00:00.000Z', status: 'in_progress', notes: 'Active patrol', shift_health: 'on_track', total_stops: 2, completed_stops: 1, organization_id: '33333333-3333-4333-8333-333333333333', officer_user_id: '22222222-2222-4222-8222-222222222222' };
const readinessBase = { shift_id: ACTIVE_SHIFT.id, status: 'in_progress', service_type: 'patrol', scheduled_end: ACTIVE_SHIFT.scheduled_end, actual_start: null, open_stops: [], open_stop_count: 0, open_required_task_count: 0, open_dispatch_job_count: 0, active_welfare_alert_count: 0, debrief_submitted: false, blockers: ['The debrief has not been recorded'], can_end: false, can_end_after_debrief: true };

test('End shift says what is still open and will not end the shift until it is closed', async ({ page }) => {
  await page.route('**/rest/v1/shifts**', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([ACTIVE_SHIFT]) }));
  await page.route('**/rest/v1/rpc/get_shift_end_readiness', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...readinessBase, open_stops: [{ stop_id: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', place: 'Tahunanui Beach Reserve', status: 'pending', module_key: null }], open_stop_count: 1, open_required_task_count: 1, open_dispatch_job_count: 1, blockers: ['1 stop is still open', '1 required stop task is not done', '1 dispatch job is still open', 'The debrief has not been recorded'], can_end_after_debrief: false }) }));
  let completeCalled = false;
  await page.route('**/rest/v1/rpc/complete_officer_shift', async (route) => { completeCalled = true; await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); });
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  await expect(dialog.getByText('1 stop still open')).toBeVisible();
  await expect(dialog.getByText('Tahunanui Beach Reserve')).toBeVisible();
  await expect(dialog.getByText('1 dispatch job still open')).toBeVisible();
  await expect(dialog.getByText('No welfare alerts active')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Record debrief and end shift' })).toBeDisabled();
  await expect(dialog).toHaveScreenshot('officer-end-shift-dialog.png', { maxDiffPixelRatio: 0.03 });
  await dialog.getByRole('button', { name: 'Open stops' }).click();
  await expect(page).toHaveURL(/\/officer\/patrol$/);
  expect(completeCalled).toBe(false);
});

test('when everything is closed, End shift takes the debrief and ends the shift with the end position', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: -41.29038, longitude: 173.24687 });
  await page.route('**/rest/v1/shifts**', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([ACTIVE_SHIFT]) }));
  await page.route('**/rest/v1/rpc/get_shift_end_readiness', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readinessBase) }));
  let debriefPayload: Record<string, unknown> | null = null;
  let completePayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/rpc/submit_shift_debrief', async (route) => { debriefPayload = JSON.parse(route.request().postData() ?? '{}'); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '99999999-9999-4999-8999-999999999999', created: true, submitted_at: '2026-08-29T21:30:00.000Z' }]) }); });
  await page.route('**/rest/v1/rpc/complete_officer_shift', async (route) => { completePayload = JSON.parse(route.request().postData() ?? '{}'); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ shift_id: ACTIVE_SHIFT.id, shift_status: 'completed', completed_at: '2026-08-29T21:35:00.000Z' }]) }); });
  await signInAsOfficer(page, '/officer/schedule');
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  await expect(dialog.getByText('Every stop is done')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Record debrief and end shift' })).toBeDisabled();
  await dialog.getByLabel('How did the shift go?').fill('Quiet night, all stops visited, gate at Tahunanui left secured.');
  await dialog.getByLabel('Needs follow-up').check();
  await expect(dialog.getByRole('button', { name: 'Record debrief and end shift' })).toBeDisabled();
  await dialog.getByLabel('What needs following up?').fill('Gate padlock is stiff.');
  await dialog.getByRole('button', { name: 'Record debrief and end shift' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Shift ended at' })).toBeVisible();
  expect(debriefPayload).toMatchObject({ p_shift_id: ACTIVE_SHIFT.id, p_summary: 'Quiet night, all stops visited, gate at Tahunanui left secured.', p_follow_up_required: true, p_follow_up_notes: 'Gate padlock is stiff.', p_safety_incident_reported: false });
  expect(completePayload).toMatchObject({ p_shift_id: ACTIVE_SHIFT.id, p_expected_status: 'in_progress', p_gps_lat: -41.29038, p_gps_lng: 173.24687 });
});

test('End shift is one tap from the officer home page while on shift', async ({ page }) => {
  await page.route('**/rest/v1/shifts**', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([ACTIVE_SHIFT]) }));
  await page.route('**/rest/v1/rpc/get_shift_end_readiness', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...readinessBase, debrief_submitted: true, blockers: [], can_end: true }) }));
  await page.route('**/rest/v1/rpc/complete_officer_shift', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ shift_id: ACTIVE_SHIFT.id, shift_status: 'completed', completed_at: '2026-08-29T21:35:00.000Z' }]) }));
  await signInAsOfficer(page, '/officer');
  await expect(page.getByRole('heading', { name: /^On shift/ })).toBeVisible();
  await page.getByRole('button', { name: 'End shift' }).click();
  const dialog = page.getByRole('dialog', { name: 'End patrol shift' });
  await expect(dialog.getByText('Debrief recorded')).toBeVisible();
  await dialog.getByRole('button', { name: 'End shift' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Shift ended at' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open timesheet' })).toBeVisible();
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