import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const OWNER_EMAIL = 'squires.don@live.com';
const MARKER = 'FCM-SYNTHETIC-AGENTIC';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function syntheticPlateSvg(plate: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500" viewBox="0 0 900 500"><rect width="900" height="500" fill="#142a34"/><rect x="105" y="120" width="690" height="260" rx="18" fill="#344b55"/><rect x="180" y="205" width="540" height="95" rx="8" fill="#f4f1dc" stroke="#c3b979" stroke-width="8"/><text x="450" y="270" text-anchor="middle" font-family="sans-serif" font-size="64" font-weight="700" fill="#172b2d">${plate}</text><text x="450" y="350" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#c7f1df">${MARKER} - TEST ONLY</text></svg>`;
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization) return json({ error: 'Unauthorized' }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id,email,role,organization_id').eq('id', user.id).single();
    if (!profile || profile.email !== OWNER_EMAIL || profile.role !== 'grand_master') return json({ error: 'Owner grandmaster test identity required' }, 403);
    const body = await request.json().catch(() => ({}));
    if (body.marker !== MARKER) return json({ error: `marker must equal ${MARKER}` }, 422);
    const action = body.action === 'cleanup' ? 'cleanup' : 'seed';
    const recordId = typeof body.record_id === 'string' ? body.record_id : null;
    if (action === 'cleanup') {
      if (!recordId) return json({ error: 'record_id is required for cleanup' }, 422);
      const { data: alert } = await admin.from('breach_alerts').select('id,observation_id,notes').eq('id', recordId).eq('organization_id', profile.organization_id).maybeSingle();
      if (!alert || !String(alert.notes ?? '').includes(MARKER)) return json({ error: 'Synthetic breach record not found' }, 404);
      const observationId = alert.observation_id;
      await admin.from('breach_alerts').delete().eq('id', recordId);
      if (observationId) {
        const { data: observation } = await admin.from('observations').select('photo_url').eq('id', observationId).maybeSingle();
        await admin.from('observations').delete().eq('id', observationId);
        if (observation?.photo_url) await admin.storage.from('bob-uploads').remove([observation.photo_url]);
      }
      return json({ ok: true, action, record_id: recordId });
    }
    const requestedZoneId = String(body.zone_id ?? '').trim();
    const zoneQuery = admin.from('location_zones').select('id,organization_id,name').eq('organization_id', profile.organization_id).eq('is_active', true).order('name').limit(1);
    const { data: zones } = requestedZoneId ? await zoneQuery.eq('id', requestedZoneId) : await zoneQuery;
    const zone = zones?.[0] ?? null;
    if (!zone) return json({ error: 'Zone is not available in the owner organisation' }, 404);
    const suffix = Date.now().toString(36).toUpperCase();
    const plate = `SYN${suffix.slice(-4)}`;
    const storagePath = `synthetic/${profile.organization_id}/${MARKER}/${suffix}.svg`;
    const { error: uploadError } = await admin.storage.from('bob-uploads').upload(storagePath, syntheticPlateSvg(plate), { contentType: 'image/svg+xml', upsert: false });
    if (uploadError) throw uploadError;
    const { data: observation, error: observationError } = await admin.from('observations').insert({
      organization_id: profile.organization_id,
      officer_id: user.id,
      plate_number: plate,
      zone_id: zone.id,
      observed_at: new Date().toISOString(),
      photo_url: storagePath,
      original_photo_url: storagePath,
      plate_confidence: 1,
      plate_source: 'manual',
      module_key: 'freedom_camping',
      is_compliant: false,
      compliance_status: 'breach',
      officer_notes: `${MARKER}: synthetic plate-bearing evidence for agentic acceptance testing.`,
      external_refs: { synthetic_marker: MARKER, source: 'governed_test_seed' },
    }).select('id').single();
    if (observationError || !observation) {
      await admin.storage.from('bob-uploads').remove([storagePath]);
      throw observationError ?? new Error('Synthetic observation was not created');
    }
    const { data: alert, error: alertError } = await admin.from('breach_alerts').insert({
      organization_id: profile.organization_id,
      observation_id: observation.id,
      zone_id: zone.id,
      plate_number: plate,
      breach_type: 'nightly_limit',
      nights_count: 3,
      limit_value: 2,
      status: 'actioned',
      action_type: 'written_warning',
      actioned_by: user.id,
      actioned_at: new Date().toISOString(),
      notes: `${MARKER}: synthetic breach for agentic document acceptance testing.`,
    }).select('id').single();
    if (alertError || !alert) {
      await admin.from('observations').delete().eq('id', observation.id);
      await admin.storage.from('bob-uploads').remove([storagePath]);
      throw alertError ?? new Error('Synthetic breach alert was not created');
    }
    await admin.from('audit_log').insert({ organization_id: profile.organization_id, actor_user_id: user.id, action: 'synthetic_breach_seeded', target_table: 'breach_alerts', target_id: alert.id, metadata: { marker: MARKER, observation_id: observation.id, storage_path: storagePath } });
    return json({ ok: true, action, marker: MARKER, record_id: alert.id, observation_id: observation.id, storage_path: storagePath, zone: zone.name });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Synthetic breach seed failed' }, 500);
  }
});
