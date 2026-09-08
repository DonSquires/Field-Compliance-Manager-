import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260908102000_document_promotion_proposals.sql'), 'utf8');

describe('document promotion proposal boundary', () => {
  it('keeps proposals separate from authoritative records and tenant scoped', () => {
    expect(migration).toContain('document_promotion_proposals');
    expect(migration).toContain('document_version_id uuid NOT NULL REFERENCES public.document_versions');
    expect(migration).toContain('organization_id uuid NOT NULL REFERENCES public.organizations');
    expect(migration).toContain("status text NOT NULL DEFAULT 'proposed'");
  });

  it('uses an authenticated governed command and audits proposal creation', () => {
    expect(migration).toContain('auth.uid()');
    expect(migration).toContain('public.is_admin_for_org(v_org_id)');
    expect(migration).toContain("'document_promotion_proposed'");
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE ON public.document_promotion_proposals');
  });
});