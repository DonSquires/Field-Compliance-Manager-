import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INFERENCE_SERVICE_URL = (Deno.env.get('INFERENCE_SERVICE_URL') ?? '').replace(/\/+$/, '');
const INFERENCE_API_KEY = Deno.env.get('INFERENCE_API_KEY') ?? '';
const EVIDENCE_BUCKET = 'scans';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const serviceSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
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

async function watermark(bytes: Uint8Array, text: string): Promise<Blob> {
  if (!INFERENCE_SERVICE_URL || !INFERENCE_API_KEY) {
    throw new Error('Inference watermark service is not configured; photo evidence cannot be accepted');
  }
  try {
    const body = new FormData();
    body.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'smoke_evidence.jpg');
    body.append('watermark_text', text);
    const response = await fetch(`${INFERENCE_SERVICE_URL}/infer/watermark`, {
      method: 'POST',
      headers: { 'x-inference-api-key': INFERENCE_API_KEY },
      body,
    });
    if (!response.ok) throw new Error(`Inference watermark service failed with HTTP ${response.status}`);
    return response.blob();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Inference watermark service failed')) throw error;
    throw new Error('Inference watermark service could not process photo evidence', { cause: error });
  }
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
    const address = String(body.address ?? '').trim();
    const smokeSourceType = String(body.smoke_source_type ?? 'domestic_solid_fuel').trim();
    const complaintSource = String(body.complaint_source ?? 'neighbour').trim();
    const severity = String(body.severity ?? 'moderate').trim();
    const actionTaken = String(body.action_taken ?? 'no_action').trim();
    const noticeNumber = String(body.notice_number ?? '').trim();
    const sourceConfirmed = body.source_confirmed === true;
    const notes = String(body.notes ?? '').trim();
    const imageBase64Input = body.image_base64;

    if (!clientRequestId) return json({ error: 'client_request_id is required' }, 400);
    if (!address) return json({ error: 'Observed smoke location address is required' }, 400);
    if (!sourceConfirmed) return json({ error: 'Officer must confirm the observed smoke source' }, 400);
    if (['abatement_notice', 'infringement_notice'].includes(actionTaken) && !noticeNumber) {
      return json({ error: 'Notice number is required for statutory abatement or infringement notices' }, 400);
    }

    const imageArray: string[] = Array.isArray(imageBase64Input)
      ? imageBase64Input.map(String).filter(Boolean)
      : (typeof imageBase64Input === 'string' && imageBase64Input ? [imageBase64Input] : []);

    if (imageArray.length === 0) return json({ error: 'At least one evidence image is required' }, 400);

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, organization_id')
      .eq('id', user.id)
      .single();

    if (!profile?.organization_id) return json({ error: 'Active officer organisation profile required' }, 403);

    const assessedAt = body.assessed_at ? new Date(body.assessed_at).toISOString() : new Date().toISOString();

    // Out-of-hours check (weekdays 5pm-8am, weekends 24/7 in NZ time)
    const nzDate = new Date(new Date(assessedAt).toLocaleString('en-US', { timeZone: 'Pacific/Auckland' }));
    const day = nzDate.getDay();
    const hour = nzDate.getHours();
    const isOutOfHours = day === 0 || day === 6 || hour < 8 || hour >= 17;

    const processedEvidence: Array<{
      original_path: string;
      watermarked_path: string;
      captured_at: string;
      evidence_kind: string;
      purpose: string;
    }> = [];

    for (let i = 0; i < imageArray.length; i++) {
      const bytes = base64ToBytes(imageArray[i]);
      const watermarkText = [
        'Smoke evidence',
        `Time ${assessedAt}`,
        `Address ${address}`,
        `Officer ${user.id}`,
        `Request ${clientRequestId}`,
      ].join(' | ');

      const basePath = `org/${profile.organization_id}/smoke-assessments/${clientRequestId}/${Date.now()}_${i}`;
      const originalPath = `${basePath}-original.jpg`;
      const watermarkedPath = `${basePath}-watermarked.jpg`;

      const watermarkedBlob = await watermark(bytes, watermarkText);
      const rawSha256 = await sha256Hex(bytes);
      const watermarkedSha256 = await sha256Hex(watermarkedBlob);

      const { error: origErr } = await supabase.storage.from(EVIDENCE_BUCKET).upload(originalPath, new Blob([bytes], { type: 'image/jpeg' }), { upsert: true, contentType: 'image/jpeg' });
      if (origErr) throw origErr;

      const { error: wmkErr } = await supabase.storage.from(EVIDENCE_BUCKET).upload(watermarkedPath, watermarkedBlob, { upsert: true, contentType: 'image/jpeg' });
      if (wmkErr) throw wmkErr;

      processedEvidence.push({
        original_path: originalPath,
        watermarked_path: watermarkedPath,
        captured_at: assessedAt,
        evidence_kind: 'photo',
        purpose: i === 0 ? 'primary_evidence' : 'supporting_evidence',
        raw_sha256: rawSha256,
        watermarked_sha256: watermarkedSha256,
        watermark_text: watermarkText,
        watermark_service: 'inference',
      });
    }

    let classificationResult: {
      status?: string;
      classification?: string | null;
      confidence?: number | null;
      details?: Record<string, unknown>;
      reasoning?: string | null;
      classifier?: string;
      provider?: string | null;
      model?: string | null;
      prompt_version?: string;
      failure_reason?: string;
    } = { status: 'unavailable' };

    if (processedEvidence.length > 0) {
      try {
        const { data: signed } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(processedEvidence[0].watermarked_path, 300);
        if (signed?.signedUrl) {
          const classifyRes = await fetch(`${SUPABASE_URL}/functions/v1/classify-photo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: authorization },
            body: JSON.stringify({ photo_url: signed.signedUrl, module: 'smoke', context: `Address: ${address}; SourceType: ${smokeSourceType}` }),
          });
          if (classifyRes.ok) {
            const classData = await classifyRes.json();
            classificationResult = {
              status: classData.error ? 'unavailable' : 'available',
              classification: classData.classification ?? null,
              confidence: classData.confidence ?? null,
              details: classData.details ?? {},
              reasoning: classData.reasoning ?? null,
              classifier: classData.classifier ?? 'bob_vision',
              provider: classData.provider ?? null,
              model: classData.model ?? null,
              prompt_version: classData.prompt_version ?? 'smoke_photo_v1',
            };
          }
        }
      } catch (classificationError) {
        console.error('Smoke photo classification failed', classificationError);
        classificationResult = {
          status: 'unavailable',
          classifier: 'bob_vision',
          prompt_version: 'smoke_photo_v1',
          failure_reason: classificationError instanceof Error
            ? classificationError.message
            : 'Smoke photo classification failed',
        };
      }
    }

    const { data: receiptRows, error: receiptErr } = await supabase.rpc('submit_smoke_assessment_receipt_v2', {
      p_client_request_id: clientRequestId,
      p_assessed_at: assessedAt,
      p_smoke_source_type: smokeSourceType,
      p_complaint_source: complaintSource,
      p_severity: severity,
      p_action_taken: actionTaken,
      p_scene_description: body.scene_description || null,
      p_notes: notes || null,
      p_source_confirmed: sourceConfirmed,
      p_address: address,
      p_complaint_address: body.complaint_address || null,
      p_complainant_site_id: body.complainant_site_id || null,
      p_site_id: body.site_id || null,
      p_notice_number: noticeNumber || null,
      p_legal_basis: body.legal_basis || 'RMA s.17A',
      p_is_out_of_hours: isOutOfHours,
      p_follow_up_required: Boolean(body.follow_up_required),
      p_shift_id: body.shift_id || null,
      p_dispatch_job_id: body.dispatch_job_id || null,
      p_evidence_items: processedEvidence,
      p_classification: classificationResult,
    });

    if (receiptErr) throw receiptErr;

    const receipt = Array.isArray(receiptRows) ? receiptRows[0] : receiptRows;
    if (!receipt?.id) throw new Error('Smoke assessment receipt could not be confirmed');
    const { data: perception, error: perceptionError } = await serviceSupabase.rpc(
      'record_smoke_photo_perception_envelope',
      {
        p_assessment_id: receipt.id,
        p_classification: classificationResult,
      },
    );
    if (perceptionError) throw new Error(`Smoke perception receipt failed: ${perceptionError.message}`);

    return json({
      success: true,
      assessment_id: receipt.id,
      created: receipt.created,
      received_at: receipt.received_at,
      evidence_state: receipt.evidence_state,
      review_state: receipt.review_state,
      is_out_of_hours: isOutOfHours,
      evidence: processedEvidence,
      classification: classificationResult,
      perception,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Smoke assessment could not be submitted' }, 500);
  }
});
