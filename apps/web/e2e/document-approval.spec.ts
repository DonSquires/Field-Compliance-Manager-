import { expect, test } from '@playwright/test';
import { installSupabaseFixtures, monitorBrowserErrors, signInAsAdmin } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-30T09:30:00+12:00'));
  await installSupabaseFixtures(page);
});

test('administrator reviews extraction evidence before promoting a document', async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  let classificationPayload: Record<string, unknown> | null = null;
  let promotionPayload: Record<string, unknown> | null = null;
  await page.route('**/rest/v1/rpc/review_document_classification', async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    classificationPayload = payload;
    await route.fulfill(json({ id: 'abababab-abab-4bab-8bab-ababababab13', document_version_id: payload.p_document_version_id, privacy_class: payload.p_privacy_class, contains_pii: payload.p_contains_pii, contains_operational_security: payload.p_contains_operational_security, contains_financial_data: payload.p_contains_financial_data, contains_legal_privilege: payload.p_contains_legal_privilege, classifier_source: 'human_review', confidence: 1, rationale: payload.p_reason, reviewed_at: '2026-08-30T09:40:00.000Z', created_at: '2026-08-30T09:40:00.000Z' }));
  });
  await page.route('**/functions/v1/bob-document-promote', async (route) => {
    promotionPayload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill(json({ success: true, ok: true, document_version_id: 'abababab-abab-4bab-8bab-ababababab11' }));
  });
  const proposals: Array<Record<string, any>> = [{ id: 'abababab-abab-4bab-8bab-ababababab17', document_version_id: 'abababab-abab-4bab-8bab-ababababab18', status: 'approved', target_type: 'finance_reconciliation', proposed_payload: { title: 'FIRST Security Guard Services Limited - HR Pay Costing.pdf' }, source_map: { source_excerpt: 'Approved finance reconciliation source.' }, created_at: '2026-08-30T08:25:00.000Z', review_reason: 'Finance source reviewed and approved for draft reconciliation.', document_version: { id: 'abababab-abab-4bab-8bab-ababababab18', documents: { id: 'abababab-abab-4bab-8bab-ababababab19', original_filename: 'FIRST Security Guard Services Limited - HR Pay Costing.pdf' } } }];
  await page.route('**/rest/v1/rpc/propose_document_promotion', async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    const versionId = String(payload.p_document_version_id);
    const proposal = { id: 'abababab-abab-4bab-8bab-ababababab14', document_version_id: versionId, status: 'proposed', target_type: String(payload.p_target_type), proposed_payload: payload.p_proposed_payload, source_map: payload.p_source_map, created_at: '2026-08-30T09:45:00.000Z', review_reason: null, document_version: { id: versionId, documents: { id: 'abababab-abab-4bab-8bab-ababababab10', original_filename: '107 Gorge Road - Service Agreement.pdf' } } };
    proposals.unshift(proposal);
    await route.fulfill(json(proposal));
  });
  await page.route('**/rest/v1/document_promotion_proposals*', async (route) => {
    const versionId = new URL(route.request().url()).searchParams.get('document_version_id')?.replace('eq.', '');
    await route.fulfill(json(versionId ? proposals.filter((proposal) => proposal.document_version_id === versionId) : proposals));
  });
  await page.route('**/rest/v1/rpc/review_document_promotion_proposal', async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    const proposal = proposals.find((item) => item.id === payload.p_proposal_id);
    if (proposal) { proposal.status = payload.p_decision; proposal.review_reason = payload.p_reason; }
    await route.fulfill(json(proposal ?? null));
  });
  await signInAsAdmin(page, '/admin/approvals');
  await expect(page.getByRole('heading', { name: 'Team approvals' })).toBeVisible();
  await page.getByRole('tab', { name: /Documents/ }).click();
  const queue = page.getByRole('region', { name: 'Document promotion queue' });
  await expect(queue.getByText('107 Gorge Road - Service Agreement.pdf')).toBeVisible();
  await expect(queue.getByText('Operational security')).toBeVisible();
  await expect(queue.getByText('Financial data')).toBeVisible();
  await expect(queue.getByText('Review pending')).toBeVisible();
  const approvalPageOverflow = await page.locator('.approvals-page').evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(approvalPageOverflow).toBeLessThanOrEqual(1);
  await queue.getByText('Extracted source preview').click();
  await expect(queue.getByText('Service agreement for contracted security services at 107 Gorge Road.')).toBeVisible();
  await queue.getByRole('button', { name: 'Open source review' }).click();
  await expect(page).toHaveURL(/\/admin\/document-studio\?document=abababab-abab-4bab-8bab-ababababab10&version=abababab-abab-4bab-8bab-ababababab11/);
  const sourceReview = page.getByRole('region', { name: 'Source classification and promotion' });
  await expect(sourceReview.getByText('Operational security', { exact: true }).first()).toBeVisible();
  await expect(sourceReview.getByText('Financial data', { exact: true }).first()).toBeVisible();
  await sourceReview.getByLabel('Classification review reason').fill('Confirmed as tenant-sensitive contract material with operational and financial content.');
  await sourceReview.getByRole('button', { name: 'Record classification review' }).click();
  await expect(page.locator('.bob-document-notice')).toContainText('Classification review recorded for this source version.');
  expect(classificationPayload).toMatchObject({ p_document_version_id: 'abababab-abab-4bab-8bab-ababababab11', p_privacy_class: 'tenant_sensitive', p_contains_operational_security: true, p_contains_financial_data: true });
  await sourceReview.getByRole('button', { name: 'Promote to tenant library' }).click();
  await expect(page.locator('.bob-document-notice')).toContainText('promoted to the tenant reference library');
  expect(promotionPayload).toMatchObject({ document_version_id: 'abababab-abab-4bab-8bab-ababababab11', target_scope: 'tenant_reference' });
  await sourceReview.getByLabel('Domain proposal target').selectOption('crm_agreement');
  await sourceReview.getByRole('button', { name: 'Prepare domain proposal' }).click();
  const sourceProposals = page.getByRole('region', { name: 'Proposals for selected document' });
  await expect(sourceProposals.getByText('crm agreement', { exact: false })).toBeVisible();
  await sourceProposals.getByText('Proposed fields').click();
  await sourceProposals.getByText('Source excerpt').click();
  await expect(sourceProposals.getByText('Service agreement for contracted security services at 107 Gorge Road.', { exact: true })).toBeVisible();
  await sourceProposals.getByLabel('Review reason').fill('The agreement source and tenant scope are appropriate for the CRM intake queue.');
  await sourceProposals.getByRole('button', { name: 'Approve proposal' }).click();
  await expect(page.locator('.bob-document-notice')).toContainText('Proposal approved with a review receipt.');
  await page.goBack();
  await page.getByRole('tab', { name: /Documents/ }).click();
  await expect(page.getByRole('heading', { name: 'Promotion proposals' })).toBeVisible();
  await expect(page.getByText('Crm Agreement · approved')).toBeVisible();
  const proposalQueue = page.getByRole('region', { name: 'Document promotion proposals' });
  const crmProposal = proposalQueue.locator('article').filter({ hasText: '107 Gorge Road - Service Agreement.pdf' });
  await expect(crmProposal.getByRole('button', { name: 'Approve proposal' })).toHaveCount(0);
  await expect(crmProposal.getByRole('button', { name: 'Reject proposal' })).toHaveCount(0);
  await expect(page.getByText('No authoritative CRM record has been created by this approval.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Apply to CRM' }).click();
  const crmDialog = page.getByRole('dialog', { name: 'Apply approved agreement' });
  await crmDialog.getByLabel('Client organisation').selectOption('40404040-4040-4040-8040-404040404040');
  await crmDialog.getByLabel('Starts').fill('2026-09-01');
  await crmDialog.getByRole('button', { name: 'Create service agreement' }).click();
  await expect(page.getByRole('status')).toContainText('CRM agreement created from approved proposal');
  await page.getByRole('button', { name: /Create draft invoice for FIRST Security/ }).click();
  const financeDialog = page.getByRole('dialog', { name: 'Create draft invoice' });
  await financeDialog.getByLabel('Client organisation').selectOption('40404040-4040-4040-8040-404040404040');
  await financeDialog.getByLabel('Invoice number').fill('INV-DOC-0001');
  await financeDialog.getByLabel('Subtotal').fill('1000');
  await financeDialog.getByLabel('GST').fill('150');
  await financeDialog.getByLabel('Total', { exact: true }).fill('1150');
  await financeDialog.getByRole('button', { name: 'Create draft invoice' }).click();
  await expect(page.getByRole('status')).toContainText('Draft invoice created from approved proposal');
  expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});

