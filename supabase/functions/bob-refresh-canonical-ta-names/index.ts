/**
 * bob-refresh-canonical-ta-names -- Refresh the canonical_ta_names table from
 * the LIVE NZTA FeatureServer.
 *
 * POST /functions/v1/bob-refresh-canonical-ta-names
 * Auth: service-role OR x-cron-secret (admin/scheduled job only).
 *
 * Phase 2 of the geofence redesign (epic #226).
 *
 * Q1 ruling: canonical TA names from LIVE authoritative data, NEVER a
 * hardcoded 2013 list. This edge function fetches DISTINCT TA names from the
 * NZTA FeatureServer and upserts them into canonical_ta_names via the
 * refresh_canonical_ta_names RPC.
 *
 * Q6 ruling: if the NZTA source is unavailable, the function surfaces a LOUD
 * error and does NOT wipe the existing table data. Never silently degrade.
 *
 * Callable by:
 *   - A scheduled cron job (x-cron-secret header)
 *   - A grand_master/admin via the UI (service-role auth)
 *   - The executor on first use (if the table is empty)
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fetchCanonicalTaNames, clearTaNameCache } from '../_shared/ta-validation.ts';
 // ATLAS EXTERNAL CALLER: supabase-pg-cron-canonical-ta-refresh
 const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret'
};
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  const json = (body, status = 200)=>new Response(JSON.stringify(body), {
      status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  // Auth: service-role or cron secret only
  const authHeader = req.headers.get('Authorization') ?? '';
  const cronHeader = req.headers.get('x-cron-secret') ?? '';
  const isServiceRole = SUPABASE_SERVICE_ROLE_KEY && authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  const isCron = CRON_SECRET && cronHeader === CRON_SECRET;
  if (!isServiceRole && !isCron) {
    return json({
      error: 'Unauthorized (service-role or x-cron-secret required)'
    }, 401);
  }
  try {
    // Step 1: Fetch DISTINCT TA names from the LIVE NZTA FeatureServer
    clearTaNameCache(); // Force fresh fetch
    const names = await fetchCanonicalTaNames();
    if (names.length === 0) {
      // Q6: LOUD error, never silently degrade
      return json({
        success: false,
        error: 'NZTA_SOURCE_UNAVAILABLE: could not fetch any TA names from the NZTA FeatureServer. The existing canonical_ta_names data has been preserved. Check the NZTA FeatureServer status and retry.'
      }, 502);
    }
    // Step 2: Upsert into canonical_ta_names via the RPC
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await admin.rpc('refresh_canonical_ta_names', {
      p_names: names,
      p_source: 'nzta_featureserver'
    });
    if (error) {
      return json({
        success: false,
        error: `refresh_canonical_ta_names RPC failed: ${error.message}`
      }, 500);
    }
    // The RPC returns a jsonb object with success, upserted, source, refreshed_at
    const result = data;
    if (result?.success === false) {
      return json({
        success: false,
        error: result.error ?? 'RPC returned failure'
      }, 500);
    }
    return json({
      success: true,
      fetched_from_nzta: names.length,
      upserted: result?.upserted ?? names.length,
      source: 'nzta_featureserver',
      sample: names.slice(0, 5),
      note: `Refreshed canonical_ta_names with ${names.length} TA names from the live NZTA FeatureServer.`
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
