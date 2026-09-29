/**
 * update-user-email — Change the email address a person signs in with
 *
 * POST /functions/v1/update-user-email
 * Body: { user_id, email, reason }
 *
 * Corrects the address on an account: a typo in an invite, a staff member whose
 * name changed, or a person moving to a new work address. The sign-in identity
 * lives in auth.users, so this needs the service role; user_profiles.email is
 * the copy the console reads and is kept in step.
 *
 * Two paths, because the risk is not the same:
 *
 *  - Never signed in: the invitation is still unclaimed and the address is very
 *    often simply mistyped. It is corrected outright and the invitation re-sent.
 *
 *  - Already signed in: the account belongs to a person, so the new address has
 *    to be claimed before it becomes their sign-in identity — the same proof a
 *    new signup gives. A pending change is registered and nothing moves until it
 *    is confirmed; profile, role, organisation and history are untouched.
 *
 * Auth: grand_master / master / admin for a user in their own organisation
 * (grand_master across organisations), or client_admin for client users at
 * their own organisation. Never above the caller's own authority.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const CAN_MANAGE = ['grand_master', 'master', 'admin', 'client_admin'];
const ROLE_LABELS: Record<string, string> = {
  grand_master: 'Grand Master', master: 'Master', admin: 'Administrator', admin_officer: 'Admin Officer',
  nzscv_monitor: 'NZSCV Monitor', officer: 'Officer', scan_operator: 'Scan Operator',
  client_admin: 'Client Administrator', client_officer: 'Client Officer', client_viewer: 'Client Viewer',
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing authorization header' }, 401);

    const callerClient = createClient(supabaseUrl, serviceKey, { global: { headers: { Authorization: authHeader } } });
    const adminClient = createClient(supabaseUrl, serviceKey);

    const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
    if (authError || !caller) return json({ error: 'Unauthorized' }, 401);

    const { data: callerProfile } = await adminClient
      .from('user_profiles').select('id, organization_id, role, deactivated_at').eq('id', caller.id).single();
    if (!callerProfile || callerProfile.deactivated_at) return json({ error: 'Active identity administrator required' }, 403);
    if (!CAN_MANAGE.includes(callerProfile.role)) return json({ error: 'Forbidden: insufficient role' }, 403);

    const body = await req.json().catch(() => ({}));
    const userId = typeof body.user_id === 'string' ? body.user_id : '';
    const requested = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!userId || !requested) return json({ error: 'user_id and email are required' }, 400);
    if (!EMAIL.test(requested)) return json({ error: 'Enter a valid email address.' }, 400);
    if (!reason) return json({ error: 'A change reason is required for the audit trail.' }, 400);

    const { data: target } = await adminClient
      .from('user_profiles').select('id, organization_id, role, display_name, email').eq('id', userId).single();
    if (!target) return json({ error: 'Target user not found' }, 404);

    if (callerProfile.role !== 'grand_master' && target.organization_id !== callerProfile.organization_id) {
      return json({ error: 'Cannot change the email of users in other organizations' }, 403);
    }
    if (callerProfile.role === 'client_admin' && !String(target.role).startsWith('client_')) {
      return json({ error: 'A client administrator can only manage client users' }, 403);
    }
    // identity_role_level is the same ceiling the manage_user_identity_access RPC applies.
    const [{ data: callerLevel }, { data: targetLevel }] = await Promise.all([
      adminClient.rpc('identity_role_level', { p_role: callerProfile.role }),
      adminClient.rpc('identity_role_level', { p_role: target.role }),
    ]);
    if (typeof callerLevel === 'number' && typeof targetLevel === 'number' && targetLevel > callerLevel) {
      return json({ error: 'Cannot manage a user above your authority' }, 403);
    }

    const { data: authUser, error: getUserError } = await adminClient.auth.admin.getUserById(userId);
    if (getUserError || !authUser?.user) return json({ error: 'Could not retrieve the account' }, 500);
    const currentEmail = (authUser.user.email ?? '').toLowerCase();
    if (currentEmail === requested) return json({ error: 'That is already this account’s email address.' }, 400);

    const siteUrl = Deno.env.get('SITE_URL') ?? 'https://fcmanager.co.nz';

    // ── Claimed account: the new address proves itself first; nothing changes until it does. ──
    if (authUser.user.last_sign_in_at) {
      const { data: link, error: linkError } = await adminClient.auth.admin.generateLink({
        type: 'email_change_new',
        email: currentEmail,
        newEmail: requested,
        options: { redirectTo: `${siteUrl}/auth/callback` },
      });
      if (linkError) {
        const message = /already|registered|exists/i.test(linkError.message ?? '')
          ? 'Another account already uses that email address.'
          : linkError.message;
        return json({ error: message }, 400);
      }
      const { error: pendingAudit } = await adminClient.rpc('log_user_management_action', {
        p_organization_id: target.organization_id,
        p_target_user_id: userId,
        p_action_type: 'user_email_change_requested',
        p_performed_by: callerProfile.id,
        p_old_value: { email: currentEmail },
        p_new_value: { email: requested },
        p_metadata: { reason, display_name: target.display_name, role: target.role, requires_confirmation: true },
      });
      if (pendingAudit) console.error('[update-user-email] audit log failed:', pendingAudit.message);
      return json({
        success: true, user_id: userId, email: currentEmail, pending_email: requested,
        requires_confirmation: true, confirmation_link: link?.properties?.action_link ?? null,
      });
    }

    // ── Unclaimed invitation: correct the address outright and send the invitation to it. ──
    const { error: updateError } = await adminClient.auth.admin.updateUserById(userId, {
      email: requested,
      email_confirm: true,
    });
    if (updateError) {
      const message = /already|registered|exists/i.test(updateError.message ?? '')
        ? 'Another account already uses that email address.'
        : updateError.message;
      return json({ error: message }, 400);
    }

    // The console reads user_profiles.email; leaving it stale would show the old address as if it still worked.
    const { error: profileError } = await adminClient
      .from('user_profiles').update({ email: requested }).eq('id', userId);
    if (profileError) console.error('[update-user-email] profile sync failed:', profileError.message);

    let invitationResent = false;
    {
      const { data: org } = await adminClient
        .from('organizations').select('name, logo_url').eq('id', target.organization_id).maybeSingle();
      const { error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(requested, {
        data: {
          display_name: target.display_name || requested.split('@')[0],
          role: target.role,
          role_label: ROLE_LABELS[target.role] ?? target.role,
          organization_id: target.organization_id,
          organization_name: org?.name ?? 'Field Compliance Manager',
          organization_logo: org?.logo_url ?? '',
        },
        redirectTo: `${siteUrl}/auth/callback`,
      });
      if (inviteError) console.error('[update-user-email] invite resend failed:', inviteError.message);
      else invitationResent = true;
    }

    const { error: auditError } = await adminClient.rpc('log_user_management_action', {
      p_organization_id: target.organization_id,
      p_target_user_id: userId,
      p_action_type: 'user_email_changed',
      p_performed_by: callerProfile.id,
      p_old_value: { email: currentEmail || target.email },
      p_new_value: { email: requested },
      p_metadata: { reason, display_name: target.display_name, role: target.role, invitation_resent: invitationResent },
    });
    if (auditError) console.error('[update-user-email] audit log failed:', auditError.message);

    return json({ success: true, user_id: userId, email: requested, requires_confirmation: false, invitation_resent: invitationResent });
  } catch (err) {
    console.error('[update-user-email] unexpected error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