test('Bob draft queue previews evidence and sends the decision to the exact Studio source', async ({ page }) => {
  const documentId = '81818181-8181-4181-8181-818181818181';
  const versionId = '82828282-8282-4282-8282-828282828282';
  await page.route('**/rest/v1/documents*', async (route) => await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      id: documentId,
      original_filename: 'synthetic-site-plan.html',
      organization_id: '33333333-3333-4333-8333-333333333333',
      current_scope: 'conversation_only',
      source_channel: 'system_generated',
      updated_at: '2026-08-29T09:00:00.000Z',
      document_versions: [{
        id: versionId,
        extracted_text: 'Synthetic review evidence: keep the north gate clear during deliveries.',
        extraction_confidence: 0.9,
        ocr_required: false,
        created_at: '2026-08-29T09:00:00.000Z',
        metadata_json: { title: 'Synthetic North Gate Plan', document_type: 'site_safety_plan', authoring_status: 'needs_review', authoring_html: '<h1>Synthetic North Gate Plan</h1><p>Synthetic review evidence: keep the north gate clear during deliveries.</p>', review_reason: 'Verify the source and operating assumptions.' },
        document_classifications: [],
      }],
    }]),
  }));

  await signInAsAdmin(page, '/admin/approvals');
  await page.getByRole('tab', { name: /Documents/ }).click();
  const queue = page.getByRole('region', { name: 'Bob document review queue' });
  await expect(queue.getByText('Synthetic North Gate Plan')).toBeVisible();
  await queue.getByText('Preview draft content').click();
  await expect(queue.getByText('Synthetic review evidence: keep the north gate clear during deliveries.')).toBeVisible();
  await expect(queue.getByRole('button', { name: 'Approve document' })).toHaveCount(0);
  await expect(queue.getByRole('button', { name: 'Reject document' })).toHaveCount(0);

  await queue.getByRole('button', { name: 'Open exact draft in Studio' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/document-studio\\?document=${documentId}&version=${versionId}`));
  await expect(page.getByLabel('Document title')).toHaveValue('Synthetic North Gate Plan');
  await expect(page.getByRole('textbox', { name: 'Document content' })).toContainText('Synthetic review evidence: keep the north gate clear during deliveries.');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
});