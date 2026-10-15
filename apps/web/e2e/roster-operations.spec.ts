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

test('enterprise roster week board is operational and visually stable', async ({ page }) => {
 const errors=monitorBrowserErrors(page); await signInAsAdmin(page,'/admin/roster');
 await expect(page.getByRole('heading',{name:'Roster',exact:true})).toBeVisible();
 const board=page.locator('.roster-board');await expect(board.getByText('Ana Ngata',{exact:true})).toBeVisible(); await expect(board.getByText('Jordan Lee',{exact:true})).toBeVisible();
 await expect(page).toHaveScreenshot('roster-overview-first-viewport.png');
 if((page.viewportSize()?.width??0)<900){await expect(page.locator('.roster-board-scroll-cue')).toBeVisible();const boardSize=await board.evaluate((element)=>({scrollWidth:element.scrollWidth,clientWidth:element.clientWidth}));expect(boardSize.scrollWidth).toBeGreaterThan(boardSize.clientWidth);}
 await page.getByRole('button',{name:'2 weeks'}).click();await expect(page.locator('.roster-board-head>div')).toHaveCount(15);expect(await board.evaluate((element)=>element.scrollWidth>element.clientWidth)).toBe(true);await page.getByRole('button',{name:'Month'}).click();await expect(page.locator('.roster-board-head>div')).toHaveCount(32);for(let index=0;index<7;index+=1)await page.getByTitle('Previous period').click();await expect(page.getByLabel('Public holidays').getByText('Provincial anniversary day')).toBeVisible();await expect(page.getByLabel('Public holidays').getByText("New Year's Day",{exact:true})).toBeVisible();await expect(page.locator('.roster-horizon-bar')).toHaveScreenshot('roster-calendar-controls.png');await page.getByLabel('Regional holidays').selectOption('WGN');await expect(page.getByText('Regional public holiday calendar updated.')).toBeVisible();await page.getByRole('button',{name:'Week',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Availability restrictions'})).toBeVisible();const restriction=page.locator('.roster-availability-queue').getByRole('button',{name:/Jordan Lee/});await restriction.click();const availabilityDialog=page.getByRole('dialog',{name:'Staff availability'});await expect(availabilityDialog).toBeVisible();await expect(availabilityDialog.getByLabel('Staff member')).toHaveValue('2f2f2f2f-2222-4222-8222-222222222222');await expect(availabilityDialog.getByText('Unavailable on Sundays')).toBeVisible();await availabilityDialog.getByRole('button',{name:'Close',exact:true}).click();
 const commercialQueue=page.locator('.roster-commercial-queue');await expect(commercialQueue.getByRole('heading',{name:'Commercial readiness exceptions'})).toBeVisible();await commercialQueue.getByRole('button',{name:/Roster Administration/}).click();const commercialInspector=page.locator('.roster-slot-inspector');await expect(commercialInspector.getByText('Missing rule',{exact:true})).toBeVisible();await expect(commercialInspector.getByText('Not applicable',{exact:true})).toHaveCount(3);await expect(commercialInspector.getByText('Ready',{exact:true})).toBeVisible();await expect(commercialInspector).toHaveScreenshot('roster-commercial-readiness.png');if((page.viewportSize()?.width??0)<900){const factBackground=await commercialInspector.locator('dl > div').first().evaluate((element)=>getComputedStyle(element).backgroundColor);expect(factBackground).toBe('rgb(243, 246, 243)');}await commercialInspector.locator('header button').click();
 await expect(page.locator('.roster-board').getByText('Roster Administration',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 if((page.viewportSize()?.width??0)<600){await board.scrollIntoViewIfNeeded();await expect(page).toHaveScreenshot('roster-week-board.png');}else await expect(board).toHaveScreenshot('roster-week-board.png');
 await page.getByRole('button',{name:/08:00–\d\d:\d\d site guard/i}).click(); await expect(page.getByText('Assignment',{exact:true})).toBeVisible(); await expect(page.getByText('On track',{exact:true})).toBeVisible(); await page.locator('.roster-inspector header button').click();
 const slotQueue=page.locator('.roster-slot-queue');await slotQueue.getByRole('button',{name:/Roster Administration/}).click();await expect(page.getByText('Roster slot',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Reassign'}).click();const reassignDialog=page.getByRole('dialog',{name:'Reassign roster slot?'});await expect(reassignDialog.getByRole('button',{name:'Confirm reassignment'})).toBeDisabled();await reassignDialog.getByLabel('Replacement officer').selectOption({label:'Jordan Lee'});await reassignDialog.getByLabel('Reassignment reason').fill('Coverage plan changed after supervisor review.');await expect(reassignDialog).toHaveScreenshot('roster-reassign-slot-dialog.png');await reassignDialog.getByRole('button',{name:'Confirm reassignment'}).click();await expect(page.getByText('Roster slot reassigned. The replacement officer has been asked to accept it.')).toBeVisible();await slotQueue.getByRole('button',{name:/Roster Administration/}).click();const cancelSlot=page.getByRole('button',{name:'Cancel slot'});await cancelSlot.scrollIntoViewIfNeeded();await cancelSlot.click();const cancelDialog=page.getByRole('dialog',{name:'Cancel roster slot?'});await expect(cancelDialog.getByRole('button',{name:'Confirm cancellation'})).toBeDisabled();await cancelDialog.getByLabel('Cancellation reason').fill('Internal priorities changed for this roster period.');await expect(cancelDialog).toHaveScreenshot('roster-cancel-slot-dialog.png');await cancelDialog.getByRole('button',{name:'Confirm cancellation'}).click();await expect(page.getByText('Roster slot cancelled, and its shift with it.')).toBeVisible();
 await page.getByRole('button',{name:'risk'}).click(); await expect(board.getByText('Jordan Lee',{exact:true})).toBeVisible(); await expect(board.getByText('Ana Ngata',{exact:true})).toBeHidden();
 await page.getByRole('button',{name:/Create shift/}).click(); const dialog=page.getByRole('dialog',{name:'Create shift'}); await expect(dialog).toBeVisible(); await dialog.getByLabel('Officer',{exact:true}).selectOption('22222222-2222-4222-8222-222222222222'); await dialog.getByLabel('Start',{exact:true}).fill('2026-08-30T10:00'); await dialog.getByLabel('End',{exact:true}).fill('2026-08-30T18:00'); await expect(dialog.getByText('Publish immediately')).toBeVisible(); await expect(dialog).toHaveScreenshot('roster-create-shift-dialog.png'); await dialog.getByRole('button',{name:'Create shift'}).click(); await expect(page.getByText('Shift published for Ana Ngata. They will see it on their schedule and can accept or decline.')).toBeVisible(); expect(errors,errors.join('\n')).toEqual([]);
});

test('administrator corrects staff availability with confirmation and receipts', async ({ page }) => {
	const errors = monitorBrowserErrors(page);
	await signInAsAdmin(page, '/admin/roster');

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
        await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
        await page.getByRole('button', { name: 'Copy selected' }).click();
        const dialog = page.getByRole('dialog', { name: 'Create shift' });
        await expect(dialog.getByRole('alert')).toContainText('Tahunanui Patrol Zone has no verified boundary (it is a zone, not a site), so the officer cannot record arriving or leaving the post. Verify the site boundary first.');
});
test.describe('in the roster operating timezone', () => {
        test.use({ timezoneId: 'Pacific/Auckland' });

        test('administrator repeats a selected assignment across a date range', async ({ page }) => {
                await signInAsAdmin(page, '/admin/roster');
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
        await page.route('**/rest/v1/roster_slots**', async (route) => await route.fulfill(json([
                { id: 'a1a1a1a1-0000-4000-8000-000000000001', work_unit_id: unit, staff_id: null, scheduled_start: '2026-08-25T20:00:00.000Z', scheduled_end: '2026-08-26T04:00:00.000Z', status: published ? 'published' : 'draft', linked_shift_id: null, notes: null },
                { id: 'a1a1a1a1-0000-4000-8000-000000000002', work_unit_id: unit, staff_id: '22222222-2222-4222-8222-222222222222', scheduled_start: '2026-08-27T20:00:00.000Z', scheduled_end: '2026-08-28T04:00:00.000Z', status: published ? 'published' : 'draft', linked_shift_id: null, notes: null },
        ])));
        await page.route('**/rest/v1/rpc/preview_batch_publish_roster_slots', async (route) => await route.fulfill(json([{ draft_count: 2, leave_conflict_count: 0, unassigned_count: 1, field_shift_count: 0 }])));
        await page.route('**/rest/v1/rpc/batch_publish_roster_slots', async (route) => { published = true; await route.fulfill(json([{ published_count: 2, materialized_count: 0, conflict_count: 0 }])); });
        await page.route('**/rest/v1/rpc/get_roster_batch_publish_failures', async (route) => await route.fulfill(json([])));
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
        expect(errors, errors.join('\n')).toEqual([]);
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
        await expect(page.locator('.roster-setup-banner').getByRole('button', { name: 'People, Pay & HR' })).toBeVisible();
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
        await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
        await page.getByRole('button', { name: 'Copy selected' }).click();
        const dialog = page.getByRole('dialog', { name: 'Create shift' });
        const notes = dialog.locator('.roster-assignment-note');
        await expect(notes.nth(0)).toHaveClass(/is-stop/);
        await expect(notes.nth(0)).toContainText("The roster will refuse this: Only 4 hours' rest from the nearest other shift; this organisation requires 10.");
        await expect(notes.nth(1)).toContainText('Security licence expires 28 Aug, before this shift ends.');
        expect(requested).toMatchObject({ p_staff_id: '22222222-2222-4222-8222-222222222222' });
        expect(String((requested as Record<string, unknown> | null)?.p_scheduled_start)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // the server decides; the dialog still lets the rosterer try and shows the refusal inline
        await expect(dialog.getByRole('button', { name: 'Create shift' })).toBeEnabled();
});

test('when the employer has no rest and hours rules the Create shift dialog says the roster is not checking fatigue', async ({ page }) => {
        await page.route('**/rest/v1/rpc/preview_roster_assignment', async (route) => {
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff_id: '22222222-2222-4222-8222-222222222222', work_ready: true, rules: null, rest_hours: null, week_start: '2026-08-24', week_hours: 4, consecutive_days: 1, availability_conflict: false, conflict: null, credential_warnings: [] }) });
        });
        await page.route('**/rest/v1/rpc/create_roster_slot', async (route) => {
                await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'P0001', message: "Fatigue rule breach: Only 4 hours' rest from the nearest other shift; this organisation requires 10", details: null, hint: null }) });
        });
        await signInAsAdmin(page, '/admin/roster');
        await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
        await page.getByRole('button', { name: 'Copy selected' }).click();
        const dialog = page.getByRole('dialog', { name: 'Create shift' });
        const notes = dialog.locator('.roster-assignment-note');
        await expect(notes.nth(0)).toContainText('4 h in the week starting 24 Aug · no other shift nearby · day 1 in a row.');
        await expect(notes.nth(1)).toContainText('No rest and hours rules are set for this officer\'s employer, so the roster is not checking fatigue. Set them in People & HR › Rostering › Rest & hours rules.');
        // a server refusal lands inside the dialog, not behind it
        await dialog.getByRole('button', { name: 'Create shift' }).click();
        await expect(dialog.locator('.roster-dialog-error')).toContainText("Fatigue rule breach: Only 4 hours' rest from the nearest other shift; this organisation requires 10");
        // changing the shift clears the refusal that was about the previous times
        await dialog.getByLabel('End').fill('2026-09-05T23:00');
        await expect(dialog.locator('.roster-dialog-error')).toHaveCount(0);
});
