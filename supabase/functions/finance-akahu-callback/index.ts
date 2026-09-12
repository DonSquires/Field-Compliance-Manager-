import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const appId = Deno.env.get('AKAHU_APP_ID') ?? '';
const appSecret = Deno.env.get('AKAHU_APP_SECRET') ?? '';
const redirectUri = Deno.env.get('AKAHU_REDIRECT_URI') ?? '';
const apiBase = 'https://api.akahu.io/v1';
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
const html = (title: string, message: string, status = 200) => new Response(`<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p><p>You can close this window and return to Finance.</p></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

serve(async (request) => {
  if (request.method !== 'GET') return html('Akahu connection', 'This callback accepts GET requests only.', 405);
  if (!appId || !appSecret || !redirectUri) return html('Connection not configured', 'The Akahu provider is not configured yet.', 503);
  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');
  const providerError = params.get('error');
  if (providerError || !code || !state) return html('Connection not completed', 'The ANZ authorisation was cancelled or did not return a valid code.', 400);

  const admin = createClient(url, serviceKey);
  const stateHash = await hash(state);
  const { data: requestRow } = await admin.from('finance_external_connection_requests').select('id,organization_id,provider_type,provider_name,oauth_state_expires_at').eq('oauth_state_hash', stateHash).maybeSingle();
  if (!requestRow || requestRow.provider_type !== 'bank' || requestRow.provider_name !== 'ANZ' || !requestRow.oauth_state_expires_at || new Date(requestRow.oauth_state_expires_at).getTime() < Date.now()) return html('Connection expired', 'This authorisation window has expired. Start the ANZ connection again.', 400);

  const tokenResponse = await fetch(`${apiBase}/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: appId, client_secret: appSecret }) });
  if (!tokenResponse.ok) return html('Connection failed', 'Akahu did not confirm the authorisation code.', 502);
  const token = await tokenResponse.json();
  const accessToken = typeof token.access_token === 'string' ? token.access_token : '';
  if (!accessToken) return html('Connection failed', 'Akahu returned no usable access token.', 502);

  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  const [accountsResponse, transactionsResponse] = await Promise.all([fetch(`${apiBase}/accounts`, { headers }), fetch(`${apiBase}/transactions`, { headers })]);
  const accountsPayload = accountsResponse.ok ? await accountsResponse.json() : { items: [] };
  const transactionsPayload = transactionsResponse.ok ? await transactionsResponse.json() : { items: [] };
  const providerReference = `akahu:${requestRow.id}`;
  const { error: importError } = await admin.rpc('record_akahu_import', { p_request_id: requestRow.id, p_provider_reference: providerReference, p_accounts: accountsPayload.items ?? accountsPayload.data ?? [], p_transactions: transactionsPayload.items ?? transactionsPayload.data ?? [] });
  if (importError) return html('Import needs review', 'The authorisation succeeded, but the initial ANZ data import needs review.', 502);
  return html('ANZ connected', 'The initial ANZ balances and transactions were imported for review. No payment or IRD submission was made.');
});
