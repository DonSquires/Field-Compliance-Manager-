import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim();
const anonKey = (Deno.env.get('SUPABASE_ANON_KEY') ?? '').trim();
const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
const applyApiKey = (Deno.env.get('AKAHU_APPLY_API_KEY') ?? '').trim();
const applyBase = 'https://api.apply.akahu.nz/v1';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Authentication required' }, 401);
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: 'Authentication required' }, 401);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: profile } = await admin.from('user_profiles').select('organization_id,role,deactivated_at').eq('id', user.id).maybeSingle();
  if (!profile?.organization_id || profile.deactivated_at) return json({ error: 'Active organisation profile required' }, 403);
  if (!['grand_master', 'master', 'admin', 'admin_officer'].includes(profile.role)) return json({ error: 'Finance administrator required' }, 403);
  // A missing provider key is a provisioning state, not a server fault: report it
  // so the workspace can show "not connected" instead of failing every page load.
  if (!applyApiKey) return json({ configured: false, reason: 'akahu_apply_not_configured', apply_org: null, api_key_exposed: false });

  const response = await fetch(`${applyBase}/orgs/current`, { headers: { Authorization: `Bearer ${applyApiKey}`, Accept: 'application/json' } });
  if (!response.ok) return json({ error: 'Akahu Apply rejected the server configuration', upstream_status: response.status }, response.status === 401 ? 502 : 502);
  const payload = await response.json();
  return json({ configured: true, apply_org: { id: payload._id, name: payload.name }, api_key_exposed: false });
});
