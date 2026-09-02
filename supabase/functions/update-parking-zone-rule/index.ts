import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const EVIDENCE_BUCKET = 'scans';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
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
  if (!binary.length || binary.length > MAX_IMAGE_BYTES) throw new Error('Signage photo must be between 1 byte and 8 MB.');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('Parking signage must be a JPEG image.');
  return bytes;
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);

  let uploadedPath: string | null = null;
  try {
    const authHeader = request.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);

    const body = await request.json();
    const zoneId = String(body.zone_id ?? '').trim();
    const expectedVersion = Number(body.expected_version);
    const timeLimitMinutes = Number(body.time_limit_minutes);
    const disabledMultiplier = Number(body.disabled_multiplier);
    const limitSource = String(body.limit_source ?? '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(zoneId)) return json({ error: 'Valid zone_id is required' }, 400);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return json({ error: 'Valid expected_version is required' }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: zone } = await admin.from('location_zones').select('organization_id').eq('id', zoneId).maybeSingle();
    if (!zone) return json({ error: 'Parking zone not found' }, 404);

    if (typeof body.signage_image_base64 === 'string' && body.signage_image_base64.trim()) {
      const bytes = decodeJpeg(body.signage_image_base64);
      uploadedPath = `org/${zone.organization_id}/parking-signage/${zoneId}/${crypto.randomUUID()}.jpg`;
      const { error: uploadError } = await admin.storage.from(EVIDENCE_BUCKET).upload(
        uploadedPath,
        new Blob([bytes], { type: 'image/jpeg' }),
        { contentType: 'image/jpeg', upsert: false },
      );
      if (uploadError) throw new Error(`Signage upload failed: ${uploadError.message}`);
    }

    const { data, error } = await caller.rpc('manage_parking_zone_rule', {
      p_zone_id: zoneId,
      p_expected_version: expectedVersion,
      p_time_limit_minutes: timeLimitMinutes,
      p_disabled_multiplier: disabledMultiplier,
      p_limit_source: limitSource,
      p_signage_photo_path: uploadedPath,
    });
    if (error) throw new Error(error.message);
    uploadedPath = null;
    return json({ success: true, zone: data });
  } catch (error) {
    if (uploadedPath) {
      const cleanup = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await cleanup.storage.from(EVIDENCE_BUCKET).remove([uploadedPath]);
    }
    const detail = error instanceof Error ? error.message : 'Parking rule update failed';
    console.error('[update-parking-zone-rule]', detail);
    return json({ error: 'Parking rule update failed', detail }, 400);
  }
});