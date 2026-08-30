/**
 * resend-invite — Resend invitation email to existing user
 *
 * POST /functions/v1/resend-invite
 *
 * Resends the invitation email to a user who is already registered
 * but may not have completed setup or needs a new invite link.
 *
 * Body: { user_id }
 *
 * Auth: Requires a valid JWT from an admin/master/grand_master user.
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
  'admin'
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
    if (!callerProfile || !CAN_INVITE.includes(callerProfile.role)) {
      return json({
        error: 'Forbidden: insufficient role'
      }, 403);
    }
    const body = await req.json();
    const { user_id } = body;
    if (!user_id) return json({
      error: 'user_id is required'
    }, 400);
    // Verify user exists and is in same org
    const { data: targetProfile } = await adminClient.from('user_profiles').select('id, organization_id, display_name, role').eq('id', user_id).single();
    if (!targetProfile) {
      return json({
        error: 'User not found'
      }, 404);
    }
    // Verify same org (unless grand_master)
    if (callerProfile.role !== 'grand_master' && targetProfile.organization_id !== callerProfile.organization_id) {
      return json({
        error: 'Cannot resend invite for users in other organizations'
      }, 403);
    }
    // Get user email from auth.users
    const { data: authUser, error: getUserError } = await adminClient.auth.admin.getUserById(user_id);
    if (getUserError || !authUser?.user?.email) {
      console.error('[resend-invite] get user error:', getUserError);
      return json({
        error: 'Could not retrieve user email'
      }, 500);
    }
    // Resend invite
    const siteUrl = Deno.env.get('SITE_URL') ?? 'https://fcmanager.vercel.app';
    const displayName = targetProfile.display_name || authUser.user.email.split('@')[0];
    const { error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(authUser.user.email, {
      data: {
        display_name: displayName,
        role: targetProfile.role,
        organization_id: targetProfile.organization_id
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
