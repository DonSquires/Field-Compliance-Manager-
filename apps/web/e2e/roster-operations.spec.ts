import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
	await page.clock.setFixedTime(new Date('2026-08-31T09:30:00+12:00'));
	await installSupabaseFixtures(page);
	await page.route('**/rest/v1/rpc/get_operating_organization_contexts', async (route) => await route.fulfill({
		contentType: 'application/json',
		body: JSON.stringify([{ organization_id: '41414141-4141-4141-8141-414141414141', organization_name: 'Northern Branch', authority_basis: 'branch_authorisation', role_at_branch: 'admin', module_access: ['roster'], can_be_rostered: false, is_default: true }]),
	}));
});

test('roster removes unused place selectors without clearing other workspace context', async ({ page }) => {
  await page.route('**/rest/v1/rpc/get_operating_organization_contexts', (route) => route.fulfill({ json: [{
    organization_id: '33333333-3333-4333-8333-333333333333', organization_name: 'Harbour Compliance Services',
    authority_basis: 'organisation_home', role_at_branch: 'admin', module_access: ['roster'], can_be_rostered: false, is_default: true,
  }] }));
  await page.route('**/rest/v1/service_agreement_locations*', (route) => route.fulfill({ json: [{
    id: '21212121-2121-4121-8121-212121212121', service_agreement_id: '24242424-2424-4424-8424-242424242424',
    site_id: '25252525-2525-4525-8525-252525252525', zone_id: null,
  }] }));
  await page.route('**/rest/v1/client_sites*', (route) => route.fulfill({ json: [{
    id: '25252525-2525-4525-8525-252525252525', name: 'Civic Centre', address: '1 Civic Square',
    site_type: 'commercial', location_id: null, client_organization_id: '40404040-4040-4040-8040-404040404040',
    service_agreement_id: '24242424-2424-4424-8424-242424242424', active: true,
  }] }));
  await signInAsAdmin(page, '/admin/roster-targets');
  const context = page.getByRole('region', { name: 'Service place context' });
  await expect(context.getByLabel('Service agreement')).toHaveValue('24242424-2424-4424-8424-242424242424');
  await context.getByLabel('Service site or zone').selectOption('');
  const selectedPlace = await context.getByLabel('Service site or zone').inputValue();
  await page.getByRole('navigation', { name: 'Roster sections' }).getByRole('button', { name: 'Roster board', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Roster', exact: true })).toBeVisible();
  await expect(context).toHaveCount(0);
  await expect(page.getByLabel('Roster branch')).toHaveValue('33333333-3333-4333-8333-333333333333');
  await page.getByRole('navigation', { name: 'Roster sections' }).getByRole('button', { name: 'Work units & coverage', exact: true }).click();
  await expect(context.getByLabel('Service site or zone')).toHaveValue(selectedPlace);
});

test('compact roster gives the calendar most of the viewport', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile-chromium';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await signInAsAdmin(page, '/admin/roster');
  await expect(page.locator('.roster-board').getByText('Ana Ngata', { exact: true })).toBeVisible();
  const layout = await page.locator('.roster-board').evaluate((element) => ({
    top: element.getBoundingClientRect().top,
    height: element.getBoundingClientRect().height,
    bodyWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.top).toBeLessThanOrEqual(mobile ? 400 : 230);
  expect(layout.height).toBeGreaterThanOrEqual(mobile ? 240 : 495);
  await expect(page.getByRole('complementary', { name: 'Officer directory' })).toBeHidden();
  for (const control of [page.getByRole('button', { name: 'Create shift', exact: true }), page.getByLabel('Roster branch')]) {
    await expect(control).toBeVisible();
    expect(await control.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: testInfo.outputPath('compact-roster.png') });
});

test('roster secondary tools retain planning actions and visible filter state', async ({ page }) => {
  await page.route('**/rest/v1/rpc/preview_roster_from_templates', (route) => route.fulfill({ json: {
    templates_applied: 1, candidate_slots: 2, existing_slots: 1, new_slots: 1,
  } }));
  await signInAsAdmin(page, '/admin/roster');
  const tools = page.getByText('Tools', { exact: true });
  await tools.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Fill from templates', exact: true }).click();
  const template = page.getByRole('dialog', { name: /from templates/ });
  await expect(template).toBeVisible();
  await expect.poll(() => template.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab');
    // Native dialogs may tab through browser chrome, but not background controls.
    await expect.poll(() => template.evaluate((element) => element.contains(document.activeElement) || document.activeElement === document.body)).toBe(true);
  }
  await expect(page.getByRole('button', { name: 'Staff availability', exact: true })).toBeHidden();
  await template.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(tools).toBeFocused();
  await tools.click();
  await page.getByRole('button', { name: 'Staff availability', exact: true }).click();
  const availability = page.getByRole('dialog', { name: 'Staff availability' });
  await expect(availability).toBeVisible();
  await expect.poll(() => availability.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(availability).toBeHidden();
  await expect(tools).toBeFocused();
  await page.locator('.roster-operational-dock > summary').click();
  const restriction = page.locator('.roster-availability-queue').getByRole('button', { name: /Jordan Lee/ });
  await restriction.click();
  await expect.poll(() => availability.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(restriction).toBeFocused();
  await page.locator('.roster-operational-dock > summary').click();
  await page.getByText('View options', { exact: true }).click();
  await page.getByLabel('Staff readiness').selectOption('risk');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Staff readiness')).toBeHidden();
  await expect(page.getByRole('button', { name: /Clear filters/ })).toBeVisible();
  await expect(page.locator('.roster-board').getByText('Ana Ngata', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Clear filters/ }).click();
  await expect(page.locator('.roster-board').getByText('Ana Ngata', { exact: true })).toBeVisible();
  await page.getByText('View options', { exact: true }).click();
  await page.getByRole('button', { name: 'Staff details', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Officer directory' })).toBeVisible();
});

test('roster controls and opened tools fit phone and intermediate workspace widths', async ({ page }, testInfo) => {
  const widths = testInfo.project.name === 'mobile-chromium' ? [375, 390, 760] : [768, 1024, 1280];
  await signInAsAdmin(page, '/admin/roster');
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    for (const control of [page.getByRole('button', { name: 'Create shift', exact: true }), page.getByLabel('Roster branch'), page.getByLabel('Search officers'), page.getByText('View options', { exact: true })]) {
      const bounds = await control.boundingBox();
      expect(bounds, `control exists at ${width}px`).not.toBeNull();
      expect(bounds!.x, `control left at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width, `control right at ${width}px`).toBeLessThanOrEqual(width);
    }
    await page.getByText('Tools', { exact: true }).click();
    const popup = page.locator('.roster-toolbar-actions .roster-toolbar-popover');
    const bounds = await popup.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x, `popup left at ${width}px`).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width, `popup right at ${width}px`).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('changing roster horizon uses the selected horizon for the current period', async ({ page }) => {
  await signInAsAdmin(page, '/admin/roster');
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.getByLabel('Roster range start')).toHaveValue('2026-08-24');
  await expect(page.locator('.roster-board').getByText('Roster Administration', { exact: true })).toBeVisible();
});

test('long branch and staff names keep roster controls within the viewport', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile-chromium';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const name = 'Northern Regional Operations and Shared Services for Extended District Coverage';
  await page.route('**/rest/v1/rpc/get_operating_organization_contexts', (route) => route.fulfill({ json: [{
    organization_id: '41414141-4141-4141-8141-414141414141', organization_name: name,
    authority_basis: 'branch_authorisation', role_at_branch: 'admin', module_access: ['roster'], can_be_rostered: false, is_default: true,
  }] }));
  await page.route('**/rest/v1/rpc/get_operating_branch_roster_staff', (route) => route.fulfill({ json: [{
    user_id: '22222222-2222-4222-8222-222222222222', staff_id: '22222222-2222-4222-8222-222222222222',
    display_name: 'Alexandra Catherine Sample-Extended-Name', employment_type: 'permanent', work_ready: true,
    credential_expiry: '2027-06-01', credential_verified: true,
  }] }));
  await signInAsAdmin(page, '/admin/roster');
  await expect(page.getByLabel('Roster branch').locator('option:checked')).toHaveText(name);
  await expect(page.locator('.roster-board').getByRole('button', { name: /^AC Alexandra Catherine/ })).toBeVisible();
  for (const control of [page.getByLabel('Roster branch'), page.getByRole('button', { name: 'Create shift', exact: true }), page.getByText('View options', { exact: true })]) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('roster command workbench keeps directory, range and governed timesheet review inline', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  const staffId = '22222222-2222-4222-8222-222222222222';
  const sheetId = '38383838-3838-4838-8838-383838383838';
  let status = 'submitted';
  let reviewPayload: Record<string, unknown> | null = null;
  let branchPayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/rpc/get_branch_timesheet_queue', async (route) => {
    branchPayload = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: sheetId, staff_id: staffId, period_start: '2026-08-24', period_end: '2026-09-06', scheduled_hours: 40, actual_hours: 42, work_derived_hours: 41, adjustment_hours: 1, status }]) });
  });
  await page.route('**/rest/v1/rpc/review_branch_timesheet', async (route) => {
    reviewPayload = route.request().postDataJSON();
    status = String(reviewPayload!.p_decision);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: sheetId, status }) });
  });
  await signInAsAdmin(page, '/admin/roster');
  await page.getByText('View options', { exact: true }).click();
  await page.getByRole('button', { name: 'Staff details', exact: true }).click();
  const directory = page.getByRole('complementary', { name: 'Officer directory' });
  const board = page.locator('.roster-board');
  await expect(directory.getByText('Ana Ngata', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '1 timesheet approvals' })).toBeVisible();
  await expect(page.getByLabel('Roster branch')).toHaveValue('41414141-4141-4141-8141-414141414141');
  expect(branchPayload).toEqual({ p_operating_organization_id: '41414141-4141-4141-8141-414141414141' });
  await directory.getByRole('button', { name: /Ana Ngata/ }).click();
  await expect(board.getByText('Jordan Lee', { exact: true })).toHaveCount(0);
  await expect(board.getByText('Ana Ngata', { exact: true })).toBeVisible();
  await directory.getByRole('button', { name: 'All officers' }).click();
  await page.getByLabel('Search officers').fill('Jordan');
  await expect(board.getByText('Ana Ngata', { exact: true })).toHaveCount(0);
  await page.getByLabel('Search officers').fill('');
  await page.getByRole('button', { name: '1 timesheet approvals' }).click();
  const reconciliation = page.getByRole('region', { name: 'Inline timesheet reconciliation' });
  await expect(reconciliation.getByText('42', { exact: true })).toBeVisible();
  await reconciliation.getByRole('button', { name: 'Branch check', exact: true }).click();
  await reconciliation.getByLabel('Review notes').fill('Compared roster and governed work evidence.');
  await reconciliation.getByRole('button', { name: 'Confirm decision' }).click();
  await expect(reconciliation.getByText(/Audit decision recorded; no payment made\./)).toBeVisible();
  expect(reviewPayload).toMatchObject({ p_expected_status: 'submitted', p_decision: 'branch_checked', p_timesheet_id: sheetId });
  await expect(page.getByRole('button', { name: '0 timesheet approvals' })).toBeVisible();
  await expect(reconciliation.getByText('A different corporate payroll reviewer must approve.')).toBeVisible();
  const layout = await page.locator('.roster-command-workbench').evaluate((element) => ({
    bottom: element.getBoundingClientRect().bottom,
    viewport: window.innerHeight,
    overflow: getComputedStyle(element).overflow,
    minHeight: getComputedStyle(element).minHeight,
    bodyWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewport + 1);
  expect(layout.overflow).toBe('hidden');
  expect(layout.minHeight).toBe('0px');
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
  await page.getByLabel('Roster range start').fill('2026-10-12');
  await expect(page.getByRole('button', { name: '0 timesheet approvals' })).toBeVisible();
  await expect(reconciliation.getByText('No timesheets in this scope.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('roster directory never invents licences and timesheet read failures stay unknown', async ({ page }) => {
  await page.route('**/rest/v1/rpc/get_operating_branch_roster_staff', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ user_id: '22222222-2222-4222-8222-222222222222', staff_id: '22222222-2222-4222-8222-222222222222', display_name: 'Ana Ngata', employment_type: 'permanent', work_ready: true, credential_expiry: null, credential_verified: null }]) }));
  await page.route('**/rest/v1/rpc/get_branch_timesheet_queue', async (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Local timesheet review authority required' }) }));
  await signInAsAdmin(page, '/admin/roster');
  await page.getByText('View options', { exact: true }).click();
  await page.getByRole('button', { name: 'Staff details', exact: true }).click();
  const directory = page.getByRole('complementary', { name: 'Officer directory' });
  await expect(directory.getByText('Credentials not recorded')).toBeVisible();
  await expect(directory.getByText(/licence clear/i)).toHaveCount(0);
  await page.getByRole('button', { name: '— timesheet approvals' }).click();
  await expect(page.getByRole('region', { name: 'Inline timesheet reconciliation' }).getByRole('alert')).toContainText('Local timesheet review authority required');
  await expect(page.getByRole('button', { name: '— timesheet approvals' })).toBeVisible();
});

test('roster admin start and finish drive the officer shift after a phone briefing', async ({ page }) => {
        const shiftId = '12121212-1212-4212-8212-121212121212';
        const events: Array<Record<string, unknown>> = [];
        const requests: Array<Record<string, unknown>> = [];
        const shift: Record<string, unknown> = { id: shiftId, officer_user_id: '22222222-2222-4222-8222-222222222222', service_type: 'patrol', scheduled_start: '2026-08-27T22:00:00.000Z', scheduled_end: '2026-08-28T06:00:00.000Z', status: 'accepted', shift_health: null, total_stops: 0, notes: null, actual_start: null, actual_end: null, ended_reason: null, updated_at: '2026-08-30T19:00:00.000Z' };
        const finishLocation = { recorded_at: '2026-08-28T20:40:00.000Z', lat: -41.29, lng: 173.27, accuracy_m: 8, address: '65 Tipahi Street, Nelson South' };
        let failNextFinish = true;
        await page.route('**/rest/v1/shifts*', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([shift]) }));
        await page.route('**/rest/v1/rpc/get_roster_admin_attendance', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(events) }));
        await page.route('**/rest/v1/rpc/get_admin_shift_finish_preview', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ shift_id: shiftId, open_dispatch_jobs: 1, open_welfare_alerts: 1, last_location: { recorded_at: finishLocation.recorded_at, address: finishLocation.address, accuracy_m: 8 } }) }));
        await page.route('**/rest/v1/rpc/record_admin_shift_attendance', async (route) => {
                const request = route.request().postDataJSON();
                requests.push(request);
                const isStart = request.p_event_type === 'admin_start';
                if (!isStart && failNextFinish) {
                        failNextFinish = false;
                        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null }) });
                        return;
                }
                if (isStart) Object.assign(shift, { status: 'in_progress', actual_start: request.p_recorded_at, updated_at: '2026-08-30T20:05:00.000Z' });
                else Object.assign(shift, { status: 'completed', actual_end: request.p_recorded_at, ended_reason: 'supervisor_closed', updated_at: '2026-08-30T21:05:00.000Z' });
                const previous = events[0] ?? { shift_id: shiftId, location_captured_at: null, location_address: null };
                events.splice(0, events.length, isStart
                        ? { ...previous, admin_start: request.p_recorded_at, admin_start_reason: request.p_reason, admin_start_by: 'Morgan Reed' }
                        : { ...previous, admin_finish: request.p_recorded_at, admin_finish_reason: request.p_reason, admin_finish_by: 'Morgan Reed', finish_location_captured_at: finishLocation.recorded_at, finish_location_address: finishLocation.address, finish_released_dispatch_jobs: 1, finish_resolved_welfare_alerts: 1 });
                await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ event_id: `admin-event-${requests.length}`, shift_id: shiftId, event_type: request.p_event_type, recorded_at: request.p_recorded_at, replayed: false, source: isStart ? 'admin_started_officer_shift' : 'admin_finished_officer_shift', shift_status: shift.status, ...(isStart ? {} : { released_dispatch_jobs: 1, resolved_welfare_alerts: 1, finish_location: finishLocation }) }) });
        });
        await signInAsAdmin(page, '/admin/roster');
        await page.locator('.roster-board .roster-shift').filter({ hasText: 'patrol' }).first().click();
        const inspector = page.locator('.roster-inspector').filter({ hasText: 'Assignment' });
        await inspector.getByRole('button', { name: 'Record admin start' }).click();
        const startDialog = page.getByRole('dialog', { name: /^Start .*shift$/ });
        await expect(startDialog).toContainText('starts the shift in the officer');
        await startDialog.getByLabel('Shift started at').fill('2026-08-29T08:00');
        await startDialog.getByLabel('Reason (required, kept in the audit trail)').fill('Officer phoned in from the gate; their phone app would not open.');
        const startButton = startDialog.getByRole('button', { name: 'Start shift' });
        await expect(startButton).toBeDisabled();
        await startDialog.getByLabel(/I spoke with the officer by phone/).check();
        await startButton.click();
        await expect.poll(() => requests.length).toBe(1);
        expect(requests[0]).toMatchObject({ p_event_type: 'admin_start', p_site_briefed_by_phone: true, p_reason: 'Officer phoned in from the gate; their phone app would not open.' });
        await expect(page.getByRole('status').filter({ hasText: 'Shift started for the officer' })).toBeVisible();
        await expect(inspector.getByText('Started by operations')).toBeVisible();
        await expect(inspector).toContainText("Waiting for the officer's device to report");
        await expect(inspector).not.toContainText('not officer attendance');
        await expect(inspector.getByRole('button', { name: 'Record admin start' })).toHaveCount(0);
        await inspector.getByRole('button', { name: 'Record admin finish' }).click();
        const finishDialog = page.getByRole('dialog', { name: /^Finish .*shift$/ });
        await expect(finishDialog).toContainText('unreached stops are skipped');
        await expect(finishDialog).toContainText('forgot to log off');
        await expect(finishDialog).toContainText('1 open dispatch job will return to the dispatch queue');
        await expect(finishDialog).toContainText('1 open welfare alert will be resolved');
        await expect(finishDialog).toContainText('65 Tipahi Street, Nelson South');
        await finishDialog.getByLabel('Shift finished at').fill('2026-08-29T09:00');
        await finishDialog.getByLabel('Reason (required, kept in the audit trail)').fill('Officer phoned to say they had left the site.');
        const finishButton = finishDialog.getByRole('button', { name: 'Finish shift' });
        await expect(finishButton).toBeDisabled();
        await finishDialog.getByLabel(/I have checked the officer is safe/).check();
        await finishButton.click();
        await expect.poll(() => requests.length).toBe(2);
        await expect(finishDialog.getByRole('alert')).toContainText('Wait a few seconds and try again');
        await finishButton.click();
        await expect.poll(() => requests.length).toBe(3);
        expect(requests[2]).toMatchObject({ p_event_type: 'admin_finish', p_site_briefed_by_phone: false, p_officer_safety_confirmed: true, p_reason: 'Officer phoned to say they had left the site.' });
        expect(requests[2].p_client_request_id).toBe(requests[1].p_client_request_id);
        await expect(page.getByRole('status').filter({ hasText: 'Shift finished for the officer' })).toContainText('1 dispatch job returned to the queue; 1 welfare alert resolved; last GPS breadcrumb');
        await expect(inspector.getByText('Finished by operations')).toBeVisible();
        await expect(inspector).toContainText('Last GPS breadcrumb');
        await expect(inspector).toContainText('65 Tipahi Street, Nelson South');
        await expect(inspector.getByRole('button', { name: 'Record admin finish' })).toHaveCount(0);
});

test('enterprise roster week board is operational and visually stable', async ({ page }) => {
 test.setTimeout(90_000);
 const errors=monitorBrowserErrors(page); await signInAsAdmin(page,'/admin/roster');
 await expect(page.getByRole('heading',{name:'Roster',exact:true})).toBeVisible();
 const board=page.locator('.roster-board');await expect(board.getByText('Ana Ngata',{exact:true})).toBeVisible(); await expect(board.getByText('Jordan Lee',{exact:true})).toBeVisible();
 const boardLayout=await board.evaluate((element)=>({overflowX:getComputedStyle(element).overflowX,overflowY:getComputedStyle(element).overflowY,headerPosition:getComputedStyle(element.querySelector('.roster-board-head')!).position,firstColumnPosition:getComputedStyle(element.querySelector('.roster-person')!).position}));expect(boardLayout).toEqual({overflowX:'auto',overflowY:'auto',headerPosition:'sticky',firstColumnPosition:'sticky'});
 await expect(page.locator('.admin-shell')).toHaveAttribute('data-theme', 'dark');
 const headerColors = await page.locator('.roster-board-head>div').first().evaluate((cell) => {
  const style = getComputedStyle(cell);
  return { background: style.backgroundColor, color: style.color };
 });
 expect(headerColors).toEqual({ background: 'rgb(13, 25, 39)', color: 'rgb(130, 150, 168)' });
 await expect(page).toHaveScreenshot('roster-overview-first-viewport.png');
 if((page.viewportSize()?.width??0)<900){await expect(board).toHaveAccessibleDescription(/Scroll within the schedule/);const boardSize=await board.evaluate((element)=>({scrollWidth:element.scrollWidth,clientWidth:element.clientWidth}));expect(boardSize.scrollWidth).toBeGreaterThan(boardSize.clientWidth);}
 await page.getByRole('button',{name:'2 weeks'}).click();await expect(page.locator('.roster-board-head>div')).toHaveCount(15);expect(await board.evaluate((element)=>element.scrollWidth>element.clientWidth)).toBe(true);await page.getByRole('button',{name:'Month'}).click();await expect(page.locator('.roster-board-head>div')).toHaveCount(32);const stickyAtMonthEnd=await board.evaluate((element)=>{element.scrollLeft=element.scrollWidth;const boardLeft=element.getBoundingClientRect().left;return{headerOffset:Math.round(element.querySelector('.roster-board-head>div')!.getBoundingClientRect().left-boardLeft),rowOffset:Math.round(element.querySelector('.roster-person')!.getBoundingClientRect().left-boardLeft)};});expect(stickyAtMonthEnd).toEqual({headerOffset:1,rowOffset:1});for(let index=0;index<7;index+=1)await page.getByTitle('Previous period').click();await expect(page.locator('.roster-board-head').getByText('Provincial anniversary day')).toBeVisible();await expect(page.locator('.roster-board-head').getByText("New Year's Day",{exact:true})).toBeVisible();await expect(page.locator('.roster-toolbar-period')).toHaveScreenshot('roster-calendar-controls.png');await page.getByText('View options',{exact:true}).click();await page.getByLabel('Regional holidays').selectOption('WGN');await expect(page.getByText('Regional public holiday calendar updated.')).toBeVisible();await page.keyboard.press('Escape');await board.evaluate((element)=>{element.scrollLeft=0;});await page.getByRole('button',{name:'Week',exact:true}).click();
 await page.locator('.roster-operational-dock > summary').click();
 await expect(page.getByRole('heading',{name:'Availability restrictions'})).toBeVisible();const restriction=page.locator('.roster-availability-queue').getByRole('button',{name:/Jordan Lee/});await restriction.click();const availabilityDialog=page.getByRole('dialog',{name:'Staff availability'});await expect(availabilityDialog).toBeVisible();await expect(availabilityDialog.getByLabel('Staff member')).toHaveValue('2f2f2f2f-2222-4222-8222-222222222222');await expect(availabilityDialog.getByText('Unavailable on Sundays')).toBeVisible();await availabilityDialog.getByRole('button',{name:'Close',exact:true}).click();
 const commercialQueue=page.locator('.roster-commercial-queue');
 await expect(commercialQueue.getByRole('heading',{name:'Commercial readiness exceptions'})).toBeVisible();
 await commercialQueue.getByRole('button',{name:/Roster Administration/}).click();
 const commercialInspector=page.locator('.roster-slot-inspector');
 await expect(commercialInspector.getByText('Missing rule',{exact:true})).toBeVisible();
 await expect(commercialInspector.getByText('Not applicable',{exact:true})).toHaveCount(3);
 await expect(commercialInspector.getByText('Ready',{exact:true})).toBeVisible();
 await expect(commercialInspector).toHaveScreenshot('roster-commercial-readiness.png');
 if((page.viewportSize()?.width??0)<900){
  const factBackground=await commercialInspector.locator('dl > div').first().evaluate((element)=>getComputedStyle(element).backgroundColor);
  const tokenBackground=await page.evaluate(()=>{
   const probe=document.createElement('div');
   probe.style.backgroundColor='var(--color-bg-elevated)';
   document.body.appendChild(probe);
   const background=getComputedStyle(probe).backgroundColor;
   probe.remove();
   return background;
  });
  expect(factBackground).toBe(tokenBackground);
 }
 await commercialInspector.locator('header button').click();
 await expect(page.locator('.roster-board').getByText('Roster Administration',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 if((page.viewportSize()?.width??0)<600){await board.scrollIntoViewIfNeeded();await expect(page).toHaveScreenshot('roster-week-board.png');}else await expect(board).toHaveScreenshot('roster-week-board.png');
 await page.getByRole('button',{name:/08:00–16:00 site guard/i}).click(); await expect(page.getByText('Assignment',{exact:true})).toBeVisible(); await expect(page.getByText('On track',{exact:true})).toBeVisible(); await page.locator('.roster-inspector header button').click();
 const slotQueue=page.locator('.roster-slot-queue');await slotQueue.getByRole('button',{name:/Roster Administration/}).click();await expect(page.getByText('Roster slot',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Reassign'}).click();const reassignDialog=page.getByRole('dialog',{name:'Reassign roster slot?'});await expect(reassignDialog.getByRole('button',{name:'Confirm reassignment'})).toBeDisabled();await reassignDialog.getByLabel('Replacement officer').selectOption({label:'Jordan Lee'});await reassignDialog.getByLabel('Reassignment reason').fill('Coverage plan changed after supervisor review.');await expect(reassignDialog).toHaveScreenshot('roster-reassign-slot-dialog.png');await reassignDialog.getByRole('button',{name:'Confirm reassignment'}).click();await expect(page.getByText('Roster slot reassigned. The replacement officer has been asked to accept it.')).toBeVisible();await slotQueue.getByRole('button',{name:/Roster Administration/}).click();const cancelSlot=page.getByRole('button',{name:'Cancel slot'});await cancelSlot.scrollIntoViewIfNeeded();await cancelSlot.click();const cancelDialog=page.getByRole('dialog',{name:'Cancel roster slot?'});await expect(cancelDialog.getByRole('button',{name:'Confirm cancellation'})).toBeDisabled();await cancelDialog.getByLabel('Cancellation reason').fill('Internal priorities changed for this roster period.');await expect(cancelDialog).toHaveScreenshot('roster-cancel-slot-dialog.png');await cancelDialog.getByRole('button',{name:'Confirm cancellation'}).click();await expect(page.getByText('Roster slot cancelled, and its shift with it.')).toBeVisible();
 await page.getByText('View options',{exact:true}).click();await page.getByLabel('Staff readiness').selectOption('risk');await page.keyboard.press('Escape');await expect(board.getByText('Jordan Lee',{exact:true})).toBeVisible(); await expect(board.getByText('Ana Ngata',{exact:true})).toBeHidden();
 await page.getByRole('button',{name:/Create shift/}).click(); const dialog=page.getByRole('dialog',{name:'Create shift'}); await expect(dialog).toBeVisible(); await dialog.getByLabel('Officer',{exact:true}).selectOption('22222222-2222-4222-8222-222222222222'); await dialog.getByLabel('Start',{exact:true}).fill('2026-08-30T10:00'); await dialog.getByLabel('End',{exact:true}).fill('2026-08-30T18:00'); await expect(dialog.getByText('Publish immediately')).toBeVisible(); await expect(dialog).toHaveScreenshot('roster-create-shift-dialog.png'); await dialog.getByRole('button',{name:'Create shift'}).click(); await expect(page.getByText('Shift published for Ana Ngata. They will see it on their schedule and can accept or decline.')).toBeVisible(); expect(errors,errors.join('\n')).toEqual([]);
});

test('administrator corrects staff availability with confirmation and receipts', async ({ page }) => {
	const errors = monitorBrowserErrors(page);
	await signInAsAdmin(page, '/admin/roster');

	await page.locator('.roster-operational-dock > summary').click();
	await page.locator('.roster-availability-queue').getByRole('button', { name: /Jordan Lee/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Staff availability' });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel('Staff member')).toHaveValue('2f2f2f2f-2222-4222-8222-222222222222');
	await expect(dialog.getByText('Unavailable on Sundays')).toBeVisible();

	await dialog.getByRole('button', { name: 'Remove' }).click();
	await dialog.getByLabel('Removal reason').fill('Sunday availability has changed after supervisor review.');
	await dialog.getByRole('button', { name: 'Confirm removal' }).click();
	await expect(page.getByText('Availability record removed with an audit receipt. Future roster checks no longer use it.')).toBeVisible();
	await expect(dialog.getByText('No availability records for this staff member in the displayed period.')).toBeVisible();

	await dialog.locator('.roster-availability-grid select').nth(1).selectOption('preferred');
	await dialog.getByLabel('Notes').fill('Prefers this day when coverage is available.');
	await dialog.getByRole('button', { name: 'Save availability' }).click();
	await expect(page.getByText('Staff availability saved with an audit receipt. Roster conflict checks now use this record.')).toBeVisible();
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(errors).toEqual([]);
});

test('administrator copies an existing roster assignment into a future draft', async ({ page }) => {
	await signInAsAdmin(page, '/admin/roster');
	await page.locator('.roster-operational-dock > summary').click();
	await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
	await page.getByRole('button', { name: 'Copy selected' }).click();
	const dialog = page.getByRole('dialog', { name: 'Create shift' });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel('Officer')).toHaveValue('22222222-2222-4222-8222-222222222222');
	await expect(dialog.getByLabel('Work unit')).toHaveValue('23232323-2323-4323-8323-232323232323');
	await expect(dialog.getByText('Publish immediately')).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Create shift' })).toBeVisible();
});

test('the Create shift dialog says what the shift would contain on that day before it exists', async ({ page }) => {
        let requested: Record<string, unknown> | null = null;
        await page.route('**/rest/v1/rpc/preview_work_unit_coverage', async (route) => {
                requested = JSON.parse(route.request().postData() ?? '{}');
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'patrol', ok: false, has_route: true, config_count: 3, stop_count: 0, day_of_week: 6, contracted_days: [1, 2, 3, 4, 5] }) });
        });
        await signInAsAdmin(page, '/admin/roster');
        await page.locator('.roster-operational-dock > summary').click();
        await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
        await page.getByRole('button', { name: 'Copy selected' }).click();
        const dialog = page.getByRole('dialog', { name: 'Create shift' });
        await expect(dialog.getByRole('alert')).toContainText(/No contracted stops on a \w+day for this run — the contract covers Mon–Fri\. The shift would have nothing to visit unless stops are added\./);
        expect(requested).toMatchObject({ p_work_unit_id: '23232323-2323-4323-8323-232323232323' });
        expect(String((requested as Record<string, unknown> | null)?.p_shift_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // the shift's own hours travel with the request so the contract window can be checked
        expect(String((requested as Record<string, unknown> | null)?.p_scheduled_start)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(String((requested as Record<string, unknown> | null)?.p_scheduled_end)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // still advisory: the shift can be created
        await expect(dialog.getByRole('button', { name: 'Create shift' })).toBeEnabled();
});

test('a shift outside the contracted hours, or too short for the contracted visits, is said plainly', async ({ page }) => {
        let shape: 'night' | 'short' = 'night';
        await page.route('**/rest/v1/rpc/preview_work_unit_coverage', async (route) => {
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'patrol', ok: shape !== 'night', has_route: true, config_count: 1, stop_count: 2, day_of_week: 2, contracted_days: [1, 2, 3, 4, 5], window_start: '07:00', window_end: '19:00', visits_max: 2, min_gap_minutes: 60, outside_window: shape === 'night', too_short_for_visits: shape === 'short' }) });
        });
        await signInAsAdmin(page, '/admin/roster');
        await page.locator('.roster-operational-dock > summary').click();
        await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
        await page.getByRole('button', { name: 'Copy selected' }).click();
        const dialog = page.getByRole('dialog', { name: 'Create shift' });
        await expect(dialog.getByRole('alert')).toContainText('This shift is outside the contracted hours (07:00–19:00) for this run. Every visit would already be late when the officer starts — move the shift into the window or vary the agreement.');
        shape = 'short';
        await dialog.locator('label:has(> span:text-is("Start")) input').fill('2026-09-22T07:00');
        await dialog.locator('label:has(> span:text-is("End")) input').fill('2026-09-22T07:45');
        await expect(dialog.getByRole('alert')).toContainText('2 contracted stops on a Tuesday, but the contract wants 2 visits at least 60 min apart and this shift is too short to fit them. Lengthen the shift or expect the later visits to be missed.');
        await expect(dialog.getByRole('button', { name: 'Create shift' })).toBeEnabled();
});

test('a static post whose place has no verified boundary is flagged at roster time', async ({ page }) => {
        await page.route('**/rest/v1/rpc/preview_work_unit_coverage', async (route) => {
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'static', ok: false, has_module: true, place_name: 'Tahunanui Patrol Zone', place_kind: 'zone', boundary_verified: false }) });
        });
        await signInAsAdmin(page, '/admin/roster');
        await page.locator('.roster-operational-dock > summary').click();
        await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
        await page.getByRole('button', { name: 'Copy selected' }).click();
        const dialog = page.getByRole('dialog', { name: 'Create shift' });
        await expect(dialog.getByRole('alert')).toContainText('Tahunanui Patrol Zone has no verified boundary (it is a zone, not a site), so the officer cannot record arriving or leaving the post. Verify the site boundary first.');
});
test.describe('in the roster operating timezone', () => {
        test.use({ timezoneId: 'Pacific/Auckland' });

        test('administrator repeats a selected assignment across a date range', async ({ page }) => {
                await signInAsAdmin(page, '/admin/roster');
                await page.locator('.roster-operational-dock > summary').click();
                await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
                await page.getByRole('button', { name: 'Repeat selected' }).click();
                const dialog = page.getByRole('dialog', { name: 'Repeat assignment' });
                await expect(dialog).toBeVisible();
                await expect(dialog.getByLabel('From date')).toHaveValue('2026-09-05');
                await expect(dialog.getByLabel('To date')).toHaveValue('2026-09-11');
                await expect(dialog.getByText('Creates draft assignments and skips overlapping or leave-conflicted days.')).toBeVisible();
        });
});
test('rosterer sees open shifts in the board and publishes drafts after a plain-words check', async ({ page }) => {
        const errors = monitorBrowserErrors(page);
        const json = (body: unknown) => ({ contentType: 'application/json', body: JSON.stringify(body) });
        const unit = '23232323-2323-4323-8323-232323232323';
        let published = false;
        let offerPayload: Record<string, unknown> | null = null;
        await page.route('**/rest/v1/roster_slots**', async (route) => await route.fulfill(json([
                { id: 'a1a1a1a1-0000-4000-8000-000000000001', work_unit_id: unit, staff_id: null, scheduled_start: '2026-08-25T20:00:00.000Z', scheduled_end: '2026-08-26T04:00:00.000Z', status: published ? 'published' : 'draft', linked_shift_id: null, notes: null },
                { id: 'a1a1a1a1-0000-4000-8000-000000000002', work_unit_id: unit, staff_id: '22222222-2222-4222-8222-222222222222', scheduled_start: '2026-08-27T20:00:00.000Z', scheduled_end: '2026-08-28T04:00:00.000Z', status: published ? 'published' : 'draft', linked_shift_id: null, notes: null },
        ])));
        await page.route('**/rest/v1/rpc/preview_batch_publish_roster_slots', async (route) => await route.fulfill(json([{ draft_count: 2, leave_conflict_count: 0, unassigned_count: 1, field_shift_count: 0 }])));
        await page.route('**/rest/v1/rpc/batch_publish_roster_slots', async (route) => { published = true; await route.fulfill(json([{ published_count: 2, materialized_count: 0, conflict_count: 0 }])); });
        await page.route('**/rest/v1/rpc/get_roster_batch_publish_failures', async (route) => await route.fulfill(json([])));
        await page.route('**/rest/v1/rpc/offer_overtime_by_seniority', async (route) => {
                offerPayload = JSON.parse(route.request().postData() ?? '{}');
                await route.fulfill(json([{ offers_created: 3, offer_round: 1 }]));
        });
        await signInAsAdmin(page, '/admin/roster');
        const board = page.locator('.roster-board');
        await expect(board.getByText('Open shifts', { exact: true })).toBeVisible();
        await expect(board.getByText('Nobody assigned yet', { exact: true })).toBeVisible();
        const openChip = board.locator('.roster-open-row').getByRole('button', { name: /Roster Administration/ });
        await expect(openChip).toContainText('Draft – not sent yet');
        await openChip.click();
        const inspector = page.locator('.roster-slot-inspector');
        await expect(inspector.getByText('Nobody assigned', { exact: true })).toBeVisible();
        await expect(inspector.getByText('Draft – not sent yet', { exact: true })).toBeVisible();
        await expect(inspector.getByText('Not needed for office work', { exact: true })).toBeVisible();
        await inspector.locator('header button').click();
        await page.locator('.roster-operational-dock > summary').click();
        await expect(page.locator('.roster-slot-queue').getByText('All shifts this period')).toBeVisible();
        await page.getByRole('button', { name: 'Publish 2 drafts' }).click();
        const dialog = page.getByRole('dialog', { name: 'Publish 2 draft shifts?' });
        await expect(dialog.getByText(/have nobody assigned yet/)).toBeVisible();
        await expect(dialog.getByText(/Officers see them on their schedule and can accept or decline/)).toBeVisible();
        await expect(dialog).toHaveScreenshot('roster-publish-drafts-dialog.png');
        await dialog.getByRole('button', { name: 'Publish now' }).click();
        await expect(page.getByText(/2 shifts published and 0 field shift records created\. Officers can now accept or decline\./)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Publish 0 drafts' })).toBeDisabled();
        await expect(board.locator('.roster-open-row').getByText('Waiting for officer', { exact: true })).toBeVisible();
        await openChip.click();
        await inspector.getByRole('button', { name: 'Offer overtime' }).click();
        expect(offerPayload).toMatchObject({
                p_roster_slot_id: 'a1a1a1a1-0000-4000-8000-000000000001',
                p_offer_count: 3,
                p_expires_in_minutes: 60,
        });
        await expect(page.getByText('Offered to 3 staff in seniority order (round 1). Offers expire in 60 minutes.')).toBeVisible();
        expect(errors, errors.join('\n')).toEqual([]);
});

test('work-unit planning can create and advertise an open shift without rosterable staff', async ({ page }) => {
        const json = (body: unknown) => ({ contentType: 'application/json', body: JSON.stringify(body) });
        let createPayload: Record<string, unknown> | null = null;
        let materializeCalled = false;
        await page.route('**/rest/v1/rpc/get_operating_branch_roster_staff', async (route) => await route.fulfill(json([])));
        await page.route('**/rest/v1/roster_slots**', async (route) => await route.fulfill(json([])));
        await page.route('**/rest/v1/rpc/create_roster_slot_with_break', async (route) => {
                createPayload = JSON.parse(route.request().postData() ?? '{}');
                await route.fulfill(json({
                        id: 'a1a1a1a1-0000-4000-8000-000000000003',
                        work_unit_id: '23232323-2323-4323-8323-232323232323',
                        staff_id: null,
                        scheduled_start: createPayload?.p_scheduled_start,
                        scheduled_end: createPayload?.p_scheduled_end,
                        status: 'published',
                        linked_shift_id: null,
                        notes: null,
                }));
        });
        await page.route('**/rest/v1/rpc/materialize_roster_slot', async (route) => {
                materializeCalled = true;
                await route.fulfill(json(null));
        });

        await signInAsAdmin(page, '/admin/roster');
        await page.getByRole('button', { name: 'Work unit schedule' }).click();
        const board = page.locator('.roster-board');
        await expect(board.locator('.roster-board-head').getByText('Work unit', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'ready', exact: true })).toHaveCount(0);
        await board.getByRole('button', { name: /Add shift for Roster Administration on/ }).first().click();
        const dialog = page.getByRole('dialog', { name: 'Create shift' });
        await expect(dialog.getByLabel('Officer', { exact: true })).toHaveValue('');
        await expect(dialog.getByText('Advertise open shift immediately')).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Create shift' })).toBeEnabled();
        await dialog.getByRole('button', { name: 'Create shift' }).click();

        expect(createPayload).toMatchObject({
                p_work_unit_id: '23232323-2323-4323-8323-232323232323',
                p_staff_id: null,
                p_publish: true,
        });
        expect(materializeCalled).toBe(false);
        await expect(page.getByText('Open shift published for Roster Administration. Open it on the roster and offer it to available staff.')).toBeVisible();
});

test('work-unit add targets the chosen unit even when another draft is selected', async ({ page }, testInfo) => {
        test.skip(testInfo.project.name === 'mobile-chromium', 'The mobile inspector intentionally covers the schedule until it is closed.');
        const json = (body: unknown) => ({ contentType: 'application/json', body: JSON.stringify(body) });
        await page.route('**/rest/v1/roster_slots**', async (route) => await route.fulfill(json([{
                id: '32323232-3232-4232-8232-323232323232',
                work_unit_id: '23232323-2323-4323-8323-232323232323',
                staff_id: '22222222-2222-4222-8222-222222222222',
                scheduled_start: '2026-08-28T21:00:00.000Z',
                scheduled_end: '2026-08-29T01:00:00.000Z',
                status: 'draft',
                linked_shift_id: null,
                notes: 'Roster administration',
        }])));

        await signInAsAdmin(page, '/admin/roster');
        await page.locator('.roster-operational-dock > summary').click();
        await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
        await page.getByRole('button', { name: 'Work unit schedule' }).click();
        await page.locator('.roster-board').getByRole('button', { name: /Add shift for North District Patrol on/ }).first().click();

        const dialog = page.getByRole('dialog', { name: 'Create shift' });
        await expect(dialog.getByLabel('Work unit')).toHaveValue('18181818-1818-4818-8818-181818181818');
        await expect(dialog.getByLabel('Officer')).toHaveValue('');
});

test('roster opens the branch timesheet correction and approval queue directly', async ({ page }) => {
        await signInAsAdmin(page, '/admin/roster');
        await page.getByText('Tools', { exact: true }).click();
        await page.locator('.roster-toolbar-popover').getByRole('button', { name: 'Timesheets & approvals', exact: true }).click();
        await expect(page).toHaveURL(/\/admin\/timesheets$/);
        await expect(page.getByRole('heading', { name: 'Timesheets & approvals', exact: true })).toBeVisible();
        await expect(page.getByLabel('Hours approval status')).toBeVisible();
});

test('roster page explains what to set up first when the branch has nothing to roster', async ({ page }) => {
        const json = (body: unknown) => ({ contentType: 'application/json', body: JSON.stringify(body) });
        await page.route('**/rest/v1/roster_work_units**', async (route) => await route.fulfill(json([])));
        await page.route('**/rest/v1/roster_slots**', async (route) => await route.fulfill(json([])));
        await page.route('**/rest/v1/rpc/get_operating_branch_roster_staff', async (route) => await route.fulfill(json([])));
        await signInAsAdmin(page, '/admin/roster');
        await expect(page.getByText('Nothing to roster against yet')).toBeVisible();
        await expect(page.getByText(/Build a patrol run from a client agreement in Client Portfolios/)).toBeVisible();
        await expect(page.locator('.roster-setup-banner').getByRole('button', { name: 'Client Portfolios' })).toBeVisible();
        await expect(page.locator('.roster-setup-banner').getByRole('button', { name: 'Work units' })).toBeVisible();
        await expect(page.locator('.roster-setup-banner').getByRole('button', { name: 'People' })).toBeVisible();
        await expect(page.locator('.roster-board')).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Publish .*draft/ })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Create shift' })).toHaveCount(0);
});
test('the Create shift dialog shows the officer\'s rest, hours and days in a row and says when the roster will refuse', async ({ page }) => {
        let requested: Record<string, unknown> | null = null;
        await page.route('**/rest/v1/rpc/preview_roster_assignment', async (route) => {
                const payload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>; requested = payload;
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff_id: payload.p_staff_id, work_ready: true, rules: { min_rest_hours_between_shifts: 10, max_hours_per_week: 60, max_consecutive_days: 6, enforced: true }, rest_hours: 4, week_start: '2026-08-24', week_hours: 44, consecutive_days: 3, availability_conflict: false, conflict: "Only 4 hours' rest from the nearest other shift; this organisation requires 10", credential_warnings: [{ credential_type: 'Security licence', expiry_date: '2026-08-28', verified: true }] }) });
        });
        await signInAsAdmin(page, '/admin/roster');
        await page.locator('.roster-operational-dock > summary').click();
        await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
        await page.getByRole('button', { name: 'Copy selected' }).click();
        const dialog = page.getByRole('dialog', { name: 'Create shift' });
        const notes = dialog.locator('.roster-assignment-note');
        await expect(notes.nth(0)).toHaveClass(/is-stop/);
        await expect(notes.nth(0)).toContainText("The roster will refuse this: Only 4 hours' rest from the nearest other shift; this organisation requires 10.");
        await expect(notes.nth(1)).toContainText('Security licence expires 28 Aug 2026, before this shift ends.');
        expect(requested).toMatchObject({ p_staff_id: '22222222-2222-4222-8222-222222222222' });
        expect(String((requested as Record<string, unknown> | null)?.p_scheduled_start)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // the server decides; the dialog still lets the rosterer try and shows the refusal inline
        await expect(dialog.getByRole('button', { name: 'Create shift' })).toBeEnabled();
});

test('when the employer has no rest and hours rules the Create shift dialog says the roster is not checking fatigue', async ({ page }) => {
        await page.route('**/rest/v1/rpc/preview_roster_assignment', async (route) => {
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff_id: '22222222-2222-4222-8222-222222222222', work_ready: true, rules: null, rest_hours: null, week_start: '2026-08-24', week_hours: 4, consecutive_days: 1, availability_conflict: false, conflict: null, credential_warnings: [] }) });
        });
        await page.route('**/rest/v1/rpc/create_roster_slot_with_break', async (route) => {
                await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'P0001', message: "Fatigue rule breach: Only 4 hours' rest from the nearest other shift; this organisation requires 10", details: null, hint: null }) });
        });
        await signInAsAdmin(page, '/admin/roster');
        await page.locator('.roster-operational-dock > summary').click();
        await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
        await page.getByRole('button', { name: 'Copy selected' }).click();
        const dialog = page.getByRole('dialog', { name: 'Create shift' });
        const notes = dialog.locator('.roster-assignment-note');
        await expect(notes.nth(0)).toContainText('4 h in the week starting 24 Aug 2026 · no other shift nearby · day 1 in a row.');
        await expect(notes.nth(1)).toContainText('No rest and hours rules are set for this officer\'s employer, so the roster is not checking fatigue. Set them in Rosters › Shift setup & open shifts › Rest & hours rules.');
        // a server refusal lands inside the dialog, not behind it
        await dialog.getByRole('button', { name: 'Create shift' }).click();
        const refusal = dialog.getByRole('alert').filter({ hasText: "Fatigue rule breach: Only 4 hours' rest from the nearest other shift; this organisation requires 10" });
        await expect(refusal).toBeVisible();
        // changing the shift clears the refusal that was about the previous times
        await dialog.getByLabel('End').fill('2026-09-05T23:00');
        await expect(refusal).toHaveCount(0);
});
