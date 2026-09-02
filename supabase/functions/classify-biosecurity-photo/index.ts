/**
 * classify-biosecurity-photo — tenant-scoped advisory species inference.
 *
 * Stores the submitted field photo as private evidence, asks a vision model
 * for a constrained plant/insect assessment, and persists only Bob advisory
 * fields. Human confirmation remains a separate officer action.
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
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_ROLES = new Set(['grand_master', 'master', 'admin', 'admin_officer', 'officer']);
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

function decodeBase64(value: string) {
  const normalized = value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s/g, '');
  const binary = atob(normalized);
  if (!binary.length || binary.length > MAX_IMAGE_BYTES) {
    throw new Error('Photo must be between 1 byte and 8 MB.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { normalized, bytes };
}

function extractJson(response: Record<string, unknown>) {
  const choices = response.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content !== 'string') throw new Error('Vision model returned no structured result.');
  return JSON.parse(content);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  let uploadedPath: string | null = null;
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
      .select('id, organization_id, role, display_name')
      .eq('id', user.id)
      .maybeSingle();
    if (!profile || !ALLOWED_ROLES.has(String(profile.role))) return json({ error: 'Forbidden' }, 403);

    const body = await req.json();
    const assessmentId = String(body.assessment_id ?? '').trim();
    if (!assessmentId) return json({ error: 'assessment_id is required' }, 400);
    if (typeof body.image_base64 !== 'string' || !body.image_base64.trim()) {
      return json({ error: 'image_base64 is required' }, 400);
    }
    if (!OPENAI_API_KEY) return json({ error: 'Biosecurity inference is not configured' }, 503);

    const { data: assessment } = await admin
      .from('biosecurity_assessments')
      .select('id, organization_id, officer_user_id, officer_id, location_name, scene_description, photo_urls')
      .eq('id', assessmentId)
      .maybeSingle();
    if (!assessment || assessment.organization_id !== profile.organization_id) return json({ error: 'Assessment not found' }, 404);
    if (profile.role === 'officer' && assessment.officer_user_id !== user.id && assessment.officer_id !== user.id) {
      return json({ error: 'Forbidden' }, 403);
    }

    const { normalized, bytes } = decodeBase64(body.image_base64);
    const photoId = crypto.randomUUID();
    uploadedPath = `org/${profile.organization_id}/biosecurity/${assessment.id}/${photoId}.jpg`;
    const { error: uploadError } = await admin.storage.from(EVIDENCE_BUCKET).upload(
      uploadedPath,
      new Blob([bytes], { type: 'image/jpeg' }),
      { contentType: 'image/jpeg', upsert: false },
    );
    if (uploadError) throw new Error(`Evidence upload failed: ${uploadError.message}`);

    const context = [assessment.location_name, assessment.scene_description, String(body.context ?? '').trim()]
      .filter(Boolean)
      .join('; ')
      .slice(0, 1500);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    const modelResponse = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_VISION_MODEL,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'You are an advisory biosecurity image analyst for New Zealand field officers. Identify plants and insects only from visible evidence. Never invent a species. Ambiguous, partial, low-quality, juvenile, larval, damaged, or look-alike specimens require manual review. Threat level is advisory and must not be treated as a legal pest determination.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Assess the primary organism in this field photo. Context: ${context || 'none supplied'}` },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${normalized}`, detail: 'high' } },
            ],
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'biosecurity_photo_assessment',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['organism_type', 'identification_status', 'scientific_name', 'common_name', 'confidence', 'threat_level', 'density', 'recommended_action', 'reasoning', 'visible_features', 'manual_review_required'],
              properties: {
                organism_type: { type: 'string', enum: ['plant', 'insect', 'other', 'unknown'] },
                identification_status: { type: 'string', enum: ['identified', 'uncertain', 'not_identifiable'] },
                scientific_name: { type: ['string', 'null'] },
                common_name: { type: ['string', 'null'] },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                threat_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical', 'unknown'] },
                density: { type: 'string', enum: ['isolated', 'scattered', 'moderate', 'dense', 'severe', 'not_assessable'] },
                recommended_action: { type: 'string' },
                reasoning: { type: 'string' },
                visible_features: { type: 'array', items: { type: 'string' }, maxItems: 8 },
                manual_review_required: { type: 'boolean' },
              },
            },
          },
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!modelResponse.ok) {
      const detail = (await modelResponse.text()).slice(0, 300);
      throw new Error(`Vision model returned ${modelResponse.status}: ${detail}`);
    }

    const inference = extractJson(await modelResponse.json());
    const confidence = Math.max(0, Math.min(1, Number(inference.confidence) || 0));
    const manualReviewRequired = inference.manual_review_required === true
      || inference.identification_status !== 'identified'
      || confidence < 0.8;
    const photo = {
      id: photoId,
      name: String(body.file_name ?? 'biosecurity-photo.jpg').slice(0, 200),
      storage_bucket: EVIDENCE_BUCKET,
      storage_path: uploadedPath,
      uploaded_at: new Date().toISOString(),
      metadata: { officer_id: user.id, officer_name: profile.display_name ?? null },
    };
    const checklist = {
      schema_version: 1,
      inference_status: manualReviewRequired ? 'manual_review_required' : 'advisory_identification',
      organism_type: inference.organism_type,
      identification_status: inference.identification_status,
      common_name: inference.common_name,
      threat_level: inference.threat_level,
      density: inference.density,
      reasoning: inference.reasoning,
      visible_features: inference.visible_features,
      manual_review_required: manualReviewRequired,
      model: OPENAI_VISION_MODEL,
      analyzed_at: new Date().toISOString(),
      photo_id: photoId,
    };
    const { data: updated, error: updateError } = await admin.rpc('finalize_biosecurity_photo_inference', {
      p_assessment_id: assessment.id,
      p_actor_user_id: user.id,
      p_photo: photo,
      p_species_id: inference.scientific_name,
      p_confidence: confidence,
      p_recommendation: inference.recommended_action,
      p_checklist: checklist,
    });
    if (updateError) throw new Error(`Assessment finalization failed: ${updateError.message}`);

    uploadedPath = null;
    return json({ success: true, assessment: updated, advisory: true });
  } catch (error) {
    if (uploadedPath) {
      const cleanup = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await cleanup.storage.from(EVIDENCE_BUCKET).remove([uploadedPath]);
    }
    const message = error instanceof Error ? error.message : 'Biosecurity photo classification failed';
    console.error('[classify-biosecurity-photo]', message);
    return json({ error: 'Biosecurity photo classification failed', detail: message }, 500);
  }
});