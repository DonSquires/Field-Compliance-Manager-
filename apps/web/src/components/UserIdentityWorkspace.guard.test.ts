import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync(resolve(process.cwd(), 'src/components/UserIdentityWorkspace.tsx'), 'utf8');
const fn = readFileSync(resolve(process.cwd(), '../../supabase/functions/update-user-email/index.ts'), 'utf8');
const authContext = readFileSync(resolve(process.cwd(), 'src/context/AuthContext.tsx'), 'utf8');
const syncSql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260929140000_sync_profile_email_after_change.sql'), 'utf8');

describe('changing the address a person signs in with', () => {
  it('goes through the governed edge function, never a direct table write', () => {
    expect(workspace).toContain("supabase.functions.invoke('update-user-email'");
    expect(workspace).not.toMatch(/from\('user_profiles'\)[\s\S]{0,120}\.update\(/);
  });

  it('requires a reason and refuses a no-op change', () => {
    expect(workspace).toContain('!emailReason.trim()');
    expect(workspace).toContain("email.trim().toLowerCase() === (user.email ?? '').toLowerCase()");
    expect(fn).toContain('A change reason is required for the audit trail.');
    expect(fn).toContain('That is already this account’s email address.');
  });

  it('keeps the sign-in identity and the console copy in step', () => {
    expect(fn).toContain('auth.admin.updateUserById');
    expect(fn).toContain("from('user_profiles').update({ email: requested })");
  });

  it('holds the same authority ceiling as the identity RPC', () => {
    expect(fn).toContain("const CAN_MANAGE = ['grand_master', 'master', 'admin', 'client_admin']");
    expect(fn).toContain('Cannot change the email of users in other organizations');
    expect(fn).toContain('A client administrator can only manage client users');
    expect(fn).toContain('Cannot manage a user above your authority');
  });

  it('re-sends an unclaimed invitation to the new address and audits the change', () => {
    expect(fn).toContain('last_sign_in_at');
    expect(fn).toContain('inviteUserByEmail');
    expect(fn).toContain("p_action_type: 'user_email_changed'");
  });

  it('makes an already-signed-in account claim the new address before it replaces the old one', () => {
    expect(fn).toContain("type: 'email_change_new'");
    expect(fn).toContain("p_action_type: 'user_email_change_requested'");
    expect(fn).toContain('requires_confirmation: true');
    // the claimed path must not overwrite the sign-in identity or the console copy
    const claimed = fn.slice(fn.indexOf('if (authUser.user.last_sign_in_at)'), fn.indexOf('Unclaimed invitation'));
    expect(claimed).not.toContain('updateUserById');
    expect(claimed).not.toContain("from('user_profiles').update");
  });

  it('brings the profile copy up to the address once the person confirms it', () => {
    expect(authContext).toContain("supabase.rpc('sync_my_profile_email')");
    expect(syncSql).toContain('auth.email()');
    expect(syncSql).toContain('WHERE id = v_actor');
    expect(syncSql).toContain("'user_email_change_confirmed'");
    expect(syncSql).toContain('GRANT EXECUTE ON FUNCTION public.sync_my_profile_email() TO authenticated, service_role');
  });
});
