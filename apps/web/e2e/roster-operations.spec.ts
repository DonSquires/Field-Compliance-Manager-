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
 const commercialQueue=page.locator('.roster-commercial-queue');await expect(commercialQueue.getByRole('heading',{name:'Commercial readiness exceptions'})).toBeVisible();await commercialQueue.getByRole('button',{name:/Roster Administration/}).click();const commercialInspector=page.locator('.roster-slot-inspector');await expect(commercialInspector.getByText('missing rule',{exact:true})).toBeVisible();await expect(commercialInspector.getByText('not applicable',{exact:true})).toHaveCount(3);await expect(commercialInspector.getByText('ready',{exact:true})).toBeVisible();await expect(commercialInspector).toHaveScreenshot('roster-commercial-readiness.png');await commercialInspector.locator('header button').click();
 await expect(page.locator('.roster-board').getByText('Roster Administration',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 if((page.viewportSize()?.width??0)<600){await board.scrollIntoViewIfNeeded();await expect(page).toHaveScreenshot('roster-week-board.png');}else await expect(board).toHaveScreenshot('roster-week-board.png');
 await page.getByRole('button',{name:/08:00 am site guard/i}).click(); await expect(page.getByText('Assignment',{exact:true})).toBeVisible(); await expect(page.getByText('on_track',{exact:true})).toBeVisible(); await page.locator('.roster-inspector header button').click();
 const slotQueue=page.locator('.roster-slot-queue');await slotQueue.getByRole('button',{name:/Roster Administration/}).click();await expect(page.getByText('Roster slot',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Reassign'}).click();const reassignDialog=page.getByRole('dialog',{name:'Reassign roster slot?'});await expect(reassignDialog.getByRole('button',{name:'Confirm reassignment'})).toBeDisabled();await reassignDialog.getByLabel('Replacement officer').selectOption({label:'Jordan Lee'});await reassignDialog.getByLabel('Reassignment reason').fill('Coverage plan changed after supervisor review.');await expect(reassignDialog).toHaveScreenshot('roster-reassign-slot-dialog.png');await reassignDialog.getByRole('button',{name:'Confirm reassignment'}).click();await expect(page.getByText('Roster slot reassigned and returned for officer response.')).toBeVisible();await slotQueue.getByRole('button',{name:/Roster Administration/}).click();const cancelSlot=page.getByRole('button',{name:'Cancel slot'});await cancelSlot.scrollIntoViewIfNeeded();await cancelSlot.click();const cancelDialog=page.getByRole('dialog',{name:'Cancel roster slot?'});await expect(cancelDialog.getByRole('button',{name:'Confirm cancellation'})).toBeDisabled();await cancelDialog.getByLabel('Cancellation reason').fill('Internal priorities changed for this roster period.');await expect(cancelDialog).toHaveScreenshot('roster-cancel-slot-dialog.png');await cancelDialog.getByRole('button',{name:'Confirm cancellation'}).click();await expect(page.getByText('Roster slot cancelled with synchronized field state.')).toBeVisible();
 await page.getByRole('button',{name:'risk'}).click(); await expect(board.getByText('Jordan Lee',{exact:true})).toBeVisible(); await expect(board.getByText('Ana Ngata',{exact:true})).toBeHidden();
 await page.getByRole('button',{name:/Create shift/}).click(); const dialog=page.getByRole('dialog',{name:'Create shift'}); await expect(dialog).toBeVisible(); await dialog.getByLabel('Officer',{exact:true}).selectOption('22222222-2222-4222-8222-222222222222'); await dialog.getByLabel('Start',{exact:true}).fill('2026-08-30T10:00'); await dialog.getByLabel('End',{exact:true}).fill('2026-08-30T18:00'); await expect(dialog.getByText('Publish immediately')).toBeVisible(); await expect(dialog).toHaveScreenshot('roster-create-shift-dialog.png'); await dialog.getByRole('button',{name:'Create shift'}).click(); await expect(page.getByText('Shift published for Ana Ngata.')).toBeVisible(); expect(errors,errors.join('\n')).toEqual([]);
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

test('administrator repeats a selected assignment across a date range', async ({ page }) => {
	await signInAsAdmin(page, '/admin/roster');
	await page.locator('.roster-slot-queue').getByRole('button', { name: /Roster Administration/ }).click();
	await page.getByRole('button', { name: 'Repeat selected' }).click();
	const dialog = page.getByRole('dialog', { name: 'Repeat assignment' });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel('From date')).toHaveValue('2026-09-04');
	await expect(dialog.getByLabel('To date')).toHaveValue('2026-09-10');
	await expect(dialog.getByText('Creates draft assignments and skips overlapping or leave-conflicted days.')).toBeVisible();
});
