import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim();
const anonKey = (Deno.env.get('SUPABASE_ANON_KEY') ?? '').trim();
const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
const applyApiKey = (Deno.env.get('AKAHU_APPLY_API_KEY') ?? '').trim();
const applyRedirectUri = (Deno.env.get('AKAHU_APPLY_REDIRECT_URI') ?? '').trim();
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
  const applicationId = typeof body.application_id === 'string' ? body.application_id : '';
  const requestedDays = typeof body.requested_days === 'number' ? body.requested_days : 365;
  const allowManualUploads = body.allow_manual_uploads !== false;
  if (!applicationId || !/^application_[a-z0-9]{24,27}$/.test(applicationId)) return json({ error: 'A valid Apply application is required' }, 400);
  if (!Number.isInteger(requestedDays) || requestedDays < 30 || requestedDays > 730) return json({ error: 'requested_days must be between 30 and 730' }, 400);

  const { data: application } = await admin.from('finance_akahu_apply_applications').select('id,akahu_application_id').eq('id', applicationId).eq('organization_id', profile.organization_id).maybeSingle();
  if (!application) return json({ error: 'Apply application not found for this organisation' }, 404);

  const requestBody: Record<string, unknown> = { requested_days: requestedDays, allow_manual_uploads: allowManualUploads, allow_multiple_ob_connections: true };
  if (applyRedirectUri) requestBody.redirect_uri = applyRedirectUri;
  const response = await fetch(`${applyBase}/applications/${application.akahu_application_id}/sharing-request`, { method: 'POST', headers: { Authorization: `Bearer ${applyApiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
  if (!response.ok) return json({ error: 'Akahu Apply could not create the sharing request', upstream_status: response.status }, 502);
  const payload = await response.json();
  if (typeof payload._id !== 'string' || typeof payload.link !== 'string' || typeof payload.expires_at !== 'string') return json({ error: 'Akahu Apply returned an incomplete sharing request' }, 502);

  const { data: sharingRequest, error: insertError } = await admin.from('finance_akahu_apply_sharing_requests').insert({ organization_id: profile.organization_id, application_id: application.id, akahu_sharing_request_id: payload._id, link: payload.link, expires_at: payload.expires_at, created_by: user.id }).select('id,application_id,akahu_sharing_request_id,link,expires_at,last_submitted_at').single();
  if (insertError) return json({ error: 'Sharing request was created but could not be recorded locally' }, 500);
  await admin.from('audit_log').insert({ organization_id: profile.organization_id, actor_user_id: user.id, action: 'finance_akahu_apply_sharing_request_created', target_table: 'finance_akahu_apply_sharing_requests', target_id: sharingRequest.id, metadata: { application_id: application.id, requested_days: requestedDays, allow_manual_uploads: allowManualUploads } });
  return json({ created: true, sharing_request: sharingRequest });
});
