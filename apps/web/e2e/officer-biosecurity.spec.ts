import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test('officer records a biosecurity assessment with source, protected-land, and referral evidence', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installSupabaseFixtures(page);

  let submittedBiosecurity: Record<string, unknown> | null = null;

  await page.route('**/functions/v1/submit-biosecurity-assessment', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload).toMatchObject({
      species_name: 'Wilding pine',
      density_estimate: 'dense',
      action_taken: 'mpi_referral',
      location_name: 'North boundary track',
      protected_land_address: '14 Harbour Road',
      mpi_referral_number: 'MPI-2048',
      follow_up_required: true,
    });
    expect(typeof payload.image_base64).toBe('string');
    submittedBiosecurity = {
      id: 'abababab-abab-4bab-8bab-abababababab',
      species_name: 'Wilding pine',
      density_estimate: 'dense',
      action_taken: 'mpi_referral',
      scene_description: null,
      status: 'open',
      assessed_at: '2026-08-30T09:30:00.000Z',
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        assessment_id: 'abababab-abab-4bab-8bab-abababababab',
        review_state: 'submitted',
        classification: { classification: 'Pinus contorta' },
      }),
    });
  });

  await page.route('**/rest/v1/biosecurity_assessments**', async (route) => {
    const list = submittedBiosecurity ? [submittedBiosecurity] : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) });
  });

  await signInAsOfficer(page, '/officer/biosecurity');
  await page.getByRole('button', { name: /New Assessment/ }).click();
  await page.locator('input[type="file"]').setInputFiles('node_modules/leaflet/dist/images/marker-icon.png');
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
  await expect(page.getByRole('status')).toContainText('Assessment confirmed');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});