import { test, expect, type Page } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin, signInAsOfficer } from './fixtures';
import type { FieldPlace, PlaceZone } from '../src/lib/fieldPlaces';

const CLIENT = 'c1c1c1c1-0000-4000-8000-000000000001';
const HOUSE = 'a1a1a1a1-0000-4000-8000-000000000001';
const SITE = '51515151-0000-4000-8000-000000000001';
const POINT = '51515151-0000-4000-8000-000000000002';
const updated = '2026-08-29T12:00:00.000Z';

async function workspace(page: Page, populated = true) {
  await installSupabaseFixtures(page, { officerModules: [] });
  const writes: Array<{ name: string; body: Record<string, unknown> }> = [];
  const client = { id: CLIENT, name: 'Fixture client', contact_email: '', contact_phone: '', account_notes: '', updated_at: updated };
  const place: FieldPlace = {
    id: HOUSE, name: 'Main yard', organization_id: CLIENT, address: null, notes: null, updated_at: updated, canonical_place_id: HOUSE,
    sites: [{ id: SITE, name: 'Main yard', active: true, site_type: 'other', lat: null, lng: null, gps_lat: null, gps_lng: null, boundary: null, boundary_status: 'provisional', boundary_verification: 'unverified', risk_level: null, site_brief: null, access_instructions: null, hs_notes: null, configuration_version: 1 }],
    zones: [],
  };
  let places = populated ? [place] : [];
  await page.route('**/functions/v1/linz-map-tile?*', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#ccd8c9"/><path d="M0 128H256 M128 0V256" stroke="#889388"/><text x="10" y="30">Synthetic map fixture</text></svg>',
  }));
  await page.route('**/rest/v1/organizations?*', async route => {
    if (new URL(route.request().url()).searchParams.get('id') === `eq.${CLIENT}`) await route.fulfill({ json: client });
    else await route.fallback();
  });
  await page.route('**/rest/v1/locations?*', route => route.fulfill({ json: { organization_id: CLIENT } }));
  await page.route('**/rest/v1/service_agreements?*', async route => {
    if (new URL(route.request().url()).searchParams.get('client_organization_id') === `eq.${CLIENT}`) await route.fulfill({ json: [{ id: 'agreement-fixture', invitation_status: 'not_invited', external_refs: { engagement_confirmation: { confirmed_by: 'test-admin' } }, starts_on: null, ends_on: null }] });
    else await route.fallback();
  });
  await page.route('**/rest/v1/rpc/get_field_place_workspace', route => route.fulfill({ json: { clients: [{ id: CLIENT, name: client.name }], places, total: places.length } }));
  await page.route('**/rest/v1/rpc/save_service_client', async route => {
    const body = route.request().postDataJSON();
    writes.push({ name: 'save_service_client', body });
    client.name = body.p_name;
    await route.fulfill({ json: { ...client, engagement_confirmed: true } });
  });
  await page.route('**/rest/v1/rpc/create_service_location', async route => {
    const body = route.request().postDataJSON();
    writes.push({ name: 'create_service_location', body });
    place.name = body.p_name; places = [place];
    await route.fulfill({ json: { location_id: HOUSE } });
  });
  await page.route('**/rest/v1/rpc/save_service_location_profile', async route => {
    const body = route.request().postDataJSON();
    writes.push({ name: 'save_service_location_profile', body });
    place.name = body.p_name; place.notes = body.p_notes;
    if (body.p_site_profile) place.sites[0].site_brief = body.p_site_profile.site_brief;
    if (body.p_resolved_address) place.address = body.p_resolved_address.label;
    await route.fulfill({ json: { location_id: HOUSE, updated_at: updated } });
  });
  await page.route('**/rest/v1/rpc/capture_field_place', async route => {
    const body = route.request().postDataJSON();
    writes.push({ name: 'capture_field_place', body });
    place.name = body.p_name;
    const marker: PlaceZone = { id: POINT, name: `${place.name} - verification point`, active: true, module_key: 'patrol', lat: body.p_capture.confirmed_lat, lng: body.p_capture.confirmed_lng, boundary: null, boundary_status: 'provisional', boundary_verification: 'verified', is_verification_point: true, radius_meters: 10, verified_at: updated, verified_by: 'Test officer', capture: body.p_capture, configuration_version: 1 };
    place.zones = [marker]; places = [place];
    await route.fulfill({ json: { location_id: HOUSE, zone_id: POINT, radius_m: 10, updated_at: updated } });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', { value: (success: PositionCallback) => success({
      coords: { latitude: -41.27, longitude: 173.28, accuracy: 35, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) },
      timestamp: Date.now(), toJSON: () => ({}),
    }) });
  });
  return { writes, place };
}

