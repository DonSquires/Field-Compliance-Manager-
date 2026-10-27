/**
 * resend-invite — Resend invitation email to existing user
 *
 * POST /functions/v1/resend-invite
 *
 * Resends the invitation email to a user who is already registered
 * but may not have completed setup or needs a new invite link.
 *
 * Body: { user_id } or { organization_id } (the one user of that organisation who has never signed in).
 *
 * Auth: a grand_master/master/admin for a user in their own organisation; a client_admin for their own
 * organisation; or anyone resolve_org_invitation authorises to seat that organisation's first user
 * (the provider re-sending a client's invitation).
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_INVITE = [
  'grand_master',
  'master',
  'admin',
  'admin_officer'
];
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  const json = (body, status = 200)=>new Response(JSON.stringify(body), {
      status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  try {
    // Verify caller JWT
    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
    if (authError || !caller) return json({
      error: 'Unauthorized'
    }, 401);
    // Get caller profile to check role
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile } = await adminClient.from('user_profiles').select('role, organization_id').eq('id', caller.id).single();
    if (!callerProfile || !(CAN_INVITE.includes(callerProfile.role) || callerProfile.role === 'client_admin')) {
      return json({
        error: 'Forbidden: insufficient role'
      }, 403);
    }
    const body = await req.json();
    let { user_id } = body;
    const organization_id = body.organization_id;
    if (!user_id && !organization_id) return json({
      error: 'user_id or organization_id is required'
    }, 400);
    let targetProfile = null;
    if (user_id) {
      const { data } = await adminClient.from('user_profiles').select('id, organization_id, display_name, role').eq('id', user_id).single();
      targetProfile = data;
      if (!targetProfile) return json({
        error: 'User not found'
      }, 404);
    }
    // Authority first, before anything about the target organisation is looked up (no enumeration through the answers).
    const targetOrgId = targetProfile?.organization_id ?? organization_id;
    const sameOrg = targetOrgId === callerProfile.organization_id;
    if (callerProfile.role === 'client_admin' && !sameOrg) {
      return json({
        error: 'Cannot resend invite for users in other organizations'
      }, 403);
    }
    if (callerProfile.role !== 'grand_master' && !sameOrg) {
      // the provider re-sending its client's invitation: the same authority that could have sent it
      const { data: resolved, error: resolveError } = await callerClient.rpc('resolve_org_invitation', { p_target_organization_id: targetOrgId });
      if (resolveError || !resolved?.role) return json({
        error: 'Cannot resend invite for users in other organizations'
      }, 403);
    }
    if (!targetProfile) {
      // the organisation's users who have never signed in; exactly one means the first-user invitation is still pending
      const { data: orgProfiles } = await adminClient.from('user_profiles').select('id, organization_id, display_name, role').eq('organization_id', targetOrgId).is('deactivated_at', null);
      const pending = [];
      for (const profile of orgProfiles ?? []) {
        const { data: candidate } = await adminClient.auth.admin.getUserById(profile.id);
        if (candidate?.user && !candidate.user.last_sign_in_at) pending.push(profile);
      }
      if (pending.length === 0) return json({
        error: 'Nobody at this organisation is waiting for an invitation; they have already signed in.'
      }, 404);
      if (pending.length > 1) return json({
        error: 'Several people at this organisation have not signed in yet; choose the person to re-invite.'
      }, 400);
      targetProfile = pending[0];
      user_id = targetProfile.id;
    }
    const { data: authUser, error: getUserError } = await adminClient.auth.admin.getUserById(user_id);
    if (getUserError || !authUser?.user?.email) {
      console.error('[resend-invite] get user error:', getUserError);
      return json({
        error: 'Could not retrieve user email'
      }, 500);
    }
    if (authUser.user.last_sign_in_at) return json({
      error: 'This person has already signed in. If they cannot get in, they can use "Forgot password" on the sign-in page.'
    }, 409);
    const { data: targetOrg } = await adminClient.from('organizations').select('name, logo_url').eq('id', targetProfile.organization_id).maybeSingle();
    const ROLE_LABELS: Record<string, string> = { grand_master: 'Grand Master', master: 'Master', admin: 'Administrator', admin_officer: 'Admin Officer', nzscv_monitor: 'NZSCV Monitor', officer: 'Officer', scan_operator: 'Scan Operator', client_admin: 'Client Administrator', client_officer: 'Client Officer', client_viewer: 'Client Viewer' };
    const siteUrl = Deno.env.get('SITE_URL') ?? 'https://fcmanager.co.nz';
    const displayName = targetProfile.display_name || authUser.user.email.split('@')[0];
    // the landing page reads organisation_name and role_label from the invited user's metadata
    const { error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(authUser.user.email, {
      data: {
        display_name: displayName,
        role: targetProfile.role,
        role_label: ROLE_LABELS[targetProfile.role] ?? targetProfile.role,
        organization_id: targetProfile.organization_id,
        organization_name: targetOrg?.name ?? 'Field Compliance Manager',
        organization_logo: targetOrg?.logo_url ?? ''
      },
      redirectTo: `${siteUrl}/auth/callback`
    });
    if (inviteError) {
      console.error('[resend-invite] invite error:', inviteError);
      let errorMsg = inviteError.message;
      if (inviteError.message?.includes('SMTP')) {
        errorMsg = 'Email service not configured. Contact your administrator to set up SMTP.';
      } else if (inviteError.message?.includes('rate limit')) {
        errorMsg = 'Too many invite attempts. Please wait a few minutes and try again.';
      }
      return json({
        error: errorMsg,
        details: inviteError.message
      }, 400);
    }
    const { error: auditError } = await adminClient.rpc('log_user_management_action', {
      p_organization_id: targetProfile.organization_id,
      p_target_user_id: user_id,
      p_action_type: 'invite_resent',
      p_performed_by: caller.id,
      p_old_value: null,
      p_new_value: null,
      p_metadata: {
        display_name: displayName,
        role: targetProfile.role
      }
    });
    if (auditError) console.error('[resend-invite] audit log failed:', auditError.message);
    console.log(`[resend-invite] resent invite to ${authUser.user.email}`);
    return json({
      success: true,
      email: authUser.user.email
    });
  } catch (err) {
    console.error('[resend-invite] unexpected error:', err);
    const errorMsg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: errorMsg
    }, 500);
  }
});
