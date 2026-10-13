import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// ATLAS EXTERNAL CALLER: fcm-desktop-client
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Origin': '*',
};

serve((request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response(JSON.stringify({ error: 'Desktop client configuration is unavailable' }), {
      status: 503,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ supabase_url: SUPABASE_URL, supabase_anon_key: SUPABASE_ANON_KEY }), {
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': 'public, max-age=3600',
      'Content-Type': 'application/json',
    },
  });
});