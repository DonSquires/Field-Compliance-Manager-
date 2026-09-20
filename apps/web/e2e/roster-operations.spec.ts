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
 await page.getByRole('button',{name:'2 weeks'}).click();await expect(page.locator('.roster-board-head>div')).toHaveCount(15);expect(await board.evaluate((element)=>element.scrollWidth>element.clientWidth)).toBe(true);await page.getByRole('button',{name:'Month'}).click();await expect(page.locator('.roster-board-head>div')).toHaveCount(32);for(let index=0;index<7;index+=1)await page.getByTitle('Previous period').click();await expect(page.getByLabel('Public holidays').getByText('Provincial anniversary day')).toBeVisible();await expect(page.getByLabel('Public holidays').getByText("New Year's Day",{exact:true})).toBeVisible();await expect(page.locator('.roster-horizon-bar')).toHaveScreenshot('roster-calendar-controls.png');await page.getByLabel('Regional holidays').selectOption('WGN');await expect(page.getByText('Regional public holiday calendar updated.')).toBeVisible();await page.getByRole('button',{name:'Week',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Availability restrictions'})).toBeVisible();const restriction=page.locator('.roster-availability-queue').getByRole('button',{name:/Jordan Lee/});await restriction.click();const restrictedDialog=page.getByRole('dialog',{name:'Create shift'});await expect(restrictedDialog).toBeVisible();await restrictedDialog.getByRole('button',{name:'Cancel'}).click();
 const commercialQueue=page.locator('.roster-commercial-queue');await expect(commercialQueue.getByRole('heading',{name:'Commercial readiness exceptions'})).toBeVisible();await commercialQueue.getByRole('button',{name:/Roster Administration/}).click();const commercialInspector=page.locator('.roster-slot-inspector');await expect(commercialInspector.getByText('Missing rule',{exact:true})).toBeVisible();await expect(commercialInspector.getByText('Not applicable',{exact:true})).toHaveCount(3);await expect(commercialInspector.getByText('Ready',{exact:true})).toBeVisible();await expect(commercialInspector).toHaveScreenshot('roster-commercial-readiness.png');await commercialInspector.locator('header button').click();
 await expect(page.locator('.roster-board').getByText('Roster Administration',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 if((page.viewportSize()?.width??0)<600){await board.scrollIntoViewIfNeeded();await expect(page).toHaveScreenshot('roster-week-board.png');}else await expect(board).toHaveScreenshot('roster-week-board.png');
 await page.getByRole('button',{name:/08:00–\d\d:\d\d site guard/i}).click(); await expect(page.getByText('Assignment',{exact:true})).toBeVisible(); await expect(page.getByText('On track',{exact:true})).toBeVisible(); await page.locator('.roster-inspector header button').click();
 const slotQueue=page.locator('.roster-slot-queue');await slotQueue.getByRole('button',{name:/Roster Administration/}).click();await expect(page.getByText('Roster slot',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Reassign'}).click();const reassignDialog=page.getByRole('dialog',{name:'Reassign roster slot?'});await expect(reassignDialog.getByRole('button',{name:'Confirm reassignment'})).toBeDisabled();await reassignDialog.getByLabel('Replacement officer').selectOption({label:'Jordan Lee'});await reassignDialog.getByLabel('Reassignment reason').fill('Coverage plan changed after supervisor review.');await expect(reassignDialog).toHaveScreenshot('roster-reassign-slot-dialog.png');await reassignDialog.getByRole('button',{name:'Confirm reassignment'}).click();await expect(page.getByText('Roster slot reassigned. The replacement officer has been asked to accept it.')).toBeVisible();await slotQueue.getByRole('button',{name:/Roster Administration/}).click();const cancelSlot=page.getByRole('button',{name:'Cancel slot'});await cancelSlot.scrollIntoViewIfNeeded();await cancelSlot.click();const cancelDialog=page.getByRole('dialog',{name:'Cancel roster slot?'});await expect(cancelDialog.getByRole('button',{name:'Confirm cancellation'})).toBeDisabled();await cancelDialog.getByLabel('Cancellation reason').fill('Internal priorities changed for this roster period.');await expect(cancelDialog).toHaveScreenshot('roster-cancel-slot-dialog.png');await cancelDialog.getByRole('button',{name:'Confirm cancellation'}).click();await expect(page.getByText('Roster slot cancelled, and its shift with it.')).toBeVisible();
 await page.getByRole('button',{name:'risk'}).click(); await expect(board.getByText('Jordan Lee',{exact:true})).toBeVisible(); await expect(board.getByText('Ana Ngata',{exact:true})).toBeHidden();
 await page.getByRole('button',{name:/Create shift/}).click(); const dialog=page.getByRole('dialog',{name:'Create shift'}); await expect(dialog).toBeVisible(); await dialog.getByLabel('Officer',{exact:true}).selectOption('22222222-2222-4222-8222-222222222222'); await dialog.getByLabel('Start',{exact:true}).fill('2026-08-30T10:00'); await dialog.getByLabel('End',{exact:true}).fill('2026-08-30T18:00'); await expect(dialog.getByText('Publish immediately')).toBeVisible(); await expect(dialog).toHaveScreenshot('roster-create-shift-dialog.png'); await dialog.getByRole('button',{name:'Create shift'}).click(); await expect(page.getByText('Shift published for Ana Ngata. They will see it on their schedule and can accept or decline.')).toBeVisible(); expect(errors,errors.join('\n')).toEqual([]);
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
        await expect(dialog.getByRole('alert')).toContainText(/No contracted stops on a \w+day for this run — the contract covers Mon, Tue, Wed, Thu, Fri\. The shift would have nothing to visit unless stops are added\./);
        expect(requested).toMatchObject({ p_work_unit_id: '23232323-2323-4323-8323-232323232323' });
        expect(String((requested as Record<string, unknown> | null)?.p_shift_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // still advisory: the shift can be created
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
test('administrator repeats a selected assignment across a date range', async ({ page }) => {
        await signInAsAdmin(page, '/admin/roster');	await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
	await page.getByRole('button', { name: 'Repeat selected' }).click();
	const dialog = page.getByRole('dialog', { name: 'Repeat assignment' });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel('From date')).toHaveValue('2026-09-04');
	await expect(dialog.getByLabel('To date')).toHaveValue('2026-09-10');
	await expect(dialog.getByText('Creates draft assignments and skips overlapping or leave-conflicted days.')).toBeVisible();
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
        await expect(page.getByText('No rosterable staff in this branch yet')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Open People, Pay & HR' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Publish 0 drafts' })).toBeDisabled();
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
});
