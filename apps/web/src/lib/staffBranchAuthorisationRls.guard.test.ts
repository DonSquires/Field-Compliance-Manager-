import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905005200_harden_staff_branch_authorisation_rls.sql'), 'utf8');

describe('staff branch authorization RLS', () => {
  it('removes direct browser writes and retains self-read access', () => {
    expect(migration).toContain('DROP POLICY IF EXISTS sba_write');
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE ON public.staff_branch_authorisations FROM authenticated');
    expect(migration).toContain('user_id = auth.uid()');
  });

  it('limits branch managers to managed branches while retaining corporate HR administration', () => {
    expect(migration).toContain("actor.role in ('master', 'admin')");
    expect(migration).toContain('staff_branch_authorisations.branch_org_id = any(public.user_managed_branch_ids())');
    expect(migration).toContain('target.employer_organization_id = coalesce(actor.employer_organization_id, actor.organization_id)');
  });
});