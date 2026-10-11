import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { inferAccessRecognition } from '../_shared/recognitionCandidates.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INFERENCE_SERVICE_URL = (Deno.env.get('INFERENCE_SERVICE_URL') ?? '').replace(/\/+$/, '');
const INFERENCE_API_KEY = Deno.env.get('INFERENCE_API_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const serviceSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256Hex(value: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(value).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authorization = request.headers.get('Authorization') ?? '';
  const token = authorization.replace('Bearer ', '').trim();
  const userSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: authError } = await userSupabase.auth.getUser(token);
  if (authError || !user) return json({ error: 'Unauthorized' }, 401);

  try {
    const body = await request.json();
    const imageBase64 = typeof body.image_base64 === 'string' ? body.image_base64.trim() : '';
    if (!imageBase64) return json({ error: 'image_base64 is required' }, 400);

    const { data: profile, error: profileError } = await userSupabase
      .from('user_profiles')
      .select('id,organization_id')
      .eq('id', user.id)
      .single();
    if (profileError || !profile?.organization_id) {
      return json({ error: 'Active organization profile required' }, 403);
    }

    const bytes = base64ToBytes(imageBase64);
    const recognition = await inferAccessRecognition({
      bytes,
      sourceSha256: await sha256Hex(bytes),
      organizationId: profile.organization_id,
      inferenceServiceUrl: INFERENCE_SERVICE_URL,
      inferenceApiKey: INFERENCE_API_KEY,
      serviceSupabase,
    });
    return json({ success: true, recognition });
  } catch (error) {
    console.error('Access-subject recognition failed', error);
    return json({
      error: error instanceof Error ? error.message : 'Access-subject recognition failed',
    }, 502);
  }
});
