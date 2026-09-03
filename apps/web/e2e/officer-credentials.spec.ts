import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
});

test('officer credentials distinguishes valid, expiring, expired, and unverified authority', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/staff_credentials**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
    { id: 'abababab-abab-4bab-8bab-abababababab', credential_type: 'Security licence', credential_number: 'SL-2048', issuing_authority: 'PSPLA', expiry_date: '2027-06-01', verified: true },
    { id: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', credential_type: 'First aid', credential_number: 'FA-1024', issuing_authority: 'Red Cross', expiry_date: '2026-09-10', verified: false },
    { id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', credential_type: 'Warrant card', credential_number: 'WC-88', issuing_authority: 'Council', expiry_date: '2026-08-01', verified: true },
  ]) }));
  await signInAsOfficer(page, '/officer/credentials');

  await expect(page.getByText('Verified', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Unverified', { exact: true })).toBeVisible();
  await expect(page.locator('.severity-badge.severity-high').filter({ hasText: 'Expires' })).toBeVisible();
  await expect(page.locator('.severity-badge.severity-high').filter({ hasText: 'Expired' })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('officer credentials does not present a failed load as no credentials', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.route('**/rest/v1/staff_credentials**', async (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Credential records are unavailable.' }) }));
  await signInAsOfficer(page, '/officer/credentials');

  await expect(page.getByRole('alert')).toContainText('Credential records are unavailable.');
  await expect(page.getByText('No credentials on file.')).toHaveCount(0);
  expect(browserErrors.filter((error) => !error.includes('status of 500'))).toEqual([]);
});