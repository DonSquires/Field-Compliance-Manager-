import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830145000_govern_user_identity_access.sql'), 'utf8');

describe('governed user spine', () => {
  it('restores the audit owner used by identity edge functions', () => {
    expect(sql).toContain('log_user_management_action');
    expect(sql).toContain('Complete audit provenance is required');
    expect(sql).toContain('grant execute on function public.log_user_management_action');
  });

  it('enforces authority, expected state, self-protection, and reasoned changes', () => {
    expect(sql).toContain('identity_role_level(v_target.role)>public.identity_role_level(v_actor.role)');
    expect(sql).toContain('v_target.updated_at<>p_expected_updated_at');
    expect(sql).toContain('You cannot change your own role');
    expect(sql).toContain('You cannot change your own access preset');
    expect(sql).toContain('v_old_identity');
    expect(sql).toContain('A change reason is required');
  });

  it('owns preset assignment and direct grant revocation', () => {
    expect(sql).toContain("p_action='set_preset'");
    expect(sql).toContain("p_action='clear_preset'");
    expect(sql).toContain("p_action='end_grant'");
    expect(sql).toContain("'direct_access_grant_ended'");
  });

  it('derives human readiness and closes direct identity/access mutations', () => {
    for (const table of ['user_profiles', 'staff_profiles', 'preset_assignments', 'staff_credentials']) expect(sql).toContain(table);
    expect(sql).toContain('Ready for assigned responsibilities');
    for (const table of ['user_profiles', 'preset_assignments', 'staff_area_grants']) expect(sql).toContain(`revoke insert,update,delete,truncate on public.${table}`);
  });
});