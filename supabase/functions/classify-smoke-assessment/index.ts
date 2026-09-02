/**
 * Observational analysis of existing private Smoke evidence.
 * Never determines legal breach, responsibility, cause, or enforcement action.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? '';
const OPENAI_BASE_URL = (Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
const OPENAI_VISION_MODEL = Deno.env.get('OPENAI_VISION_MODEL') ?? 'gpt-4o-mini';
const EVIDENCE_BUCKET = 'scans';
const ALLOWED_ROLES = new Set(['grand_master', 'master', 'admin', 'admin_officer', 'officer']);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function extractJson(response: Record<string, unknown>) {
  const choices = response.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  if (typeof message?.content !== 'string') throw new Error('Vision model returned no structured result.');
  return JSON.parse(message.content);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const authHeader = request.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: profile } = await admin.from('user_profiles').select('organization_id, role, deactivated_at').eq('id', user.id).maybeSingle();
    if (!profile || profile.deactivated_at || !ALLOWED_ROLES.has(String(profile.role))) return json({ error: 'Forbidden' }, 403);

    const body = await request.json();
    const assessmentId = String(body.assessment_id ?? '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(assessmentId)) return json({ error: 'Valid assessment_id is required' }, 400);
    if (!OPENAI_API_KEY) return json({ error: 'Smoke inference is not configured' }, 503);
    const { data: assessment } = await admin.from('smoke_assessments').select('id, organization_id, officer_user_id, client_request_id, status, scene_description, photo_urls, smoke_ai_analysis, bob_classification, bob_confidence, bob_recommendation').eq('id', assessmentId).maybeSingle();
    if (!assessment || assessment.organization_id !== profile.organization_id) return json({ error: 'Assessment not found' }, 404);
    if (profile.role === 'officer' && assessment.officer_user_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (assessment.smoke_ai_analysis) return json({ success: true, analyzed: false, assessment, advisory: true });
    if (assessment.status !== 'open') return json({ error: 'Only open Smoke assessments can be classified' }, 409);

    const photos = Array.isArray(assessment.photo_urls) ? assessment.photo_urls.slice(0, 3) : [];
    if (photos.length < 1) return json({ error: 'Smoke assessment has no evidence photos' }, 409);
    const expectedPrefix = `org/${assessment.organization_id}/smoke/${assessment.client_request_id}/`;
    const imageContent: Array<Record<string, unknown>> = [];
    const photoIds: string[] = [];
    for (const photo of photos) {
      const storagePath = String(photo?.storage_path ?? '');
      const photoId = String(photo?.id ?? '');
      if (photo?.storage_bucket !== EVIDENCE_BUCKET || !storagePath.startsWith(expectedPrefix) || !photoId) return json({ error: 'Smoke evidence reference is invalid' }, 409);
      const { data: image, error: downloadError } = await admin.storage.from(EVIDENCE_BUCKET).download(storagePath);
      if (downloadError || !image) throw new Error(`Smoke evidence download failed: ${downloadError?.message ?? 'object missing'}`);
      const bytes = new Uint8Array(await image.arrayBuffer());
      if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('Stored Smoke evidence is not a JPEG image.');
      imageContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytesToBase64(bytes)}`, detail: 'high' } });
      photoIds.push(photoId);
    }

    const context = String(assessment.scene_description ?? '').slice(0, 1500);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    const modelResponse = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_VISION_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are an observational Smoke Control evidence analyst. Describe only visible plume, visible source, scene, confounders, and image quality. Never determine legal breach, excessive smoke, nuisance, responsibility, identity, intent, address, duration, recurrence, fuel or cause, safety, or enforcement action. Do not infer facts from the officer narrative. Dark or dense smoke, ambiguity, degraded imagery, confounders, or weak source-to-plume linkage always require manual review.' },
          { role: 'user', content: [{ type: 'text', text: `Assess visible evidence across these ${photos.length} field image(s). Officer context is orientation only: ${context}` }, ...imageContent] },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'smoke_evidence_assessment', strict: true, schema: {
          type: 'object', additionalProperties: false,
          required: ['smoke_visible','source_visible','plume_density_band','plume_opacity_band','plume_colour_band','plume_direction_visible','source_to_plume_link_confidence','scene_conditions','confounders_detected','image_quality','evidence_utility','classification_summary','observable_facts','quality_warnings','review_flags','recommended_officer_prompts','evidence_grade','material_uncertainties','manual_review_required','supports_follow_up','suggested_next_step','confidence_by_field'],
          properties: {
            smoke_visible: { type: 'string', enum: ['none','possible','clear'] }, source_visible: { type: 'string', enum: ['chimney_flue','outdoor_burn','vehicle_exhaust','industrial_vent','unknown_source','no_source_visible'] },
            plume_density_band: { type: 'string', enum: ['none','faint','light','moderate','dense','indeterminate'] }, plume_opacity_band: { type: 'string', enum: ['none','low','medium','high','indeterminate'] }, plume_colour_band: { type: 'string', enum: ['none','white_light','grey','dark','mixed','indeterminate'] }, plume_direction_visible: { type: 'boolean' }, source_to_plume_link_confidence: { type: 'number', minimum: 0, maximum: 1 },
            scene_conditions: { type: 'array', items: { type: 'string', enum: ['daylight','dusk','night','rain','fog','backlit','glare','obstructed'] }, maxItems: 8 }, confounders_detected: { type: 'array', items: { type: 'string', enum: ['steam','fog','cloud','shadow','vehicle_exhaust','barbecue','dust','lens_flare','distance_too_great'] }, maxItems: 9 },
            image_quality: { type: 'string', enum: ['usable','degraded','unusable'] }, evidence_utility: { type: 'string', enum: ['supports_observation','weak_support','not_suitable'] }, classification_summary: { type: 'string' }, observable_facts: { type: 'array', items: { type: 'string' }, maxItems: 10 }, quality_warnings: { type: 'array', items: { type: 'string' }, maxItems: 8 }, review_flags: { type: 'array', items: { type: 'string' }, maxItems: 8 }, recommended_officer_prompts: { type: 'array', items: { type: 'string' }, maxItems: 6 },
            evidence_grade: { type: 'string', enum: ['strong','moderate','weak','unusable'] }, material_uncertainties: { type: 'array', items: { type: 'string' }, maxItems: 8 }, manual_review_required: { type: 'boolean' }, supports_follow_up: { type: 'boolean' }, suggested_next_step: { type: 'string', enum: ['request_more_evidence','re_attend','supervisor_review','hold'] },
            confidence_by_field: { type: 'object', additionalProperties: false, required: ['smoke_visible','source_visible','plume_density_band','plume_opacity_band','plume_colour_band'], properties: { smoke_visible: { type: 'number', minimum: 0, maximum: 1 }, source_visible: { type: 'number', minimum: 0, maximum: 1 }, plume_density_band: { type: 'number', minimum: 0, maximum: 1 }, plume_opacity_band: { type: 'number', minimum: 0, maximum: 1 }, plume_colour_band: { type: 'number', minimum: 0, maximum: 1 } } },
          },
        } } },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!modelResponse.ok) throw new Error(`Vision model returned ${modelResponse.status}: ${(await modelResponse.text()).slice(0, 300)}`);
    const inference = extractJson(await modelResponse.json());
    const fieldConfidence = Object.values(inference.confidence_by_field ?? {}).map(Number).filter(Number.isFinite);
    const confidence = Math.max(0, Math.min(1, fieldConfidence.length ? Math.min(...fieldConfidence) : 0));
    const consequential = inference.plume_colour_band === 'dark' || inference.plume_density_band === 'dense';
    const manualReviewRequired = inference.manual_review_required === true || consequential || inference.image_quality !== 'usable' || inference.confounders_detected?.length > 0 || Number(inference.source_to_plume_link_confidence) < 0.8 || confidence < 0.8;
    const analysis = { ...inference, schema_version: 1, manual_review_required: manualReviewRequired, model: OPENAI_VISION_MODEL, analyzed_at: new Date().toISOString(), photo_ids: photoIds, images_analyzed: photoIds.length, legal_use_boundary: 'Observational support only; not a legal breach or enforcement determination.' };
    const recommendation = manualReviewRequired ? 'Manual review required before relying on this image evidence.' : 'Review alongside officer narrative, GPS, time, and applicable legal instrument.';
    const { data: updated, error: finalizeError } = await admin.rpc('finalize_smoke_photo_inference', { p_assessment_id: assessment.id, p_actor_user_id: user.id, p_analysis: analysis, p_summary: inference.classification_summary, p_confidence: confidence, p_recommendation: recommendation });
    if (finalizeError) throw new Error(`Smoke inference finalization failed: ${finalizeError.message}`);
    return json({ success: true, analyzed: true, assessment: updated, advisory: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Smoke classification failed';
    console.error('[classify-smoke-assessment]', detail);
    return json({ error: 'Smoke classification failed', detail }, 500);
  }
});