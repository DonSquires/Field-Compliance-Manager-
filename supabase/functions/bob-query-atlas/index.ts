import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CAN_SQL, OWNER_EMAILS } from '../_shared/auth.ts';
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
async function readAtlasStatus(admin, expectedCommit = '') {
  const [capabilities, edges] = await Promise.all([
    admin.from('bob_capability_map')
      .select('last_refreshed_at, refresh_source', { count: 'exact' })
      .eq('retirement_status', 'live')
      .order('last_refreshed_at', { ascending: false })
      .limit(1),
    admin.from('bob_app_map_edges')
      .select('last_refreshed_at, refresh_source', { count: 'exact' })
      .eq('retirement_status', 'live')
      .order('last_refreshed_at', { ascending: false })
      .limit(1)
  ]);
  if (capabilities.error || edges.error) {
    throw new Error(capabilities.error?.message ?? edges.error?.message ?? 'Atlas freshness could not be read');
  }
  // Provenance ledger is additive. If the migration is not applied yet, say so
  // rather than implying the map is current.
  const run = await admin.from('bob_atlas_refresh_runs')
    .select('source_commit, source_branch, refreshed_at, capability_total, edge_total, retired_total')
    .order('refreshed_at', { ascending: false })
    .limit(1);
  const latestRun = run.error ? null : run.data?.[0] ?? null;
  const sourceCommit = latestRun?.source_commit ?? null;
  const expected = String(expectedCommit ?? '').trim();
  let sourceParity = 'unknown';
  let note = '';
  if (run.error) {
    note = 'Atlas provenance ledger is unavailable (bob_atlas_refresh_runs not applied). Treat this map as unverified and confirm against repo_search before calling it current.';
  } else if (!sourceCommit) {
    note = 'Atlas rows exist but no refresh run recorded a source commit. Re-run scripts/atlas-refresh.js --apply to restore provenance.';
  } else if (!expected) {
    sourceParity = 'unverified';
    note = `Atlas was generated from commit ${sourceCommit}. Pass expected_commit (the commit you are reasoning about) to get a parity verdict instead of a bare commit id.`;
  } else if (expected === sourceCommit || sourceCommit.startsWith(expected) || expected.startsWith(sourceCommit)) {
    sourceParity = 'current';
    note = `Atlas matches commit ${sourceCommit}. Map and repository agree.`;
  } else {
    sourceParity = 'stale';
    note = `Atlas was generated from ${sourceCommit} but you asked about ${expected}. The map predates the code; re-run the refresh before trusting gap or blast-radius answers.`;
  }
  return {
    capability_count: capabilities.count ?? null,
    edge_count: edges.count ?? null,
    capability_last_refreshed_at: capabilities.data?.[0]?.last_refreshed_at ?? null,
    edge_last_refreshed_at: edges.data?.[0]?.last_refreshed_at ?? null,
    capability_refresh_source: capabilities.data?.[0]?.refresh_source ?? null,
    edge_refresh_source: edges.data?.[0]?.refresh_source ?? null,
    source_commit: sourceCommit,
    source_branch: latestRun?.source_branch ?? null,
    last_refresh_run_at: latestRun?.refreshed_at ?? null,
    expected_commit: expected || null,
    source_commit_recorded: Boolean(sourceCommit),
    source_parity: sourceParity,
    note
  };
}
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
    const role = String(profile?.role ?? '');
    if (!isOwner && !CAN_SQL.has(role)) return json({
      error: 'Forbidden: Atlas inspection requires an admin diagnostic role'
    }, 403);
    const body = await req.json();
    const action = String(body.action ?? 'capability_map').trim();
    const filter = String(body.filter ?? '').trim();
    const limit = Math.min(Math.max(Number(body.limit ?? 100), 1), 500);
    const offset = Math.min(Math.max(Number(body.offset ?? 0), 0), 100_000);
    const atlasStatus = await readAtlasStatus(admin, body.expected_commit);
    if (action === 'status') {
      return json({
        ok: true,
        action,
        atlas_status: atlasStatus
      });
    }
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
        atlas_status: atlasStatus,
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
        atlas_status: atlasStatus,
        results: data ?? []
      });
    }
    if (action === 'gap_report') {
      const { data, error } = await admin.rpc('bob_atlas_gap_report', {
        p_limit: limit,
        p_offset: offset,
        p_include_columns: body.include_columns === true,
        p_include_unknown_exercise: body.include_unknown_exercise === true
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
        atlas_status: atlasStatus,
        results: data ?? []
      });
    }
    if (action === 'expectation_report') {
      const { data, error } = await admin.rpc('bob_atlas_expectation_report', {
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
        atlas_status: atlasStatus,
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
        atlas_status: atlasStatus,
        flow_reach: flowRows,
        fk_reach: fkData ?? []
      });
    }
    return json({
      error: `Unknown action '${action}'. Valid: status, capability_map, terrain_edges, gap_report, expectation_report, blast_radius`
    }, 422);
  } catch (err) {
    console.error('[bob-query-atlas]', err);
    return json({
      error: 'Internal error'
    }, 500);
  }
});
