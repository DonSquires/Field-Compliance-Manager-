import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await installSupabaseFixtures(page);
});

test('enterprise document studio exposes governed families and honest brand readiness', async ({ page }, testInfo) => {
  const browserErrors = monitorBrowserErrors(page);
  await signInAsAdmin(page, '/admin/document-studio');

  await expect(page).toHaveURL(/\/admin\/document-studio$/);
  await expect(page.getByText('Bob document studio', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Document title')).toBeVisible();
  await expect(page.getByLabel('Document type')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Document content' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Site safety structure' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Incident structure' })).toBeVisible();
  await expect(page.getByText('No approved organization logo is configured. The draft will not invent branding.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();

  await page.getByRole('button', { name: 'Site safety structure' }).click();
  await expect(page.getByRole('textbox', { name: 'Document content' })).toContainText('Site safety plan');
  await expect(page.getByRole('textbox', { name: 'Document content' })).toContainText('Hazards and controls');

  await expect(page.getByRole('button', { name: 'Search references' })).toBeVisible();
  await expect(page.getByPlaceholder('Search bylaws, policies, reports…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('document-studio-structure.png'), fullPage: true });
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('document review deep link opens the exact draft in Studio and records its decision there', async ({ page }) => {
  const documentId = '81818181-8181-4181-8181-818181818181';
  const versionId = '82828282-8282-4282-8282-828282828282';
  let reviewPayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/documents*', async (route) => await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      id: documentId,
      original_filename: 'synthetic-site-plan.html',
      updated_at: '2026-08-29T09:00:00.000Z',
      source_channel: 'system_generated',
      current_scope: 'conversation_only',
      document_versions: [{
        id: versionId,
        extracted_text: 'Synthetic evidence: the north gate must remain clear during deliveries.',
        metadata_json: { title: 'Synthetic North Gate Plan', document_type: 'site_safety_plan', authoring_status: 'needs_review', authoring_html: '<h1>Synthetic North Gate Plan</h1><p>Synthetic evidence: the north gate must remain clear during deliveries.</p>', authored_by: 'Test fixture' },
        created_at: '2026-08-29T09:00:00.000Z',
      }],
    }]),
  }));
  await page.route('**/rest/v1/rpc/review_bob_document_draft', async (route) => {
    reviewPayload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, decision: 'approved' }) });
  });

  await signInAsAdmin(page, `/admin/document-studio?document=${documentId}&version=${versionId}`);
  await expect(page.getByLabel('Document title')).toHaveValue('Synthetic North Gate Plan');
  await expect(page.getByRole('textbox', { name: 'Document content' })).toContainText('Synthetic evidence: the north gate must remain clear during deliveries.');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await page.getByLabel('Reviewer rationale').fill('Synthetic review: source and operational details checked.');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.locator('.bob-document-notice')).toContainText('Approved with a durable review receipt.');
  expect(reviewPayload).toMatchObject({
    p_document_id: documentId,
    p_document_version_id: versionId,
    p_decision: 'approved',
    p_review_reason: 'Synthetic review: source and operational details checked.',
  });
});
