/**
 * bob-self-audit — Bob's introspection + independent-QA tool.
 *
 * Built after a live test surfaced a real dead-end: asked directly "show me
 * the raw resolve_geofence tool result you got for Champagne Gully", Bob had
 * no safe way to answer — he either would have dumped raw JSON (blocked by
 * the ABSOLUTE OUTPUT RULES) or fell back to a generic "I'm not sure how to
 * help with that" (the dispatchTool default-branch fallback). Bob could not
 * distinguish "I resolved it and the boundary got lost in transit" from "I
 * never actually called resolve_geofence and only narrated that I would" —
 * exactly the ACT WITH YOUR HANDS failure mode the persona already warns
 * against, but with no tool to verify it against.
 *
 * This gives Bob (and a human) a real, read-only, structured way to:
 *   1. trace_conversation — see the ACTUAL tool calls made in a conversation
 *      (tool, args, outcome, meta — including geofence objects), not a
 *      narrated recollection. Answers "did I actually call X" directly.
 *   2. audit_proposal — cross-check a specific bob_agentic_actions row's
 *      bob_reasoning text against its own proposed_payload for a known class
 *      of mismatch (reasoning claims a field was resolved/found but the
 *      payload doesn't carry it) — the exact Champagne Gully failure mode.
 *   3. check_schema_drift — compare a list of table/column names against the
 *      LIVE schema, catching the "stale card describes a retired table"
 *      failure class (the APP_AUDIT_2026-07 LocationsPage finding, #91).
 *
 * Governance: ADMIRAL ONLY (grand_master). This is a meta/debug capability
 * over Bob's own operation, not a normal user-facing chat tool — same rank
 * gate as repo_search. Read-only: never writes, never mutates a proposal.
 * Raw ids ARE returned here (unlike ordinary chat replies) because the caller
 * is by definition the admiral doing genuine diagnostic work — mirrors the
 * tier-based UUID-redaction carve-out already applied at the conductor layer.
 *
 * Body: { action: 'trace_conversation' | 'audit_proposal' | 'check_schema_drift' | 'write_self_assessment', ... }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_SELF_AUDIT = new Set([
  'grand_master'
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
// Fields inside a tool's `meta` that are worth surfacing verbatim in a trace
// (kept short-listed and explicit rather than dumping the whole object, so a
// trace stays readable even for a long conversation).
const META_FIELDS_OF_INTEREST = [
  'tool',
  'outcome',
  'query',
  'count',
  'action_id',
  'provisional',
  'resolved',
  'geofence',
  'confidence_tier',
  'error',
  'loop_step_count'
];
function pickMeta(md) {
  if (!md || typeof md !== 'object') return {};
  const out = {};
  for (const k of META_FIELDS_OF_INTEREST){
    if (md[k] !== undefined) out[k] = md[k];
  }
  if (Array.isArray(md.loop_steps)) out.loop_steps = md.loop_steps;
  return out;
}
const REASONING_PAYLOAD_CHECKS = [
  {
    claim_keywords: [
      'boundary',
      'parcel',
      'polygon'
    ],
    payload_path: [
      'zone',
      'boundary'
    ],
    label: 'boundary geometry'
  },
  {
    claim_keywords: [
      'night limit',
      'nightly_limit',
      'consecutive'
    ],
    payload_path: [
      'zone',
      'nightly_limit_consecutive'
    ],
    label: 'nightly_limit_consecutive'
  },
  {
    claim_keywords: [
      'scv required',
      'scv_required'
    ],
    payload_path: [
      'zone',
      'scv_required'
    ],
    label: 'scv_required'
  }
];
function getPath(obj, path) {
  let cur = obj;
  for (const key of path){
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}
function isEmpty(v) {
  return v === null || v === undefined || typeof v === 'string' && v.trim() === '';
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
    const { data: profile } = await admin.from('user_profiles').select('id, role').eq('id', user.id).single();
    if (!profile || !CAN_SELF_AUDIT.has(String(profile.role))) {
      return json({
        error: 'Forbidden: admiral (grand_master) only — self-audit is a diagnostic capability, not a general chat tool'
      }, 403);
    }
    const body = await req.json().catch(()=>({}));
    const action = String(body.action ?? '').trim();
    switch(action){
      case 'trace_conversation':
        {
          const conversationId = String(body.conversation_id ?? '').trim();
          if (!conversationId) return json({
            error: 'conversation_id is required'
          }, 400);
          const limit = Math.min(Math.max(Number(body.limit ?? 40), 1), 200);
          const { data, error } = await admin.from('bob_messages').select('role, content, metadata, created_at').eq('conversation_id', conversationId).order('created_at', {
            ascending: true
          }).limit(limit);
          if (error) throw new Error(error.message);
          const rows = data ?? [];
          const turns = rows.map((r)=>{
            const md = r.metadata && typeof r.metadata === 'object' ? r.metadata : null;
            return {
              role: r.role,
              created_at: r.created_at,
              content_preview: String(r.content ?? '').slice(0, 300),
              planned_tool: md?.planned_tool ?? md?.tool ?? null,
              route_selected: md?.route_selected ?? null,
              reasoning: md?.reasoning ?? null,
              confidence: md?.confidence ?? null,
              tool_meta: pickMeta(md)
            };
          });
          // Direct answer to "did tool X actually run": a flat list of every
          // distinct tool name that appears anywhere in this trace (top-level
          // planned_tool AND any tool named inside a loop_steps array).
          const toolsInvoked = new Set();
          for (const t of turns){
            if (typeof t.planned_tool === 'string') toolsInvoked.add(t.planned_tool);
            const steps = t.tool_meta?.loop_steps;
            if (Array.isArray(steps)) {
              for (const s of steps){
                if (typeof s.tool === 'string') toolsInvoked.add(s.tool);
              }
            }
          }
          return json({
            success: true,
            conversation_id: conversationId,
            turn_count: turns.length,
            tools_invoked: [
              ...toolsInvoked
            ],
            turns
          });
        }
      case 'audit_proposal':
        {
          const actionId = String(body.action_id ?? '').trim();
          if (!actionId) return json({
            error: 'action_id is required'
          }, 400);
          const { data: row, error } = await admin.from('bob_agentic_actions').select('id, action_type, status, proposed_payload, amended_payload, bob_reasoning, context_summary, created_at, conversation_id').eq('id', actionId).maybeSingle();
          if (error) throw new Error(error.message);
          if (!row) return json({
            error: 'action_not_found'
          }, 404);
          const reasoningText = String(row.bob_reasoning ?? '').toLowerCase();
          const payload = row.amended_payload ?? row.proposed_payload;
          const mismatches = [];
          for (const check of REASONING_PAYLOAD_CHECKS){
            const claimed = check.claim_keywords.some((kw)=>reasoningText.includes(kw));
            if (!claimed) continue;
            const value = getPath(payload, check.payload_path);
            if (isEmpty(value)) {
              mismatches.push({
                claim: `reasoning mentions "${check.label}"`,
                expected_field: check.payload_path.join('.'),
                found_empty: true
              });
            }
          }
          return json({
            success: true,
            action_id: actionId,
            action_type: row.action_type,
            status: row.status,
            conversation_id: row.conversation_id,
            bob_reasoning: row.bob_reasoning,
            proposed_payload: payload,
            mismatches,
            verdict: mismatches.length ? 'REASONING/PAYLOAD MISMATCH — the stated reasoning claims a field was resolved that the actual payload does not carry. Do not trust the reasoning text alone; re-verify against the real payload before relying on this proposal.' : 'No known mismatch pattern detected between reasoning and payload (heuristic check only — absence of a flagged mismatch is not proof of correctness).'
          });
        }
      case 'check_schema_drift':
        {
          const tables = Array.isArray(body.tables) ? body.tables.map((t)=>String(t).trim()).filter(Boolean) : [];
          if (!tables.length) return json({
            error: 'tables (array of table names to check) is required'
          }, 400);
          const { data, error } = await admin.from('information_schema.tables').select('table_name').eq('table_schema', 'public').in('table_name', tables);
          if (error) throw new Error(error.message);
          const existing = new Set((data ?? []).map((r)=>r.table_name));
          const missing = tables.filter((t)=>!existing.has(t));
          return json({
            success: true,
            checked: tables,
            existing: [
              ...existing
            ],
            missing,
            verdict: missing.length ? `${missing.length} table(s) referenced do not exist in the live schema — any knowledge card, catalogue description, or reasoning that references them is STALE and should be corrected or superseded.` : 'All referenced tables exist in the live schema.'
          });
        }
      case 'write_self_assessment':
        {
          // Validate required fields
          const VALID_AREAS = new Set([
            'chore',
            'interaction',
            'communication'
          ]);
          const VALID_VALENCES = new Set([
            'reward',
            'correction'
          ]);
          const area = String(body.area ?? '').trim();
          const valence = String(body.valence ?? '').trim();
          const what = String(body.what ?? '').trim();
          const errors = [];
          if (!area) {
            errors.push("'area' is required");
          } else if (!VALID_AREAS.has(area)) {
            errors.push(`'area' must be one of: chore, interaction, communication (got '${area}')`);
          }
          if (!valence) {
            errors.push("'valence' is required");
          } else if (!VALID_VALENCES.has(valence)) {
            errors.push(`'valence' must be one of: reward, correction (got '${valence}')`);
          }
          if (!what) {
            errors.push("'what' is required and must be a non-empty string");
          }
          if (errors.length) {
            return json({
              error: 'Validation failed',
              details: errors
            }, 400);
          }
          // ROUTING (Don ruling !1373, reaffirmed 2026-08-14): a self-assessment
          // is Bob's MEMORY, so it is written to his OWN free diary
          // (bob_self_memory, graduated free-write in 0355/!1374) -- NOT to
          // bob_conduct_log. MEMORY != GROWTH: bob_conduct_log is the HUMAN
          // three-part sign-off GROWTH record (the readiness evidence that feeds
          // earnedReadiness); Bob never writes a self-scored row there, or he
          // would be scoring his own growth (the self-promotion vector
          // earnedReadiness + doctrine 4b forbid). The two stores are separate
          // things and must not share a store or a signal
          // (BOB_MEMORY_IS_HIS_OWN.md §3, §4.2).
          //
          // The four-part conduct shape (area/valence/what/reason/method_lesson/
          // redo_ref) has no columns in the free-text diary, so it is composed
          // VERBATIM into memory_text -- a faithful memory, nothing lost. memory_kind
          // maps to the diary's own vocab: a correction is a 'lesson', a reward is a
          // 'reflection'.
          const memoryKind = valence === 'correction' ? 'lesson' : 'reflection';
          const parts = [
            `[self-assessment | area: ${area} | valence: ${valence}]`,
            what
          ];
          if (body.reason) parts.push(`Reason: ${String(body.reason).trim()}`);
          if (body.method_lesson) parts.push(`Method lesson: ${String(body.method_lesson).trim()}`);
          if (body.redo_ref) parts.push(`Redo: ${String(body.redo_ref).trim()}`);
          if (body.source_ref) parts.push(`Source: ${String(body.source_ref).trim()}`);
          const memoryText = parts.join('\n');
          const { data: inserted, error: insertErr } = await admin.from('bob_self_memory').insert({
            memory_text: memoryText,
            memory_kind: memoryKind
          }).select('id').single();
          if (insertErr) throw new Error(insertErr.message);
          return json({
            success: true,
            memory_id: inserted.id,
            memory_kind: memoryKind,
            message: "Self-assessment written to Bob's own memory. His diary is his own -- direct-write, no approval gate, same as any crew member's memory."
          });
        }
      default:
        return json({
          error: `Unknown action '${action}'`,
          valid: [
            'trace_conversation',
            'audit_proposal',
            'check_schema_drift',
            'write_self_assessment'
          ]
        }, 422);
    }
  } catch (err) {
    console.error('[bob-self-audit] error:', err);
    return json({
      error: 'Self-audit failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
