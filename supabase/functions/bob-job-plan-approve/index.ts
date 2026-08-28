/**
 * bob-job-plan-approve -- Layer 4.1: approve/reject a WHOLE bob_job_plans plan
 *
 * POST /functions/v1/bob-job-plan-approve
 * Body: { plan_id, action: 'approve' | 'reject', reasoning }
 *
 * THE GAP THIS CLOSES: #86 Phase 3 shipped bob_job_plans/bob_job_plan_steps,
 * bob-plan-step-advance, and apps/planner (the polling worker) -- but nothing
 * could ever move a plan's status to 'executing'. Without this function the
 * whole job-plan runner is inert: apps/planner only polls plans already in
 * ('executing', 'needs_review'), and bob-plan-step-advance refuses to touch
 * a plan that isn't already 'executing'. This is that missing approval step.
 *
 * Mirrors bob-proposal-approver's shape deliberately (same auth model, same
 * CAN_APPROVE roles, same "reasoning required" audit discipline) because a
 * plan approval is the SAME KIND of human decision as a single action
 * approval -- just at plan granularity. bob_job_plans.status='proposed' is
 * the plan-level equivalent of bob_agentic_actions.status='pending'.
 *
 * Governance:
 *   - Requires a valid JWT from an admin/master/grand_master in the plan's org
 *     (grand_master may cross orgs, same as bob-proposal-approver).
 *   - Only status='proposed' plans are decidable -- a 'draft' plan (Bob still
 *     assembling steps) cannot be approved; a plan already 'executing' or
 *     terminal cannot be re-decided.
 *   - Approve requires the plan to actually have at least one step, and every
 *     step to be in status='pending' (i.e. genuinely unstarted) -- refuses to
 *     "approve" a plan that has already partially run out-of-band, which
 *     would be a sign of a data problem, not a normal approval.
 *   - Approve sets status='executing' + approved_by=caller.id + approved_at.
 *     approved_by is what bob-plan-step-advance later stamps onto every
 *     bob_agentic_actions row this plan creates -- see that function's
 *     header comment for why this is a design discipline (real human
 *     attribution), not the enforcement of some proposer<>approver code
 *     guard (no such guard exists in bob-proposal-approver today).
 *   - Reject sets status='cancelled' + rejection_reason -- the worker never
 *     picks up a cancelled plan (it only polls 'executing'/'needs_review').
 *   - Reasoning is REQUIRED for both decisions (matches bob-proposal-approver's
 *     audit-trail convention).
 *   - This function does NOT advance any step itself -- apps/planner's next
 *     poll tick picks up the newly-'executing' plan and calls
 *     bob-plan-step-advance per step, exactly as designed.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
// Same approver roles as bob-proposal-approver -- a plan approval is the same
// kind of human decision, just at plan granularity.
const CAN_APPROVE = [
  'grand_master',
  'master',
  'admin'
];
const DECIDABLE = new Set([
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
    const planId = (body.plan_id ?? '').trim();
    const decision = body.action;
    const reasoning = (body.reasoning ?? '').trim();
    if (!planId) return json({
      error: 'plan_id is required'
    }, 400);
    if (decision !== 'approve' && decision !== 'reject') return json({
      error: "action must be 'approve' or 'reject'"
    }, 400);
    if (!reasoning) return json({
      error: 'reasoning is required'
    }, 400);
    const { data: plan, error: loadErr } = await admin.from('bob_job_plans').select('id, organization_id, status, goal, conversation_id').eq('id', planId).single();
    if (loadErr || !plan) return json({
      error: 'Plan not found'
    }, 404);
    // Org scope (grand_master may cross orgs).
    if (callerProfile.role !== 'grand_master' && plan.organization_id !== callerProfile.organization_id) {
      return json({
        error: 'Cannot decide plans for other organizations'
      }, 403);
    }
    if (!DECIDABLE.has(String(plan.status))) {
      return json({
        error: `Plan is not awaiting approval (status=${plan.status}); cannot ${decision}`
      }, 409);
    }
    const { data: steps, error: stepsErr } = await admin.from('bob_job_plan_steps').select('id, status, sequence, action_type').eq('plan_id', planId).order('sequence', {
      ascending: true
    });
    if (stepsErr) return json({
      error: 'Could not load plan steps',
      details: stepsErr.message
    }, 500);
    if (!steps || steps.length === 0) {
      return json({
        error: 'Plan has no steps -- nothing to approve. Bob must assemble at least one step before proposing the plan.'
      }, 422);
    }
    const now = new Date().toISOString();
    if (decision === 'approve') {
      // Refuse to "approve" a plan whose steps are not all genuinely unstarted --
      // a non-pending step here indicates a data problem (e.g. re-approval
      // after partial execution), not a normal first-time approval.
      const nonPending = steps.filter((s)=>s.status !== 'pending');
      if (nonPending.length > 0) {
        return json({
          error: `Plan has ${nonPending.length} step(s) not in 'pending' status -- refusing to approve. This plan may have already been actioned.`,
          non_pending_step_ids: nonPending.map((s)=>s.id)
        }, 409);
      }
      const { error: updErr } = await admin.from('bob_job_plans').update({
        status: 'executing',
        approved_by: caller.id,
        approved_at: now,
        updated_at: now
      }).eq('id', planId);
      if (updErr) return json({
        error: 'Could not record approval',
        details: updErr.message
      }, 500);
      // Notify Bob's conductor (plan-shaped payload, mutually exclusive with
      // action_id) so a message is posted back to the conversation, same
      // pattern as bob-proposal-approver's own fire-and-forget notifyConductor.
      notifyConductor({
        plan_id: planId,
        decision: 'plan_executing',
        goal: plan.goal,
        step_count: steps.length,
        conversation_id: plan.conversation_id,
        organization_id: plan.organization_id
      });
      return json({
        success: true,
        plan_id: planId,
        status: 'executing',
        step_count: steps.length,
        note: 'Plan approved. apps/planner will begin advancing steps in dependency order on its next poll cycle.'
      });
    }
    // ── reject ──
    const { error: updErr } = await admin.from('bob_job_plans').update({
      status: 'cancelled',
      updated_at: now
    }).eq('id', planId);
    if (updErr) return json({
      error: 'Could not record rejection',
      details: updErr.message
    }, 500);
    notifyConductor({
      plan_id: planId,
      decision: 'plan_cancelled',
      goal: plan.goal,
      rejection_reason: reasoning,
      conversation_id: plan.conversation_id,
      organization_id: plan.organization_id
    });
    return json({
      success: true,
      plan_id: planId,
      status: 'cancelled',
      note: 'Plan rejected. No steps will be run.'
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
/** Fire-and-forget: notify Bob's conductor of a plan-level bell decision.
 *  Mirrors bob-proposal-approver's own notifyConductor exactly, but sends
 *  the PLAN-shaped payload (plan_id, never action_id) that
 *  bob-notify-conductor's handlePlanDecision branch expects. */ function notifyConductor(payload) {
  if (!payload.conversation_id) return; // nothing to post back to
  const url = `${SUPABASE_URL}/functions/v1/bob-notify-conductor`;
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    },
    body: JSON.stringify(payload)
  }).catch((e)=>console.error('[bob-job-plan-approve] notifyConductor failed:', e));
}
