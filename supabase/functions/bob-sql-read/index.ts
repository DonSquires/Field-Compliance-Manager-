/**
 * bob-sql-read — Read-only SQL for Bob (diagnostic power tool)
 *
 * Admiral (grand_master): unrestricted via bob_execute_read_query (security
 * definer, service_role, RLS bypassed). Uses admin client.
 *
 * Captain (master) / Commander (admin): org-scoped via
 * bob_execute_read_query_scoped (security invoker, RLS applies). Uses
 * callerClient (anon key + user JWT) so the DB enforces org-scoping
 * through existing RLS policies. No application-level org filter needed.
 * Epic #185 E4 (#189).
 *
 * DEFENCE IN DEPTH:
 *   1. Auth: JWT required; caller must be admiral, captain, or commander.
 *   2. Edge-side validation: single statement, must start SELECT/WITH, keyword
 *      denylist for writes/DDL.
 *   3. DB-side: both RPC variants run READ ONLY, re-check the same rules,
 *      row-cap + statement-timeout. The engine physically cannot write.
 *   4. Non-admiral: security invoker means RLS policies apply at the DB layer.
 *
 * DATA-FLOW NOTE: results return to the conductor and may be reasoned over by
 * OpenAI (gpt-4o-mini). Prefer AGGREGATES/COUNTS (no row-level PII). Row-level is
 * capped and only when explicitly requested.
 *
 * Body: { query: string, row_limit?: number, timeout_ms?: number }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
// Admiral (grand_master) — unrestricted (security definer, RLS bypassed).
// Captain (master) + Commander (admin) — org-scoped via RLS (security invoker).
const CAN_SQL = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer'
]);
const ADMIRAL = new Set([
  'grand_master'
]);
// Denylist for write/DDL statement keywords. Uses statement-level anchoring
// (preceded by start-of-string or whitespace; followed by whitespace, semicolon,
// or end-of-string) so column names/aliases like do_count, set_name,
// comment_text, reset_flag are NOT rejected. Removed: do, set, reset, comment,
// merge, call — too common in identifiers. The DB-side READ ONLY transaction
// (bob_execute_read_query) is the real enforcement layer against writes.
const WRITE_DDL = /(^|\s)(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|analyze|reindex|refresh)(\s|;|$)/i;
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
    if (!profile || !CAN_SQL.has(String(profile.role))) {
      return json({
        error: 'Forbidden: admiral, captain, or commander only'
      }, 403);
    }
    const isAdmiral = ADMIRAL.has(String(profile.role));
    const _orgId = isAdmiral ? null : String(profile.organization_id ?? '') || null;
    const body = await req.json().catch(()=>({}));
    let q = String(body.query ?? '').trim();
    if (!q) return json({
      error: 'query is required'
    }, 400);
    q = q.replace(/;\s*$/, '');
    if (q.includes(';')) return json({
      error: 'Only a single statement is allowed'
    }, 422);
    const lowered = q.toLowerCase();
    if (!lowered.startsWith('select') && !lowered.startsWith('with')) {
      return json({
        error: 'Only SELECT / WITH...SELECT queries are allowed'
      }, 422);
    }
    if (WRITE_DDL.test(q)) return json({
      error: 'Write / DDL / session keywords are not permitted'
    }, 422);
    const rowLimit = typeof body.row_limit === 'number' ? body.row_limit : 50;
    const timeoutMs = typeof body.timeout_ms === 'number' ? body.timeout_ms : 5000;
    // Admiral: service-role client -> bob_execute_read_query (security definer, RLS bypassed).
    // Non-admiral: caller client (anon key + user JWT) -> bob_execute_read_query_scoped
    // (security invoker, RLS applies at the DB layer — no app-level org filter needed).
    const rpcClient = isAdmiral ? admin : callerClient;
    const rpcName = isAdmiral ? 'bob_execute_read_query' : 'bob_execute_read_query_scoped';
    const { data, error } = await rpcClient.rpc(rpcName, {
      query_text: q,
      row_limit: rowLimit,
      timeout_ms: timeoutMs
    });
    if (error) return json({
      ok: false,
      error: error.message
    }, 502);
    const res = data ?? {};
    if (res.ok === false) return json({
      ok: false,
      error: res.error ?? 'query failed'
    }, 422);
    const rows = Array.isArray(res.rows) ? res.rows : [];
    return json({
      ok: true,
      row_count: rows.length,
      rows,
      row_limit: res.row_limit ?? rowLimit,
      audit: {
        actor_id: user.id,
        role: profile.role,
        org_scoped: !isAdmiral
      }
    });
  } catch (err) {
    console.error('[bob-sql-read] error:', err);
    return json({
      ok: false,
      error: 'SQL read failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
