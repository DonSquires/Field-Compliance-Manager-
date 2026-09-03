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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function watermark(bytes: Uint8Array, text: string): Promise<Blob> {
  if (!INFERENCE_SERVICE_URL || !INFERENCE_API_KEY) return new Blob([bytes], { type: 'image/jpeg' });
  try {
    const body = new FormData();
    body.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'biosecurity_evidence.jpg');
    body.append('watermark_text', text);
    const response = await fetch(`${INFERENCE_SERVICE_URL}/infer/watermark`, {
      method: 'POST',
      headers: { 'x-inference-api-key': INFERENCE_API_KEY },
      body,
    });
    if (!response.ok) return new Blob([bytes], { type: 'image/jpeg' });
    return response.blob();
  } catch {
    return new Blob([bytes], { type: 'image/jpeg' });
  }
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authorization = request.headers.get('Authorization') ?? '';
  const token = authorization.replace('Bearer ', '').trim();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return json({ error: 'Unauthorized' }, 401);

  try {
    const body = await request.json();
    const clientRequestId = String(body.client_request_id ?? '');
    const locationName = String(body.location_name ?? '').trim();
    const speciesName = String(body.species_name ?? '').trim();
    const densityEstimate = String(body.density_estimate ?? 'scattered');
    const actionTaken = String(body.action_taken ?? 'no_action');
    const noticeNumber = String(body.notice_number ?? '').trim();
    const mpiReferralNumber = String(body.mpi_referral_number ?? '').trim();
    const imageBase64Input = body.image_base64;

    if (!clientRequestId) return json({ error: 'client_request_id is required' }, 400);
    if (!locationName) return json({ error: 'Observed location name is required' }, 400);
    if (densityEstimate !== 'not_found' && !speciesName) return json({ error: 'Species name is required when pest/species is present' }, 400);
    if (['notice_of_direction', 'infringement_notice'].includes(actionTaken) && !noticeNumber) {
      return json({ error: 'Notice number is required for direction or infringement actions' }, 400);
    }
    if (actionTaken === 'mpi_referral' && !mpiReferralNumber) {
      return json({ error: 'MPI referral number is required for MPI referrals' }, 400);
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
        'Biosecurity evidence',
        `Time ${assessedAt}`,
        `Location ${locationName}`,
        `Officer ${user.id}`,
        `Request ${clientRequestId}`,
      ].join(' | ');

      const basePath = `org/${profile.organization_id}/biosecurity-assessments/${clientRequestId}/${Date.now()}_${i}`;
      const originalPath = `${basePath}-original.jpg`;
      const watermarkedPath = `${basePath}-watermarked.jpg`;

      const watermarkedBlob = await watermark(bytes, watermarkText);

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
      });
    }

    let classificationResult: { status?: string; classification?: string; confidence?: number; species_name?: string } = { status: 'unavailable' };

    if (processedEvidence.length > 0) {
      try {
        const { data: signed } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(processedEvidence[0].watermarked_path, 300);
        if (signed?.signedUrl) {
          const classifyRes = await fetch(`${SUPABASE_URL}/functions/v1/classify-photo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: authorization },
            body: JSON.stringify({ photo_url: signed.signedUrl, module: 'biosecurity', context: `Location: ${locationName}; Species: ${speciesName}` }),
          });
          if (classifyRes.ok) {
            const classData = await classifyRes.json();
            classificationResult = {
              status: classData.error ? 'unavailable' : 'available',
              classification: classData.classification ?? null,
              confidence: classData.confidence ?? null,
              species_name: classData.details?.species_name ?? speciesName,
            };
          }
        }
      } catch {
        classificationResult = { status: 'unavailable' };
      }
    }

    const { data: receiptRows, error: receiptErr } = await supabase.rpc('submit_biosecurity_assessment_receipt', {
      p_client_request_id: clientRequestId,
      p_assessed_at: assessedAt,
      p_species_name: speciesName || null,
      p_density_estimate: densityEstimate,
      p_action_taken: actionTaken,
      p_scene_description: body.scene_description || null,
      p_location_name: locationName,
      p_protected_land_address: body.protected_land_address || null,
      p_protected_land_site_id: body.protected_land_site_id || null,
      p_notice_number: noticeNumber || null,
      p_mpi_referral_number: mpiReferralNumber || null,
      p_follow_up_required: Boolean(body.follow_up_required),
      p_shift_id: body.shift_id || null,
      p_dispatch_job_id: body.dispatch_job_id || null,
      p_evidence_items: processedEvidence,
      p_classification: classificationResult,
    });

    if (receiptErr) throw receiptErr;

    const receipt = Array.isArray(receiptRows) ? receiptRows[0] : receiptRows;
    if (!receipt?.id) throw new Error('Biosecurity assessment receipt could not be confirmed');

    return json({
      success: true,
      assessment_id: receipt.id,
      created: receipt.created,
      received_at: receipt.received_at,
      evidence_state: receipt.evidence_state,
      review_state: receipt.review_state,
      evidence: processedEvidence,
      classification: classificationResult,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Biosecurity assessment could not be submitted' }, 500);
  }
});
