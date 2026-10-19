import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page, { officerModules: ['freedom_camping'] });
});

test('registration wildcards show selectable identities before history or flag actions', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  const patterns: string[] = [];
  const vehicles = [
    { id: 'abababab-abab-4bab-8bab-abababababab', plate_number: 'RJ198', make: 'Toyota', model: 'Hiace', homeless_status: 'none' },
    { id: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', plate_number: 'RJ298', make: 'Ford', model: 'Transit', homeless_status: 'none' },
  ];
  await page.route('**/rest/v1/rpc/search_vehicle_registrations', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    patterns.push(String(body.p_pattern));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(vehicles) });
  });
  await page.route('**/rest/v1/canonical_vehicle_public**', async (route) => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get('id');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(id ? vehicles[1] : vehicles) });
  });
  for (const table of ['canonical_scv_public', 'person_permits_fieldwork', 'observations', 'breach_alerts', 'entity_flags']) {
    await page.route(`**/rest/v1/${table}**`, async route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  }
  await page.route('**/rest/v1/rpc/get_safety_warnings', async route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await signInAsAdmin(page, '/admin/field-ops?area=vehicle-search');
  await page.getByLabel('Registration search').fill('RJ%9%8');
  await page.getByRole('button', { name: 'Search Plate' }).click();
  const results = page.getByRole('region', { name: 'Matching vehicles' });
  await expect(results.getByRole('button', { name: 'RJ198' })).toBeVisible();
  await expect(results.getByRole('button', { name: 'RJ298' })).toBeVisible();
  expect(patterns).toEqual(['RJ%9%8']);
  await expect(page.getByRole('button', { name: '+ Raise of-interest flag' })).toHaveCount(0);
  await results.getByRole('button', { name: 'RJ298' }).click();
  await expect(page.getByText('Ford Transit', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Raise of-interest flag' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('repeat reports combine subjects and drilldowns across the authorised scope', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  const calls: Array<{ name: string; scope: unknown }> = [];
  await page.route('**/rest/v1/rpc/can_manage_r_and_m_identity', async route => route.fulfill({ contentType: 'application/json', body: 'true' }));
  const vehicleRow = { plate: 'RJ198', sightings: 4, places: 2, officers: 2, patrol_sightings: 3, cctv_sightings: 1,
    first_seen: '2026-08-01T00:00:00Z', last_seen: '2026-08-02T00:00:00Z', owner_identified: false, total_count: 1 };
  for (const name of [
    'list_repeat_vehicle_subjects_for_agreement', 'list_repeat_person_subjects_for_agreement',
    'list_unlinked_plate_mentions_for_agreement', 'list_vehicle_subject_history_for_agreement',
    'get_vehicle_subject_details_for_agreement', 'list_vehicle_subject_identifications',
  ]) {
    await page.route(`**/rest/v1/rpc/${name}`, async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.push({ name, scope: body.p_service_agreement_id });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(name === 'list_repeat_vehicle_subjects_for_agreement' ? [vehicleRow] : []) });
    });
  }
  await signInAsAdmin(page, '/admin/reports');
  await page.getByText('Repeat subject review', { exact: true }).click();
  await expect(page.getByRole('option', { name: 'All authorised agreements and observations' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Open sighting history for RJ198' }).click();
  await expect(page.getByRole('dialog', { name: 'RJ198 · 4 sightings' })).toBeVisible();
  await expect(page.getByText('2 places · first seen', { exact: false })).toBeVisible();
  await expect.poll(() => calls.filter(call => call.name === 'list_vehicle_subject_identifications').length).toBe(1);
  expect(calls.every(call => call.scope === null)).toBe(true);
  expect(calls.some(call => call.name === 'list_repeat_person_subjects_for_agreement')).toBe(true);
  expect(errors).toEqual([]);
});
