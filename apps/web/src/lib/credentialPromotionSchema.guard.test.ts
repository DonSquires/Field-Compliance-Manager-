import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260908102000_document_promotion_proposals.sql'), 'utf8');

describe('credential promotion execution boundary', () => {
  it('requires an approved credential proposal and same-organisation staff profile', () => {
    expect(migration).toContain('apply_credential_promotion_proposal');
    expect(migration).toContain("v_proposal.target_type <> 'credential' OR v_proposal.status <> 'approved'");
    expect(migration).toContain('v_org_id <> v_proposal.organization_id');
    expect(migration).toContain('staff_profiles');
  });

  it('creates unverified credentials with source storage and audit provenance', () => {
    expect(migration).toContain('document_storage_path');
    expect(migration).toContain('verified, notes, client_request_id');
    expect(migration).toContain('v_storage_path, false');
    expect(migration).toContain("'staff_credentials'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.apply_credential_promotion_proposal');
  });
});