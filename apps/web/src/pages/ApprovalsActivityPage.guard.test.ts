import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/ApprovalsActivityPage.tsx'), 'utf8');
const studioSource = readFileSync(resolve(process.cwd(), 'src/pages/BobDocumentStudioPage.tsx'), 'utf8');

describe('governed approvals workbench', () => {
  it('loads tree-scoped activity through the canonical RPC', () => {
    expect(source).toContain("rpc('get_approvals_activity'");
    expect(source).toContain('p_statuses: null');
    expect(source).toContain("profile?.role === 'admin'");
    expect(source).toContain('row.organization_id === scopeOrganizationId');
    expect(source).not.toContain(".from('bob_agentic_actions')");
  });

  it('uses role-specific language and shows only status filters that contain work', () => {
    expect(source).toContain("title: 'Platform approvals'");
    expect(source).toContain("title: 'Organisation approvals'");
    expect(source).toContain("title: 'Team approvals'");
    expect(source).toContain('visibleStatusFilters.map');
    expect(source).toContain("setFilter(visibleStatusFilters[0]?.id ?? 'all')");
    expect(source).toContain("setReviewArea(workAreas[0]?.id ?? 'actions')");
  });

  it('separates decisions, documents, and plans into relevant work areas', () => {
    expect(source).toContain("type ApprovalWorkArea = 'actions' | 'documents' | 'plans'");
    expect(source).toContain('aria-label="Approval work area"');
    expect(source).toContain("reviewArea === 'documents' && documentReviews.length > 0");
    expect(source).toContain("reviewArea === 'plans' && plans.length > 0");
    expect(source).toContain("reviewArea === 'actions' && <>");
  });

  it('treats every pending lifecycle status as decision work', () => {
    expect(source).toContain("status === 'pending_approval' || status === 'proposed'");
    expect(source).toContain('isPendingAction(selected.status)');
  });

  it('requires reasoning and uses the governed decision edge function', () => {
    expect(source).toContain("functions.invoke('bob-proposal-approver'");
    expect(source).toContain('reasoning: reasoning.trim()');
    expect(source).toContain('required rows={4}');
  });

  it('opens Bob deep links on the exact governed action without widening authority', () => {
    expect(source).toContain('useSearchParams');
    expect(source).toContain("searchParams.get('actionId')");
    expect(source).toContain("requestedActionId ? 'all' : 'pending'");
    expect(source).toContain('row.id === requestedActionId');
    expect(source).toContain('selected.can_decide');
    expect(source).toContain('not available in your current organisation or role');
  });

  it('sanitizes payload display and surfaces apply failures honestly', () => {
    expect(source).toContain('formatGovernedPayload');
    expect(source).toContain('response?.apply_error');
    expect(source).toContain('Approval recorded, but application failed');
  });

  it('respects the RPC decision-authority flag', () => {
    expect(source).toContain('selected.can_decide');
    expect(source).toContain('assigned_approver_name');
    expect(source).toContain('Decision owner');
    expect(source).toContain('Your authority');
    expect(source).toContain('owns this decision');
    expect(source).not.toContain('Decision authority</dt><dd>');
  });

  it('routes reference-library review to the exact source document instead of deciding centrally', () => {
    expect(source).toContain('Open source review');
    expect(source).toContain('document=${encodeURIComponent(document.document_id)}&version=${encodeURIComponent(document.version_id)}');
    expect(source).not.toContain('Review classification');
    expect(source).not.toContain('Promote to tenant library');
    expect(studioSource).toContain("functions.invoke('bob-document-promote'");
    expect(studioSource).toContain('document_version_id: selectedFile.versionId');
    expect(studioSource).toContain("target_scope: 'tenant_reference'");
    expect(studioSource).not.toMatch(/from\('(documents|document_versions|document_classifications)'\)[\s\S]{0,240}\.(insert|update|upsert|delete)\(/);
  });

  it('shows field-level extraction evidence and sensitive-data flags before promotion', () => {
    expect(source).toContain('extracted_text');
    expect(source).toContain('contains_pii');
    expect(source).toContain('contains_financial_data');
    expect(source).toContain('contains_legal_privilege');
    expect(source).toContain('Extracted source preview');
    expect(source).toContain('Human reviewed');
  });

  it('records human classification review in Studio through the governed RPC', () => {
    expect(studioSource).toContain("rpc('review_document_classification'");
    expect(studioSource).toContain('p_reason: classificationForm.reason.trim()');
    expect(studioSource).toContain('Record classification review');
    expect(studioSource).not.toMatch(/from\('document_classifications'\)[\s\S]{0,240}\.(insert|update|upsert|delete)\(/);
    expect(source).not.toContain("rpc('review_document_classification'");
  });

  it('prepares contract proposals without writing authoritative CRM records', () => {
    expect(studioSource).toContain("rpc('propose_document_promotion'");
    expect(studioSource).toContain("'crm_agreement'");
    expect(studioSource).toContain('Prepare domain proposal');
    expect(source).not.toContain("rpc('propose_document_promotion'");
    expect(source).not.toContain("rpc('manage_crm_agreement_setup'");
  });

  it('reviews domain proposals in Studio through the governed decision RPC', () => {
    expect(studioSource).toContain("rpc('review_document_promotion_proposal'");
    expect(studioSource).toContain('p_decision: decision');
    expect(studioSource).toContain('Approve proposal');
    expect(studioSource).toContain('Reject proposal');
    expect(source).not.toContain("rpc('review_document_promotion_proposal'");
    expect(source).not.toContain('Approve proposal');
    expect(source).not.toContain('Reject proposal');
  });

  it('does not imply CRM execution from proposal approval', () => {
    expect(source).toContain('No authoritative CRM record has been created by this approval.');
    expect(source).not.toContain("rpc('manage_crm_agreement_setup'");
  });

  it('requires explicit human CRM details before applying an approved proposal', () => {
    expect(source).toContain("rpc('apply_crm_agreement_promotion_proposal'");
    expect(source).toContain('p_client_organization_id: executionForm.clientOrganizationId');
    expect(source).toContain('p_provider_organization_id: operatingOrganizationId');
    expect(source).toContain('Create service agreement');
  });

  it('exposes explicit finance inputs before creating a draft invoice', () => {
    expect(source).toContain("rpc('apply_finance_reconciliation_proposal'");
    expect(source).toContain('p_total_amount: Number(financeForm.totalAmount)');
    expect(source).toContain('Create draft invoice');
  });

  it('uses target-specific execution fields instead of one generic form', () => {
    expect(source).toContain('Advanced credential details');
    expect(source).toContain('p_credential_type: targetForm.credentialType');
    expect(source).toContain('p_document_type: targetForm.documentType');
    expect(source).toContain('p_work_unit_type: targetForm.workUnitType');
    expect(source).toContain('p_investigation_id: targetForm.investigationId');
    expect(source).toContain('Apply approved credential');
    expect(source).toContain('Apply approved HR document');
    expect(source).toContain('Apply approved site brief');
    expect(source).toContain('Apply approved investigation link');
  });

  it('simplifies the approval review into a single clear human-review summary with live evidence and direct actions', () => {
    expect(source).toContain('Live evidence');
    expect(source).toContain('What this will change');
    expect(source).toContain('Review action');
    expect(source).toContain('Approve action');
    expect(source).toContain('Reject action');
    expect(source).toContain('Edit before apply');
  });
});