import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260908102000_document_promotion_proposals.sql'), 'utf8');

describe('CRM agreement proposal application boundary', () => {
  it('requires an approved proposal and explicit authoritative party data', () => {
    expect(migration).toContain('apply_crm_agreement_promotion_proposal');
    expect(migration).toContain("v_proposal.target_type <> 'crm_agreement' OR v_proposal.status <> 'approved'");
    expect(migration).toContain('p_provider_organization_id uuid');
    expect(migration).toContain('p_client_organization_id uuid');
    expect(migration).toContain('Active client organisation is required');
  });

  it('is idempotent, audited, and does not accept direct authenticated execution', () => {
    expect(migration).toContain('v_proposal.applied_target_id IS NOT NULL');
    expect(migration).toContain("'document_promotion_proposal_applied'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.apply_crm_agreement_promotion_proposal');
    expect(migration).toContain("'document_promotion_proposal_id'");
    expect(migration).toContain("'document_version_id'");
  });
});