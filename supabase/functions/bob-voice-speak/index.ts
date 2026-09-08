/**
 * bob-voice-speak - browser-facing TTS proxy Edge Function
 *
 * The browser sends Bob's reply text here; this function forwards to apps/api
 * `/api/bob/voice/speak` (holding API_TOKEN), which proxies to the self-hosted
 * fcm-voice TTS. Returns audio_base64 for the client to play. No secret in the
 * browser; audio rendered only on our infrastructure.
 *
 * Input:  { text, voice? }   Output: { audio_base64, mime } | { error }
 * Env: API_URL, API_TOKEN
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const API_URL = Deno.env.get('API_URL') ?? '';
const API_TOKEN = Deno.env.get('API_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    status: 200,
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
      const authorization = req.headers.get('Authorization') ?? '';
      const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authorization } }
      });
      const { data: { user }, error: authError } = await caller.auth.getUser();
      if (authError || !user) return json({ error: 'Unauthorized' }, 401);
    if (!API_URL || !API_TOKEN) return json({
      error: 'Voice speak not configured'
    }, 503);
    const body = await req.json();
    const text = String(body.text ?? '').trim();
    if (!text) return json({
      error: 'text is required'
    }, 400);
    const apiRes = await fetch(`${API_URL}/api/bob/voice/speak`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`
      },
      body: JSON.stringify({
        text: text.slice(0, 2000),
        voice: body.voice
      })
    });
    const t = await apiRes.text();
    const data = t ? JSON.parse(t) : {};
    if (!apiRes.ok || data?.ok === false) {
      return json({
        error: data?.detail ?? data?.error ?? `TTS failed (${apiRes.status})`
      }, 502);
    }
    return json({
      audio_base64: data.audio_base64 ?? '',
      mime: data.mime ?? 'audio/wav'
    });
  } catch (err) {
    console.error('[bob-voice-speak] error:', err);
    return json({
      error: 'Internal error in voice speak'
    }, 500);
  }
});
