/**
 * bob-self-memory-approve -- OWNER-ONLY: approve/reject a Bob self-memory
 *
 * POST /functions/v1/bob-self-memory-approve
 * Body: { memory_id, decision: 'approve' | 'reject', owner_note? }
 *
 * STRUCTURALLY ISOLATED from the operational approval path. This function:
 *   - Does NOT use can_approve_action, CAN_APPROVE, or any role-tree logic.
 *   - Does NOT touch bob_agentic_actions.
 *   - Does NOT chain to bob-proposal-execute or bob-plan-step-advance.
 *   - Has NO grand_master short-circuit, no agreement clauses.
 *
 * Auth model (owner-only, fail-closed):
 *   1. Requires a valid JWT (not service-role, not cron -- a real human).
 *   2. Caller's email must be in OWNER_EMAILS.
 *   3. Caller must NOT be Bob's system user.
 *   4. The DB-level RPC (approve_bob_self_memory) enforces the same checks
 *      via is_platform_owner() + trigger guard -- defense in depth.
 *
 * After approval, optionally notifies Bob's conductor so Bob can surface
 * the owner's note in chat (notification only, not approval coupling).
 *
 * Red-team fix for MR !1120 bypass vectors.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { OWNER_EMAILS } from '../_shared/auth.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const BOB_SYSTEM_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const json = (body, status = 200)=>new Response(JSON.stringify(body), {
    status,
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
    // ── 1. Authenticate the caller (must be a real human JWT) ──
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
    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !caller) return json({
      error: 'Unauthorized'
    }, 401);
    // ── 2. Owner-only gate (app-level, mirrors DB-level is_platform_owner) ──
    const callerEmail = (caller.email ?? '').toLowerCase().trim();
    if (!OWNER_EMAILS.has(callerEmail)) {
      return json({
        error: 'Forbidden: only the platform owner can approve Bob self-memories'
      }, 403);
    }
    // ── 3. Bob cannot approve his own memories ──
    if (caller.id === BOB_SYSTEM_USER_ID) {
      return json({
        error: 'Forbidden: Bob cannot approve his own memories'
      }, 403);
    }
    // ── 4. Parse and validate the request body ──
    const body = await req.json();
    const memoryId = (body.memory_id ?? '').trim();
    const decision = (body.decision ?? '').trim();
    const ownerNote = (body.owner_note ?? '').trim() || null;
    if (!memoryId) return json({
      error: 'memory_id is required'
    }, 400);
    if (decision !== 'approve' && decision !== 'reject') {
      return json({
        error: "decision must be 'approve' or 'reject'"
      }, 400);
    }
    // ── 5. Call the DB-level RPC (defense in depth -- it re-checks owner) ──
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    // Use the caller-scoped client so auth.uid() resolves correctly in the RPC.
    const { error: rpcErr } = await callerClient.rpc('approve_bob_self_memory', {
      p_memory_id: memoryId,
      p_decision: decision,
      p_owner_note: ownerNote
    });
    if (rpcErr) {
      // Surface the DB-level error message (it contains the fail-closed reason).
      return json({
        error: rpcErr.message
      }, 422);
    }
    // ── 6. Best-effort: notify Bob in chat about the decision ──
    // Fire-and-forget: load the memory to get context, then post to conductor.
    try {
      const { data: memory } = await admin.from('bob_self_memory').select('id, memory_text, memory_kind, status').eq('id', memoryId).single();
      if (memory) {
        const decisionLabel = decision === 'approve' ? 'approved' : 'rejected';
        const noteClause = ownerNote ? ` Owner note: "${ownerNote}"` : '';
        const summary = `Your ${memory.memory_kind} memory has been ${decisionLabel} by the owner.${noteClause}`;
        // Enqueue a notification so it shows in the bell as resolved.
        await admin.rpc('enqueue_notification', {
          p_organization_id: await resolveOwnerOrgId(admin),
          p_category: 'bob_self_memory',
          p_title: `Bob self-memory ${decisionLabel}`,
          p_body: summary,
          p_severity: 'info',
          p_recipient_user_id: null,
          p_recipient_role: 'grand_master',
          p_link_page: 'bob_self_memory',
          p_link_payload: {
            memory_id: memoryId,
            decision: decisionLabel
          },
          p_dedup_key: `bob_self_memory_decision:${memoryId}`
        });
      }
    } catch (notifyErr) {
      // Non-fatal: the approval succeeded, notification is best-effort.
      console.warn('[bob-self-memory-approve] notification failed (non-fatal):', notifyErr);
    }
    return json({
      success: true,
      memory_id: memoryId,
      decision,
      status: decision === 'approve' ? 'approved' : 'rejected'
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    console.error('[bob-self-memory-approve] error:', err);
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
/** Resolve the platform owner org id (Iron Eagle). */ // deno-lint-ignore no-explicit-any
async function resolveOwnerOrgId(admin) {
  const { data } = await admin.from('organizations').select('id').eq('organization_type', 'owner').order('created_at').limit(1).maybeSingle();
  const row = data;
  return row?.id ?? '56710c19-d604-4767-9ad8-9c5863b4ceb7';
}
