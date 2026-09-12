import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const akahuAppId = Deno.env.get('AKAHU_APP_ID') ?? '';
const akahuRedirectUri = Deno.env.get('AKAHU_REDIRECT_URI') ?? '';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map((byte) => byte.toString(16).padStart(2, '0')).join('');

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!/^app_token_[a-z0-9]+$/i.test(akahuAppId) || !akahuRedirectUri) return json({ error: 'Akahu App ID Token or redirect URI is not configured correctly' }, 503);

  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Authentication required' }, 401);
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: 'Authentication required' }, 401);

  const body = await request.json().catch(() => ({}));
  const requestId = typeof body.request_id === 'string' ? body.request_id : '';
  if (!requestId) return json({ error: 'request_id is required' }, 400);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: profile } = await admin.from('user_profiles').select('organization_id,deactivated_at,role').eq('id', user.id).maybeSingle();
  if (!profile?.organization_id || profile.deactivated_at) return json({ error: 'Active organisation profile required' }, 403);
  const { data: requestRow } = await admin.from('finance_external_connection_requests').select('id,organization_id,provider_type,bank_account_id').eq('id', requestId).maybeSingle();
  if (!requestRow || requestRow.organization_id !== profile.organization_id || requestRow.provider_type !== 'bank') return json({ error: 'ANZ connection request not found' }, 404);
  if (!['grand_master', 'master', 'admin', 'admin_officer'].includes(profile.role)) return json({ error: 'Finance administrator required' }, 403);

  const state = `${crypto.randomUUID()}.${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { error: startError } = await admin.rpc('start_finance_external_oauth', { p_request_id: requestId, p_state_hash: await hash(state), p_state_expires_at: expiresAt, p_adapter_name: 'akahu' });
  if (startError) return json({ error: 'OAuth request could not be prepared' }, 400);

  const params = new URLSearchParams({ response_type: 'code', client_id: akahuAppId, redirect_uri: akahuRedirectUri, scope: 'ENDURING_CONSENT', state });
  return json({ authorization_url: `https://oauth.akahu.nz?${params.toString()}`, expires_at: expiresAt });
});
