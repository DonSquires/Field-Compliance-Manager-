/**
 * deactivate-user — Deactivate or reactivate a user
 *
 * Requires admin/master/grand_master role.
 * Logs action to audit trail.
 *
 * Request body:
 * {
 *   user_id: string,
 *   action: 'deactivate' | 'reactivate',
 *   reason?: string  // Optional reason for deactivation
 * }
 *
 * Response:
 * {
 *   success: true,
 *   user_id: string,
 *   action: 'deactivate' | 'reactivate',
 *   deactivated_at: string | null
 * }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({
        error: 'Missing authorization header'
      }, 401);
    }
    // Create client with user's JWT for permission checks
    const userClient = createClient(supabaseUrl, supabaseServiceKey, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    // Create admin client for privileged operations
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    // Get current user
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return json({
        error: 'Unauthorized'
      }, 401);
    }
    // Get current user's profile
    const { data: currentProfile, error: profileError } = await adminClient.from('user_profiles').select('id, organization_id, role').eq('id', user.id).single();
    if (profileError || !currentProfile) {
      return json({
        error: 'User profile not found'
      }, 404);
    }
    // Check if user has permission (admin/master/grand_master)
    const allowedRoles = [
      'grand_master',
      'master',
      'admin'
    ];
    if (!allowedRoles.includes(currentProfile.role)) {
      return json({
        error: 'Insufficient permissions. Only admin, master, or grand_master can deactivate users.'
      }, 403);
    }
    // Parse request body
    const { user_id, action, reason } = await req.json();
    if (!user_id || !action) {
      return json({
        error: 'user_id and action are required'
      }, 400);
    }
    if (![
      'deactivate',
      'reactivate'
    ].includes(action)) {
      return json({
        error: 'action must be "deactivate" or "reactivate"'
      }, 400);
    }
    // Get target user
    const { data: targetUser, error: targetError } = await adminClient.from('user_profiles').select('id, organization_id, role, display_name, deactivated_at').eq('id', user_id).single();
    if (targetError || !targetUser) {
      return json({
        error: 'Target user not found'
      }, 404);
    }
    // Check if target user is in the same org (unless grand_master)
    if (currentProfile.role !== 'grand_master' && targetUser.organization_id !== currentProfile.organization_id) {
      return json({
        error: 'Cannot deactivate users from other organizations'
      }, 403);
    }
    // Prevent deactivating yourself
    if (targetUser.id === currentProfile.id) {
      return json({
        error: 'Cannot deactivate your own account'
      }, 400);
    }
    // Prevent deactivating grand_master (unless you are grand_master)
    if (targetUser.role === 'grand_master' && currentProfile.role !== 'grand_master') {
      return json({
        error: 'Cannot deactivate grand_master users'
      }, 403);
    }
    // Check current state
    const isCurrentlyDeactivated = !!targetUser.deactivated_at;
    if (action === 'deactivate' && isCurrentlyDeactivated) {
      return json({
        error: 'User is already deactivated'
      }, 400);
    }
    if (action === 'reactivate' && !isCurrentlyDeactivated) {
      return json({
        error: 'User is already active'
      }, 400);
    }
    // Perform action
    const updates = {};
    if (action === 'deactivate') {
      updates.deactivated_at = new Date().toISOString();
      updates.deactivated_by = currentProfile.id;
    } else {
      updates.deactivated_at = null;
      updates.deactivated_by = null;
    }
    const { error: updateError } = await adminClient.from('user_profiles').update(updates).eq('id', user_id);
    if (updateError) {
      console.error('Failed to update user:', updateError);
      return json({
        error: 'Failed to update user',
        details: updateError.message
      }, 500);
    }
    // Log to audit trail
    const metadata = {
      display_name: targetUser.display_name,
      role: targetUser.role
    };
    if (reason) {
      metadata.reason = reason;
    }
    const { error: auditError } = await adminClient.rpc('log_user_management_action', {
      p_organization_id: targetUser.organization_id,
      p_target_user_id: user_id,
      p_action_type: action === 'deactivate' ? 'user_deactivated' : 'user_reactivated',
      p_performed_by: currentProfile.id,
      p_old_value: null,
      p_new_value: null,
      p_metadata: metadata
    });
    if (auditError) {
      console.error('Failed to log audit trail:', auditError);
    // Don't fail the request if audit logging fails
    }
    return json({
      success: true,
      user_id,
      action,
      deactivated_at: updates.deactivated_at
    });
  } catch (err) {
    console.error('Unexpected error:', err);
    return json({
      error: 'Internal server error',
      details: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
