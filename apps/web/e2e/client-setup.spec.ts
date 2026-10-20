import { expect, test, type Page } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const CLIENT = 'c1c1c1c1-0000-4000-8000-000000000001';
const AGREEMENT = 'a1a1a1a1-0000-4000-8000-000000000001';
const SITE = '51515151-0000-4000-8000-000000000001';
const SECOND = '51515151-0000-4000-8000-000000000002';
const site = (id = SITE, name = 'Main store') => ({ id, name, address: '44 Trafalgar Street, Nelson', site_type: 'commercial_premises', gps_lat: -41.27, gps_lng: 173.28, boundary: null, boundary_verification: 'unverified' });
type Write = { fn: string; body: Record<string, unknown> };
async function setup(page: Page, resumed = false, schedules: unknown[] = [], rates: unknown[] = []) {
  await installSupabaseFixtures(page);
  const writes: Write[] = [];
  const rpc = (name: string, reply: unknown) => page.route(`**/rest/v1/rpc/${name}`, async (route) => {
    writes.push({ fn: name, body: JSON.parse(route.request().postData() ?? '{}') });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) });
  });
  await page.route('**/rest/v1/module_catalog?*', (route) => route.fulfill({ json: ['patrol', 'dispatch', 'static_guarding', 'parking_enforcement', 'noise_control'].map((module_key) => ({ module_key, active: true })) }));
  await page.route('**/rest/v1/rate_rules?*', (route) => route.fulfill({ json: rates }));
  await page.route('**/rest/v1/roster_work_units?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/service_agreement_delivery_schedules?*', (route) => route.fulfill({ json: schedules }));
  await page.route('**/rest/v1/organizations?*', async (route) => {
    if (new URL(route.request().url()).searchParams.has('name')) await route.fulfill({ json: [] });
    else await route.fallback();
  });
  if (resumed) {
    await page.route(`**/rest/v1/organizations?*`, async (route) => {
      if (new URL(route.request().url()).searchParams.get('id') === `eq.${CLIENT}`) await route.fulfill({ json: { id: CLIENT, name: 'Test client', contact_email: 'test@example.co.nz', contact_phone: null } });
      else await route.fallback();
    });
    await page.route('**/rest/v1/client_sites?*', (route) => route.fulfill({ json: [site(), site(SECOND, 'Depot')] }));
    await page.route('**/rest/v1/service_agreements?*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('client_organization_id') === `eq.${CLIENT}`) await route.fulfill({ json: [{ id: AGREEMENT, ends_on: null }] });
      else await route.fallback();
    });
    await page.route('**/rest/v1/crm_contacts?*', (route) => route.fulfill({ json: [{ id: 'primary-contact' }] }));
  }
  await rpc('manage_crm_organization', { id: CLIENT, name: 'Test client', contact_email: 'test@example.co.nz', contact_phone: null });
  await rpc('manage_crm_contact', { id: 'primary-contact' });
  await rpc('create_crm_site', [site()]);
  await rpc('ensure_crm_client_agreement', { agreement_id: AGREEMENT });
  await rpc('manage_crm_agreement_delivery_schedule', { schedule_id: 'saved-schedule' });
  await rpc('manage_operating_branch_rate_rule', { id: 'saved-rate', updated_at: '2026-10-19T00:00:00Z', amount: 24, rate_type: 'per_visit', site_id: SITE, service_type: 'patrol', name: 'Main store · patrol' });
  await rpc('create_patrol_route_from_agreement', [{ route_id: 'route-1', attached_places: 1 }]);
  await rpc('create_operating_roster_work_unit', { id: 'work-unit-1' });
  await signInAsAdmin(page, `/admin/client-setup${resumed ? `?account=${CLIENT}` : ''}`);
  if (resumed) {
    await expect(page.getByRole('button', { name: /Main store/ })).toBeVisible();
    await page.getByRole('button', { name: /Main store/ }).click();
  }
  return { writes, rpc };
}
const selectLocation = async (page: Page, name: string, mobile: boolean) => {
  if (mobile) await page.getByRole('button', { name: /^Locations \(/ }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
};

async function setupDirectory(page: Page) {
  const prepared = await setup(page, true);
  const accounts = [
    { id: CLIENT, name: 'Test client', organization_type: 'client' },
    { id: 'c2c2c2c2-0000-4000-8000-000000000002', name: 'Test council', organization_type: 'government' },
    { id: 'c3c3c3c3-0000-4000-8000-000000000003', name: 'Test enterprise', organization_type: 'private_enterprise' },
    { id: 'c4c4c4c4-0000-4000-8000-000000000004', name: 'Test contractor', organization_type: 'contractor' },
  ].map((account) => ({ ...account, active: true, status: 'active', updated_at: '2026-10-19T00:00:00Z', contact_email: 'test@example.co.nz', contact_phone: null, parent_organization_id: null }));
  await page.route('**/rest/v1/rpc/get_crm_provider_portfolio', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ json: accounts.map((account) => ({ organization_id: account.id, organization_name: account.name, organization_type: account.organization_type, organization_status: 'active', operating_provider_organization_id: body.p_operating_provider_organization_id, operating_provider_name: 'Test operating provider' })) });
  });
  await page.route('**/rest/v1/organizations?*', async (route) => {
    const ids = new URL(route.request().url()).searchParams.get('id') ?? '';
    if (ids.startsWith('in.') && ids.includes(CLIENT)) await route.fulfill({ json: accounts });
    else await route.fallback();
  });
  const primary = { id: 'primary-contact', organization_id: CLIENT, first_name: 'Mere', last_name: 'Test', email: 'test@example.co.nz', phone: '03 555 0100', mobile: null, role_title: 'Manager', is_primary: true, is_emergency: true, notes: 'Preserve existing governed notes', updated_at: '2026-10-18T00:00:00Z', deactivated_at: null };
  await page.route('**/rest/v1/crm_contacts?*', (route) => route.fulfill({ json: [primary] }));
  await prepared.rpc('manage_crm_contact', { ...primary, first_name: 'Reviewed', updated_at: '2026-10-20T00:00:00Z' });
  await page.goto(`/admin/crm?account=${CLIENT}`);
  await expect(page.getByRole('heading', { name: 'Client directory', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected client', exact: true }).getByRole('heading', { name: 'Test client', exact: true })).toBeVisible();
  return prepared;
}

test('CRM unifies its directory, inline primary contact and per-site governed matrix', async ({ page, isMobile }) => {
  const errors = monitorBrowserErrors(page);
  const { writes } = await setupDirectory(page);
  const contact = page.getByRole('form', { name: 'Primary contact editor' });
  await expect(contact.getByLabel('First name')).toHaveValue('Mere');
  await contact.getByLabel('First name').fill('Reviewed');
  await contact.getByRole('button', { name: 'Save contact' }).click();
  await expect(contact.getByRole('status')).toHaveText('Primary contact saved.');
  expect(writes.find((write) => write.fn === 'manage_crm_contact')?.body).toMatchObject({ p_action: 'update', p_account_organization_id: CLIENT, p_contact_id: 'primary-contact', p_expected_updated_at: '2026-10-18T00:00:00Z', p_notes: 'Preserve existing governed notes', p_is_emergency: true });
  const sites = page.getByRole('region', { name: 'Child sites and inline services' });
  await sites.getByRole('checkbox', { name: 'Main store Patrol', exact: true }).check();
  await sites.getByLabel('Billing rate for Main store', { exact: true }).fill('24');
  await sites.getByLabel('Schedule days for Main store').selectOption('weekdays');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('No unsaved service changes')).toBeVisible();
  expect(writes.find((write) => write.fn === 'manage_crm_agreement_delivery_schedule')?.body).toMatchObject({ p_site_id: SITE, p_active_days: [1, 2, 3, 4, 5] });
  await expect(sites.getByRole('checkbox', { name: 'Main store CCTV setup unavailable' })).toBeDisabled();
  await expect(sites.getByRole('checkbox', { name: 'Main store Static setup unavailable' })).toBeDisabled();
  const ribbon = page.getByRole('region', { name: 'Commercial totals for the last 30 days' });
  expect((await ribbon.boundingBox())?.height).toBe(40);
  if (!isMobile) expect(Math.round((await page.getByRole('complementary', { name: 'Client directory' }).boundingBox())?.width ?? 0)).toBe(340);
  const overflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth > innerWidth + 1, y: document.documentElement.scrollHeight > innerHeight + 1 }));
  expect(overflow, JSON.stringify(await page.evaluate(() => ({ viewport: [innerHeight, document.documentElement.scrollHeight], nodes: ['body', '.admin-shell-main', '.crm-page', '.crm-directory-layout', '.crm-selected-client', '.client-setup', '.crm-child-sites', '.crm-inline-primary-contact'].map((selector) => { const el = document.querySelector(selector); return [selector, el?.getBoundingClientRect().height, el?.getBoundingClientRect().bottom, el?.scrollHeight]; }) })))).toEqual({ x: false, y: false });
  expect(errors).toEqual([]);
});

