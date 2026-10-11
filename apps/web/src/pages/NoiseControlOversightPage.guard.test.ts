import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const admin = readFileSync(resolve(process.cwd(), 'src/pages/NoiseControlOversightPage.tsx'), 'utf8');
const officer = readFileSync(resolve(process.cwd(), 'src/pages/OfficerNoiseControlPage.tsx'), 'utf8');
const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260901012000_govern_noise_review.sql'), 'utf8');
const evidencePackage = readFileSync(resolve(process.cwd(), '../../supabase/functions/generate-noise-evidence-package/index.ts'), 'utf8');

describe('governed noise review return', () => {
  it('routes admin decisions through an expected-state RPC', () => {
    expect(admin).toContain("rpc('manage_noise_assessment_review'");
    expect(admin).toContain('p_expected_review_status: selected.review_status');
    expect(admin).toContain('Require follow-up');
    expect(admin).toContain('Close review');
    expect(admin).not.toMatch(/from\('noise_assessments'\)[\s\S]{0,300}\.update\(/);
  });

  it('separates photo interpretation from acoustic, legal, and workflow authority', () => {
    expect(admin).toContain("rpc('review_noise_photo_classification'");
    expect(admin).toContain('Review photo');
    expect(admin).toContain('A photo cannot measure noise, set the matrix, determine excessive noise, or authorize enforcement.');
    expect(admin).toContain("createSignedUrl(path, 900)");
    expect(admin).toContain('Acoustic matrix and legal action were unchanged');
    expect(officer).toContain("'submit-noise-assessment'");
    expect(officer).toContain('image_base64: imageBase64');
    expect(officer).toContain('The officer matrix remains authoritative');
  });

  it('generates court-ready evidence packages through the edge function', () => {
    expect(admin).toContain("supabase.functions.invoke<{ evidence_package_url?: string }>('generate-noise-evidence-package'");
    expect(admin).toContain('assessment_id: assessment.id');
    expect(admin).toContain('Generate evidence package');
    expect(admin).not.toMatch(/from\('noise_assessments'\)[\s\S]{0,300}\.update\(/);
    expect(evidencePackage).toContain('caller.rpc("is_admin_for_org", { target_org_id: assessment.organization_id })');
    expect(evidencePackage).toContain('if (mayGenerate !== true)');
    expect(evidencePackage).toContain('deactivated_at');
    expect(admin).toContain('evidence_package_url');
    expect(admin).toContain('GeneratedArtifactActions bucket="notice-artifacts"');
    expect(evidencePackage).toContain('up to 8 days');
    expect(evidencePackage).toContain('recorded expiry above governs this assessment');
    expect(evidencePackage).toContain('may apply for return of seized property at any time');
    expect(evidencePackage).not.toContain('72 hours from the time of issue');
    expect(evidencePackage).not.toContain('minimum of 28 days');
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
    expect(officer).toContain("if (!profile?.id || !profile?.organizationId) {");
    expect(officer).toContain("setError('Organisation access could not be confirmed. Noise assessments are unavailable.');");
    expect(officer).toContain('setLoading(false);');
  });
});
describe('attendance report and review-queue flags', () => {
  it('renders the client attendance report only through the basis-scoped RPC', () => {
    expect(admin).toContain("rpc('get_noise_attendance_report'");
    expect(admin).toContain('complainant identity is never in this report');
    expect(admin).not.toContain("from('dispatch_job_protected_parties')");
    expect(admin).not.toContain("from('shift_stops')");
    expect(admin).toContain('DELAY REASON MISSING');
  });

  it('flags statutory and evidence gaps in the review queue', () => {
    expect(admin).toContain("flags.push('END without a complaint job')");
    expect(admin).toContain("flags.push('Seizure without Police present')");
    expect(admin).toContain("flags.push('Assessment position not measured')");
    expect(admin).toContain("['off_site', 'no_gps', 'unverified_boundary', 'no_geofence'].includes(stop.arrival_verification)");
  });
});
