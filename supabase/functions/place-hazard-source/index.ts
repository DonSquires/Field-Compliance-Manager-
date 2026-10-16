/**
 * place-hazard-source — short-lived link to the source document of a place
 * hazard, so an officer can open the exact H&S document behind a briefing
 * highlight without broad storage access.
 *
 * POST /functions/v1/place-hazard-source  Body: { hazard_id }
 * Authorisation is get_place_hazard_source under the caller's JWT (hazard
 * readers, or an officer with an open shift at the place); only then is the
 * object signed with the service role, for 10 minutes.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_BUCKETS = new Set(['bob-uploads']);

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json' }
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST required' }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return reply({ error: 'Unauthorized' }, 401);
    const { hazard_id: hazardId } = await req.json();
    if (!UUID_RE.test(String(hazardId ?? ''))) return reply({ error: 'hazard_id must be a UUID' }, 400);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: source, error } = await callerClient.rpc('get_place_hazard_source', { p_hazard_id: hazardId });
    if (error) return reply({ error: error.message }, 403);
    if (!source?.has_document) {
      return reply({ has_document: false, source_name: source?.source_name ?? null, source_locator: source?.source_locator ?? null });
    }
    if (!ALLOWED_BUCKETS.has(String(source.storage_bucket))) return reply({ error: 'Source document is not in a supported store' }, 422);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: signed, error: signError } = await admin.storage.from(source.storage_bucket).createSignedUrl(source.storage_object_ref, 600);
    if (signError || !signed?.signedUrl) return reply({ error: 'Could not open the source document' }, 502);
    return reply({
      has_document: true,
      url: signed.signedUrl,
      expires_in: 600,
      original_filename: source.original_filename ?? null,
      mime_type: source.mime_type ?? null,
      source_name: source.source_name ?? null,
      source_locator: source.source_locator ?? null
    });
  } catch (err) {
    return reply({ error: 'Server error', details: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
});
