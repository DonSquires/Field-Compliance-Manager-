/**
 * bob-import-memory — Bob's learned import/data-entry mappings (self-learning)
 *
 * Bob learns as he goes: when a user APPROVES how a document maps to a table
 * (target table + source-field -> live-column map + dedupe keys), that resolution
 * is saved here, keyed by a normalized document SIGNATURE (header fingerprint +
 * doc kind). The next time a similar document is uploaded, Bob RECALLs this as a
 * warm-start proposal instead of guessing from scratch.
 *
 * Storage: reuses the live `bob_learning_memory` table (no new migration):
 *   (id, organization_id, user_id?, memory_kind, content, source, created_at)
 *   - memory_kind = 'import_mapping'
 *   - content     = JSON string of the mapping record (see MappingRecord)
 *   - source      = originating file name / route
 * Org-scoped. This function is the ONLY writer of these memories (the generic
 * executor keeps bob_learning_memory read-only).
 *
 * Auth: service-role/cron OR a JWT admin/master/grand_master when human_invoked.
 *
 * Actions:
 *   { action:'recall', signature, doc_kind? }        -> best matching mapping(s)
 *   { action:'learn',  mapping:{ signature, doc_kind, target_table, column_map,
 *                                dedupe_keys?, confidence? }, source? }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret'
};
const CAN_LEARN = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer'
]);
const MEMORY_KIND = 'import_mapping';
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
// Normalize a set of header/field names into a stable signature: lowercase,
// alnum-collapsed, de-duplicated, sorted, joined. Generalises across vendors so
// the same shape of file matches regardless of column order or filename.
function fingerprint(headers) {
  const arr = Array.isArray(headers) ? headers : String(headers ?? '').split(',');
  const norm = arr.map((h)=>String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')).filter(Boolean);
  return [
    ...new Set(norm)
  ].sort().join('|');
}
function parseContent(content) {
  try {
    return JSON.parse(String(content ?? ''));
  } catch  {
    return null;
  }
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
    const cronHeader = req.headers.get('x-cron-secret') ?? '';
    const isServiceRole = SUPABASE_SERVICE_ROLE_KEY && authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
    const isCron = CRON_SECRET && cronHeader === CRON_SECRET;
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json();
    // Resolve actor + org.
    let actorId = null;
    let orgId = body.organization_id ?? null;
    if (!isServiceRole && !isCron) {
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
      const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
      if (!profile || !CAN_LEARN.has(String(profile.role))) return json({
        error: 'Forbidden: admin/master/grand_master required'
      }, 403);
      actorId = user.id;
      orgId = orgId ?? profile.organization_id;
    }
    if (!orgId) return json({
      error: 'organization_id is required'
    }, 400);
    const action = body.action ?? 'recall';
    // ── RECALL ────────────────────────────────────────────────────────────────
    if (action === 'recall') {
      const sig = body.signature ? String(body.signature) : fingerprint(body.headers);
      if (!sig) return json({
        success: true,
        match: null,
        note: 'No signature/headers provided.'
      });
      // Pull recent import_mapping memories for the org, match by signature
      // (exact first, then doc_kind fallback). content is a JSON string.
      const { data, error } = await admin.from('bob_learning_memory').select('id, content, source, created_at').eq('organization_id', orgId).eq('memory_kind', MEMORY_KIND).order('created_at', {
        ascending: false
      }).limit(200);
      if (error) return json({
        error: error.message
      }, 500);
      const records = (data ?? []).map((r)=>({
          id: r.id,
          rec: parseContent(r.content),
          created_at: r.created_at
        })).filter((x)=>x.rec);
      const exact = records.find((x)=>x.rec.signature === sig);
      const byKind = !exact && body.doc_kind ? records.find((x)=>x.rec.doc_kind && x.rec.doc_kind === body.doc_kind) : undefined;
      const match = exact ?? byKind ?? null;
      return json({
        success: true,
        signature: sig,
        match: match ? {
          memory_id: match.id,
          ...match.rec,
          match_type: exact ? 'exact' : 'doc_kind'
        } : null,
        note: match ? 'Warm-start mapping recalled. Still requires dry-run + approval.' : 'No learned mapping yet for this document shape.'
      });
    }
    // ── LEARN ─────────────────────────────────────────────────────────────────
    if (action === 'learn') {
      if (!isServiceRole && !isCron && body.human_invoked !== true) {
        return json({
          error: 'human_invoked_required',
          message: 'Learning is saved only on explicit approval.'
        }, 403);
      }
      const m = body.mapping;
      if (!m || !m.target_table) return json({
        error: 'mapping.target_table is required'
      }, 400);
      const sig = m.signature || fingerprint(body.headers);
      if (!sig) return json({
        error: 'mapping.signature (or headers) is required'
      }, 400);
      // Upsert-by-signature: if an existing memory has the same signature, bump
      // times_used + last_used_at and refresh the mapping; else insert new.
      const { data: existing } = await admin.from('bob_learning_memory').select('id, content').eq('organization_id', orgId).eq('memory_kind', MEMORY_KIND).order('created_at', {
        ascending: false
      }).limit(200);
      const prior = (existing ?? []).map((r)=>({
          id: r.id,
          rec: parseContent(r.content)
        })).find((x)=>x.rec?.signature === sig);
      const now = new Date().toISOString();
      const record = {
        signature: sig,
        doc_kind: m.doc_kind,
        target_table: m.target_table,
        executor: m.executor,
        column_map: m.column_map ?? {},
        dedupe_keys: m.dedupe_keys ?? [],
        confidence: typeof m.confidence === 'number' ? m.confidence : 1,
        times_used: (prior?.rec?.times_used ?? 0) + 1,
        last_used_at: now,
        created_by: actorId
      };
      if (prior) {
        const { error } = await admin.from('bob_learning_memory').update({
          content: JSON.stringify(record),
          source: body.source ?? null
        }).eq('id', prior.id);
        if (error) return json({
          error: error.message
        }, 500);
        return json({
          success: true,
          learned: true,
          memory_id: prior.id,
          updated: true,
          record
        });
      }
      const { data: created, error } = await admin.from('bob_learning_memory').insert({
        organization_id: orgId,
        user_id: actorId,
        memory_kind: MEMORY_KIND,
        content: JSON.stringify(record),
        source: body.source ?? null
      }).select('id').single();
      if (error) return json({
        error: error.message
      }, 500);
      return json({
        success: true,
        learned: true,
        memory_id: created.id,
        updated: false,
        record
      });
    }
    return json({
      error: `Unknown action '${action}' (use recall or learn)`
    }, 400);
  } catch (err) {
    console.error('[bob-import-memory] error:', err);
    return json({
      error: 'Import memory failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
