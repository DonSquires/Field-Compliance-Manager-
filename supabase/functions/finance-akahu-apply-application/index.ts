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
  if (!applyApiKey) return json({ error: 'Akahu Apply is not configured yet' }, 503);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Authentication required' }, 401);
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: 'Authentication required' }, 401);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: profile } = await admin.from('user_profiles').select('organization_id,role,deactivated_at').eq('id', user.id).maybeSingle();
  if (!profile?.organization_id || profile.deactivated_at) return json({ error: 'Active organisation profile required' }, 403);
  if (!['grand_master', 'master', 'admin', 'admin_officer'].includes(profile.role)) return json({ error: 'Finance administrator required' }, 403);

  const body = await request.json().catch(() => ({}));
  const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
  if (!reference || reference.length > 500) return json({ error: 'A reference between 1 and 500 characters is required' }, 400);

  const { data: existing } = await admin.from('finance_akahu_apply_applications').select('id,akahu_application_id,reference,status').eq('organization_id', profile.organization_id).eq('reference', reference).maybeSingle();
  if (existing) return json({ created: false, application: existing });

  const response = await fetch(`${applyBase}/applications`, { method: 'POST', headers: { Authorization: `Bearer ${applyApiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ reference }) });
  if (!response.ok) return json({ error: 'Akahu Apply could not create the application', upstream_status: response.status }, 502);
  const payload = await response.json();
  if (typeof payload._id !== 'string' || !/^application_[a-z0-9]{24,27}$/.test(payload._id)) return json({ error: 'Akahu Apply returned an invalid application identifier' }, 502);

  const { data: application, error: insertError } = await admin.from('finance_akahu_apply_applications').insert({ organization_id: profile.organization_id, akahu_application_id: payload._id, reference, status: payload.status === 'archived' ? 'archived' : 'active', created_by: user.id }).select('id,akahu_application_id,reference,status').single();
  if (insertError) return json({ error: 'Apply application was created but could not be recorded locally' }, 500);
  await admin.from('audit_log').insert({ organization_id: profile.organization_id, actor_user_id: user.id, action: 'finance_akahu_apply_application_created', target_table: 'finance_akahu_apply_applications', target_id: application.id, metadata: { akahu_application_id: payload._id, reference } });
  return json({ created: true, application });
});
