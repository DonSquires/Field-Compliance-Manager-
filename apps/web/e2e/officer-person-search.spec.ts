import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, signInAsAdmin, signInAsOfficer } from './fixtures';

test('officer person search requires explicit authorization, then completes a private operational lookup', async ({ page }) => {
  await installSupabaseFixtures(page);
  let authorized = false;
  let searchCalls = 0;
  let expiryCalls = 0;
  await page.route('**/rest/v1/rpc/can_search_people', route => route.fulfill({ json: authorized }));
  await page.route('**/rest/v1/rpc/get_notice_expiry_register', route => {
    expiryCalls++;
    return route.fulfill({ json: [] });
  });
  await page.route('**/rest/v1/rpc/search_people', route => {
    searchCalls++;
    return route.fulfill({ json: [{
      canonical_person_id: 'test-person', display_name: 'Synthetic Permit Holder', review_state: 'verified',
      homeless_status: null, aliases: [], organizations: ['Test organization'],
      has_notice_in_force: true, contact_details_authorised: false, nzta_authorised: false, nzta: null,
      notices: [{ notice_id: 'test-notice', organization_name: 'Test forest', notice_type: 'trespass', notice_number: 'TEST-1',
        status: 'issued', issued_at: '2026-01-01', expires_at: '2028-01-01', expiry_state: 'in_force', location_name: 'Test block' }],
      permits: [], vehicles: [{ canonical_vehicle_id: 'test-vehicle', plate_number: 'ABC123', make: 'Test', model: 'Vehicle', colour: 'Blue', relationship: 'observed_with' }],
    }] });
  });
  await signInAsOfficer(page, '/officer/person_search');
  await expect(page.getByText(/Your administrator must enable Person search/)).toBeVisible();
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  expect(searchCalls).toBe(0);
  authorized = true;
  await page.getByRole('button', { name: 'Check access again' }).click();
  await page.getByRole('searchbox', { name: 'Name, alias or permit number' }).fill('Synthetic');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Permit Holder' })).toBeVisible();
  await expect(page.getByText('Trespass notice · TEST-1')).toBeVisible();
  await expect(page.getByText('Notice review queue')).toHaveCount(0);
  expect(expiryCalls).toBe(0);
  const layout = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(layout.content).toBeLessThanOrEqual(layout.viewport + 1);
  await page.getByRole('button', { name: 'Open vehicle ABC123 in vehicle search' }).click();
  await expect(page).toHaveURL(/\/officer\/vehicle_lookup\?plate=ABC123$/);
  await expect(page.getByPlaceholder('Enter plate number (e.g. ABC123)')).toHaveValue('ABC123');
});

test('admin vehicle search is available without parking or camping modules', async ({ page, isMobile }) => {
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/organization_modules**', route => route.fulfill({ json: [{ module_key: 'patrol', enabled: true }] }));
  await signInAsAdmin(page, '/admin/field-ops?area=vehicle-search');
  await expect(page.getByRole('heading', { name: 'Vehicle Search & Flags', exact: true })).toBeVisible();
  await page.goto('/admin/field-ops');
  if (isMobile) await page.getByRole('button', { name: /^Operational records/ }).click();
  await page.getByRole('button', { name: /^Vehicle search Search vehicle/ }).click();
  await expect(page).toHaveURL(/area=vehicle-search/);
  await expect(page.getByRole('textbox', { name: 'Registration search' })).toBeVisible();
});
