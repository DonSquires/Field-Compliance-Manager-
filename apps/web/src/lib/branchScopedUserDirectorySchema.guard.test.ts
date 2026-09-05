import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905005300_branch_scoped_user_directory.sql'), 'utf8');

describe('branch-scoped user directory', () => {
  it('requires an authorized active delivery branch and joins through staff branch assignments', () => {
    expect(migration).toContain('user_can_operate_organization(p_operating_organization_id)');
    expect(migration).toContain("organization_type = 'branch' and active");
    expect(migration).toContain('from public.staff_branch_authorisations assignment');
  });

  it('uses the governed manager scope for every returned person', () => {
    expect(migration).toContain('staff_branch_authorisation_manager_can_manage(v_actor, v_branch.id, user_profile.id)');
  });
});