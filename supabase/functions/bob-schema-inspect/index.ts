/**
 * bob-schema-inspect — read-only schema discovery for Bob copilot planning
 *
 * Purpose:
 *   Give Bob safe read-only visibility of public schema structure so it can
 *   map imports, explain missing data, compare documents to tables, and produce
 *   better dry-runs without guessing column names.
 *
 * Auth:
 *   Supabase JWT required. Caller must be admin/master/grand_master.
 *
 * Body:
 * {
 *   "tables": ["client_sites", "organizations"], // optional
 *   "include_relationships": true,
 *   "include_constraints": true
 * }
 *
 * Guardrails:
 *   - public schema only
 *   - no row data
 *   - no arbitrary SQL
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_INSPECT = new Set([
  'grand_master',
  'master',
  'admin'
]);
const MAX_TABLES = 60;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function safeTableName(value) {
  const raw = String(value ?? '').trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw)) return null;
  return raw;
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
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
    if (!profile || !CAN_INSPECT.has(String(profile.role))) {
      return json({
        error: 'Forbidden: admin/master/grand_master required'
      }, 403);
    }
    const body = await req.json().catch(()=>({}));
    const requestedTables = Array.isArray(body.tables) ? body.tables.map(safeTableName).filter(Boolean) : [];
    if (requestedTables.length > MAX_TABLES) return json({
      error: `Too many tables requested (max ${MAX_TABLES})`
    }, 400);
    // Read schema via a SECURITY DEFINER RPC. PostgREST does not expose
    // information_schema directly, so querying it through the JS client fails;
    // the RPC reads it server-side and returns structural metadata only.
    // include_fks=false skips the expensive FK/constraint joins so the ALL-tables
    // call (table_names=null) does not hit the edge statement timeout. We only
    // compute FKs when the caller actually wants relationships.
    const wantsFks = body.include_relationships !== false;
    const { data: rpcData, error: rpcErr } = await admin.rpc('bob_inspect_schema', {
      table_names: requestedTables.length ? requestedTables : null,
      include_fks: wantsFks
    });
    if (rpcErr) throw new Error(rpcErr.message);
    const result = rpcData ?? {};
    return json({
      success: true,
      schema: result.schema ?? 'public',
      table_count: result.table_count ?? result.tables?.length ?? 0,
      tables: result.tables ?? [],
      audit: {
        actor_id: user.id,
        role: profile.role,
        row_data_returned: false
      }
    });
  } catch (err) {
    console.error('[bob-schema-inspect] error:', err);
    return json({
      error: 'Schema inspection failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
