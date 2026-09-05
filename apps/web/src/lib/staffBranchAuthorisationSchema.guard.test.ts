import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905005100_govern_staff_branch_authorisations.sql'), 'utf8');

describe('staff branch authorization governance', () => {
  it('requires an active delivery branch, an authorized manager, and a reason', () => {
    expect(migration).toContain("organization_type = 'branch' and active");
    expect(migration).toContain('staff_branch_authorisation_manager_can_manage');
    expect(migration).toContain("raise exception 'A change reason is required'");
  });

  it('preserves lifecycle history and prevents stale or self-service changes', () => {
    expect(migration).toContain("p_action not in ('grant', 'update', 'suspend', 'end')");
    expect(migration).toContain("raise exception 'You cannot change your own branch access'");
    expect(migration).toContain("raise exception 'Branch authorization changed since it was opened'");
    expect(migration).toContain("'staff_branch_authorisation_' || p_action");
  });

  it('limits branch managers to their managed branches while allowing first assignment grants', () => {
    expect(migration).toContain('cardinality(public.user_managed_branch_ids()) > 0');
    expect(migration).toContain('assignment.branch_org_id = any(public.user_managed_branch_ids())');
      expect(migration).toContain('assignment.branch_org_id = any(public.user_managed_branch_ids())');
  });
});