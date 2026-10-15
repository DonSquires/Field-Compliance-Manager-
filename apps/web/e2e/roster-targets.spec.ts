import{expect,test}from'@playwright/test';import{installSupabaseFixtures,monitorBrowserErrors,signInAsAdmin}from'./fixtures';
test.beforeEach(async({page})=>{await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));await installSupabaseFixtures(page);});
test('typed roster targets are visually distinct and operational',async({page})=>{const errors=monitorBrowserErrors(page);await signInAsAdmin(page,'/admin/roster-targets');await expect(page.getByRole('heading',{name:'Work units'})).toBeVisible();await expect(page.locator('.targets-list strong').getByText('North District Patrol',{exact:true})).toBeVisible();await expect(page.locator('.targets-list strong').getByText('Civic Centre Static Post',{exact:true})).toBeVisible();await expect(page.locator('.targets-list strong').getByText('Roster Administration',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
await page.getByRole('button',{name:/New work unit/}).click();let dialog=page.getByRole('dialog',{name:'Create work unit'});await expect(dialog.getByText('Every stop on the run keeps its own client and contract, so billing follows the place, not the shift.')).toBeVisible();await dialog.getByRole('tab',{name:'Static post'}).click();await expect(dialog.getByText('The post is authorised by the client agreement that covers the place.')).toBeVisible();await dialog.getByLabel('Contracted location').selectOption({index:1});await expect(dialog.getByText('Covered by the agreement’s static guarding module.')).toBeVisible();await dialog.getByRole('button',{name:'Cancel'}).click();
await page.getByRole('button',{name:/Add workplace/}).click();dialog=page.getByRole('dialog',{name:'Add workplace'});await dialog.getByLabel('Name').fill('Head Office');await dialog.getByLabel('Address').fill('1 Enterprise Way');await dialog.getByRole('button',{name:'Save'}).click();await expect(page.getByText('Workplace created.')).toBeVisible();
await page.getByRole('button',{name:/Add cost centre/}).click();dialog=page.getByRole('dialog',{name:'Add cost centre'});await dialog.getByLabel('Code').fill('ADMIN');await dialog.getByLabel('Name').fill('Administration');await dialog.getByRole('button',{name:'Save'}).click();await expect(page.getByText('Cost centre created.')).toBeVisible();
await page.getByRole('button',{name:/New work unit/}).click();dialog=page.getByRole('dialog',{name:'Create work unit'});await dialog.getByRole('tab',{name:'Office / internal'}).click();await expect(dialog.getByText('Office and internal work belongs to your organisation. It is never billed to a client.')).toBeVisible();await dialog.getByLabel('Name').fill('Head Office Administration');await dialog.getByLabel('Provider workplace').selectOption({label:'Head Office'});await dialog.getByLabel('Cost centre (optional)').selectOption({label:'ADMIN · Administration'});await dialog.getByRole('button',{name:'Create work unit'}).click();await expect(page.getByText('Office / internal “Head Office Administration” created. You can roster shifts against it now.')).toBeVisible();await expect(page.getByText('Head Office Administration',{exact:true})).toBeVisible();expect(errors,errors.join('\n')).toEqual([]);});

test('administrator records required skills for a typed work unit', async ({ page }) => {
	await page.route('**/rest/v1/rpc/create_operating_roster_work_unit', async (route) => {
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '17171717-1717-4717-8717-171717171717', name: 'Medical Patrol', work_unit_type: 'patrol', updated_at: '2026-08-30T09:30:00.000Z' }]) });
	});
	await page.route('**/rest/v1/rpc/manage_roster_work_unit_skill_ids', async (route) => {
		const payload = JSON.parse(route.request().postData() ?? '{}');
		expect(payload.p_work_unit_id).toBe('17171717-1717-4717-8717-171717171717');
		expect(payload.p_expected_updated_at).toBe('2026-08-30T09:30:00.000Z');
		expect(payload.p_required_skill_ids).toEqual(['87878787-8787-4787-8787-878787878787', '88888888-8888-4888-8888-888888888888']);
		expect(payload.p_client_request_id).toMatch(/^[0-9a-f-]{36}$/);
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: payload.p_work_unit_id, required_skill_ids: payload.p_required_skill_ids }) });
	});
	await signInAsAdmin(page, '/admin/roster-targets');
	await page.getByRole('button', { name: /New work unit/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Create work unit' });
	await dialog.getByLabel('Name').fill('Medical Patrol');
	await dialog.getByLabel('First aid').check();
	await dialog.getByLabel('Radio operations').check();
	await dialog.getByLabel('Patrol route').selectOption({ index: 1 });
	await dialog.getByRole('button', { name: 'Create work unit' }).click();
        await expect(page.getByText('Patrol run “Medical Patrol” created with required skills. Staff must hold them before assignment.')).toBeVisible();
});

