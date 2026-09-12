import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim();
const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
const appId = (Deno.env.get('AKAHU_APP_ID') ?? '').trim();
const userToken = (Deno.env.get('AKAHU_PERSONAL_USER_TOKEN') ?? '').trim();
const apiBase = 'https://api.akahu.io/v1';
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!/^app_token_[a-z0-9]+$/i.test(appId) || !userToken) return json({ error: 'Personal Akahu test configuration is incomplete' }, 503);
  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Authentication required' }, 401);
  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: 'Authentication required' }, 401);
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: profile } = await admin.from('user_profiles').select('id,organization_id,role,deactivated_at').eq('id', user.id).maybeSingle();
  if (!profile || profile.role !== 'grand_master' || profile.deactivated_at) return json({ error: 'Grandmaster-only personal test' }, 403);
  const headers = { Authorization: `Bearer ${userToken}`, 'X-Akahu-Id': appId, Accept: 'application/json' };
  const accountsResponse = await fetch(`${apiBase}/accounts`, { headers });
  if (!accountsResponse.ok) {
    const providerPayload = await accountsResponse.json().catch(() => ({}));
    const providerCode = typeof providerPayload.code === 'string' ? providerPayload.code : typeof providerPayload.error === 'string' ? providerPayload.error : undefined;
    const providerMessage = typeof providerPayload.message === 'string' ? providerPayload.message : undefined;
    const diagnostic = [providerCode, providerMessage].filter(Boolean).join(': ').slice(0, 240) || `HTTP ${accountsResponse.status}`;
    await admin.rpc('record_akahu_personal_check', { p_actor_user_id: user.id, p_app_reference: 'akahu-personal', p_account_count: 0, p_account_summary: [], p_status: 'failed', p_error_category: `Akahu accounts endpoint rejected the request: ${diagnostic}` });
    return json({ error: 'Akahu Personal App request was rejected.', failed_endpoint: 'accounts', upstream_status: accountsResponse.status, provider_diagnostic: diagnostic, personal_test_only: true });
  }
  const accountsPayload = await accountsResponse.json();
  const accounts = accountsPayload.items ?? accountsPayload.data ?? [];
  const summary = accounts.map((account: Record<string, unknown>) => ({ id_suffix: String(account.id ?? '').slice(-6), name: account.name ?? account.account_name ?? 'Connected account', institution: account.connection?.name ?? account.institution ?? 'Connected institution', currency: account.currency ?? 'NZD' }));
  const { error: recordError } = await admin.rpc('record_akahu_personal_check', { p_actor_user_id: user.id, p_app_reference: 'akahu-personal', p_account_count: summary.length, p_account_summary: summary, p_status: 'verified', p_error_category: null });
  if (recordError) return json({ error: 'Personal test result could not be recorded' }, 500);
  return json({ verified: true, account_count: summary.length, accounts: summary, transactions_imported: false, personal_test_only: true });
});
