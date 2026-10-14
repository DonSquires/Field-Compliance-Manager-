import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page, { officerModules: ['dispatch'] });
});

test('dispatcher keeps the selected run sheet current as patrol stops advance', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-30T09:30:00+12:00') });
  let completed = false;
  await page.route('**/rest/v1/shifts**', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{
    id: '12121212-1212-4212-8212-121212121212', officer_user_id: '22222222-2222-4222-8222-222222222222',
    officer: { display_name: 'Patrol Test Officer' }, route: { name: 'Northern Run', route_code: 'N-01' },
    scheduled_start: '2026-08-29T20:00:00.000Z', scheduled_end: '2026-08-30T04:00:00.000Z', status: 'in_progress', total_stops: 1, completed_stops: completed ? 1 : 0,
  }]) }));
  await page.route('**/rest/v1/shift_stops**', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{
    id: '34343434-3434-4434-8434-343434343434', shift_id: '12121212-1212-4212-8212-121212121212',
    stop_order: 1, site_id: '42424242-4242-4242-8242-424242424242', zone_id: null,
    site: { name: 'Civic Centre' }, zone: null,
    status: completed ? 'completed' : 'pending', actual_arrived_at: completed ? '2026-08-29T21:30:05.000Z' : null,
    actual_departed_at: completed ? '2026-08-29T21:30:10.000Z' : null,
  }]) }));
  await signInAsAdmin(page, '/admin/field-ops?area=dispatch');
  const shift = page.getByRole('button', { name: /Patrol Test Officer/ });
  await shift.click();
  const stop = page.locator('.dispatch-stop-card');
  await expect(stop).toContainText('PENDING');
  await expect(stop).toContainText('Civic Centre');
  await expect(stop).not.toContainText('42424242-4242-4242-8242-424242424242');
  completed = true;
  await page.clock.runFor(30_100);
  await expect(stop).toContainText('COMPLETED');
  const mobileSections = page.getByRole('tablist', { name: 'Dispatch console sections' });
  if (await mobileSections.isVisible()) await mobileSections.getByRole('button', { name: 'Shifts', exact: true }).click();
  await expect(shift).toHaveClass(/is-selected/);
  await expect(shift).toContainText('1/1 stops');
});

