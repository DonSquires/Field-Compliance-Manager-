import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ATLAS EXTERNAL CALLER: fcm-desktop-client
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024 * 1024;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function sanitizeDesktopReviewBatch(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const batchId = String(source.batch_id ?? '').trim();
  const clipIndex = Number(source.clip_index);
  const clipTotal = Number(source.clip_total);
  const channel = Number(source.channel);
  const startTime = String(source.start_time ?? '').trim();
  const endTime = String(source.end_time ?? '').trim();
  const fragmentCount = Number(source.fragment_count);
  const sourceBytes = Number(source.source_bytes);
  const cacheSha256 = String(source.cache_sha256 ?? '').trim();
  if (!batchId || !Number.isInteger(clipIndex) || !Number.isInteger(clipTotal) || clipIndex < 1 || clipTotal < clipIndex) return null;
  return {
    batch_id: batchId.slice(0, 80),
    clip_index: clipIndex,
    clip_total: clipTotal,
    channel: Number.isFinite(channel) ? channel : null,
    start_time: startTime.slice(0, 80),
    end_time: endTime.slice(0, 80),
    fragment_count: Number.isFinite(fragmentCount) ? fragmentCount : null,
    source_bytes: Number.isFinite(sourceBytes) ? sourceBytes : null,
    cache_sha256: cacheSha256.slice(0, 80),
  };
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const authorization = request.headers.get('Authorization') ?? '';
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);
    const body = await request.json().catch(() => ({}));
    const attachmentId = String(body.attachment_id ?? '').trim();
    const storagePath = String(body.storage_path ?? '').trim();
    const fileName = String(body.file_name ?? '').trim();
    const fileType = String(body.file_type ?? '').trim();
    const fileSizeBytes = Number(body.file_size_bytes);
    const desktopReviewBatch = sanitizeDesktopReviewBatch(body.desktop_review_batch);
    if (!attachmentId || !storagePath || !fileName || !fileType || !Number.isInteger(fileSizeBytes) || fileSizeBytes <= 0 || fileSizeBytes > MAX_ATTACHMENT_BYTES) {
      return json({ error: 'Valid attachment_id, storage_path, file_name, file_type, and file_size_bytes are required' }, 422);
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile, error: profileError } = await admin.from('user_profiles').select('organization_id').eq('id', user.id).single();
    if (profileError) return json({ error: `profile_lookup: ${profileError.message}` }, 500);
    if (!profile?.organization_id) return json({ error: 'profile_lookup: active organization not found' }, 404);
    const requiredPrefix = `desktop/${user.id}/${attachmentId}-`;
    if (!storagePath.startsWith(requiredPrefix)) return json({ error: 'Storage path does not belong to this desktop import' }, 403);
    const { data: conversation, error: conversationError } = await admin.from('bob_conversations').insert({
      organization_id: profile.organization_id,
      user_id: user.id,
      module_key: 'operations',
      title: `Desktop CCTV import: ${fileName.slice(0, 160)}`,
    }).select('id').single();
    if (conversationError || !conversation) throw new Error(`conversation_insert: ${conversationError?.message ?? 'Could not create import conversation'}`);
    const { error: attachmentError } = await admin.from('bob_attachments').insert({
      id: attachmentId,
      organization_id: profile.organization_id,
      conversation_id: conversation.id,
      uploaded_by: user.id,
      file_name: fileName,
      file_type: fileType,
      file_size_bytes: fileSizeBytes,
      storage_bucket: 'bob-uploads',
      storage_path: storagePath,
      purpose: fileType.startsWith('video/') ? 'video_intake' : 'document_intake',
      processing_state: 'pending',
      extraction_payload: desktopReviewBatch ? { desktop_review_batch: desktopReviewBatch } : {},
      source_type: 'upload',
    });
    if (attachmentError) throw new Error(`attachment_insert: ${attachmentError.message}`);
    if (!fileType.startsWith('video/')) return json({ success: true, attachment_id: attachmentId, inference_job_id: null });
    const { data: jobId, error: jobError } = await admin.rpc('register_bob_video_attachment_for_review', { p_attachment_id: attachmentId });
    if (jobError) throw new Error(`job_registration: ${jobError.message}`);
    return json({ success: true, attachment_id: attachmentId, inference_job_id: jobId });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Desktop video registration failed' }, 500);
  }
});