import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test('officer records a biosecurity assessment with source, protected-land, and referral evidence', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);
  await page.route('**/rest/v1/biosecurity_assessments**', async (route) => {
    if (route.request().method() === 'POST') {
      const [payload] = JSON.parse(route.request().postData() ?? '[]');
      expect(payload).toMatchObject({
        species_name: 'Wilding pine',
        density_estimate: 'dense',
        action_taken: 'mpi_referral',
        location_name: 'North boundary track',
        protected_land_address: '14 Harbour Road',
        mpi_referral_number: 'MPI-2048',
        follow_up_required: true,
      });
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'abababab-abab-4bab-8bab-abababababab', ...payload, status: 'open', assessed_at: '2026-08-30T09:30:00.000Z' }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await signInAsOfficer(page, '/officer/biosecurity');
  await page.getByRole('button', { name: /New Assessment/ }).click();
  await page.getByLabel('Species').fill('Wilding pine');
  await page.getByLabel('Observed location').fill('North boundary track');
  await page.getByLabel('Protected land address').fill('14 Harbour Road');
  await page.getByLabel('Density').selectOption('dense');
  await page.getByLabel('Action Taken').selectOption('mpi_referral');
  await expect(page.getByRole('button', { name: 'Submit Assessment' })).toBeDisabled();
  await page.getByLabel('MPI referral number').fill('MPI-2048');
  await page.getByText('Follow-up required', { exact: true }).click();
  await page.getByRole('button', { name: 'Submit Assessment' }).click();

  await expect(page.getByText('Wilding pine', { exact: true })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});