import{expect,test}from'@playwright/test';import{installSupabaseFixtures,monitorBrowserErrors,signInAsAdmin}from'./fixtures';
test.beforeEach(async({page})=>{await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));await installSupabaseFixtures(page);});
test('typed roster targets are visually distinct and operational',async({page})=>{const errors=monitorBrowserErrors(page);await signInAsAdmin(page,'/admin/roster-targets');await expect(page.getByRole('heading',{name:'Work units'})).toBeVisible();await expect(page.locator('.targets-list strong').getByText('North District Patrol',{exact:true})).toBeVisible();await expect(page.locator('.targets-list strong').getByText('Civic Centre Static Post',{exact:true})).toBeVisible();await expect(page.locator('.targets-list strong').getByText('Roster Administration',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await expect(page.locator('.targets-page')).toHaveScreenshot('roster-target-catalog.png');
await page.getByRole('button',{name:/New work unit/}).click();let dialog=page.getByRole('dialog',{name:'Create work unit'});await expect(dialog.getByText('Client and contract attribution remains at each generated stop-module attendance.')).toBeVisible();await dialog.getByRole('button',{name:'static'}).click();await expect(dialog.getByText('The selected agreement location and static module jointly authorize this contracted post.')).toBeVisible();await expect(dialog).toHaveScreenshot('roster-static-target-dialog.png');await dialog.getByRole('button',{name:'Cancel'}).click();
await page.getByRole('button',{name:/Add workplace/}).click();dialog=page.getByRole('dialog',{name:'Add workplace'});await dialog.getByLabel('Name').fill('Head Office');await dialog.getByLabel('Address').fill('1 Enterprise Way');await dialog.getByRole('button',{name:'Save'}).click();await expect(page.getByText('Workplace created.')).toBeVisible();
await page.getByRole('button',{name:/Add cost centre/}).click();dialog=page.getByRole('dialog',{name:'Add cost centre'});await dialog.getByLabel('Code').fill('ADMIN');await dialog.getByLabel('Name').fill('Administration');await dialog.getByRole('button',{name:'Save'}).click();await expect(page.getByText('Cost centre created.')).toBeVisible();
await page.getByRole('button',{name:/New work unit/}).click();dialog=page.getByRole('dialog',{name:'Create work unit'});await dialog.getByRole('button',{name:'internal'}).click();await expect(dialog.getByText('Internal work is provider-owned and never linked to a client agreement.')).toBeVisible();await dialog.getByLabel('Name').fill('Head Office Administration');await dialog.getByLabel('Provider workplace').selectOption({label:'Head Office'});await dialog.getByLabel('Cost centre (optional)').selectOption({label:'ADMIN · Administration'});await dialog.getByRole('button',{name:'Create work unit'}).click();await expect(page.getByText('internal work unit created.')).toBeVisible();await expect(page.getByText('Head Office Administration',{exact:true})).toBeVisible();expect(errors,errors.join('\n')).toEqual([]);});

test('administrator records required skills for a typed work unit', async ({ page }) => {
	await page.route('**/rest/v1/rpc/create_operating_roster_work_unit', async (route) => {
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '17171717-1717-4717-8717-171717171717', name: 'Medical Patrol', work_unit_type: 'patrol' }]) });
	});
	await page.route('**/rest/v1/rpc/manage_roster_work_unit_skill_requirements', async (route) => {
		const payload = JSON.parse(route.request().postData() ?? '{}');
		expect(payload.p_work_unit_id).toBe('17171717-1717-4717-8717-171717171717');
		expect(payload.p_required_skill_names).toEqual(['First aid', 'Radio operations']);
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: payload.p_work_unit_id, required_skill_names: payload.p_required_skill_names }]) });
	});
	await signInAsAdmin(page, '/admin/roster-targets');
	await page.getByRole('button', { name: /New work unit/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Create work unit' });
	await dialog.getByLabel('Name').fill('Medical Patrol');
	await dialog.getByLabel('Required skills (comma-separated)').fill('First aid, Radio operations');
	await dialog.getByLabel('Patrol route').selectOption({ index: 1 });
	await dialog.getByRole('button', { name: 'Create work unit' }).click();
	await expect(page.getByText('patrol work unit created.')).toBeVisible();
});
