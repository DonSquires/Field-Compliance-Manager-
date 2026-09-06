import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);
    const body = await req.json().catch(() => ({}));
    const attachmentId = String(body.attachment_id ?? '').trim();
    if (!attachmentId) return json({ error: 'attachment_id is required' }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id, organization_id').eq('id', user.id).single();
    if (!profile?.organization_id) return json({ error: 'Profile not found' }, 404);
    const { data: attachment, error: attachmentError } = await admin
      .from('bob_attachments')
      .select('id, organization_id, uploaded_by, file_type')
      .eq('id', attachmentId)
      .maybeSingle();
    if (attachmentError || !attachment) return json({ error: 'Attachment not found' }, 404);
    if (attachment.organization_id !== profile.organization_id || attachment.uploaded_by !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!String(attachment.file_type ?? '').startsWith('video/')) return json({ error: 'Attachment is not a video' }, 422);

    const { data: jobId, error: registerError } = await admin.rpc('register_bob_video_attachment_for_review', { p_attachment_id: attachmentId });
    if (registerError) return json({ error: registerError.message }, 409);
    return json({ success: true, inference_job_id: jobId });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Video registration failed' }, 500);
  }
});
