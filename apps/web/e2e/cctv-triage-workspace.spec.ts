import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

const organizationId = '33333333-3333-4333-8333-333333333333';
const importId = '12121212-1212-4212-8212-121212121212';
const observation = {
  id: '13131313-1313-4313-8313-131313131313',
  evidence_item_id: '14141414-1414-4414-8414-141414141414',
  source_event_id: '15151515-1515-4515-8515-151515151515',
  cctv_import_id: importId,
  entity_kind: 'person',
  observed_at: '2026-08-30T09:15:00.000Z',
  observed_to: null,
  candidate_label: 'Person at north gate',
  candidate_plate: null,
  animal_type: null,
  model_confidence: 0.93,
  species_confidence: null,
  is_pest: null,
  quality_state: 'clear',
  attributes: { frame_count: 3 },
  thumbnail: null,
  review_state: 'unreviewed',
  portfolio_key: 'person:synthetic-review',
  portfolio_state: 'unmatched',
  portfolio_candidates: [],
  person_record_id: null,
  canonical_vehicle_id: null,
  person_records: null,
  reviewed_at: null,
  review_notes: null,
};

test('CCTV triage uses the shared Admin dark tokens without changing its governed review workflow', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  const writeCalls: string[] = [];
  let observationQuery = '';
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (/\/rest\/v1\/rpc\/(review_cctv_entity_observation|confirm_cctv_vehicle_attributes|confirm_cctv_weapon_hint|update_cctv_person_profile|update_cctv_vehicle_notes)$/.test(pathname)) {
      writeCalls.push(pathname);
    }
  });
  await installSupabaseFixtures(page, { officerModules: ['cctv'] });
  await page.route('**/rest/v1/cctv_entity_observations**', async (route) => {
    const url = new URL(route.request().url());
    observationQuery = url.search;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(url.searchParams.has('portfolio_key') ? [] : [observation]) });
  });
  await page.route('**/rest/v1/cctv_imports**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { id: importId, camera_label: 'North gate camera', source_timezone: 'Pacific/Auckland', locations: { name: 'Civic Events House', address: '1 Civic Square' } },
    ]) });
  });

  await signInAsAdmin(page, '/admin/field-ops?area=cctv-triage');
  const triage = page.locator('.cctv-triage');
  await expect(triage).toBeVisible();
  // Triage is an organisation-wide evidence workspace: it says so and offers no service-place filter.
  await expect(page.locator('.operating-spine')).toHaveCount(0);
  const placeContext = page.getByRole('region', { name: 'Service place context' });
  await expect(placeContext).toContainText('Organisation-wide evidence workspace · not filtered by service place');
  await expect(placeContext.getByRole('combobox')).toHaveCount(0);
  await expect(triage.getByRole('heading', { name: 'Review observations' })).toBeVisible();
  await expect(triage.getByRole('heading', { name: 'Person · Person at north gate' })).toBeVisible();
  const viewport = page.viewportSize();
  await expect(triage.getByRole('heading', { name: 'Review observations' })).toHaveCSS('font-size', (viewport?.width ?? 0) <= 900 ? '26px' : '30px');
  expect(observationQuery).toContain(`organization_id=eq.${organizationId}`);
  // The Admin shell is dark-only (shared design tokens, 2026-10-24); the console tokens must reach the triage surfaces.
  await expect(page.locator('.admin-shell')).toHaveAttribute('data-theme', 'dark');
  const token = (name: string) => triage.evaluate((element, variable) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = `var(${variable})`;
    element.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, name);
  await expect(triage.locator('.cctv-triage__detail')).toHaveCSS('background-color', await token('--cc-surface'));
  await expect(triage.getByRole('button', { name: /^Accept$/ })).toHaveCSS('background-color', await token('--cc-brand'));
  await expect(triage.getByRole('button', { name: /^Accept$/ })).toHaveAttribute('aria-keyshortcuts', 'A');
  await expect(triage.getByLabel('single-key shortcuts')).toBeChecked();
  await expect(page).toHaveScreenshot('cctv-triage-queue-first-viewport.png');

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(writeCalls).toEqual([]);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});