test('dispatcher reorders a pending stop and amends the selected shift with explicit receipts', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  const shiftId = '12121212-1212-4212-8212-121212121212';
  const targetStopId = '34343434-3434-4434-8434-343434343433';
  let shiftUpdatedAt = '2026-08-30T08:45:00.000Z';
  let shiftNotes = 'Northern run';
  const stops = [
    { id: '34343434-3434-4434-8434-343434343431', stop_order: 1, name: 'Depot Gate', updated_at: '2026-08-30T08:45:00.000Z' },
    { id: '34343434-3434-4434-8434-343434343432', stop_order: 2, name: 'Library', updated_at: '2026-08-30T08:45:00.000Z' },
    { id: targetStopId, stop_order: 3, name: 'Civic Centre', updated_at: '2026-08-30T08:45:00.000Z' },
  ];
  const actionRequests: {
    stop?: Record<string, unknown>;
    shift?: Record<string, unknown>;
  } = {};

  await page.route('**/rest/v1/shifts**', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{
    id: shiftId,
    officer_user_id: '22222222-2222-4222-8222-222222222222',
    officer: { display_name: 'Patrol Test Officer' },
    route: { name: 'Northern Run', route_code: 'N-01' },
    scheduled_start: '2026-08-29T20:00:00.000Z',
    scheduled_end: '2026-08-30T04:00:00.000Z',
    actual_start: '2026-08-29T20:02:00.000Z',
    status: 'in_progress',
    shift_health: 'on_track',
    notes: shiftNotes,
    total_stops: 3,
    completed_stops: 0,
    updated_at: shiftUpdatedAt,
  }]) }));
  await page.route('**/rest/v1/shift_stops**', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([...stops].sort((left, right) => left.stop_order - right.stop_order).map((stop) => ({
      id: stop.id,
      shift_id: shiftId,
      stop_order: stop.stop_order,
      site_id: '42424242-4242-4242-8242-424242424242',
      zone_id: null,
      site: { name: stop.name },
      zone: null,
      status: 'pending',
      actual_arrived_at: null,
      actual_departed_at: null,
      updated_at: stop.updated_at,
    }))),
  }));
  await page.route('**/rest/v1/rpc/manage_shift_stop', async (route) => {
    actionRequests.stop = route.request().postDataJSON() as Record<string, unknown>;
    const previousOrder = stops.find((stop) => stop.id === targetStopId)?.stop_order ?? 3;
    for (const stop of stops) {
      if (stop.id === targetStopId) stop.stop_order = 1;
      else if (stop.stop_order < previousOrder) stop.stop_order += 1;
      stop.updated_at = '2026-08-30T09:31:00.000Z';
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      replayed: false,
      action: 'reorder',
      target_id: targetStopId,
      previous: { stop_order: previousOrder },
      resulting: { stop_order: 1 },
    }) });
  });
  await page.route('**/rest/v1/rpc/manage_active_shift', async (route) => {
    actionRequests.shift = route.request().postDataJSON() as Record<string, unknown>;
    shiftNotes = String(actionRequests.shift.p_notes);
    shiftUpdatedAt = '2026-08-30T09:32:00.000Z';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      replayed: false,
      action: 'amend',
      target_id: shiftId,
      previous: { notes: 'Northern run' },
      resulting: { notes: shiftNotes },
    }) });
  });

  await signInAsAdmin(page, '/admin/field-ops?area=dispatch');
  await page.getByRole('button', { name: /Patrol Test Officer/ }).click();
  await page.locator('.dispatch-stop-card').filter({ hasText: 'Civic Centre' }).click();
  await page.getByRole('button', { name: 'Change position' }).click();
  const stopAction = page.getByRole('form', { name: 'Change stop position' });
  await expect(stopAction).toContainText('writes a before-and-after audit receipt');
  await stopAction.getByLabel('New route position').selectOption('1');
  await stopAction.getByLabel('Operational reason').fill('Respond to the revised priority order from control.');
  await stopAction.getByRole('button', { name: 'Confirm change stop position' }).click();
  await expect(page.getByText('Stop moved from position 3 to 1 with an audit receipt.')).toBeVisible();
  await expect(page.locator('.dispatch-stop-card').filter({ hasText: 'Civic Centre' })).toContainText('#1');
  expect(actionRequests.stop).toMatchObject({
    p_stop_id: targetStopId,
    p_expected_status: 'pending',
    p_expected_updated_at: '2026-08-30T08:45:00.000Z',
    p_action: 'reorder',
    p_new_order: 1,
    p_reason: 'Respond to the revised priority order from control.',
  });
  expect(actionRequests.stop?.p_client_request_id).toMatch(/^[0-9a-f-]{36}$/);

  const mobileSections = page.getByRole('tablist', { name: 'Dispatch console sections' });
  if (await mobileSections.isVisible()) await mobileSections.getByRole('button', { name: 'Shifts', exact: true }).click();
  await page.getByRole('button', { name: 'Amend shift' }).click();
  const shiftAction = page.getByRole('form', { name: 'Amend shift' });
  await shiftAction.getByLabel('Updated shift note').fill('Northern run via the Civic Centre first.');
  await shiftAction.getByLabel('Operational reason').fill('Match the live route order confirmed by control.');
  await shiftAction.getByRole('button', { name: 'Confirm amend shift' }).click();
  await expect(page.getByText('Shift notes updated with an audit receipt.')).toBeVisible();
  expect(actionRequests.shift).toMatchObject({
    p_shift_id: shiftId,
    p_expected_status: 'in_progress',
    p_expected_updated_at: '2026-08-30T08:45:00.000Z',
    p_action: 'amend',
    p_notes: 'Northern run via the Civic Centre first.',
    p_reason: 'Match the live route order confirmed by control.',
  });
  expect(actionRequests.shift?.p_client_request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('priority dispatch item opens its exact operational review record', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  const dispatchJob = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', job_type: 'alarm_response', priority: 'high', status: 'dispatched',
    briefing_notes: 'Verify the north loading entrance and record the outcome.', sla_minutes: 15, sla_respond_by: '2026-08-30T10:00:00.000Z', sla_breached: false,
    expected_dwell_minutes: 8, timing_source: 'dispatcher_override', shift_id: '66666666-6666-4666-8666-666666666666', client_site_id: '42424242-4242-4242-8242-424242424242', created_at: '2026-08-30T09:00:00.000Z',
    site: { name: 'Civic Operations Centre', address: '10 Waimea Road, Nelson', hs_notes: 'Boundary-first arrival check required.', access_instructions: 'Use the north loading entrance.' }, resource: { name: 'Unit N587' },
  };
  await page.route('**/rest/v1/organization_modules**', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'abababab-abab-4bab-8bab-ababababab31', module_key: 'dispatch', enabled: true }, { id: 'abababab-abab-4bab-8bab-ababababab32', module_key: 'welfare', enabled: true }, { id: 'abababab-abab-4bab-8bab-ababababab33', module_key: 'crm', enabled: true }, { id: 'abababab-abab-4bab-8bab-ababababab34', module_key: 'rostering', enabled: true }, { id: 'abababab-abab-4bab-8bab-ababababab35', module_key: 'finance', enabled: true }]) });
  });
  await page.route('**/rest/v1/dispatch_jobs**', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([dispatchJob]) }));
  await signInAsAdmin(page, '/admin/hub');
  await expect(page.getByText(/Welfare and CCTV processing are organization-wide/)).toBeVisible();
  const queueItem = page.getByRole('button', { name: /Alarm response.*SLA due/i });
  await expect(queueItem).toBeVisible();
  await expect(page).toHaveScreenshot('admin-hub-first-viewport.png');
  await queueItem.click();
  await expect(page).toHaveURL(/\/admin\/field-ops\?area=dispatch&job=cccccccc-cccc-4ccc-8ccc-cccccccccccc/);
  const detail = page.getByLabel('Dispatch details for Civic Operations Centre');
  await expect(detail).toBeVisible();
  await expect(detail).toHaveScreenshot('dispatch-job-detail.png', { maxDiffPixelRatio: 0.05 });
  await expect(detail).toContainText('10 Waimea Road, Nelson');
  await expect(detail).toContainText('Expected attendance');
  await expect(detail).toContainText('8 min');
  await expect(detail).toContainText('Verify the north loading entrance');
  await expect(detail).toContainText('Use the north loading entrance.');
  await expect(detail).toContainText('Boundary-first arrival check required.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
test('an alarm-response job shows its response ladder counted from the alarm, in the dispatcher\'s words', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  const dispatchJob = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', job_type: 'alarm_response', priority: 'high', status: 'on_scene',
    briefing_notes: '[Alarm burglary / intruder, received 30/08/2026, 8:50:00 am by phone call]', sla_minutes: 15, sla_respond_by: '2026-08-29T21:05:00.000Z', sla_breached: true,
    expected_dwell_minutes: 8, timing_source: 'dispatcher_override', shift_id: '66666666-6666-4666-8666-666666666666', client_site_id: '42424242-4242-4242-8242-424242424242',
    created_at: '2026-08-29T21:00:00.000Z', dispatched_at: '2026-08-29T21:02:00.000Z', acknowledged_at: null, en_route_at: '2026-08-29T21:05:00.000Z', on_scene_at: '2026-08-29T21:12:00.000Z', completed_at: null,
    site: { name: 'Civic Operations Centre', address: '10 Waimea Road, Nelson', hs_notes: null, access_instructions: null }, resource: { name: 'Unit N587' },
  };
  await page.route('**/rest/v1/dispatch_jobs**', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([dispatchJob]) }));
  let alarmQuery = '';
  await page.route('**/rest/v1/alarm_events**', async (route) => {
    alarmQuery = route.request().url();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ dispatch_job_id: dispatchJob.id, received_at: '2026-08-29T20:50:00.000Z', signal_type: 'burglary', intake_channel: 'phone', panel_id: 'P-12', zone_name: 'Rear door', zone_number: '4', account_number: null }]) });
  });
  await signInAsAdmin(page, '/admin/field-ops?area=dispatch&job=cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  const detail = page.getByLabel('Dispatch details for Civic Operations Centre');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('status')).toContainText('On scene 22 min after the alarm — 7 min over the 15 min target.');
  const steps = detail.locator('.dispatch-response-steps li');
  await expect(steps.nth(0)).toContainText('Alarm received (Burglary / intruder, by phone call)');
  await expect(steps.nth(1)).toContainText(/Job created.*10 min after the alarm/);
  await expect(steps.nth(3)).toContainText(/Acknowledged\s*Not yet/);
  await expect(steps.nth(5)).toContainText(/On scene.*22 min after the alarm/);
  expect(alarmQuery).toContain('dispatch_job_id=in.%28cccccccc-cccc-4ccc-8ccc-cccccccccccc%29');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test.describe('in New Zealand', () => {
  test.use({ timezoneId: 'Pacific/Auckland' });
  test('the new alarm job form asks for the signal, the channel and the time in local wall-clock terms', async ({ page }) => {
    await page.route('**/rest/v1/dispatch_jobs**', async (route) => await route.fulfill({ contentType: 'application/json', body: '[]' }));
    await signInAsAdmin(page, '/admin/field-ops?area=dispatch');
    await page.getByRole('button', { name: /New Job|Create Job|\+ Job/i }).first().click();
    await expect(page.getByLabel('Alarm signal')).toHaveValue('burglary');
    await expect(page.getByLabel('How it reached us')).toHaveValue('phone');
    // the fixture clock is 2026-08-29T12:00Z = 30 Aug 00:00 in Auckland: the default must be the local wall clock (toISOString would show 29 Aug 12:00)
    await expect(page.getByLabel('Alarm received at')).toHaveValue('2026-08-30T00:00');
    await expect(page.getByText('The response target counts from this time, not from when the job is saved.')).toBeVisible();
  });
});
