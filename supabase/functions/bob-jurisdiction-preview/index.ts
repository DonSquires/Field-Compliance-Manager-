/**
 * bob-jurisdiction-preview -- resolve Territorial Authority names to GeoJSON
 * boundaries for PREVIEW, without writing anything.
 *
 * POST /functions/v1/bob-jurisdiction-preview
 * Body: { district_names: string[] }
 *
 * WHY (owner direction 2026-07-30): the org-jurisdiction boundary was only
 * visible AFTER approval (the executor fetches+unions+writes in one approved
 * step). So a human approved a boundary they could not see. This resolves the
 * same authoritative TA polygons READ-ONLY so the panel can draw them at PROPOSE time.
 *
 * GOVERNANCE: JWT + admin/master/grand_master only (same gate as
 * bob-resolve-geofence). READ-ONLY -- no DB write, no bob_agentic_actions row.
 * The governed write still happens later via propose -> approve ->
 * bob-proposal-execute, unchanged. Reuses the shared TA boundary resolver so
 * preview and execution cannot diverge on which polygon a name resolves to.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTaBoundary } from '../_shared/ta-boundary-resolver.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_RESOLVE = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer'
]);
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({
      ok: false,
      error: 'Unauthorized'
    }, 401);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !caller) return json({
      ok: false,
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile } = await admin.from('user_profiles').select('role').eq('id', caller.id).single();
    if (!callerProfile || !CAN_RESOLVE.has(String(callerProfile.role))) {
      return json({
        ok: false,
        error: 'Forbidden: admin/master/grand_master required'
      }, 403);
    }
    const body = await req.json();
    const names = Array.isArray(body.district_names) ? body.district_names.map((d)=>String(d).trim()).filter(Boolean) : [];
    if (names.length === 0) {
      return json({
        ok: false,
        error: 'district_names must be a non-empty array of Territorial Authority names'
      }, 400);
    }
    if (names.length > 40) {
      return json({
        ok: false,
        error: 'Too many names (max 40 per preview)'
      }, 400);
    }
    const results = [];
    for (const name of names){
      const resolution = await resolveTaBoundary(name);
      results.push({
        name,
        matched: resolution.source_status === 'matched',
        geometry: resolution.geometry,
        source: resolution.source,
        source_status: resolution.source_status,
        detail: resolution.detail
      });
    }
    const unmatched = results.filter((r)=>!r.matched).map((r)=>r.name);
    const unavailable = results.filter((r)=>r.source_status === 'source_unavailable').map((r)=>r.name);
    const sources = [...new Set(results.map((r)=>r.source).filter(Boolean))];
    return json({
      ok: true,
      results,
      matched_count: results.length - unmatched.length,
      unmatched,
      unavailable,
      sources,
      note: unmatched.length === 0 ? `All councils resolved from ${sources.join(', ')}. PREVIEW only -- nothing is saved until you propose + approve.` : unavailable.length ? `Boundary source unavailable for: ${unavailable.join(', ')}. Nothing has been saved; retry or draw the boundary manually.` : `Resolved ${results.length - unmatched.length}/${results.length}. Unmatched: ${unmatched.join(', ')}.`
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({
      ok: false,
      error: 'Jurisdiction preview failed',
      detail: msg.slice(0, 300)
    }, 502);
  }
});
