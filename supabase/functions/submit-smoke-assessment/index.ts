/**
 * submit-smoke-assessment -- Smoke control officer submission pipeline
 *
 * Purpose: bring the smoke control module to spec (photo evidence + GPS +
 * AI-assisted classification, per Bob's module_smoke_control /
 * workflow_smoke_control knowledge cards: "smoke_assessments row (location,
 * description, evidence photo) -> if excessive: notices row (direction,
 * bylaw clause)"). Mirrors process-officer-scan's photo-upload shape and
 * classify-parking-scene's vision-classification call.
 *
 * smoke_assessments/notices both have direct authenticated INSERT RLS
 * (org_access_allowed), but Storage has no client-writable bucket policies
 * in this app -- every photo upload goes through a service-role edge
 * function. This one also drives the AI classification, since that call
 * needs a signed URL the client cannot mint itself.
 *
 * Input:
 *   POST /submit-smoke-assessment
 *   Headers: Authorization: Bearer <supabase_jwt>
 *   Body: {
 *     site_id: string,
 *     complaint_source: 'neighbour'|'council_hotline'|'self_report'|'other',
 *     smoke_source_type?: string,   // officer's own call; AI classification may inform it
 *     severity?: string,
 *     action_taken: 'no_action'|'verbal_warning'|'abatement_notice'|'infringement_notice'|'prosecution_referral',
 *     scene_description?: string,
 *     notes?: string,
 *     legal_basis?: string,          // defaults to the column default (RMA s.17A) if omitted
 *     follow_up_required?: boolean,
 *     is_out_of_hours?: boolean,
 *     gps_lat?: number,
 *     gps_lng?: number,
 *     image_base64?: string,        // optional evidence photo
 *   }
 *
 * Output: { success: true, data: { assessment, notice, classification } }
 *
 * Env secrets required (photo classification only; the assessment still
 * saves without a photo if these are unset):
 *   API_URL, API_TOKEN (or RAILWAY_API_URL/RAILWAY_API_TOKEN)
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const API_URL = Deno.env.get('API_URL') ?? Deno.env.get('RAILWAY_API_URL') ?? '';
const API_TOKEN = Deno.env.get('API_TOKEN') ?? Deno.env.get('RAILWAY_API_TOKEN') ?? '';
const SCAN_BUCKET = 'scans';
const ESCALATED_ACTIONS = ['abatement_notice', 'infringement_notice', 'prosecution_referral'];

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function classifySmokeScene(photoUrl, context) {
  if (!API_URL || !API_TOKEN) return null;
  const systemPrompt = [
    'You are a smoke nuisance / air-quality enforcement assistant for New Zealand councils.',
    'Analyze this smoke observation photo and estimate the following.',
    'Return ONLY valid JSON, no markdown.',
    '',
    'Return this exact JSON structure:',
    '{',
    '  "smoke_source_type": "domestic_solid_fuel" | "industrial" | "vehicle_exhaust" | "agricultural" | "nuisance_burning" | "unknown",',
    '  "smoke_colour": "white" | "grey" | "black" | "unknown",',
    '  "estimated_opacity_percent": number | null,',
    '  "confidence": number,',
    '  "recommendation": "string",',
    '  "reasoning": "string"',
    '}',
    '',
    'The recommendation is ADVISORY ONLY -- the officer makes the final call against the applicable bylaw standard.',
  ].join('\n');
  try {
    const res = await fetch(`${API_URL}/api/bob/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ system_prompt: systemPrompt, message: `Context: ${context}\n\nPhoto URL: ${photoUrl}`, image_url: photoUrl }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.reply) return null;
    let jsonStr = String(data.reply).trim();
    const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) jsonStr = match[1].trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    console.warn('[submit-smoke-assessment] classification error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ success: false, error: 'Missing Authorization header' }, 401);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json({ success: false, error: 'Unauthorized' }, 401);

    const { data: officerProfile } = await supabase
      .from('user_profiles')
      .select('organization_id, display_name')
      .eq('id', user.id)
      .is('deactivated_at', null)
      .maybeSingle();
    if (!officerProfile?.organization_id) return json({ success: false, error: 'Active officer profile required' }, 403);
    const organizationId = officerProfile.organization_id;

    const body = await req.json();
    if (!body.site_id) return json({ success: false, error: 'site_id is required' }, 400);
    if (!body.action_taken) return json({ success: false, error: 'action_taken is required' }, 400);

    let photoPath = null;
    let classification = null;
    if (body.image_base64) {
      const path = `org/${organizationId}/smoke-evidence/${crypto.randomUUID()}.jpg`;
      const bytes = base64ToBytes(body.image_base64);
      const { error: uploadError } = await supabase.storage.from(SCAN_BUCKET).upload(path, new Blob([bytes], { type: 'image/jpeg' }), { upsert: true, contentType: 'image/jpeg' });
      if (!uploadError) {
        photoPath = path;
        const { data: signedUrlData } = await supabase.storage.from(SCAN_BUCKET).createSignedUrl(path, 300);
        if (signedUrlData?.signedUrl) {
          classification = await classifySmokeScene(signedUrlData.signedUrl, `Site: ${body.site_id}, complaint source: ${body.complaint_source ?? 'unknown'}`);
        }
      } else {
        console.warn('[submit-smoke-assessment] photo upload failed:', uploadError.message);
      }
    }

    const { data: assessment, error: insertError } = await supabase
      .from('smoke_assessments')
      .insert([
        {
          organization_id: organizationId,
          officer_user_id: user.id,
          officer_name: officerProfile.display_name ?? null,
          site_id: body.site_id,
          complaint_source: body.complaint_source ?? null,
          smoke_source_type: body.smoke_source_type ?? classification?.smoke_source_type ?? null,
          smoke_source: body.smoke_source ?? null,
          source_confirmed: body.source_confirmed ?? false,
          severity: body.severity ?? null,
          action_taken: body.action_taken,
          scene_description: body.scene_description ?? null,
          notes: body.notes ?? null,
          legal_basis: body.legal_basis ?? undefined,
          follow_up_required: body.follow_up_required ?? false,
          is_out_of_hours: body.is_out_of_hours ?? false,
          gps_lat: body.gps_lat ?? null,
          gps_lng: body.gps_lng ?? null,
          photo_urls: photoPath ? [photoPath] : [],
          bob_classification: classification ? `${classification.smoke_source_type ?? 'unknown'} / ${classification.smoke_colour ?? 'unknown'}` : null,
          bob_confidence: classification?.confidence ?? null,
          bob_recommendation: classification?.recommendation ?? null,
          status: 'open',
        },
      ])
      .select()
      .single();
    if (insertError) return json({ success: false, error: insertError.message }, 500);

    let notice = null;
    if (ESCALATED_ACTIONS.includes(body.action_taken)) {
      const noticeTypeMap = { abatement_notice: 'abatement', infringement_notice: 'infringement', prosecution_referral: 'enforcement' };
      const { data: noticeRow, error: noticeError } = await supabase
        .from('notices')
        .insert([
          {
            organization_id: organizationId,
            officer_user_id: user.id,
            notice_type: noticeTypeMap[body.action_taken] ?? 'direction',
            legal_basis: assessment.legal_basis ?? 'RMA s.17A',
            comply_by: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            status: 'draft',
          },
        ])
        .select()
        .single();
      if (!noticeError) notice = noticeRow;
      else console.warn('[submit-smoke-assessment] notice creation failed:', noticeError.message);
    }

    return json({ success: true, data: { assessment, notice, classification } });
  } catch (err) {
    console.error('[submit-smoke-assessment] unexpected error:', err instanceof Error ? err.message : String(err));
    return json({ success: false, error: 'Internal error submitting smoke assessment' }, 500);
  }
});
