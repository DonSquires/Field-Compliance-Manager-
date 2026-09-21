import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

// The guided client setup: five plain steps, each one saving through a governed writer, nothing invented.
test('an administrator sets up a new client in five plain steps and is handed the next thing to do', async ({ page, isMobile }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  const writes: Array<{ fn: string; body: Record<string, unknown> }> = [];
  const rpc = (name: string, reply: unknown) => page.route(`**/rest/v1/rpc/${name}`, async (route) => {
    writes.push({ fn: name, body: JSON.parse(route.request().postData() ?? '{}') });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) });
  });
  await rpc('manage_crm_organization', { id: 'c1c1c1c1-0000-4000-8000-000000000001', name: 'Trafalgar Street Dairy Ltd', contact_email: 'mere@example.co.nz', contact_phone: '03 555 0142', status: 'prospect' });
  await rpc('manage_crm_contact', { id: 'k1' });
  // create_crm_site returns a table (one row), as the live function does
  await rpc('create_crm_site', [{ id: 's1s1s1s1-0000-4000-8000-000000000001', name: 'Main store', address: '44 Trafalgar Street, The Wood, Nelson', site_type: 'commercial_premises', active: true, boundary_status: 'provisional', boundary_verification: 'unverified', created: true }]);
  await rpc('ensure_crm_client_agreement', { agreement_id: 'a1a1a1a1-0000-4000-8000-000000000001', created: true, invitation_status: 'not_invited' });
  await rpc('manage_crm_agreement_delivery_schedule', { schedule_id: 'd1d1d1d1-0000-4000-8000-000000000001', patrol_config_id: 'p1', module_key: 'general_patrol' });
  await rpc('create_patrol_route_from_agreement', [{ route_id: 'r1r1r1r1-0000-4000-8000-000000000001', route_name: 'Trafalgar Street Dairy Ltd patrol run', created: true, attached_places: 1, skipped_places: 0 }]);
  await rpc('create_operating_roster_work_unit', { id: 'w1w1w1w1-0000-4000-8000-000000000001', name: 'Trafalgar Street Dairy Ltd patrol run' });

  await signInAsAdmin(page, '/admin/crm');
  // the GPS / geofence evidence banner is a field thing; it stays off desk pages
  await expect(page.locator('.place-context-banner')).toHaveCount(0);
  await page.getByRole('button', { name: 'Set up a new client' }).first().click();
  await expect(page.getByRole('heading', { name: 'Set up a new client' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Setup steps' })).toContainText('Who');

  // 1 Who
  await page.getByLabel('Client name').fill('Trafalgar Street Dairy Ltd');
  await page.getByLabel('Contact first name').fill('Mere');
  await page.getByLabel('Email').fill('mere@example.co.nz');
  await page.getByRole('button', { name: 'Save client and continue' }).click();
  await expect(page.getByRole('heading', { name: /Where do we work for Trafalgar Street Dairy Ltd/ })).toBeVisible();
  expect(writes.find((write) => write.fn === 'manage_crm_organization')?.body).toMatchObject({ p_action: 'create', p_name: 'Trafalgar Street Dairy Ltd', p_organization_type: 'client' });
  expect(writes.find((write) => write.fn === 'manage_crm_contact')?.body).toMatchObject({ p_first_name: 'Mere', p_is_primary: true });
  expect(page.url()).toContain('account=c1c1c1c1-0000-4000-8000-000000000001');

  // 2 Where
  await page.getByLabel('Place name').fill('Main store');
  await page.getByLabel('Address').fill('44 Trafalgar Street, Nelson');
  await page.getByRole('button', { name: 'Find address' }).click();
  await page.getByRole('radiogroup', { name: 'Address matches' }).locator('label').first().click();
  await page.getByRole('button', { name: 'Add this place' }).click();
  await expect(page.locator('.client-setup-list li').first()).toContainText('Main store');
  await expect(page.locator('.client-setup-list li').first()).toContainText('44 Trafalgar Street, The Wood, Nelson');
  const site = writes.find((write) => write.fn === 'create_crm_site')?.body;
  expect(site).toMatchObject({ p_name: 'Main store', p_site_type: 'commercial_premises' });
  expect(typeof site?.p_center_lat).toBe('number');
  await page.getByRole('button', { name: 'Continue' }).click();

  // 3 What we do — the read-back sentence says the contract the way a manager would
  await expect(page.getByRole('heading', { name: 'What do we do there?' })).toBeVisible();
  await page.getByLabel('Service').selectOption('patrol');
  await page.getByRole('radiogroup', { name: 'Which days' }).getByText('Weekdays').click();
  await page.getByRole('radiogroup', { name: 'What hours' }).getByText('Between set hours').click();
  await page.getByLabel('From', { exact: true }).fill('22:00');
  await page.getByLabel('To', { exact: true }).fill('06:00');
  await page.getByLabel('Visits each shift').fill('2');
  await expect(page.locator('.client-setup-readback')).toContainText('Patrol visits · Mon–Fri · 22:00–06:00 · 2 visits a shift, 10 min each');
  await page.getByRole('button', { name: 'Save this service' }).click();
  await expect(page.locator('.client-setup-list li').first()).toContainText('Patrol visits · Mon–Fri · 22:00–06:00');
  expect(writes.find((write) => write.fn === 'ensure_crm_client_agreement')?.body).toMatchObject({ p_account_organization_id: 'c1c1c1c1-0000-4000-8000-000000000001' });
  expect(writes.find((write) => write.fn === 'manage_crm_agreement_delivery_schedule')?.body).toMatchObject({ p_action: 'create', p_agreement_id: 'a1a1a1a1-0000-4000-8000-000000000001', p_site_id: 's1s1s1s1-0000-4000-8000-000000000001', p_module_key: 'patrol', p_active_days: [1, 2, 3, 4, 5], p_window_start: '22:00', p_window_end: '06:00', p_visits_per_shift: 2 });
  // the tall card does not stitch cleanly under the mobile shell header; the desktop baseline carries the visual check
  if (!isMobile) await expect(page.locator('.client-setup-card')).toHaveScreenshot('client-setup-services.png', { maxDiffPixelRatio: 0.03 });
  await page.getByRole('button', { name: 'Continue' }).click();

  // 4 Who logs in — optional
  await expect(page.getByRole('heading', { name: /Who logs in for/ })).toBeVisible();
  await expect(page.locator('.client-setup-invite')).toContainText('Sending is optional');
  await page.getByRole('button', { name: 'Skip for now' }).click();

  // 5 Done — the run is built from the saved services and the next step is offered
  await expect(page.getByRole('heading', { name: 'Trafalgar Street Dairy Ltd is set up' })).toBeVisible();
  await expect(page.locator('.client-setup-card.is-done')).toContainText('The patrol run is built with 1 place and is ready to roster.');
  await expect(page.locator('.client-setup-summary')).toContainText('Not invited yet');
  expect(writes.find((write) => write.fn === 'create_patrol_route_from_agreement')?.body).toMatchObject({ p_service_agreement_id: 'a1a1a1a1-0000-4000-8000-000000000001', p_name: 'Trafalgar Street Dairy Ltd patrol run' });
  expect(writes.find((write) => write.fn === 'create_operating_roster_work_unit')?.body).toMatchObject({ p_work_unit_type: 'patrol', p_patrol_route_id: 'r1r1r1r1-0000-4000-8000-000000000001' });
  await expect(page.getByRole('button', { name: 'Roster the patrol run' })).toBeVisible();
  await page.getByRole('button', { name: 'Roster the patrol run' }).click();
  await expect(page).toHaveURL(/\/admin\/roster\?.*work_unit=w1w1w1w1-0000-4000-8000-000000000001/);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('a typed name that matches an existing client offers to open it instead of creating a duplicate', async ({ page }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/organizations?*', async (route) => {
    if (route.request().url().includes('ilike')) { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'e1e1e1e1-0000-4000-8000-000000000001', name: 'Trafalgar Street Dairy Ltd', status: 'active' }]) }); return; }
    await route.fallback();
  });
  await signInAsAdmin(page, '/admin/client-setup');
  await page.getByLabel('Client name').fill('Trafalgar');
  const matches = page.locator('.client-setup-matches');
  await expect(matches).toContainText('Already on the books?');
  await expect(matches.getByRole('button', { name: /Trafalgar Street Dairy Ltd/ })).toBeVisible();
});
