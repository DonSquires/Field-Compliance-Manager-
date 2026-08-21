/**
 * bob-voice-transcribe - browser-facing STT proxy Edge Function
 *
 * The browser (push-to-talk in BobPanel) records a short audio clip and POSTs
 * it here. This function keeps API_URL/API_TOKEN server-side and forwards to
 * apps/api `/api/bob/voice/transcribe`, which proxies to the self-hosted
 * fcm-voice STT on the VPS. The browser never holds any secret, and audio
 * reaches only our own infrastructure.
 *
 * Input (from the browser, with the user's Supabase JWT):
 *   Body: { audio_base64, language? }
 * Output:
 *   { transcript, confidence } | { error }
 *
 * Env secrets:
 *   API_URL    - apps/api base URL (no trailing slash)
 *   API_TOKEN  - apps/api auth token
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
const API_URL = Deno.env.get('API_URL') ?? '';
const API_TOKEN = Deno.env.get('API_TOKEN') ?? '';
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
    if (!API_URL || !API_TOKEN) return json({
      error: 'Voice transcribe not configured'
    }, 503);
    const body = await req.json();
    const audio = String(body.audio_base64 ?? '').trim();
    if (!audio) return json({
      error: 'audio_base64 is required'
    }, 400);
    // Cap payload (~8 MB base64 ~= 6 MB audio) - short PTT clips only.
    if (audio.length > 8 * 1024 * 1024) return json({
      error: 'audio too large'
    }, 413);
    const apiRes = await fetch(`${API_URL}/api/bob/voice/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`
      },
      body: JSON.stringify({
        audio_base64: audio,
        language: body.language ?? 'en'
      })
    });
    const text = await apiRes.text();
    const data = text ? JSON.parse(text) : {};
    if (!apiRes.ok || data?.ok === false) {
      return json({
        error: data?.detail ?? data?.error ?? `STT failed (${apiRes.status})`
      }, 502);
    }
    return json({
      transcript: data.transcript ?? '',
      confidence: data.confidence ?? 0
    });
  } catch (err) {
    console.error('[bob-voice-transcribe] error:', err);
    return json({
      error: 'Internal error in voice transcribe'
    }, 500);
  }
});
