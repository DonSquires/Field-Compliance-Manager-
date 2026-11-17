import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const LOCATION_ID = '65656565-6565-4565-8565-656565656565';
const CLIENT_ID = '40404040-4040-4040-8040-404040404040';
const PROVIDER_ID = '41414141-4141-4141-8141-414141414141';
const AGREEMENT_ID = '57575757-5757-4757-8757-575757575757';
const ZONE_ID = '58585858-5858-4858-8858-585858585858';
const SCHEDULE_ID = '59595959-5959-4959-8959-595959595959';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-16T09:00:00+13:00'));
  await installSupabaseFixtures(page);
});

test('a zone-only place gets a sunset-to-sunrise patrol with a gate check after preview and confirmation', async ({ page }, testInfo) => {
  const errors = monitorBrowserErrors(page);
  let saved: Record<string, unknown> | null = null;
  const workspace = () => ({
    location: { id: LOCATION_ID, name: 'Civic Events House', organization_id: CLIENT_ID },
    anchors: [{ kind: 'zone', id: ZONE_ID, name: 'Foreshore camping area', has_point: true }],
    agreements: [{ id: AGREEMENT_ID, provider_organization_id: PROVIDER_ID, name: 'Civic patrol agreement' }],
    services: saved ? [{
      delivery_schedule_id: SCHEDULE_ID, service_agreement_id: AGREEMENT_ID, service_kind: 'patrol',
      module_key: 'general_patrol', anchor: { site_id: null, zone_id: ZONE_ID }, active: true,
      terms: saved, effective_from: '2026-11-16', pending: null, responsibility: null, work_unit: null,
    }] : [],
    modules: [{ module_key: 'general_patrol', toolset_key: 'patrol' }],
    check_types: [
      { id: '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a', check_key: 'gate_check', label: 'Gate check', needs_photo: false, needs_note: false, is_global: true },
      { id: '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b', check_key: 'lock_up', label: 'Lock up', needs_photo: false, needs_note: false, is_global: true },
    ],
    seasons: [{ season_key: 'summer', label: 'Summer', months: [12, 1, 2] }],
    operating_branches: [],
    settings: { place_changes_need_second_approver: false, branches_may_set_up_static_posts: false, other_approver_available: false },
    can_manage: true,
  });
  await page.route('**/rest/v1/rpc/get_place_services', route => route.fulfill({ json: workspace() }));
  await page.route('**/rest/v1/rpc/preview_place_service_change', async route => {
    const body = route.request().postDataJSON();
    expect(body.p_location_id).toBe(LOCATION_ID);
    expect(body.p_terms.window).toEqual({ mode: 'solar', start: { anchor: 'sunset', offset_hours: 0 }, end: { anchor: 'sunrise', offset_hours: 0 } });
    expect(body.p_terms.checks).toEqual(['gate_check']);
    await route.fulfill({ json: {
      normalised_terms: body.p_terms, applies_from: '2026-11-16', needs_approval: false, affected: [], blocked: [],
      next_days: [{ date: '2026-11-16', patrols: 1, window_open: '20:31', window_close: '06:02', covered: false }],
      warnings: [], preview_fingerprint: 'fp-1',
    } });
  });
  await page.route('**/rest/v1/rpc/save_place_service_change', async route => {
    const body = route.request().postDataJSON();
    expect(body.p_preview_fingerprint).toBe('fp-1');
    expect(body.p_reason).toBe('Client asked for overnight gate checks');
    saved = body.p_terms;
    await route.fulfill({ json: { version_id: '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c', status: 'approved', applied_effective_from: '2026-11-16', delivery_schedule_id: SCHEDULE_ID } });
  });

  await signInAsAdmin(page, '/admin/locations');
  await page.getByRole('button', { name: 'Manage location' }).click();
  const manager = page.getByRole('dialog', { name: 'Manage Civic Events House' });
  await manager.getByRole('button', { name: 'Patrols & services' }).click();
  await expect(manager.getByText('No patrols or services at this place yet.')).toBeVisible();

  await manager.getByRole('button', { name: 'Add patrol' }).click();
  const editor = manager.getByRole('region', { name: 'Add patrol' });
  await editor.getByLabel('Sunrise / sunset').check();
  await editor.getByLabel('Gate check').check();
  await editor.getByRole('button', { name: 'Preview' }).click();
  await editor.getByLabel('Reason for change').fill('Client asked for overnight gate checks');
  await editor.getByRole('button', { name: 'Confirm' }).click();

  await expect(manager.getByText('Change saved.')).toBeVisible();
  await expect(manager.getByText(/sunset to sunrise.*Gate check/)).toBeVisible();
  await expect(manager.getByText('No responsible run yet')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await manager.screenshot({ path: testInfo.outputPath('place-services-patrol.png') });
  expect(errors, errors.join('\n')).toEqual([]);
});
