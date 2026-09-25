import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/CCTVReviewPage.tsx'), 'utf8');

describe('CCTV inference review', () => {
  it('loads inference jobs scoped to the organization', () => {
    expect(source).toContain("from('inference_jobs')");
    expect(source).toContain(".eq('organization_id', profile.organizationId)");
    expect(source).toContain('CCTV_DOMAINS');
  });

  it('joins evidence items to show source metadata', () => {
    expect(source).toContain("from('evidence_items')");
    expect(source).toContain('storage_path');
    expect(source).toContain('evidence_kind');
  });

  it('subscribes to job and evidence mutations for live refresh', () => {
    expect(source).toContain('.channel(');
    expect(source).toContain('cctv-review-');
    expect(source).toContain('profile.organizationId');
    expect(source).toContain("event: '*'");
    expect(source).toContain("table: 'inference_jobs'");
    expect(source).toContain("table: 'evidence_items'");
  });

  it('clears loading state when organization scope is unavailable', () => {
    expect(source).toContain('if (!profile?.organizationId) {');
    expect(source).toContain("setError('Organisation access could not be confirmed. CCTV review is unavailable.');");
    expect(source).toContain('setLoading(false);');
  });

  it('shows GPU inference use against the daily budget and lets an administrator set it through the governed RPC', () => {
    expect(source).toContain("supabase.rpc('cctv_inference_usage', { p_organization_id: profile.organizationId, p_days: 14 })");
    expect(source).toContain("supabase.rpc('set_cctv_inference_budget', { p_organization_id: profile.organizationId, p_daily_frame_budget: Math.round(frames), p_reason: 'Set from CCTV review' })");
    expect(source).toContain('aria-label="Inference usage and budget"');
    expect(source).toContain('Nothing fails; work resumes on its own.');
    expect(source).not.toMatch(/from\('cctv_inference_budgets'\)/);
  });

  it('issues the receipt before printing, prints it on the page, and offers verification through the governed RPC', () => {
    const issueIndex = source.indexOf("supabase.rpc('issue_cctv_report_receipt'");
    const buildIndex = source.indexOf('const report = buildCCTVPrintableReport({');
    expect(issueIndex).toBeGreaterThan(0);
    expect(buildIndex).toBeGreaterThan(issueIndex);
    expect(source).toContain('receipt: { reportId: issuedReceipt.report_id, issuedAt: issuedReceipt.generated_at, sha256: issuedReceipt.sha256, provenance: issuedReceipt.provenance ?? null }');
    expect(source).toContain("supabase.rpc('verify_cctv_report_receipt', { p_receipt_id: receiptId, p_sha256: verifyDraft.sha256.trim() || null })");
    expect(source).toContain('aria-label="Verify a printed report"');
    expect(source).toContain('The hash on the page does NOT match this receipt.');
    expect(source).not.toMatch(/from\('cctv_report_receipts'\)[\s\S]{0,300}\.(insert|update|delete)\(/);
  });

  it('explains each failed job in plain words and only bulk-retries failures a retry can fix', () => {
    expect(source).toContain("import { describeJobFailure, summariseFailures, type JobFailure } from '../lib/cctvJobFailure';");
    expect(source).toContain('describeJobFailure(job.error_message, fileName)');
    expect(source).toContain("jobFailures.get(job.id)?.retryLikelyHelps");
    expect(source).toContain('Retry the {failureSummary.retryable} fixable');
    expect(source).toContain("'Retry anyway' : 'Retry'");
    expect(source).toContain('Worker message (for engineers):');
    expect(source).toContain("<strong>Next step:</strong> {failure.nextStep}");
    // The governed RPC remains the only way a job changes state from this page.
    expect(source).not.toMatch(/from\('inference_jobs'\)[\s\S]{0,300}\.(update|delete)\(/);
  });

  it('supports a searchable split workspace and a synchronized second-screen inspector', () => {
    expect(source).toContain("type ReviewWorkspaceMode = 'split' | 'queue' | 'inspect'");
    expect(source).toContain('aria-label="Choose review layout"');
    expect(source).toContain('aria-label="Find CCTV evidence"');
    expect(source).toContain("window.localStorage.setItem(REVIEW_SELECTION_KEY, jobId)");
    expect(source).toContain("window.addEventListener('storage', syncSelection)");
    expect(source).toContain("url.searchParams.set('reviewMode', 'inspect')");
    expect(source).toContain("url.searchParams.set('reviewPopout', '1')");
    expect(source).toContain('Open inspector window');
  });

  it('puts the primary recording before report administration in the inspector', () => {
    expect(source.indexOf('className="cctv-media-container"')).toBeGreaterThan(0);
    expect(source.indexOf('className="cctv-media-container"')).toBeLessThan(source.indexOf('className={`cctv-report-readiness'));
    expect(source).toContain('evidenceDisplayName(job.evidence)');
    expect(source).toContain('evidenceDisplayName(selected.evidence)');
  });

  it('integrates governed observation records and hands canonical writes to the record editor', () => {
    expect(source).toContain("from('cctv_entity_observations')");
    expect(source).toContain(".eq('evidence_item_id', selected.evidence_item_id)");
    expect(source).toContain('.map(toObservation)');
    expect(source).toContain("activeTab === 'records'");
    expect(source).toContain('Add or link record');
    expect(source).toContain('Update record');
    expect(source).toContain('History on screen 2');
    expect(source).toContain('area=cctv-triage&observation=${observationId}');
    expect(source).toContain("table: 'cctv_entity_observations'");
    expect(source).not.toMatch(/from\('canonical_(people|vehicles)'\)[\s\S]{0,300}\.(insert|update|delete)\(/);
  });
});
