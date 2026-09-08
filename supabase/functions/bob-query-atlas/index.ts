import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { OWNER_EMAILS } from '../_shared/auth.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const json = (b, s = 200)=>new Response(JSON.stringify(b), {
    status: s,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({
      error: 'Unauthorized'
    }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authErr } = await caller.auth.getUser();
    if (authErr || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('role').eq('id', user.id).single();
    const isOwner = OWNER_EMAILS.has((user.email ?? '').toLowerCase().trim());
    if (!isOwner && String(profile?.role ?? '') !== 'grand_master') return json({
      error: 'Forbidden: admiral only'
    }, 403);
    const body = await req.json();
    const action = String(body.action ?? 'capability_map').trim();
    const filter = String(body.filter ?? '').trim();
    const limit = Math.min(Math.max(Number(body.limit ?? 100), 1), 500);
    const offset = Math.min(Math.max(Number(body.offset ?? 0), 0), 100_000);
    if (action === 'capability_map') {
      let q = admin.from('bob_capability_map').select('entity_type, entity_name, present, wired, exercised, notes, refresh_source, retirement_status', { count: 'exact' }).order('entity_type').order('entity_name').range(offset, offset + limit - 1);
      if (filter) q = q.ilike('entity_name', `%${filter}%`);
      const { data, error, count } = await q;
      if (error) return json({
        error: error.message
      }, 500);
      return json({
        ok: true,
        action,
        count: (data ?? []).length,
        total: count ?? null,
        offset,
        next_offset: count !== null && offset + (data ?? []).length < count ? offset + (data ?? []).length : null,
        results: data ?? []
      });
    }
    if (action === 'terrain_edges') {
      let q = admin.from('bob_app_map_edges').select('source_type, source_name, target_type, target_name, edge_kind, retirement_status', { count: 'exact' }).eq('retirement_status', 'live').order('source_name').range(offset, offset + limit - 1);
      if (filter) q = q.or(`source_name.ilike.%${filter}%,target_name.ilike.%${filter}%`);
      const { data, error, count } = await q;
      if (error) return json({
        error: error.message
      }, 500);
      return json({
        ok: true,
        action,
        count: (data ?? []).length,
        total: count ?? null,
        offset,
        next_offset: count !== null && offset + (data ?? []).length < count ? offset + (data ?? []).length : null,
        results: data ?? []
      });
    }
    if (action === 'gap_report') {
      const { data, error } = await admin.rpc('bob_atlas_gap_report', {
        p_limit: limit,
        p_offset: offset
      });
      if (error) return json({
        error: error.message
      }, 500);
      return json({
        ok: true,
        action,
        count: (data ?? []).length,
        total: null,
        offset,
        next_offset: (data ?? []).length === limit ? offset + (data ?? []).length : null,
        results: data ?? []
      });
    }
    if (action === 'blast_radius') {
      // "If we touch this node, what does it reach - glass to core?"
      // TWO DISTINCT layers, never conflated: FLOW (data-flow, directed) and
      // FK (structural relation, undirected). Backed by 0365 recursive-CTE
      // functions (cycle-guarded, depth-capped, live edges only).
      const fromType = String(body.from_type ?? '').trim();
      const fromName = String(body.from_name ?? '').trim();
      const direction = String(body.direction ?? 'downstream').trim();
      const requestedMaxDepth = Math.min(Math.max(Number(body.max_depth ?? 4), 1), 20);
      // FK reach is an undirected recursive walk over a dense graph. Keep the
      // request bounded at the service boundary so one query cannot consume
      // the Edge Function statement budget.
      const maxDepth = Math.min(requestedMaxDepth, 4);
      if (!fromType || !fromName) {
        return json({
          error: "blast_radius needs { from_type, from_name }. Optional: direction (downstream|upstream|both), max_depth (1-20)."
        }, 422);
      }
      // FLOW reach (directed). 'both' runs downstream + upstream and tags each.
      const flowRows = [];
      const dirs = direction === 'both' ? [
        'downstream',
        'upstream'
      ] : [
        direction === 'upstream' ? 'upstream' : 'downstream'
      ];
      for (const d of dirs){
        const { data, error } = await admin.rpc('bob_atlas_flow_reach', {
          p_from_type: fromType,
          p_from_name: fromName,
          p_direction: d,
          p_max_depth: maxDepth
        });
        if (error) return json({
          error: `flow_reach failed: ${error.message}`
        }, 500);
        for (const r of data ?? [])flowRows.push({
          ...r,
          direction: d
        });
      }
      // FK reach (undirected relation - NOT a data-flow claim).
      const { data: fkData, error: fkErr } = await admin.rpc('bob_atlas_fk_reach', {
        p_from_type: fromType,
        p_from_name: fromName,
        p_max_depth: maxDepth
      });
      if (fkErr) return json({
        error: `fk_reach failed: ${fkErr.message}`
      }, 500);
      return json({
        ok: true,
        action,
        origin: {
          entity_type: fromType,
          entity_name: fromName
        },
        direction,
        max_depth: maxDepth,
        requested_max_depth: requestedMaxDepth,
        note: `flow_reach = proven data-flow (writes/reads/calls/invokes). fk_reach = structural RELATION only (undirected); never read an FK link as a data-flow path. FK traversal is capped at depth ${maxDepth} to stay within the statement budget.`,
        flow_reach: flowRows,
        fk_reach: fkData ?? []
      });
    }
    return json({
      error: `Unknown action '${action}'. Valid: capability_map, terrain_edges, gap_report, blast_radius`
    }, 422);
  } catch (err) {
    console.error('[bob-query-atlas]', err);
    return json({
      error: 'Internal error'
    }, 500);
  }
});