test('CRM filters the merged organization directory without duplicate bottom lists', async ({ page, isMobile }) => {
  await setupDirectory(page);
  if (isMobile) await page.getByRole('button', { name: 'Directory', exact: true }).click();
  const directory = page.getByRole('complementary', { name: 'Client directory' });
  await directory.getByLabel('Directory filter').selectOption('government');
  await expect(directory.getByRole('button', { name: /Test council/ })).toBeVisible();
  await expect(directory.getByRole('button', { name: /Test enterprise/ })).toHaveCount(0);
  await directory.getByLabel('Directory filter').selectOption('private_enterprise');
  await expect(directory.getByRole('button', { name: /Test enterprise/ })).toBeVisible();
  await directory.getByLabel('Directory filter').selectOption('contractor');
  await expect(directory.getByRole('button', { name: /Test contractor/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Branches \(/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^Organizations We Contract With/ })).toHaveCount(0);
});

test('one delivery workspace saves organization, location, service and scoped rate without a wizard', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  const { writes } = await setup(page);
  await expect(page.getByRole('list', { name: 'Setup steps' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add organization' }).click();
  await page.getByLabel('Client name', { exact: true }).fill('Test client');
  await page.getByLabel('Contact first name').fill('Test');
  await page.getByLabel('Contact last name').fill('Contact');
  await page.getByLabel('Email', { exact: true }).fill('test@example.co.nz');
  await page.getByRole('button', { name: 'Save organization and contact' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`account=${CLIENT}`));
  await page.getByRole('button', { name: 'Add Location' }).click();
  await page.getByLabel('Place name').fill('Main store');
  await page.getByLabel('Address', { exact: true }).fill('44 Trafalgar Street, Nelson');
  await page.getByRole('button', { name: 'Find address' }).click();
  await page.getByRole('radiogroup', { name: 'Address matches' }).locator('label').first().click();
  await page.getByRole('button', { name: 'Create location' }).click();
  await expect(page.getByRole('heading', { name: 'Main store' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Patrol visits', exact: true }).check();
  await page.getByLabel('Visits each shift · Patrol visits').fill('2');
  await page.getByLabel('Rate · Patrol visits', { exact: true }).fill('24');
  await expect(page.getByText('1 unsaved service rows')).toBeVisible();
  expect(writes.filter((write) => write.fn === 'manage_crm_agreement_delivery_schedule')).toHaveLength(0);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('No unsaved service changes')).toBeVisible();
  expect(writes.find((write) => write.fn === 'manage_crm_agreement_delivery_schedule')?.body).toMatchObject({ p_action: 'create', p_agreement_id: AGREEMENT, p_site_id: SITE, p_module_key: 'patrol', p_visits_per_shift: 2 });
  expect(writes.find((write) => write.fn === 'manage_operating_branch_rate_rule')?.body).toMatchObject({ p_action: 'create', p_client_org_id: CLIENT, p_site_id: SITE, p_service_type: 'patrol', p_amount: 24, p_rate_type: 'per_visit' });
  await page.getByRole('button', { name: 'Build patrol run' }).click();
  await expect(page.getByRole('button', { name: 'Roster the patrol run' })).toBeVisible();
  expect(writes.find((write) => write.fn === 'create_operating_roster_work_unit')?.body).toMatchObject({ p_patrol_route_id: 'route-1' });
  await expect(page.locator('.place-context-banner.is-console')).toHaveCount(1);
  const overflow = await page.evaluate(() => ({ y: document.documentElement.scrollHeight > innerHeight + 1, x: document.documentElement.scrollWidth > innerWidth + 1 }));
  expect(overflow).toEqual({ y: false, x: false });
  expect(errors).toEqual([]);
});

test('switching locations retains unsaved drafts and cloning performs no writes', async ({ page, isMobile }) => {
  const { writes } = await setup(page, true);
  await page.getByRole('checkbox', { name: 'Patrol visits', exact: true }).check();
  await page.getByLabel('Visits each shift · Patrol visits').fill('3');
  await selectLocation(page, 'Depot', isMobile);
  await page.getByLabel('Clone service drafts from').selectOption(SITE);
  await expect(page.getByLabel('Visits each shift · Patrol visits')).toHaveValue('3');
  await selectLocation(page, 'Main store', isMobile);
  await expect(page.getByLabel('Visits each shift · Patrol visits')).toHaveValue('3');
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('No unsaved service changes')).toBeVisible();
  const schedules = writes.filter((write) => write.fn === 'manage_crm_agreement_delivery_schedule');
  expect(schedules).toHaveLength(2);
  expect(schedules.map((write) => write.body.p_site_id).sort()).toEqual([SITE, SECOND].sort());
  expect(new Set(schedules.map((write) => write.body.p_client_request_id)).size).toBe(2);
});

test('partial rate failure retries only unfinished writes with the same request identity', async ({ page }) => {
  const { writes } = await setup(page, true);
  let attempts = 0;
  await page.route('**/rest/v1/rpc/manage_operating_branch_rate_rule', async (route) => {
    attempts++;
    writes.push({ fn: 'manage_operating_branch_rate_rule', body: JSON.parse(route.request().postData() ?? '{}') });
    await route.fulfill(attempts === 1 ? { status: 403, json: { message: 'Finance permission denied' } } : { json: { id: 'rate-1', updated_at: '2026-10-19T00:00:00Z', amount: 24, rate_type: 'per_visit', site_id: SITE, service_type: 'patrol', name: 'Main store · patrol' } });
  });
  await page.getByRole('checkbox', { name: 'Patrol visits', exact: true }).check();
  await page.getByLabel('Rate · Patrol visits', { exact: true }).fill('24');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByLabel('Patrol visits save receipt')).toContainText('Needs retry');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('No unsaved service changes')).toBeVisible();
  expect(writes.filter((write) => write.fn === 'manage_crm_agreement_delivery_schedule')).toHaveLength(1);
  const rates = writes.filter((write) => write.fn === 'manage_operating_branch_rate_rule');
  expect(rates).toHaveLength(2);
  expect(rates[0].body.p_client_request_id).toBe(rates[1].body.p_client_request_id);
});

test('resumed schedule is archived locally without disabling agreement-wide services', async ({ page }) => {
  const { writes } = await setup(page, true, [{ id: 'existing-schedule', site_id: SITE, module_key: 'general_patrol', active_days: [1, 2, 3, 4, 5], window_start: '22:00:00', window_end: '06:00:00', visits_per_shift: 2, min_gap_between_visits_minutes: 60, dwell_minutes: 10, officer_instructions: 'Check doors', response_sla_minutes: null }]);
  await expect(page.getByRole('checkbox', { name: 'Patrol visits', exact: true })).toBeChecked();
  await expect(page.getByLabel('Visits each shift · Patrol visits')).toHaveValue('2');
  await page.getByRole('checkbox', { name: 'Patrol visits', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('No unsaved service changes')).toBeVisible();
  expect(writes.filter((write) => write.fn === 'manage_crm_agreement_delivery_schedule').map((write) => write.body)).toMatchObject([{ p_action: 'remove', p_schedule_id: 'existing-schedule', p_site_id: SITE }]);
  expect(writes.some((write) => write.fn === 'manage_crm_agreement_setup')).toBe(false);
});

test('only an exact site rate is updated with its optimistic timestamp', async ({ page }) => {
  const { writes } = await setup(page, true, [], [
    { id: 'exact-rate', updated_at: '2026-10-18T00:00:00Z', amount: 22, rate_type: 'per_visit', site_id: SITE, service_type: 'patrol', name: 'Main store patrol', priority: 0 },
    { id: 'shared-rate', updated_at: '2026-10-18T00:00:00Z', amount: 99, rate_type: 'per_visit', site_id: null, service_type: 'patrol', name: 'Shared default', priority: 0 },
  ]);
  await page.getByRole('checkbox', { name: 'Patrol visits', exact: true }).check();
  await expect(page.getByLabel('Rate · Patrol visits', { exact: true })).toHaveValue('22');
  await page.getByLabel('Rate · Patrol visits', { exact: true }).fill('24');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('No unsaved service changes')).toBeVisible();
  expect(writes.find((write) => write.fn === 'manage_operating_branch_rate_rule')?.body).toMatchObject({ p_action: 'update', p_rate_rule_id: 'exact-rate', p_expected_updated_at: '2026-10-18T00:00:00Z', p_site_id: SITE, p_client_org_id: CLIENT });
  expect(writes.some((write) => write.body.p_rate_rule_id === 'shared-rate')).toBe(false);
});

test('qualified site rates are retained rather than flattened into matrix defaults', async ({ page }) => {
  const { writes } = await setup(page, true, [], [{ id: 'night-rate', updated_at: '2026-10-18T00:00:00Z', amount: 36, rate_type: 'per_visit', site_id: SITE, service_type: 'patrol', module_key: 'noise_control', priority: 0 }]);
  await page.getByRole('checkbox', { name: 'Patrol visits', exact: true }).check();
  await expect(page.getByLabel('Rate · Patrol visits', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('No unsaved service changes')).toBeVisible();
  expect(writes.filter((write) => write.fn === 'manage_operating_branch_rate_rule')).toHaveLength(0);
});

test('building an existing run reuses its work unit instead of creating another', async ({ page }) => {
  const { writes } = await setup(page, true);
  await page.route('**/rest/v1/roster_work_units?*', (route) => route.fulfill({ json: [{ id: 'existing-work-unit' }] }));
  await page.getByRole('button', { name: 'Build patrol run' }).click();
  await expect(page.getByRole('button', { name: 'Roster the patrol run' })).toBeVisible();
  expect(writes.filter((write) => write.fn === 'create_operating_roster_work_unit')).toHaveLength(0);
});

test('Bob quick setup discloses the unsupported bridge and never sends contract text', async ({ page }) => {
  const { writes } = await setup(page, true);
  await page.getByRole('button', { name: 'Bob Quick Setup' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bob Quick Setup' });
  await expect(dialog.getByLabel('Paste contract')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Propose location drafts' })).toBeDisabled();
  await expect(dialog).toContainText('No approved bridge currently promotes those proposals into this matrix');
  await expect(dialog.getByRole('button', { name: 'Open governed Document Studio' })).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('spatial review and optional invitation remain governed inline actions', async ({ page }) => {
  const { writes, rpc } = await setup(page, true);
  await rpc('propose_boundary', [{ proposal_id: 'b1b1b1b1-0000-4000-8000-000000000001' }]);
  await rpc('accept_boundary_proposal', [{ entity_id: SITE }]);
  await rpc('prepare_crm_client_invitation', { email: 'test@example.co.nz', display_name: 'Test client' });
  await page.route('**/functions/v1/invite-org', (route) => route.fulfill({ json: { success: true } }));
  await page.getByRole('button', { name: 'Spatial context' }).click();
  const map = page.getByRole('region', { name: 'Map for Main store' });
  await expect(map).toBeVisible();
  await expect(map.getByText(/Boundary found and set from LINZ/)).toBeVisible();
  expect(writes.find((write) => write.fn === 'propose_boundary')?.body).toMatchObject({ p_entity_type: 'client_site', p_entity_id: SITE, p_source: 'linz_parcel' });
  expect(writes.find((write) => write.fn === 'accept_boundary_proposal')?.body).toMatchObject({ p_verify: false });
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('button', { name: 'Client invitation' }).click();
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('dialog')).toContainText('Invitation sent to test@example.co.nz');
  expect(writes.find((write) => write.fn === 'prepare_crm_client_invitation')?.body).toMatchObject({ p_account_organization_id: CLIENT });
});

test('a duplicate client name offers the existing organization rather than another create', async ({ page }) => {
  await setup(page);
  await page.route('**/rest/v1/organizations?*', async (route) => {
    if (route.request().url().includes('ilike')) await route.fulfill({ json: [{ id: CLIENT, name: 'Test client' }] });
    else await route.fallback();
  });
  await page.getByRole('button', { name: 'Add organization' }).click();
  await page.getByLabel('Client name', { exact: true }).fill('Test');
  await expect(page.locator('.client-setup-matches')).toContainText('Already on the books?');
  await expect(page.locator('.client-setup-matches').getByRole('button', { name: 'Test client' })).toBeVisible();
});
