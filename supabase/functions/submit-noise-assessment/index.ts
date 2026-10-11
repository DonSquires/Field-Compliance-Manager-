import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INFERENCE_SERVICE_URL = (Deno.env.get('INFERENCE_SERVICE_URL') ?? '').replace(/\/+$/, '');
const INFERENCE_API_KEY = Deno.env.get('INFERENCE_API_KEY') ?? '';
const EVIDENCE_BUCKET = 'scans';
const INFERENCE_TIMEOUT_MS = 8_000;
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

async function sha256Hex(value: Uint8Array | Blob) {
  const payload = value instanceof Blob ? await value.arrayBuffer() : value;
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchWithTimeout(input: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function watermark(bytes: Uint8Array, text: string) {
  if (!INFERENCE_SERVICE_URL || !INFERENCE_API_KEY) {
    throw new Error('Inference watermark service is not configured; noise photo evidence cannot be accepted');
  }
  const body = new FormData();
  body.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'noise_evidence.jpg');
  body.append('watermark_text', text);
  const response = await fetchWithTimeout(`${INFERENCE_SERVICE_URL}/infer/watermark`, {
    method: 'POST',
    headers: { 'x-inference-api-key': INFERENCE_API_KEY },
    body,
  });
  if (!response.ok) throw new Error(`Inference watermark service failed with HTTP ${response.status}`);
  return response.blob();
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authorization = request.headers.get('Authorization') ?? '';
  const token = authorization.replace('Bearer ', '').trim();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return json({ error: 'Unauthorized' }, 401);

  try {
    const body = await request.json();
    const clientRequestId = String(body.client_request_id ?? '');
    const noiseSource = String(body.noise_source ?? '').trim();
    const sourceAddress = String(body.noise_source_address ?? '').trim();
    const actionTaken = String(body.action_taken ?? 'no_action');
    const noticeNumber = String(body.notice_number ?? '').trim();
    const endNumber = String(body.end_number ?? '').trim();
    const imageBase64 = typeof body.image_base64 === 'string' ? body.image_base64 : '';

    if (!clientRequestId) return json({ error: 'client_request_id is required' }, 400);
    if (!noiseSource) return json({ error: 'Noise source type is required' }, 400);
    if (!sourceAddress) return json({ error: 'Noise source address is required' }, 400);
    if (!imageBase64) return json({ error: 'A noise evidence photo is required' }, 400);
    if (
      ['abatement_notice', 'direction_notice', 'enforcement_notice', 'equipment_seized'].includes(actionTaken)
      && !noticeNumber
      && !endNumber
    ) {
      return json({ error: 'Notice or END number is required for statutory noise enforcement actions' }, 400);
    }

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('organization_id')
      .eq('id', user.id)
      .is('deactivated_at', null)
      .single();
    if (profileError || !profile?.organization_id) {
      return json({ error: 'Active officer organisation profile required' }, 403);
    }

    const assessedAt = body.assessed_at ? new Date(body.assessed_at).toISOString() : new Date().toISOString();
    const bytes = base64ToBytes(imageBase64);
    const watermarkText = [
      'Noise evidence',
      `Time ${assessedAt}`,
      `Source address ${sourceAddress}`,
      `Officer ${user.id}`,
      `Request ${clientRequestId}`,
    ].join(' | ');
    const basePath = `org/${profile.organization_id}/noise-assessments/${clientRequestId}/${Date.now()}_0`;
    const originalPath = `${basePath}-original.jpg`;
    const watermarkedPath = `${basePath}-watermarked.jpg`;
    const watermarkedBlob = await watermark(bytes, watermarkText);
    const rawSha256 = await sha256Hex(bytes);
    const watermarkedSha256 = await sha256Hex(watermarkedBlob);

    const { error: originalError } = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .upload(originalPath, new Blob([bytes], { type: 'image/jpeg' }), {
        upsert: true,
        contentType: 'image/jpeg',
      });
    if (originalError) throw originalError;
    const { error: watermarkedError } = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .upload(watermarkedPath, watermarkedBlob, {
        upsert: true,
        contentType: 'image/jpeg',
      });
    if (watermarkedError) throw watermarkedError;

    const evidence = [{
      original_path: originalPath,
      watermarked_path: watermarkedPath,
      captured_at: assessedAt,
      evidence_kind: 'photo',
      purpose: 'primary_evidence',
      raw_sha256: rawSha256,
      watermarked_sha256: watermarkedSha256,
      watermark_text: watermarkText,
      watermark_service: 'inference',
      storage_bucket: EVIDENCE_BUCKET,
    }];

    let classification: Record<string, unknown> = {
      status: 'unavailable',
      classifier: 'bob_vision',
      prompt_version: 'noise_photo_v1',
    };
    try {
      const { data: signed, error: signedError } = await supabase.storage
        .from(EVIDENCE_BUCKET)
        .createSignedUrl(watermarkedPath, 300);
      if (signedError || !signed?.signedUrl) throw signedError ?? new Error('Private evidence could not be signed');
      const response = await fetchWithTimeout(`${SUPABASE_URL}/functions/v1/classify-photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: JSON.stringify({
          photo_url: signed.signedUrl,
          module: 'noise',
          context: `Officer source observation: ${noiseSource}; source address recorded separately`,
        }),
      });
      if (!response.ok) throw new Error(`Noise photo classifier returned HTTP ${response.status}`);
      const result = await response.json();
      if (result.error) throw new Error(String(result.error));
      classification = {
        status: 'available',
        classification: result.classification ?? null,
        confidence: result.confidence ?? null,
        details: result.details ?? {},
        reasoning: result.reasoning ?? null,
        classifier: result.classifier ?? 'bob_vision',
        provider: result.provider ?? null,
        model: result.model ?? null,
        prompt_version: result.prompt_version ?? 'noise_photo_v1',
      };
    } catch (classificationError) {
      console.error('Noise photo classification failed', classificationError);
      classification = {
        status: 'unavailable',
        classifier: 'bob_vision',
        prompt_version: 'noise_photo_v1',
        failure_reason: classificationError instanceof Error
          ? classificationError.message
          : 'Noise photo classification failed',
      };
    }

    const { data: rows, error: receiptError } = await supabase.rpc('submit_officer_noise_assessment_v2', {
      p_client_request_id: clientRequestId,
      p_assessed_at: assessedAt,
      p_noise_source: noiseSource,
      p_noise_source_address: sourceAddress,
      p_action_taken: actionTaken,
      p_volume_score: Number(body.volume_score ?? 0),
      p_time_score: Number(body.time_score ?? 1),
      p_tone_score: Number(body.tone_score ?? 0),
      p_complaint_address: body.complaint_address || null,
      p_complainant_site_id: body.complainant_site_id || null,
      p_notice_number: noticeNumber || null,
      p_end_number: endNumber || null,
      p_occupant_name: body.occupant_name || null,
      p_occupant_dob: body.occupant_dob || null,
      p_is_large_event_or_commercial: Boolean(body.is_large_event_or_commercial),
      p_police_requested: Boolean(body.police_requested),
      p_police_present: Boolean(body.police_present),
      p_scene_description: body.scene_description || null,
      p_incident_report_text: body.incident_report_text || null,
      p_follow_up_required: Boolean(body.follow_up_required),
      p_shift_id: body.shift_id || null,
      p_dispatch_job_id: body.dispatch_job_id || null,
      p_gps_lat: body.gps_lat ?? null,
      p_gps_lng: body.gps_lng ?? null,
      p_evidence_items: evidence,
      p_classification: classification,
    });
    if (receiptError) throw receiptError;
    const receipt = Array.isArray(rows) ? rows[0] : rows;
    if (!receipt?.id) throw new Error('Noise assessment receipt could not be confirmed');

    const { data: perception, error: perceptionError } = await serviceSupabase.rpc(
      'record_noise_photo_perception_envelope',
      { p_assessment_id: receipt.id, p_classification: classification },
    );
    if (perceptionError) throw new Error(`Noise perception receipt failed: ${perceptionError.message}`);

    return json({
      success: true,
      assessment_id: receipt.id,
      created: receipt.created,
      received_at: receipt.received_at,
      review_status: receipt.review_status,
      matrix_total: receipt.matrix_total,
      evidence_state: receipt.evidence_state,
      classification,
      perception,
    });
  } catch (error) {
    console.error('[submit-noise-assessment] failed', error);
    return json({ error: error instanceof Error ? error.message : 'Noise assessment could not be submitted' }, 500);
  }
});
