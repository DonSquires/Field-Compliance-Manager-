/**
 * classify-smoke-scene -- Smoke nuisance visual analysis Edge Function
 *
 * Purpose: Estimate smoke opacity/density and likely source type from a
 * phone photo using GPT-4o vision via the apps/api Bob vision endpoint,
 * to assist (not replace) the officer's own observation against the
 * council air-quality bylaw standard. Mirrors classify-parking-scene.
 *
 * Input:
 *   POST /classify-smoke-scene
 *   Headers:
 *     Authorization: Bearer <supabase_jwt>
 *   Body:
 *     {
 *       photo_url: string,   // Signed URL to photo in Supabase Storage
 *       context?: string,    // Optional: site/zone name, complaint source
 *     }
 *
 * Output:
 *   {
 *     success: true,
 *     data: {
 *       smoke_source_type: "domestic_solid_fuel" | "industrial" | "vehicle_exhaust" | "agricultural" | "nuisance_burning" | "unknown",
 *       smoke_colour: "white" | "grey" | "black" | "unknown",
 *       estimated_opacity_percent: number | null,
 *       confidence: number,
 *       recommendation: string,
 *       reasoning: string,
 *     }
 *   }
 *
 * Env secrets required:
 *   API_URL    -- apps/api base URL
 *   API_TOKEN  -- apps/api auth token
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const API_URL = Deno.env.get('API_URL') ?? Deno.env.get('RAILWAY_API_URL') ?? '';
const API_TOKEN = Deno.env.get('API_TOKEN') ?? Deno.env.get('RAILWAY_API_TOKEN') ?? '';
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
    // -- Authenticate user --------------------------------------------------
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({
      error: 'Missing Authorization header'
    }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      console.error('[classify-smoke-scene] auth error:', authError);
      return json({
        error: 'Unauthorized'
      }, 401);
    }
    // -- Parse request body -------------------------------------------------
    const body = await req.json();
    if (!body.photo_url?.trim()) return json({
      error: 'photo_url is required'
    }, 400);
    if (!API_URL || !API_TOKEN) {
      console.error('[classify-smoke-scene] API_URL or API_TOKEN not configured');
      return json({
        error: 'Classification service not configured'
      }, 503);
    }
    // -- Build smoke-scene prompt --------------------------------------------
    const systemPrompt = [
      'You are a smoke nuisance / air-quality enforcement assistant for New Zealand councils.',
      'Analyze this smoke observation photo and estimate the following.',
      'Return ONLY valid JSON, no markdown.',
      '',
      'Estimate:',
      '1. Smoke colour: white (often steam/incomplete combustion), grey, or black',
      '   (often diesel/industrial or heavily incomplete combustion).',
      '2. Likely source type: domestic solid fuel (a home fire/burner), industrial,',
      '   vehicle exhaust, agricultural (e.g. crop/vegetation burn), nuisance burning',
      '   (rubbish/debris), or unknown if not clear from the photo.',
      '3. Estimated opacity as a percentage (a Ringelmann-style visual density',
      '   estimate: roughly how much the smoke obscures the background), or null',
      '   if not estimable from this photo.',
      '4. A plain-language recommendation for the officer to consider -- this is',
      '   ADVISORY ONLY, the officer makes the final call against the applicable',
      '   bylaw standard, never state or imply a legal conclusion.',
      '',
      'Return this exact JSON structure:',
      '{',
      '  "smoke_source_type": "domestic_solid_fuel" | "industrial" | "vehicle_exhaust" | "agricultural" | "nuisance_burning" | "unknown",',
      '  "smoke_colour": "white" | "grey" | "black" | "unknown",',
      '  "estimated_opacity_percent": number | null,',
      '  "confidence": number,',
      '  "recommendation": "string",',
      '  "reasoning": "string"',
      '}'
    ].join('\n');
    const userMessage = body.context ? `Additional context: ${body.context}\n\nPhoto URL: ${body.photo_url}` : `Photo URL: ${body.photo_url}`;
    // -- Call apps/api Bob vision endpoint ----------------------------------
    console.log(`[classify-smoke-scene] Analyzing smoke scene for user ${user.id}`);
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
      console.error(`[classify-smoke-scene] API error ${apiRes.status}: ${errText.slice(0, 300)}`);
      return json({
        success: false,
        error: `Classification service returned ${apiRes.status}`
      }, 502);
    }
    const data = await apiRes.json();
    if (data.error) {
      console.error('[classify-smoke-scene] API returned error:', data.error);
      return json({
        success: false,
        error: data.error
      }, 500);
    }
    if (!data.reply) {
      console.error('[classify-smoke-scene] API returned no reply');
      return json({
        success: false,
        error: 'Empty response from classification service'
      }, 502);
    }
    // -- Parse GPT-4o JSON response -----------------------------------------
    try {
      // Extract JSON from markdown code blocks if present
      let jsonStr = data.reply.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1].trim();
      const result = JSON.parse(jsonStr);
      return json({
        success: true,
        data: result
      });
    } catch (parseErr) {
      console.error('[classify-smoke-scene] Failed to parse response:', parseErr);
      // Return best-effort with unknown source and zero confidence
      return json({
        success: true,
        data: {
          smoke_source_type: 'unknown',
          smoke_colour: 'unknown',
          estimated_opacity_percent: null,
          confidence: 0,
          recommendation: '',
          reasoning: data.reply
        }
      });
    }
  } catch (err) {
    console.error('[classify-smoke-scene] unexpected error:', err);
    return json({
      success: false,
      error: 'Internal error in classification service'
    }, 500);
  }
});
