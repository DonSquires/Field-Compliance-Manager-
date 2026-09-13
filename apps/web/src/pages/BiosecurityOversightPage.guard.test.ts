import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/BiosecurityOversightPage.tsx'), 'utf8');

describe('admin biosecurity assessment oversight', () => {
  it('loads assessments scoped to the organization', () => {
    expect(page).toContain("from('biosecurity_assessments')");
    expect(page).toContain(".eq('organization_id', orgId)");
    expect(page).toContain('setAssessments');
  });

  it('surfaces the officer observation and triage workflow', () => {
    expect(page).toContain("from('biosecurity_assessments')");
    expect(page).toContain('officer_name');
    expect(page).toContain('species_name');
    expect(page).toContain('evidence_state');
    expect(page).toContain('review_state');
  });

  it('routes review decisions through the expected-state RPC', () => {
    expect(page).toContain("rpc('manage_biosecurity_assessment_review'");
    expect(page).toContain('p_expected_review_state: assessment.review_state');
    expect(page).toContain('p_action');
    expect(page).not.toMatch(/from\('biosecurity_assessments'\)[\s\S]{0,300}\.(update|delete)\(/);
  });

  it('clears loading state when organization scope is unavailable', () => {
    expect(page).toContain('if (!orgId) {');
    expect(page).toContain('setLoading(false);');
  });
});
