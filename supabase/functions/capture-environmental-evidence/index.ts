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

type EvidenceModule = 'biosecurity' | 'smoke';

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
  const body = new FormData();
  body.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'evidence.jpg');
  body.append('watermark_text', text);
  const response = await fetch(`${INFERENCE_SERVICE_URL}/infer/watermark`, { method: 'POST', headers: { 'x-inference-api-key': INFERENCE_API_KEY }, body });
  if (!response.ok) throw new Error(`Inference watermark service failed with HTTP ${response.status}`);
  return response.blob();
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
    const module = body.module as EvidenceModule;
    const assessmentId = String(body.assessment_id ?? '');
    const imageBase64 = String(body.image_base64 ?? '');
    if (!['biosecurity', 'smoke'].includes(module) || !assessmentId || !imageBase64) {
      return json({ error: 'module, assessment_id, and image_base64 are required' }, 400);
    }

    const table = module === 'biosecurity' ? 'biosecurity_assessments' : 'smoke_assessments';
    const assessmentFields = module === 'biosecurity'
      ? 'id, organization_id, officer_user_id, location_name, species_name'
      : 'id, organization_id, officer_user_id, address';
    const { data: assessment, error: assessmentError } = await supabase
      .from(table)
      .select(assessmentFields)
      .eq('id', assessmentId)
      .single();
    if (assessmentError || !assessment || assessment.officer_user_id !== user.id) return json({ error: 'Assessment not found or not owned by this officer' }, 403);

    const bytes = base64ToBytes(imageBase64);
    const capturedAt = new Date().toISOString();
    const address = String(body.address ?? assessment.location_name ?? assessment.address ?? 'Address unavailable');
    const watermarkText = [`${module === 'biosecurity' ? 'Biosecurity' : 'Smoke'} evidence`, `Time ${capturedAt}`, `Address ${address}`, `Officer ${user.id}`, `Assessment ${assessmentId}`].join(' | ');
    const basePath = `org/${assessment.organization_id}/${module}-assessments/${assessmentId}/${Date.now()}`;
    const originalPath = `${basePath}-original.jpg`;
    const watermarkedPath = `${basePath}-watermarked.jpg`;
    const watermarked = await watermark(bytes, watermarkText);
    const rawSha256 = await sha256Hex(bytes);
    const watermarkedSha256 = await sha256Hex(watermarked);
    const { error: originalError } = await supabase.storage.from(EVIDENCE_BUCKET).upload(originalPath, new Blob([bytes], { type: 'image/jpeg' }), { upsert: false, contentType: 'image/jpeg' });
    if (originalError) throw originalError;
    const { error: watermarkError } = await supabase.storage.from(EVIDENCE_BUCKET).upload(watermarkedPath, watermarked, { upsert: false, contentType: 'image/jpeg' });
    if (watermarkError) throw watermarkError;

    const { data: evidenceId, error: evidenceError } = await supabase.rpc('register_edge_court_photo', {
      p_organization_id: assessment.organization_id,
      p_module_key: module,
      p_storage_path: watermarkedPath,
      p_captured_at: capturedAt,
      p_metadata: { original_path: originalPath, raw_sha256: rawSha256, watermarked_sha256: watermarkedSha256, watermark_text: watermarkText, watermark_service: 'inference', assessment_id: assessmentId },
    });
    if (evidenceError || !evidenceId) throw evidenceError ?? new Error('Court evidence registration could not be confirmed');

    const { data: signed, error: signedError } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(watermarkedPath, 300);
    if (signedError || !signed?.signedUrl) throw signedError ?? new Error('Evidence URL could not be created');
    const classifyResponse = await fetch(`${SUPABASE_URL}/functions/v1/classify-photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({ photo_url: signed.signedUrl, module, context: `Assessment ${assessmentId}; ${address}` }),
    });
    const classification = await classifyResponse.json();
    if (!classifyResponse.ok || classification.error) return json({ error: classification.error ?? 'Photo classification failed' }, 502);

    const evidence = { id: evidenceId, original_path: originalPath, watermarked_path: watermarkedPath, captured_at: capturedAt, raw_sha256: rawSha256, watermarked_sha256: watermarkedSha256, watermark_text: watermarkText, watermark_service: 'inference' };
    const update = module === 'biosecurity'
      ? { photo_urls: [evidence], photo_url: watermarkedPath, bob_classification: classification.classification ?? null, bob_confidence: classification.confidence ?? null, species_name: classification.details?.species_name ?? assessment.species_name }
      : { photo_urls: [evidence], bob_classification: classification.classification ?? null, bob_confidence: classification.confidence ?? null, smoke_source: classification.details?.smoke_source ?? null };
    const { error: updateError } = await supabase.from(table).update(update).eq('id', assessmentId);
    if (updateError) throw updateError;
    return json({ success: true, evidence, classification });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Environmental evidence could not be captured' }, 500);
  }
});