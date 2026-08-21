/**
 * delete-user — Permanently delete a user (Grand Master only)
 *
 * Hard-deletes the Supabase Auth user; the public.user_profiles row (and any
 * FK-cascading children) are removed by the database. Distinct from
 * deactivate-user (soft). Restricted to grand_master.
 *
 * Body: { user_id: string }
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
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({
      error: 'Missing authorization header'
    }, 401);
    const userClient = createClient(supabaseUrl, serviceKey, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const { data: caller } = await adminClient.from('user_profiles').select('id, role').eq('id', user.id).single();
    // Hard delete is Grand Master only.
    if (!caller || caller.role !== 'grand_master') {
      return json({
        error: 'Only a Grand Master can permanently delete a user.'
      }, 403);
    }
    const { user_id } = await req.json();
    if (!user_id) return json({
      error: 'user_id is required'
    }, 400);
    if (user_id === caller.id) return json({
      error: 'You cannot delete your own account.'
    }, 400);
    // Remove dependent rows that are not FK-cascaded from auth.users, then the
    // profile, then the auth user.
    await adminClient.from('staff_branch_authorisations').delete().eq('user_id', user_id);
    await adminClient.from('staff_profiles').delete().eq('user_id', user_id);
    await adminClient.from('user_profiles').delete().eq('id', user_id);
    const { error: delErr } = await adminClient.auth.admin.deleteUser(user_id);
    if (delErr) {
      console.error('[delete-user] auth delete error:', delErr.message);
      return json({
        error: `Profile removed, but auth user delete failed: ${delErr.message}`
      }, 500);
    }
    console.log(`[delete-user] ${caller.id} permanently deleted user ${user_id}`);
    return json({
      success: true,
      user_id
    });
  } catch (err) {
    console.error('[delete-user] unexpected error:', err);
    return json({
      error: err instanceof Error ? err.message : 'Internal error'
    }, 500);
  }
});