test('one-page client setup adds a location and opens its editable home profile', async ({ page }) => {
  const { writes } = await workspace(page, false);
  const errors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/client-setup');
  await page.getByLabel('Client name', { exact: true }).fill('Fixture client');
  await expect(page.getByRole('button', { name: 'Save client', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: /provider is engaged/ }).check();
  await page.getByRole('button', { name: 'Save client', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`account=${CLIENT}`));
  const locations = page.getByRole('region', { name: 'Client locations' });
  await locations.getByRole('button', { name: 'Add location', exact: true }).click();
  await page.getByLabel('Location name', { exact: true }).fill('Main yard');
  await page.getByRole('form', { name: 'Add location', exact: true }).getByRole('button', { name: 'Add location', exact: true }).click();
  await locations.getByRole('button', { name: 'Main yard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Main yard', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('No street address recorded', { exact: false })).toBeVisible();
  await page.getByLabel('Officer briefing').fill('Use the signed public entrance.');
  await page.getByRole('button', { name: 'Save location', exact: true }).click();
  await expect(page.getByText('Location profile saved. Officer verification history is preserved.')).toBeVisible();
  expect(writes.map(item => item.name)).toEqual(['save_service_client', 'create_service_location', 'save_service_location_profile']);
  expect(writes[0].body).toMatchObject({ p_name: 'Fixture client', p_confirm_engagement: true, p_email: '', p_phone: '' });
  expect(writes[1].body).toMatchObject({ p_client_id: CLIENT, p_name: 'Main yard', p_kind: 'site' });
  await expect(page.getByRole('button', { name: 'Scheduling and services' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('client-location-profile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Reporting and activity' }).click();
  await expect(page.getByText('Every patrol visit, camera activation and vehicle sighting for Main yard', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('officer without specialty ticks verifies a corrected 10m point and admin sees the receipt', async ({ page }) => {
  const { writes } = await workspace(page);
  const errors = monitorBrowserErrors(page);
  await signInAsOfficer(page, '/officer/places');
  await page.getByRole('combobox', { name: 'Client', exact: true }).selectOption(CLIENT);
  await page.getByRole('combobox', { name: 'Existing location', exact: true }).selectOption(HOUSE);
  await page.getByRole('button', { name: 'Use my current GPS' }).click();
  await expect(page.getByText('GPS accuracy is worse than 10 m.', { exact: false })).toBeVisible();
  await page.getByText('Adjust coordinates using the keyboard', { exact: true }).click();
  await page.getByLabel('Confirmed latitude').fill('-41.27002');
  const confirm = page.getByRole('checkbox', { name: /checked this point on the map/ });
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('officer-point-confirmation.png'), fullPage: true });
  await confirm.check();
  await page.getByLabel('Location name', { exact: true }).fill('Main yard verified');
  await expect(confirm).not.toBeChecked();
  await confirm.check();
  await page.getByRole('button', { name: 'Save officer verification', exact: true }).click();
  await expect(page.getByText('Main yard verified is officer verified.', { exact: false })).toBeVisible();
  expect(writes[0].body).toMatchObject({ p_location_id: HOUSE, p_client_id: CLIENT, p_map_confirmed: true, p_capture: { lat: -41.27, confirmed_lat: -41.27002, accuracy: 35 } });
  await page.evaluate(() => localStorage.clear());
  await signInAsAdmin(page, `/admin/locations?location=${HOUSE}&account=${CLIENT}`);
  await expect(page.getByRole('heading', { name: 'Officer verified', exact: true })).toBeVisible();
  await expect(page.getByText('Original GPS accuracy: 35.0 m.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('failed map tiles cannot produce a verification', async ({ page }) => {
  const { writes } = await workspace(page);
  await page.route('**/functions/v1/linz-map-tile?*', route => route.fulfill({ contentType: 'text/plain', body: 'No map tile' }));
  await signInAsOfficer(page, '/officer/places');
  await page.getByRole('combobox', { name: 'Client', exact: true }).selectOption(CLIENT);
  await page.getByRole('combobox', { name: 'Existing location', exact: true }).selectOption(HOUSE);
  await page.getByRole('button', { name: 'Use my current GPS' }).click();
  await expect(page.getByText('The map could not be loaded.', { exact: false })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /checked this point on the map/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save officer verification' })).toBeDisabled();
  expect(writes).toEqual([]);
});
