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
      notice_number: 'SMK-2026-0042',
      follow_up_required: true,
      source_confirmed: true,
    });
    expect(typeof payload.image_base64).toBe('string');
    submittedSmoke = {
      id: 'abababab-abab-4bab-8bab-abababababab',
      site_id: '42424242-4242-4242-8242-424242424242',
      organization_id: '40404040-4040-4040-8040-404040404040',
      complaint_source: 'council_hotline',
      smoke_source_type: 'nuisance_burning',
      severity: 'moderate',
      status: 'open',
      scene_description: 'Visible smoke is crossing the roadway from the rear yard.',
      action_taken: 'abatement_notice',
      notes: 'Wind is carrying smoke toward the affected property.',
      address: '1 Civic Square, Nelson',
      assessed_at: '2026-08-30T09:30:00.000Z',
      officer_name: 'Test Officer',
      notice_number: 'SMK-2026-0042',
      legal_basis: 'RMA s.17A',
      follow_up_required: true,
      source_confirmed: true,
      evidence_state: 'verified',
      review_state: 'requires_supervisor_review',
      review_notes: null,
      photo_urls: [],
      smoke_ai_analysis: {
        status: 'available',
        classification: 'nuisance burning',
        confidence: 0.82,
        details: { smoke_source: 'rubbish', severity: 'significant', visibility_impact: 'Smoke crosses the road' },
        reasoning: 'Visible plume appears to originate from open burning.',
        classifier: 'bob_vision',
        provider: 'test',
        model: 'test-vision',
        prompt_version: 'smoke_photo_v1',
      },
      smoke_ai_review: null,
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        assessment_id: 'abababab-abab-4bab-8bab-abababababab',
        review_state: 'requires_supervisor_review',
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
  await page.getByLabel('Notice number').fill('SMK-2026-0042');
  await page.getByLabel('Notes').fill('Wind is carrying smoke toward the affected property.');
  await page.getByText('Source confirmed at the selected site', { exact: true }).click();
  await page.getByText('Follow-up required', { exact: true }).click();
  await page.getByRole('button', { name: 'Submit assessment' }).click();

  await expect(page.getByText(/nuisance burning · confirmed on site/)).toBeVisible();
  await expect(page.getByText('Bob visible-image candidate')).toBeVisible();
  await expect(page.getByText('Legal and operational action')).toBeVisible();
  await expect(page.getByText('Review workflow', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Smoke assessment confirmed' })).toBeVisible();
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});