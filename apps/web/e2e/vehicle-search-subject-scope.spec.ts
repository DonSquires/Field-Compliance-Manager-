import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page, { officerModules: ['freedom_camping'] });
});

test('registration wildcards show selectable identities before history or flag actions', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  const patterns: string[] = [];
  const historyFilters: string[] = [];
  const vehicles = [
    { id: 'abababab-abab-4bab-8bab-abababababab', plate_number: 'RJ198', make: 'Toyota', model: 'Hiace', colour: '', homeless_status: 'none' },
    { id: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', plate_number: 'RJ298', make: 'Ford', model: 'Transit', colour: '', homeless_status: 'none' },
  ];
  let photoPath: string | null = null;
  await page.route('**/rest/v1/vehicle_profile_photos**', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(photoPath ? { storage_path: photoPath } : null),
  }));
  await page.route('**/rest/v1/rpc/is_admin_for_org', route => route.fulfill({ contentType: 'application/json', body: 'true' }));
  await page.route('**/rest/v1/rpc/update_vehicle_profile_details', async route => {
    const body = route.request().postDataJSON();
    expect(body.p_reason).toBe('Human reviewed appearance');
    expect(body.p_fields).not.toHaveProperty('notes');
    vehicles[1].colour = body.p_fields.colour;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ vehicle_id: vehicles[1].id }) });
  });
  await page.route('**/storage/v1/object/vehicle-profile-photos/**', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ Key: 'uploaded' }),
  }));
  await page.route('**/rest/v1/rpc/set_vehicle_profile_photo', async route => {
    const body = route.request().postDataJSON();
    expect(body.p_sha256_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.p_vehicle_id).toBe(vehicles[1].id);
    expect(body.p_reason).toBe('Reviewed source photo');
    photoPath = body.p_storage_path;
    await route.fulfill({ contentType: 'application/json', body: 'null' });
  });
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 16; canvas.height = 16;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Browser fixture canvas unavailable');
    context.fillStyle = '#336699';
    context.fillRect(0, 0, 16, 16);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await page.route('**/storage/v1/object/sign/vehicle-profile-photos/**', async route => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        signedURL: '/object/sign/vehicle-profile-photos/profile.webp?token=fixture',
      }) });
    } else {
      await route.fulfill({ contentType: 'image/png', body: png });
    }
  });
  await page.route('**/storage/v1/object/sign/scans**', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { paths: string[] };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body.paths.map(path => ({ path, signedURL: `/object/sign/scans/${path}?token=fixture`, error: null }))) });
    } else {
      await route.fulfill({ contentType: 'image/png', body: png });
    }
  });
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
  for (const table of ['canonical_scv_public', 'person_permits_fieldwork', 'rpc/read_person_permits_fieldwork', 'observations', 'breach_alerts', 'entity_flags']) {
    await page.route(`**/rest/v1/${table}**`, async route => {
      if (table === 'observations') {
        const params = new URL(route.request().url()).searchParams;
        if (params.get('select')?.includes('nights_this_zone')) {
          historyFilters.push(params.get('or') ?? '');
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify([
            { id: 'obs-1', observed_at: '2026-05-23T05:45:00Z', is_compliant: true, compliance_status: null, compliance_reason: null, nights_this_zone: 1, plate_number: 'RJ298', module_key: 'freedom_camping', vehicle_make: 'Ford', vehicle_model: 'Transit', vehicle_colour: 'White', photo_url: 'org/33333333-3333-4333-8333-333333333333/obs-1.png', zone: { name: 'Kaiuma Forest Block' } },
            { id: 'obs-2', observed_at: '2026-05-20T05:45:00Z', is_compliant: false, compliance_status: null, compliance_reason: 'Overstayed', nights_this_zone: 3, plate_number: 'RJ298', module_key: 'freedom_camping', vehicle_make: null, vehicle_model: null, vehicle_colour: null, photo_url: null, zone: null },
          ]) });
          return;
        }
      }
      await route.fulfill({ contentType: 'application/json', body: '[]' });
    });
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
  expect(historyFilters).toEqual([`(canonical_vehicle_id.eq.${vehicles[1].id},plate_number_upper.eq.RJ298)`]);
  const history = page.getByRole('table', { name: 'Observation history' });
  await expect(history.locator('tbody tr')).toHaveCount(2);
  await expect(history.getByRole('img', { name: /Observation photo/ })).toBeVisible();
  await expect(history.locator('tbody tr').nth(1)).toContainText('NON-COMPLIANT');
  await expect(history.locator('tbody tr').nth(1)).toContainText('Overstayed');
  await expect(page.getByRole('region', { name: 'Vehicle profile' }).getByText('Warrant & Certification Status')).toBeVisible();
  await page.getByRole('button', { name: 'Edit vehicle details' }).click();
  await page.getByLabel('Colour', { exact: true }).fill('Blue');
  await page.getByLabel('Reason / source for detail changes').fill('Human reviewed appearance');
  await page.getByRole('button', { name: 'Save vehicle details' }).click();
  await expect(page.getByText('Vehicle details saved with audit history.')).toBeVisible();
  await page.getByRole('button', { name: 'Add profile photo' }).click();
  await page.getByLabel('Vehicle profile photo', { exact: true }).setInputFiles({ name: 'car.png', mimeType: 'image/png', buffer: png });
  await page.getByLabel('Reason / source for profile photo').fill('Reviewed source photo');
  await page.getByRole('button', { name: 'Save profile photo' }).click();
  await expect(page.getByText('Shared vehicle profile photo saved with audit history.')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Profile of vehicle RJ298' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to search results' }).click();
  await expect(page.getByLabel('Registration search')).toHaveValue('RJ%9%8');
  await expect(results.getByRole('button', { name: 'RJ198' })).toBeVisible();
  expect(patterns).toEqual(['RJ%9%8']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
