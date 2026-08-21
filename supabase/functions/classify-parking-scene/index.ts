/**
 * classify-parking-scene -- Parking scene visual analysis Edge Function
 *
 * Purpose: Detect parking-specific visual features (road markings, signs,
 * bay occupancy) from a phone photo using GPT-4o vision via the apps/api
 * Bob vision endpoint.
 *
 * Input:
 *   POST /classify-parking-scene
 *   Headers:
 *     Authorization: Bearer <supabase_jwt>
 *   Body:
 *     {
 *       photo_url: string,   // Signed URL to photo in Supabase Storage
 *       context?: string,    // Optional: plate, location, zone name
 *     }
 *
 * Output:
 *   {
 *     success: true,
 *     data: {
 *       road_marking_detected: "yellow_lines" | "disabled_bay" | "standard" | "unknown",
 *       is_disabled_bay: boolean,
 *       sign_time_limit_minutes: number | null,
 *       sign_confidence: number,
 *       bay_occupied: boolean | null,
 *       bay_confidence: number,
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
      console.error('[classify-parking-scene] auth error:', authError);
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
      console.error('[classify-parking-scene] API_URL or API_TOKEN not configured');
      return json({
        error: 'Classification service not configured'
      }, 503);
    }
    // -- Build parking-scene prompt -----------------------------------------
    const systemPrompt = [
      'You are a parking enforcement AI assistant for New Zealand councils.',
      'Analyze this parking enforcement photo and detect the following.',
      'Return ONLY valid JSON, no markdown.',
      '',
      'Detect:',
      '1. Road markings: Look for yellow lines (no parking/restricted),',
      '   disabled bay symbols (blue/yellow wheelchair), standard white bay',
      '   lines, or no markings.',
      '2. Parking signs: Look for P-zone time limit signs (P60, P120, P30,',
      '   P15, P5 etc.) and extract the time limit in minutes. Also detect',
      '   disabled parking signs (blue wheelchair symbol).',
      '3. Bay occupancy: Is the vehicle clearly within the bay lines?',
      '',
      'Return this exact JSON structure:',
      '{',
      '  "road_marking_detected": "yellow_lines" | "disabled_bay" | "standard" | "unknown",',
      '  "is_disabled_bay": boolean,',
      '  "sign_time_limit_minutes": number | null,',
      '  "sign_confidence": number,',
      '  "bay_occupied": boolean | null,',
      '  "bay_confidence": number,',
      '  "reasoning": "string"',
      '}',
      '',
      'NZ context: Single yellow line = time-restricted parking.',
      'Double yellow line = no parking at any time.',
      'Blue wheelchair symbol = disabled bay (mobility parking).',
      'P60 = 60 minute limit, P120 = 2 hour limit, etc.'
    ].join('\n');
    const userMessage = body.context ? `Additional context: ${body.context}\n\nPhoto URL: ${body.photo_url}` : `Photo URL: ${body.photo_url}`;
    // -- Call apps/api Bob vision endpoint ----------------------------------
    console.log(`[classify-parking-scene] Analyzing parking scene for user ${user.id}`);
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
      console.error(`[classify-parking-scene] API error ${apiRes.status}: ${errText.slice(0, 300)}`);
      return json({
        success: false,
        error: `Classification service returned ${apiRes.status}`
      }, 502);
    }
    const data = await apiRes.json();
    if (data.error) {
      console.error('[classify-parking-scene] API returned error:', data.error);
      return json({
        success: false,
        error: data.error
      }, 500);
    }
    if (!data.reply) {
      console.error('[classify-parking-scene] API returned no reply');
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
      console.error('[classify-parking-scene] Failed to parse response:', parseErr);
      // Return best-effort with unknown marking and zero confidence
      return json({
        success: true,
        data: {
          road_marking_detected: 'unknown',
          is_disabled_bay: false,
          sign_time_limit_minutes: null,
          sign_confidence: 0,
          bay_occupied: null,
          bay_confidence: 0,
          reasoning: data.reply
        }
      });
    }
  } catch (err) {
    console.error('[classify-parking-scene] unexpected error:', err);
    return json({
      success: false,
      error: 'Internal error in classification service'
    }, 500);
  }
});
