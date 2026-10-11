/**
 * classify-photo — Bob AI photo classification Edge Function
 *
 * Purpose: Analyze evidence photos using Bob AI vision capabilities
 *
 * Use cases:
 *   - Biosecurity: Species identification from photos
 *   - Smoke Control: Smoke source detection and severity assessment
 *   - Noise Control: Equipment/source identification
 *   - Parking: Vehicle make/model recognition
 *
 * Input:
 *   POST /classify-photo
 *   Headers:
 *     Authorization: Bearer <supabase_jwt>
 *   Body:
 *     {
 *       photo_url: string,          // Signed URL to photo in Supabase Storage
 *       module: 'biosecurity' | 'smoke' | 'noise' | 'parking',
 *       context?: string,           // Additional context (location, prior observations)
 *     }
 *
 * Output:
 *   {
 *     classification: string,      // Primary classification result
 *     confidence: number,          // 0-1 confidence score
 *     details: {
 *       species_name?: string,     // For biosecurity
 *       common_name?: string,
 *       threat_level?: 'low' | 'medium' | 'high' | 'critical',
 *       smoke_source?: string,     // For smoke control
 *       severity?: 'minor' | 'moderate' | 'significant' | 'severe',
 *       equipment_type?: string,   // For noise control
 *       vehicle_make?: string,     // For parking
 *       vehicle_model?: string,
 *     },
 *     reasoning: string,           // Bob's explanation
 *   }
 *
 * Env secrets required:
 *   BOB_INFERENCE_SECRET  — shared secret with apps/api
 *   API_URL               — apps/api base URL
 *   API_TOKEN             — apps/api auth token
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const API_URL = Deno.env.get('FCM_API_URL') ?? Deno.env.get('API_URL') ?? Deno.env.get('RAILWAY_API_URL') ?? '';
const API_TOKEN = Deno.env.get('FCM_API_TOKEN') ?? Deno.env.get('API_TOKEN') ?? Deno.env.get('RAILWAY_API_TOKEN') ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*'
      }
    });
  }
  const json = (body, status = 200)=>new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  try {
    // ── Authenticate user ─────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({
      error: 'Missing Authorization header'
    }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      console.error('[classify-photo] auth error:', authError);
      return json({
        error: 'Unauthorized'
      }, 401);
    }
    // ── Parse request body ────────────────────────────────────────────────────
    const body = await req.json();
    if (!body.photo_url?.trim()) return json({
      error: 'photo_url is required'
    }, 400);
    if (!body.module) return json({
      error: 'module is required'
    }, 400);
    if (!API_URL || !API_TOKEN) {
      console.error('[classify-photo] API_URL or API_TOKEN not configured');
      return json({
        error: 'Classification service not configured'
      }, 503);
    }
    // ── Build module-specific prompt ──────────────────────────────────────────
    const prompts = {
      profile_photo: `You are a strict photo validator for a professional security company staff ID system.

Your ONLY job is to determine if this photo is suitable as a professional staff profile photo.

ACCEPT the photo ONLY if ALL of the following are true:
- It shows a HUMAN FACE clearly visible
- It is a HEAD AND SHOULDERS shot (face and upper chest visible)
- The person is the primary subject (not a crowd, not a group)
- The photo is in focus and well-lit
- It is a still photo (not animated)

REJECT the photo if ANY of the following are true:
- No human face is visible
- It shows an animal, pet, vehicle, object, landscape, or cartoon
- It is a group photo with multiple people
- The face is obscured, masked, or not clearly visible
- It is a full-body shot with no clear face focus
- It appears to be a screenshot, meme, or graphic
- It is animated or a GIF frame

Respond ONLY with this exact JSON format:
{
  "classification": "accepted" or "rejected",
  "confidence": <0.0 to 1.0>,
  "details": {
    "has_human_face": true or false,
    "is_head_and_shoulders": true or false,
    "is_single_person": true or false,
    "is_clear_and_focused": true or false,
    "rejection_reason": "<only if rejected: brief reason>"
  },
  "reasoning": "<one sentence explanation>"
}`,
      biosecurity: `You are a biosecurity expert analyzing a photo for invasive species identification.

Analyze this photo and identify:
1. Species name (scientific and common name)
2. Threat level (low, medium, high, critical)
3. Density estimate if visible (isolated, scattered, moderate, dense, severe)
4. Recommended action

Provide your response in JSON format:
{
  "classification": "<species scientific name>",
  "confidence": <0-1>,
  "details": {
    "species_name": "<scientific name>",
    "common_name": "<common name>",
    "threat_level": "<low|medium|high|critical>",
    "density": "<isolated|scattered|moderate|dense|severe>"
  },
  "reasoning": "<brief explanation>"
}`,
      smoke: `You are an environmental compliance officer analyzing a photo for smoke source identification.

Analyze this photo and identify:
1. Smoke source type (domestic fire, burn-off, industrial, vehicle, rubbish burning)
2. Severity (minor, moderate, significant, severe)
3. Visibility impact
4. Recommended action

Provide your response in JSON format:
{
  "classification": "<smoke source type>",
  "confidence": <0-1>,
  "details": {
    "smoke_source": "<domestic_fire|burn_off|industrial|vehicle|rubbish>",
    "severity": "<minor|moderate|significant|severe>",
    "visibility_impact": "<description>"
  },
  "reasoning": "<brief explanation>"
}`,
      noise: `You are a noise control officer analyzing a photo for noise source identification.

Analyze this photo and identify:
1. Noise source type (music equipment, machinery, construction, animals, vehicle)
2. Equipment type if visible
3. A visual-only apparent activity level

You cannot hear or measure noise from a photograph. Do not decide whether noise
is excessive, do not estimate decibels, and do not recommend enforcement.

Provide your response in JSON format:
{
  "classification": "<noise source type>",
  "confidence": <0-1>,
  "details": {
    "source_type": "<music_equipment|machinery|construction|animal|vehicle|unknown>",
    "equipment_type": "<description>",
    "estimated_level": "<inactive|low_visual_activity|moderate_visual_activity|high_visual_activity|unknown>"
  },
  "reasoning": "<brief explanation>"
}`,
      parking: `You are a parking enforcement officer analyzing a photo for vehicle identification.

Analyze this photo and identify:
1. Vehicle make and model
2. Vehicle type (car, van, truck, motorcycle)
3. Any visible parking violations

Provide your response in JSON format:
{
  "classification": "<vehicle make and model>",
  "confidence": <0-1>,
  "details": {
    "vehicle_make": "<make>",
    "vehicle_model": "<model>",
    "vehicle_type": "<type>"
  },
  "reasoning": "<brief explanation>"
}`
    };
    if (!(body.module in prompts)) return json({
      error: 'module is not supported'
    }, 400);
    const systemPrompt = prompts[body.module];
    const userMessage = body.context ? `Additional context: ${body.context}\n\nPhoto URL: ${body.photo_url}` : `Photo URL: ${body.photo_url}`;
    // ── Call apps/api Bob vision endpoint ────────────────────────────────────
    console.log(`[classify-photo] Analyzing ${body.module} photo for user ${user.id}`);
    const apiRes = await fetch(`${API_URL}/api/bob/vision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`
      },
      body: JSON.stringify({
        system_prompt: systemPrompt,
        message: userMessage,
        image_url: body.photo_url
      })
    });
    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error(`[classify-photo] API error ${apiRes.status}: ${errText.slice(0, 300)}`);
      return json({
        error: `Classification service returned ${apiRes.status}`
      }, 502);
    }
    const data = await apiRes.json();
    if (data.error) {
      console.error('[classify-photo] API returned error:', data.error);
      return json({
        error: data.error
      }, 500);
    }
    if (!data.reply) {
      console.error('[classify-photo] API returned no reply');
      return json({
        error: 'Empty response from classification service'
      }, 502);
    }
    // ── Parse Bob's JSON response ─────────────────────────────────────────────
    try {
      // Extract JSON from markdown code blocks if present
      let jsonStr = data.reply.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1].trim();
      const result = JSON.parse(jsonStr);
      if (!result || typeof result !== 'object'
          || typeof result.classification !== 'string'
          || typeof result.confidence !== 'number'
          || result.confidence < 0
          || result.confidence > 1
          || !result.details
          || typeof result.details !== 'object') {
        return json({ error: 'Classification response did not match the governed evidence contract' }, 502);
      }
      return json({
        ...result,
        classifier: 'bob_vision',
        provider: typeof data.provider === 'string' ? data.provider : null,
        model: typeof data.model === 'string' ? data.model : null,
        prompt_version: `${body.module}_photo_v1`
      });
    } catch (parseErr) {
      console.error('[classify-photo] Failed to parse Bob response:', parseErr);
      return json({ error: 'Classification service returned invalid structured output' }, 502);
    }
  } catch (err) {
    console.error('[classify-photo] unexpected error:', err);
    return json({
      error: 'Internal error in classification service'
    }, 500);
  }
});
