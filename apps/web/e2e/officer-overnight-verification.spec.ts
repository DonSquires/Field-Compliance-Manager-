import { expect, test } from '@playwright/test';
import { installFreedomCampingFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test('officer overnight verification shows computed pairing state without manual action controls', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installFreedomCampingFixtures(page);
  await page.route('**/rest/v1/vehicle_overnight_sessions**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'abababab-abab-4bab-8bab-abababababab', plate_number: 'ABC123', overnight_date: '2026-08-29', verification_status: 'verified_overnight', movement_decision: 'stationary', evidence_strength: 'strong', evening_seen_at: '2026-08-29T20:15:00.000Z', morning_seen_at: '2026-08-30T06:20:00.000Z' }]) }));
  await signInAsOfficer(page, '/officer/overnight_verification');

  await expect(page.getByText('verified overnight')).toBeVisible();
  await expect(page.getByText(/evidence: strong/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Verify|Resolve|Escalate/ })).toHaveCount(0);
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('officer overnight verification does not present an unavailable feed as empty', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installFreedomCampingFixtures(page);
  await page.route('**/rest/v1/vehicle_overnight_sessions**', async (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Overnight evidence is unavailable.' }) }));
  await signInAsOfficer(page, '/officer/overnight_verification');

  await expect(page.getByRole('alert')).toContainText('Overnight evidence is unavailable.');
  await expect(page.getByText('No overnight sessions recorded.')).toHaveCount(0);
  expect(browserErrors.filter((error) => !error.includes('status of 500'))).toEqual([]);
});