import { expect, test } from '@playwright/test';
import { installOfficerScheduleFixtures, monitorBrowserErrors, signInAsOfficer } from './fixtures';

test('officer smoke assessment records valid source, location, action, and follow-up evidence', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await installOfficerScheduleFixtures(page);
  await page.route('**/rest/v1/service_agreement_locations**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ service_agreement_id: '24242424-2424-4424-8424-242424242424', site_id: '42424242-4242-4242-8242-424242424242', zone_id: null, status: 'active' }]) }));
  await page.route('**/rest/v1/client_sites**', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: '42424242-4242-4242-8242-424242424242', name: 'Civic Events Centre', address: '1 Civic Square, Nelson', site_type: 'commercial_premises', client_organization_id: '40404040-4040-4040-8040-404040404040', service_agreement_id: '24242424-2424-4424-8424-242424242424', active: true }]) }));
  let submittedSmoke: Record<string, unknown> | null = null;

  await page.route('**/functions/v1/submit-smoke-assessment', async (route) => {
    const payload = JSON.parse(route.request().postData() ?? '{}');
    expect(payload).toMatchObject({
      complaint_source: 'council_hotline',
      smoke_source_type: 'nuisance_burning',
      complaint_address: '14 Harbour Road, Nelson',
      action_taken: 'abatement_notice',
      follow_up_required: true,
    });
    expect(typeof payload.image_base64).toBe('string');
    submittedSmoke = {
      id: 'abababab-abab-4bab-8bab-abababababab',
      site_id: '42424242-4242-4242-8242-424242424242',
      organization_id: '40404040-4040-4040-8040-404040404040',
      complaint_source: 'council_hotline',
      smoke_source_type: 'nuisance_burning',
      severity: 'medium',
      status: 'open',
      scene_description: 'Visible smoke is crossing the roadway from the rear yard.',
      action_taken: 'abatement_notice',
      notes: null,
      address: '1 Civic Square, Nelson',
      assessed_at: '2026-08-30T09:30:00.000Z',
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        assessment_id: 'abababab-abab-4bab-8bab-abababababab',
        review_state: 'submitted',
        is_out_of_hours: true,
        classification: { classification: 'Nuisance burning' },
      }),
    });
  });

  await page.route('**/rest/v1/smoke_assessments**', async (route) => {
    const list = submittedSmoke ? [submittedSmoke] : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) });
  });

  await signInAsOfficer(page, '/officer/smoke_control');
  await page.getByRole('button', { name: /New Assessment/ }).click();
  await page.locator('input[type="file"]').setInputFiles('node_modules/leaflet/dist/images/marker-icon.png');
  await page.getByLabel('Complaint source').selectOption('council_hotline');
  await page.getByLabel('Smoke source type').selectOption('nuisance_burning');
  await page.getByLabel('Complainant address').fill('14 Harbour Road, Nelson');
  await page.getByLabel('Scene description').fill('Visible smoke is crossing the roadway from the rear yard.');
  await page.getByLabel('Action taken').selectOption('abatement_notice');
  await page.getByText('Source confirmed at the selected site', { exact: true }).click();
  await page.getByText('Follow-up required', { exact: true }).click();
  await page.getByRole('button', { name: 'Submit Assessment' }).click();

  await expect(page.getByText('Source: nuisance_burning')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Smoke assessment confirmed' })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});