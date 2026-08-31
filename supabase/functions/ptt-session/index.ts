import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const PTT_SESSION_SECRET = Deno.env.get('PTT_SESSION_SECRET') ?? Deno.env.get('PTT_SECRET') ?? '';
const PTT_SIGNAL_URL = Deno.env.get('PTT_SIGNALLING_URL') ?? '';
const PTT_SERVER_URL = Deno.env.get('PTT_SERVER_URL') ?? '';
const PTT_TURN_URLS = Deno.env.get('PTT_TURN_URLS') ?? '';
const PTT_TURN_SHARED_SECRET = Deno.env.get('PTT_TURN_SHARED_SECRET') ?? '';
const SESSION_TTL_SECONDS = 300;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const base64Url = (value: string) => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

async function signSession(claims: Record<string, unknown>) {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify(claims));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PTT_SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(String.fromCharCode(...new Uint8Array(signature)))}`;
}

async function turnCredential(username: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PTT_TURN_SHARED_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function websocketUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    return ['wss:', 'ws:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !PTT_SESSION_SECRET) return json({ error: 'PTT is not configured' }, 503);

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization) return json({ error: 'Unauthorized' }, 401);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: userError } = await client.auth.getUser();
  if (userError || !user) return json({ error: 'Unauthorized' }, 401);

  const body = await req.json().catch(() => ({}));
  const channelId = typeof body.channelId === 'string' ? body.channelId : '';
  if (!channelId) return json({ error: 'channelId is required' }, 400);

  const { data: channel, error: channelError } = await client
    .from('ptt_channels')
    .select('id, organization_id')
    .eq('id', channelId)
    .maybeSingle();
  if (channelError || !channel) return json({ error: 'PTT channel is unavailable' }, 404);

  const { data: profile } = await client
    .from('user_profiles')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await signSession({
    v: 1,
    sub: user.id,
    organizationId: channel.organization_id,
    channelId: channel.id,
    displayName: profile?.display_name || user.email || 'Officer',
    exp: expiresAt,
  });
  const turnUrls = PTT_TURN_URLS.split(',').map(url => url.trim()).filter(Boolean);
  const iceServers = !PTT_TURN_SHARED_SECRET || turnUrls.length === 0
    ? []
    : [{ urls: turnUrls, username: `${expiresAt}:${user.id}`, credential: await turnCredential(`${expiresAt}:${user.id}`) }];
  const signalUrls = [...new Set([PTT_SIGNAL_URL, PTT_SERVER_URL].map(websocketUrl).filter(Boolean))];
  return json({ token, expiresAt, channelId: channel.id, signalUrl: signalUrls[0] ?? '', signalUrls, iceServers });
});