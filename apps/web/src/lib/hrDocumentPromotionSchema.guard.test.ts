import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260908102000_document_promotion_proposals.sql'), 'utf8');

describe('HR document promotion execution boundary', () => {
  it('requires approved HR proposals and same-organisation staff', () => {
    expect(migration).toContain('apply_hr_document_promotion_proposal');
    expect(migration).toContain("v_proposal.target_type <> 'hr_case' OR v_proposal.status <> 'approved'");
    expect(migration).toContain('v_org_id <> v_proposal.organization_id');
    expect(migration).toContain('staff_profiles');
  });

  it('registers only explicit staff documents and audits the source proposal', () => {
    expect(migration).toContain('staff_documents');
    expect(migration).toContain('File name and secure storage path are required');
    expect(migration).toContain('document_promotion_proposal_applied');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.apply_hr_document_promotion_proposal');
  });
});