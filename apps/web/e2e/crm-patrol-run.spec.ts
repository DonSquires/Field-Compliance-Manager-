import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const accountId = '40404040-4040-4040-8040-404040404040';
const agreementId = '24242424-2424-4424-8424-242424242424';
const civicCentreSiteId = '25252525-2525-4525-8525-252525252525';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
});

test('admin turns the accepted agreement places into a patrol run the roster can use', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  let routed = false;
  let buildPayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/service_agreements**', async (route) => {
    const select = new URL(route.request().url()).searchParams.get('select') ?? '';
    if (!select.startsWith('id,name,agreement_type,invitation_status,provider_organization_id,client_organization_id')) { await route.fallback(); return; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: agreementId, name: 'Civic Events Compliance Services', agreement_type: 'operational', invitation_status: 'accepted', provider_organization_id: '41414141-4141-4141-8141-414141414141', client_organization_id: accountId }]) });
  });
  await page.route('**/rest/v1/service_agreement_delivery_schedules**', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { id: '30303030-3030-4030-8030-303030303030', service_agreement_id: agreementId, proposal_scope_schedule_id: '31313131-3131-4131-8131-313131313131', site_id: civicCentreSiteId, zone_id: null, capability_key: 'patrol', work_model: 'scheduled_patrol', active_days: [1, 2, 3, 4, 5, 6, 7], visits_per_shift: 2, window_start: '22:00:00', window_end: '00:00:00', dwell_minutes: 10, response_sla_minutes: 30, depart_sla_minutes: 45, preferred_stop_order: 1, officer_instructions: 'Check the north loading doors and the ticket booth shutters.' },
  ]) }));
  await page.route('**/rest/v1/client_site_patrol_config**', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { id: '32323232-3232-4232-8232-323232323232', proposal_scope_schedule_id: '31313131-3131-4131-8131-313131313131', patrol_route_id: routed ? '33333333-3333-4333-8333-333333333339' : null },
  ]) }));
  await page.route('**/rest/v1/patrol_routes**', async (route) => await route.fulfill({ contentType: 'application/json', body: JSON.stringify(routed
    ? [{ id: '19191919-1919-4919-8919-191919191919', name: 'North District Patrol' }, { id: '33333333-3333-4333-8333-333333333339', name: 'Civic Events Compliance Services patrol run' }]
    : [{ id: '19191919-1919-4919-8919-191919191919', name: 'North District Patrol' }]) }));
  await page.route('**/rest/v1/rpc/create_patrol_route_from_agreement', async (route) => {
    buildPayload = JSON.parse(route.request().postData() ?? '{}');
    routed = true;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ route_id: '33333333-3333-4333-8333-333333333339', route_name: 'Civic Events Compliance Services patrol run', created: true, attached_places: 1, skipped_places: 0 }]) });
  });

  await signInAsAdmin(page, '/admin/crm');
  await page.locator(`#crm-account-${accountId}`).click();
  const portfolio = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await portfolio.getByRole('button', { name: 'Agreements 1' }).first().click();

  const run = portfolio.getByRole('region', { name: 'Patrol run for Civic Events Compliance Services' });
  await expect(run).toContainText('Places and times');
  await expect(run).toContainText('Civic Centre');
  await expect(run).toContainText('2 visits per shift · 22:00–00:00 · 10 min on site · Every day');
  await expect(run).toContainText('Check the north loading doors and the ticket booth shutters.');
  await expect(run).toContainText('Not built yet. This turns the places above into a route the roster can use.');
  await expect(run).toContainText('Available after the patrol run is built.');
  await expect(run).toHaveScreenshot('crm-patrol-run-before.png');

  await run.getByRole('button', { name: 'Build patrol run' }).click();
  await expect(portfolio.getByText(/Civic Events Compliance Services patrol run is built with 1 place\. Next: add a work unit so it can be rostered\./)).toBeVisible();
  expect(buildPayload).toMatchObject({ p_service_agreement_id: agreementId });
  await expect(run).toContainText('Civic Events Compliance Services patrol run · 1 place. Shifts on this run get one stop per visit, with the instructions above.');
  await expect(run).toContainText('Give the run a rosterable name so officers can be scheduled onto it.');

  await run.getByRole('button', { name: 'Add work unit for this run' }).click();
  const form = portfolio.locator('.crm-operational-work-form');
  await expect(form.getByLabel('Work type', { exact: true })).toHaveValue('patrol');
  await expect(form.getByLabel('Patrol route', { exact: true })).toHaveValue('33333333-3333-4333-8333-333333333339');
  await expect(form.getByLabel('Work unit name', { exact: true })).toHaveValue('Civic Events Compliance Services patrol run');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('the Client Portfolio shows what was delivered at the agreement\'s places — the same numbers the client sees', async ({ page }) => {
  let requested: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/service_agreements**', async (route) => {
    const select = new URL(route.request().url()).searchParams.get('select') ?? '';
    if (!select.startsWith('id,name,agreement_type,invitation_status,provider_organization_id,client_organization_id')) { await route.fallback(); return; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: agreementId, name: 'Civic Events Compliance Services', agreement_type: 'operational', invitation_status: 'accepted', provider_organization_id: '41414141-4141-4141-8141-414141414141', client_organization_id: accountId }]) });
  });
  await page.route('**/rest/v1/rpc/get_agreement_service_delivery', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    requested = payload;
    const lastMonth = String(payload.p_period_start).startsWith('2026-07');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      agreement_id: agreementId, period_start: payload.p_period_start, period_end: payload.p_period_end,
      places: [{ location_id: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', place_name: 'Civic Centre', place_kind: 'site', patrol_expected: lastMonth ? 31 : 27, patrol_completed: lastMonth ? 31 : 25, patrol_missed: lastMonth ? 0 : 2, patrol_late: 0, post_expected: 4, post_attended: lastMonth ? 4 : 3, post_minutes: 1455, last_presence_at: '2026-08-29T20:40:00.000Z', shift_count: 31 }],
      totals: { patrol_expected: lastMonth ? 31 : 27, patrol_completed: lastMonth ? 31 : 25, patrol_missed: lastMonth ? 0 : 2, patrol_late: 0, post_expected: 4, post_attended: lastMonth ? 4 : 3, post_minutes: 1455, place_count: 1 },
    }) });
  });
  await signInAsAdmin(page, '/admin/crm');
  await page.locator(`#crm-account-${accountId}`).click();
  const portfolio = page.getByRole('dialog', { name: 'Civic Events Limited' });
  await portfolio.getByRole('button', { name: 'Agreements 1' }).first().click();

  const delivered = portfolio.getByRole('region', { name: "Delivered at this agreement's places" });
  await expect(delivered).toContainText('25/27');
  await expect(delivered.locator('.crm-agreement-delivery-places li').filter({ hasText: 'Civic Centre' })).toContainText('25 of 27 contracted visits done · 2 missed visits · 3 guard attendances of 4 rostered · 24h 15m on post');
  await expect(delivered.locator('.crm-agreement-delivery-places li').first()).toHaveClass(/has-gaps/);
  await expect(delivered.getByText(/The client can see these gaps too\./)).toBeVisible();
  expect(requested).toMatchObject({ p_agreement_id: agreementId, p_period_start: '2026-08-01', p_period_end: '2026-08-31' });

  await delivered.getByRole('button', { name: 'Last month' }).click();
  await expect(delivered).toContainText('31/31');
  await expect(delivered.getByText(/The client can see these gaps too\./)).toHaveCount(0);
  expect(requested).toMatchObject({ p_period_start: '2026-07-01', p_period_end: '2026-07-31' });
});
