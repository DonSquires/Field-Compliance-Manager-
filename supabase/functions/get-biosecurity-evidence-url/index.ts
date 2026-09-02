import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ADMIN_ROLES = new Set(['grand_master', 'master', 'admin', 'admin_officer']);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);

    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: profile } = await admin
      .from('user_profiles')
      .select('organization_id, role, deactivated_at')
      .eq('id', user.id)
      .maybeSingle();
    if (!profile || profile.deactivated_at || !ADMIN_ROLES.has(String(profile.role))) {
      return json({ error: 'Forbidden' }, 403);
    }

    const body = await req.json();
    const assessmentId = String(body.assessment_id ?? '').trim();
    const photoId = String(body.photo_id ?? '').trim();
    if (!assessmentId || !photoId) return json({ error: 'assessment_id and photo_id are required' }, 400);

    const { data: assessment } = await admin
      .from('biosecurity_assessments')
      .select('id, organization_id, photo_urls')
      .eq('id', assessmentId)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();
    if (!assessment) return json({ error: 'Assessment not found' }, 404);

    const photos = Array.isArray(assessment.photo_urls) ? assessment.photo_urls : [];
    const photo = photos.find((candidate) => candidate && typeof candidate === 'object' && candidate.id === photoId);
    const storagePath = typeof photo?.storage_path === 'string' ? photo.storage_path : '';
    const expectedPrefix = `org/${profile.organization_id}/biosecurity/${assessment.id}/`;
    if (!storagePath.startsWith(expectedPrefix) || photo?.storage_bucket !== 'scans') {
      return json({ error: 'Evidence not found' }, 404);
    }

    const { data: signed, error: signedError } = await admin.storage.from('scans').createSignedUrl(storagePath, 300);
    if (signedError || !signed?.signedUrl) throw new Error(signedError?.message ?? 'Evidence URL could not be created');
    return json({ success: true, signed_url: signed.signedUrl, expires_in: 300 });
  } catch (error) {
    console.error('[get-biosecurity-evidence-url]', error);
    return json({ error: 'Biosecurity evidence could not be opened' }, 500);
  }
});