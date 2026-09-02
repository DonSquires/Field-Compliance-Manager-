import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const EVIDENCE_BUCKET = 'scans';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_ROLES = new Set(['grand_master', 'master', 'admin', 'admin_officer', 'officer']);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function decodeJpeg(value: string) {
  const normalized = value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s/g, '');
  const binary = atob(normalized);
  if (!binary.length || binary.length > MAX_IMAGE_BYTES) throw new Error('Each Smoke evidence photo must be between 1 byte and 8 MB.');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('Smoke evidence photos must be JPEG images.');
  return bytes;
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  const uploadedPaths: string[] = [];
  try {
    const authHeader = request.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: profile } = await admin.from('user_profiles').select('organization_id, role, display_name, deactivated_at').eq('id', user.id).maybeSingle();
    if (!profile || profile.deactivated_at || !ALLOWED_ROLES.has(String(profile.role))) return json({ error: 'Forbidden' }, 403);

    const body = await request.json();
    const requestId = String(body.client_request_id ?? '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return json({ error: 'Valid client_request_id is required' }, 400);
    if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) return json({ error: 'Smoke assessment payload is required' }, 400);
    if (!Array.isArray(body.photos) || body.photos.length < 1 || body.photos.length > 3) return json({ error: 'Between one and three evidence photos are required' }, 400);

    const evidence: Array<Record<string, unknown>> = [];
    for (const photo of body.photos) {
      if (typeof photo?.image_base64 !== 'string') throw new Error('Each Smoke photo requires an image.');
      const bytes = decodeJpeg(photo.image_base64);
      const photoId = crypto.randomUUID();
      const storagePath = `org/${profile.organization_id}/smoke/${requestId}/${photoId}.jpg`;
      const { error: uploadError } = await admin.storage.from(EVIDENCE_BUCKET).upload(storagePath, new Blob([bytes], { type: 'image/jpeg' }), { contentType: 'image/jpeg', upsert: false });
      if (uploadError) throw new Error(`Smoke evidence upload failed: ${uploadError.message}`);
      uploadedPaths.push(storagePath);
      evidence.push({
        id: photoId,
        name: String(photo.file_name ?? 'smoke-evidence.jpg').slice(0, 200),
        storage_bucket: EVIDENCE_BUCKET,
        storage_path: storagePath,
        uploaded_at: new Date().toISOString(),
        metadata: { officer_id: user.id, officer_name: profile.display_name ?? null },
      });
    }

    const { data, error } = await caller.rpc('submit_smoke_assessment', {
      p_client_request_id: requestId,
      p_payload: { ...body.payload, photo_urls: evidence },
    });
    if (error) throw new Error(error.message);
    const receipt = Array.isArray(data) ? data[0] : data;
    if (!receipt?.assessment_id) throw new Error('Smoke assessment receipt was not returned.');
    if (receipt.created === false) await admin.storage.from(EVIDENCE_BUCKET).remove(uploadedPaths);
    uploadedPaths.length = 0;
    return json({ success: true, receipt });
  } catch (error) {
    if (uploadedPaths.length > 0) {
      const cleanup = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await cleanup.storage.from(EVIDENCE_BUCKET).remove(uploadedPaths);
    }
    const detail = error instanceof Error ? error.message : 'Smoke assessment submission failed';
    console.error('[submit-smoke-assessment]', detail);
    return json({ error: 'Smoke assessment submission failed', detail }, 400);
  }
});