test('administrator corrects required skills before rostering field work', async ({ page }) => {
	await signInAsAdmin(page, '/admin/roster-targets');
	await page.getByRole('button', { name: 'Configure required skills for North District Patrol' }).click();
	const dialog = page.getByRole('dialog', { name: 'Required skills' });
	await expect(dialog.getByText('North District Patrol')).toBeVisible();
	await expect(dialog.getByText(/Site inductions remain separate/)).toBeVisible();
	await dialog.getByLabel('First aid').check();
	await dialog.getByLabel('Radio operations').check();
	await expect(dialog.getByText('2 required skills. New and changed assignments will be refused unless the staff member holds all of them.')).toBeVisible();
	await dialog.getByRole('button', { name: 'Save required skills' }).click();
	await expect(page.getByText('Required skills updated with an audit receipt. New and changed roster assignments now require current staff skills.')).toBeVisible();
	await expect(page.getByText('Required skills: First aid, Radio operations')).toBeVisible();
});

test('static post creation names the contracted place and blocks when the agreement lacks static guarding', async ({ page }) => {
        const json = (body: unknown) => ({ contentType: 'application/json', body: JSON.stringify(body) });
        await page.route('**/rest/v1/service_agreement_locations**', async (route) => await route.fulfill(json([
                { id: '21212121-2121-4121-8121-212121212121', service_agreement_id: '24242424-2424-4424-8424-242424242424', site_id: '25252525-2525-4525-8525-252525252525', zone_id: null },
                { id: '21212121-2121-4121-8121-212121212122', service_agreement_id: '24242424-2424-4424-8424-242424242499', site_id: '25252525-2525-4525-8525-252525252525', zone_id: null },
        ])));
        await signInAsAdmin(page, '/admin/roster-targets');
        await expect(page.locator('.targets-list article.type-static > div:nth-of-type(2) small').first()).toHaveText('Civic Centre');
        await page.getByRole('button', { name: /New work unit/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Create work unit' });
        await dialog.getByRole('tab', { name: 'Static post' }).click();
        await dialog.getByLabel('Contracted location').selectOption({ index: 2 });
        await expect(dialog.getByText('This agreement does not include static guarding.')).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Create work unit' })).toBeDisabled();
        await dialog.getByLabel('Contracted location').selectOption({ index: 1 });
        await expect(dialog.getByText('Covered by the agreement’s static guarding module.')).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Create work unit' })).toBeEnabled();
});

test('a static post whose place cannot take attendance says so on its card', async ({ page }) => {
        await page.route('**/rest/v1/service_agreement_locations**', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
                { id: '21212121-2121-4121-8121-212121212121', service_agreement_id: '24242424-2424-4424-8424-242424242424', site_id: '25252525-2525-4525-8525-252525252525', zone_id: null },
                { id: '27272727-2727-4727-8727-272727272727', service_agreement_id: '24242424-2424-4424-8424-242424242424', site_id: null, zone_id: '66666666-6666-4666-8666-666666666666' },
                { id: '28282828-2828-4828-8828-282828282828', service_agreement_id: '24242424-2424-4424-8424-242424242424', site_id: '29292929-2929-4929-8929-292929292929', zone_id: null },
        ]) }));
        await page.route('**/rest/v1/client_sites**', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
                { id: '25252525-2525-4525-8525-252525252525', name: 'Civic Centre', boundary_verification: 'verified' },
                { id: '29292929-2929-4929-8929-292929292929', name: 'Harbour Depot', boundary_verification: 'pending' },
        ]) }));
        await page.route('**/rest/v1/location_zones**', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '66666666-6666-4666-8666-666666666666', name: 'Civic Event Operations Zone' }]) }));
        await page.route('**/rest/v1/roster_work_units**', async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
                { id: '20202020-2020-4020-8020-202020202020', name: 'Civic Centre Static Post', work_unit_type: 'static', service_type: 'static_guarding', active: true, patrol_route_id: null, service_agreement_location_id: '21212121-2121-4121-8121-212121212121', service_agreement_module_id: '22222222-2222-4222-8222-222222222222', workplace_id: null, team_id: null, cost_centre_id: null, required_skill_names: [] },
                { id: '30303030-3030-4030-8030-303030303030', name: 'Events Zone Static Post', work_unit_type: 'static', service_type: 'static_guarding', active: true, patrol_route_id: null, service_agreement_location_id: '27272727-2727-4727-8727-272727272727', service_agreement_module_id: '22222222-2222-4222-8222-222222222222', workplace_id: null, team_id: null, cost_centre_id: null, required_skill_names: [] },
                { id: '31313131-3131-4131-8131-313131313131', name: 'Harbour Depot Static Post', work_unit_type: 'static', service_type: 'static_guarding', active: true, patrol_route_id: null, service_agreement_location_id: '28282828-2828-4828-8828-282828282828', service_agreement_module_id: '22222222-2222-4222-8222-222222222222', workplace_id: null, team_id: null, cost_centre_id: null, required_skill_names: [] },
        ]) }));
        await signInAsAdmin(page, '/admin/roster-targets');
        await expect(page.locator('#work-unit-20202020-2020-4020-8020-202020202020')).toContainText('Civic Centre');
        await expect(page.locator('#work-unit-20202020-2020-4020-8020-202020202020').getByRole('note')).toHaveCount(0);
        await expect(page.locator('#work-unit-30303030-3030-4030-8030-303030303030').getByRole('note')).toContainText('Civic Event Operations Zone is a zone, not a site, so the officer cannot record arriving at or leaving this post.');
        await expect(page.locator('#work-unit-31313131-3131-4131-8131-313131313131').getByRole('note')).toContainText('Harbour Depot has no verified boundary yet, so the officer cannot record arriving at or leaving this post. Verify the site boundary first.');
});
