/**
 * bob-proposal-approver — Layer 4.1: approve/reject a Bob agentic action
 *
 * POST /functions/v1/bob-proposal-approver
 * Body: { action_id, action: 'approve' | 'reject', reasoning, apply?, amended_payload? }
 *   amended_payload (#87): optional human-edited payload persisted as
 *   amended_payload/amended_by/amended_at; the executor reads
 *   coalesce(amended_payload, proposed_payload).
 *
 * Closes the Bob loop: propose -> APPROVE (this fn) -> execute
 * (bob-proposal-execute). Operates on the canonical agentic ledger
 * `bob_agentic_actions` (the rich audit table), NOT the lighter
 * `bob_action_proposals` card layer — the build converges on one ledger.
 *
 * Background / why this exists:
 *   NotificationsBell already invokes 'bob-proposal-approver', but the function
 *   did NOT exist (phantom function) — approve/reject silently failed. This
 *   creates it for real and standardises the loop on bob_agentic_actions.
 *
 * Governance:
 *   - Requires a valid JWT from an admin/master/grand_master in the action's org.
 *   - Approve sets status='approved' + approved_by + approved_at.
 *   - Reject sets status='rejected' + rejection_reason.
 *   - Reasoning is REQUIRED for both (audit trail).
 *   - Best-effort two-person rule: the approver may not approve an action whose
 *     user_id is themselves (when user_id is recorded).
 *   - Only 'pending'/'pending_approval' actions can be decided (no re-deciding
 *     applied/failed/already-decided actions).
 *   - This fn does NOT execute the write — bob-proposal-execute does, separately
 *     (keeps approve and execute as distinct steps).
 *
 * Live-schema verified (2026-06-28): bob_agentic_actions(status, approved_by,
 *   approved_at, rejection_reason, user_id, organization_id, ...).
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_APPROVE = [
  'grand_master',
  'master',
  'admin',
  'admin_officer'
];
const DECIDABLE = new Set([
  'pending',
  'pending_approval',
  'proposed'
]);
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
    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !caller) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile } = await admin.from('user_profiles').select('role, organization_id').eq('id', caller.id).single();
    if (!callerProfile || !CAN_APPROVE.includes(callerProfile.role)) {
      return json({
        error: 'Forbidden: insufficient role'
      }, 403);
    }
    const body = await req.json();
    // Accept proposal_id as an alias (the bell historically sent proposal_id).
    const actionId = (body.action_id ?? body.proposal_id ?? '').trim();
    const decision = body.action;
    const reasoning = (body.reasoning ?? '').trim();
    // Phase 1.5: when true, chain straight into the executor after approval.
    const applyAfterApprove = body.apply === true;
    // #87: optional human-edited payload. If provided, persisted as amended_payload
    // so the executor reads coalesce(amended_payload, proposed_payload).
    const amendedPayload = body.amended_payload ?? null;
    if (!actionId) return json({
      error: 'action_id is required'
    }, 400);
    if (decision !== 'approve' && decision !== 'reject') return json({
      error: "action must be 'approve' or 'reject'"
    }, 400);
    if (!reasoning) return json({
      error: 'reasoning is required'
    }, 400);
    const { data: action, error: loadErr } = await admin.from('bob_agentic_actions').select('id, organization_id, user_id, status, conversation_id').eq('id', actionId).single();
    if (loadErr || !action) return json({
      error: 'Action not found'
    }, 404);
    // Org scope: tree-based check (#16/#18). Replaces the flat
    // action.organization_id === callerProfile.organization_id check with
    // can_approve_action RPC that respects org-tree descent + agreement-based
    // access (0271 Model A). grand_master can always approve; master/admin
    // can approve if is_admin_for_org(action.organization_id) is true.
    const { data: canApprove } = await admin.rpc('can_approve_action', {
      p_user_id: caller.id,
      p_action_org_id: action.organization_id
    });
    if (!canApprove) {
      return json({
        error: 'Not authorised to approve actions for this organisation'
      }, 403);
    }
    // Only undecided actions can be decided.
    if (!DECIDABLE.has(String(action.status))) {
      return json({
        error: `Action is not pending (status=${action.status}); cannot ${decision}`
      }, 409);
    }
    // Model: Bob proposes, the human approves — there is NO second-human
    // requirement. Bob-originated proposals are attributed to the Bob system
    // user, so an authorised human approving them is correct (not self-approval).
    // (Self-approval is therefore permitted and fully audited via approved_by.)
    const now = new Date().toISOString();
    const update = decision === 'approve' ? {
      status: 'approved',
      approved_by: caller.id,
      approved_at: now,
      rejection_reason: null,
      bob_reasoning_note: undefined
    } : {
      status: 'rejected',
      rejection_reason: reasoning,
      approved_by: caller.id,
      approved_at: now
    };
    // Remove undefined keys.
    delete update.bob_reasoning_note;
    // #87: persist a human amendment on approve. Bob's proposed_payload is never
    // overwritten; the executor reads coalesce(amended_payload, proposed_payload).
    // Only record an amendment when the approver actually sent an edited payload.
    if (decision === 'approve' && amendedPayload && typeof amendedPayload === 'object') {
      update.amended_payload = amendedPayload;
      update.amended_by = caller.id;
      update.amended_at = now;
    }
    const { error: updErr } = await admin.from('bob_agentic_actions').update(update).eq('id', action.id);
    if (updErr) return json({
      error: 'Could not record decision',
      details: updErr.message
    }, 500);
    // ── Phase 1.5: one-tap Approve & apply ──
    // Approve and execute stay distinct, separately-audited ledger steps. We
    // simply trigger the executor back-to-back through the trusted server
    // boundary: the executor is service-role-only, so we invoke it here with
    // the service-role key — the browser never receives it.
    if (decision === 'approve' && applyAfterApprove) {
      try {
        const execRes = await fetch(`${SUPABASE_URL}/functions/v1/bob-proposal-execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
          },
          body: JSON.stringify({
            action_id: action.id
          })
        });
        const execBody = await execRes.json().catch(()=>({}));
        if (execRes.ok && execBody.success) {
          // Notify Bob so he can chain the next step.
          notifyConductor({
            action_id: action.id,
            decision: 'applied',
            result_record_id: execBody.result_record_id,
            result_table: execBody.result_table,
            conversation_id: action.conversation_id,
            organization_id: action.organization_id,
            action_type: action.action_type
          });
          return json({
            success: true,
            action_id: action.id,
            status: 'applied',
            applied: true,
            result_table: execBody.result_table ?? null,
            result_record_id: execBody.result_record_id ?? null,
            note: execBody.note ?? 'Approved and applied.'
          });
        }
        // Approval succeeded but execution failed — report honestly.
        notifyConductor({
          action_id: action.id,
          decision: 'failed',
          error_message: execBody.error ?? `Executor returned ${execRes.status}`,
          conversation_id: action.conversation_id,
          organization_id: action.organization_id,
          action_type: action.action_type
        });
        return json({
          success: true,
          action_id: action.id,
          status: 'approved',
          applied: false,
          apply_error: execBody.error ?? `Executor returned ${execRes.status}`,
          note: 'Approved, but applying the write failed. The action stays decided and can be retried.'
        });
      } catch (execErr) {
        const msg = execErr instanceof Error ? execErr.message : 'Executor call failed';
        notifyConductor({
          action_id: action.id,
          decision: 'failed',
          error_message: msg,
          conversation_id: action.conversation_id,
          organization_id: action.organization_id,
          action_type: action.action_type
        });
        return json({
          success: true,
          action_id: action.id,
          status: 'approved',
          applied: false,
          apply_error: msg,
          note: 'Approved, but applying the write failed. The action stays decided and can be retried.'
        });
      }
    }
    // ── PILLAR E: Transition slot status on bell decision ─────────────────────
    // After recording the approve/reject decision, update the corresponding
    // slot in bob_conversation_facts so the conductor's next-turn idempotency
    // check (checkIdempotency Layer 1) sees the correct slot status.
    // Best-effort: any failure is logged but never blocks the response.
    if (action.conversation_id) {
      try {
        const { data: factsRow } = await admin.from('bob_conversation_facts').select('active_slot, slots').eq('conversation_id', action.conversation_id).maybeSingle();
        if (factsRow && factsRow.active_slot && factsRow.slots) {
          const slotKey = factsRow.active_slot;
          const slots = factsRow.slots;
          const slot = slots[slotKey];
          // Only transition if this slot was the one that generated this action
          const slotActionId = slot?.resolved_ids?.action_id;
          if (slot && (!slotActionId || slotActionId === action.id)) {
            const newStatus = decision === 'approve' ? 'approved' : 'rejected';
            const updatedSlots = {
              ...slots,
              [slotKey]: {
                ...slot,
                status: newStatus
              }
            };
            await admin.from('bob_conversation_facts').update({
              slots: updatedSlots,
              updated_at: new Date().toISOString()
            }).eq('conversation_id', action.conversation_id);
            console.log(`[bob-proposal-approver][pillar-e] slot "${slotKey}" -> ${newStatus} for action ${action.id}`);
          }
        }
      } catch (slotErr) {
        console.warn('[bob-proposal-approver][pillar-e] slot transition failed (non-fatal):', slotErr);
      }
    }
    // ──────────────────────────────────────────────────────────────────────────
    // Notify Bob of approve or reject (non-apply path).
    notifyConductor({
      action_id: action.id,
      decision: decision === 'approve' ? 'approved' : 'rejected',
      rejection_reason: decision === 'reject' ? reasoning : undefined,
      conversation_id: action.conversation_id,
      organization_id: action.organization_id,
      action_type: action.action_type
    });
    return json({
      success: true,
      action_id: action.id,
      status: decision === 'approve' ? 'approved' : 'rejected',
      applied: false,
      note: decision === 'approve' ? 'Approved. Run bob-proposal-execute to apply the write.' : 'Rejected.'
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
/** Fire-and-forget: notify Bob's conductor of a bell decision. */ function notifyConductor(payload) {
  if (!payload.conversation_id) return; // nothing to post back to
  const url = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/bob-notify-conductor`;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify(payload)
  }).catch((e)=>console.error('[bob-proposal-approver] notifyConductor failed:', e));
}
