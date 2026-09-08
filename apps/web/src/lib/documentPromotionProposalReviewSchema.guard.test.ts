import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260908102000_document_promotion_proposals.sql'), 'utf8');

describe('governed document promotion proposal review', () => {
  it('requires authenticated tenant-scoped review and a valid decision', () => {
    expect(migration).toContain('review_document_promotion_proposal');
    expect(migration).toContain("p_decision NOT IN ('approved', 'rejected')");
    expect(migration).toContain('public.is_admin_for_org(v_proposal.organization_id)');
    expect(migration).toContain("v_proposal.status <> 'proposed'");
  });

  it('requires a reason, records reviewer state, and audits the decision', () => {
    expect(migration).toContain('Review reason is required');
    expect(migration).toContain('reviewed_by = v_actor');
    expect(migration).toContain("'document_promotion_proposal_reviewed'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.review_document_promotion_proposal');
  });
});