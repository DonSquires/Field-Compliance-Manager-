import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const admin = readFileSync(resolve(process.cwd(), 'src/pages/NoiseControlOversightPage.tsx'), 'utf8');
const officer = readFileSync(resolve(process.cwd(), 'src/pages/OfficerNoiseControlPage.tsx'), 'utf8');
const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901012000_govern_noise_review.sql'), 'utf8');

describe('governed noise review return', () => {
  it('routes admin decisions through an expected-state RPC', () => {
    expect(admin).toContain("rpc('manage_noise_assessment_review'");
    expect(admin).toContain('p_expected_review_status: selected.review_status');
    expect(admin).toContain('Require follow-up');
    expect(admin).toContain('Close review');
    expect(admin).not.toMatch(/from\('noise_assessments'\)[\s\S]{0,300}\.update\(/);
  });

  it('generates court-ready evidence packages through the edge function', () => {
    expect(admin).toContain("supabase.functions.invoke<{ evidence_package_url?: string }>('generate-noise-evidence-package'");
    expect(admin).toContain('assessment_id: assessment.id');
    expect(admin).toContain('Generate evidence package');
    expect(admin).not.toMatch(/from\('noise_assessments'\)[\s\S]{0,300}\.update\(/);
  });

  it('shows and focuses exact officer review outcomes', () => {
    expect(officer).toContain("get('assessment')");
    expect(officer).toContain('Supervisor review');
    expect(officer).toContain('officer-noise-${a.id}');
  });

  it('locks, audits, personally notifies, and closes direct updates', () => {
    for (const value of ['for update', 'is_admin_for_org', 'p_expected_review_status', "'noise_assessment_reviewed'", 'p_recipient_user_id=>v_officer', "'assessment_id',v_item.id"]) expect(sql).toContain(value);
    expect(sql).toContain('revoke update,delete on table public.noise_assessments from authenticated');
    expect(sql).toContain('from public,anon;');
  });

  it('clears loading state when organization scope is unavailable', () => {
    expect(admin).toContain('if (!orgId) {');
    expect(admin).toContain('setLoading(false);');
  });
});