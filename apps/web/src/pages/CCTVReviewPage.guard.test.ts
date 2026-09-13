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
    expect(source).toContain('setLoading(false);');
  });
});
