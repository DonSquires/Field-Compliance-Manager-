/**
 * bob-plan-step-advance -- SERVICE-ROLE ONLY: advance ONE bob_job_plan_steps row
 *
 * POST /functions/v1/bob-plan-step-advance
 * Body: { step_id }
 *
 * The narrow bridge between the job-plan runner (apps/planner, a persistent
 * worker on the hPanel VPS) and the EXISTING, UNCHANGED governed-write chain
 * (bob_agentic_actions -> bob-proposal-execute). This function does NOT
 * introduce a new write path -- it performs exactly the same three moves a
 * human-driven chat turn performs (propose -> approve -> execute), just
 * without a live human JWT in the loop, because the human already approved
 * the WHOLE PLAN once (bob_job_plans.approved_by) and this row is simply the
 * next itemised, already-reviewed step of that plan.
 *
 * ============================================================
 * WHY THIS IS SAFE (read before ever touching SUPPORTED_ACTIONS below)
 * ============================================================
 * The existing bob-propose-* producers and bob-proposal-approver both require
 * a live human JWT (auth.getUser()) -- a background worker cannot hold one.
 * Rather than weakening those functions to accept a service-role bypass
 * (which would let ANY service-role caller propose+approve in one step, a
 * much bigger blast radius), this function is DELIBERATELY narrow:
 *   1. It only inserts a bob_agentic_actions row shaped EXACTLY like the
 *      corresponding propose_* producer would (same action_type, same
 *      proposed_payload shape) -- copy the payload contract from the
 *      matching bob-propose-* function when adding a new plan action_type.
 *   2. The row's user_id is ALWAYS Bob's system user
 *      (00000000-0000-0000-0000-00000000b0b0) -- Bob remains the proposer,
 *      exactly as in the chat path.
 *   3. approved_by is stamped as bob_job_plans.approved_by -- the REAL HUMAN
 *      who reviewed and approved the itemised plan -- NEVER Bob's own id and
 *      NEVER a service-account id, so the audit trail always shows a real
 *      accountable human. CORRECTION (verified against live code
 *      2026-07-12): bob-proposal-approver does NOT enforce a proposer<>
 *      approver check -- its own comment states self-approval of a
 *      Bob-originated action is permitted by design ("there is NO
 *      second-human requirement"). This function's approved_by choice is
 *      therefore a DESIGN DISCIPLINE this bridge chooses to follow (real
 *      human attribution, never Bob's own id), not the preservation of an
 *      existing code-level guard -- no such guard exists. Bob being
 *      grand_master (0185) does not change this discipline either way.
 *   4. The actual write STILL goes through bob-proposal-execute, called
 *      exactly as bob-proposal-approver's apply-after-approve path already
 *      does today -- same guards, same rollback-on-failure, same audit
 *      columns (result_table/result_record_id/applied_at/error_message).
 *   5. A plan can ONLY be advanced while bob_job_plans.status = 'executing'
 *      (i.e. a human has already approved it) -- there is no path from
 *      'draft'/'proposed' straight to a write.
 *
 * If you are tempted to add a new action_type here as a shortcut instead of
 * building its bob-propose-* producer contract properly, stop -- the payload
 * shape MUST match what a human-reviewed propose_* call would have produced,
 * because that is the whole basis of the human's up-front consent.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const BOB_SYSTEM_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret'
};
// Every action_type a plan step may carry MUST already be a real, reviewed
// bob-proposal-execute action_type -- this function creates the SAME shape
// of bob_agentic_actions row a human-driven propose_* call would create; it
// does not add new write behaviour. Kept as an explicit allow-list (mirrors
// bob-proposal-execute's own SUPPORTED_ACTIONS pattern) so a plan can never
// carry an action this bridge has not been deliberately wired for.
//
// Each entry below was re-verified line-by-line against the LIVE
// bob-proposal-execute SUPPORTED_ACTIONS set on 2026-07-12 (do not trust
// memory -- re-check supabase/functions/bob-proposal-execute/index.ts before
// adding a new entry here). The executor's full live set as of that check:
//   create_service_agreement_draft, set_org_jurisdiction, set_site_risk_level,
//   create_client_root_org, create_client_org, create_client_site,
//   create_patrol_route_assignment, create_patrol_route_service_area,
//   create_freedom_camping_zone, create_zone_patrol_stop.
// This bridge only enables the subset actually needed by the LINZ zone
// backfill plan today -- extend deliberately, not speculatively, and only
// after confirming the new entry is still in the executor's live set.
const SUPPORTED_PLAN_ACTIONS = new Set([
  'create_freedom_camping_zone',
  'create_zone_patrol_stop',
  'create_client_site',
  'create_patrol_route_assignment'
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
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  const authHeader = req.headers.get('Authorization') ?? '';
  const cronHeader = req.headers.get('x-cron-secret') ?? '';
  const isServiceRole = SUPABASE_SERVICE_ROLE_KEY && authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  const isCron = CRON_SECRET && cronHeader === CRON_SECRET;
  if (!isServiceRole && !isCron) {
    return json({
      error: 'Unauthorized (service-role or x-cron-secret required -- this endpoint is for the plan-runner worker only, never a browser/user call)'
    }, 401);
  }
  try {
    const body = await req.json();
    const stepId = String(body.step_id ?? '').trim();
    if (!stepId) return json({
      error: 'step_id is required'
    }, 400);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: step, error: stepErr } = await admin.from('bob_job_plan_steps').select('id, plan_id, sequence, depends_on_step_id, action_type, proposed_payload, status, bob_agentic_action_id').eq('id', stepId).maybeSingle();
    if (stepErr || !step) return json({
      error: 'Step not found'
    }, 404);
    const failStep = async (msg)=>{
      await admin.from('bob_job_plan_steps').update({
        status: 'failed',
        error_message: msg,
        updated_at: new Date().toISOString()
      }).eq('id', stepId);
      return json({
        error: msg
      }, 422);
    };
    if (step.status === 'applied') {
      return json({
        success: true,
        step_id: stepId,
        already_applied: true,
        bob_agentic_action_id: step.bob_agentic_action_id
      });
    }
    if (step.status !== 'ready' && step.status !== 'pending') {
      return json({
        error: `Step is not advanceable (status='${step.status}')`
      }, 409);
    }
    if (!SUPPORTED_PLAN_ACTIONS.has(step.action_type)) {
      return await failStep(`action_type '${step.action_type}' is not in SUPPORTED_PLAN_ACTIONS -- wire it deliberately before using it in a plan`);
    }
    // Dependency guard: a step with an unmet dependency may not advance, even
    // if the worker mistakenly asked for it (belt-and-braces -- the worker's
    // own query should already filter on this).
    if (step.depends_on_step_id) {
      const { data: dep } = await admin.from('bob_job_plan_steps').select('status').eq('id', step.depends_on_step_id).maybeSingle();
      if (!dep || dep.status !== 'applied') {
        return json({
          error: `Dependency step ${step.depends_on_step_id} is not yet applied (status='${dep?.status ?? 'missing'}')`
        }, 409);
      }
    }
    // Load the parent plan; confirm it is actually executing (approved) and
    // capture the REAL HUMAN approver -- this is the identity stamped as the
    // approver of the resulting action, never Bob, never a service account.
    const { data: plan, error: planErr } = await admin.from('bob_job_plans').select('id, organization_id, status, approved_by').eq('id', step.plan_id).maybeSingle();
    if (planErr || !plan) return await failStep('Parent plan not found');
    if (plan.status !== 'executing' && plan.status !== 'needs_review') {
      return json({
        error: `Plan is not executing (status='${plan.status}') -- a human must approve the plan before any step can advance`
      }, 409);
    }
    if (!plan.approved_by) {
      return await failStep('Plan has no approved_by human -- refusing to advance a step with no real approver to attribute the write to');
    }
    // 1. Create the bob_agentic_actions row -- SAME SHAPE a human-driven
    // propose_* call would have created (action_type + proposed_payload),
    // Bob as proposer, PENDING (never inserted pre-approved).
    const contextSummary = typeof step.proposed_payload?.context_summary === 'string' ? step.proposed_payload.context_summary : `Plan step ${step.sequence}: ${step.action_type}`;
    // Pillar E (#273): fallback idempotency key for non-conversational / cron
    // paths. No active_slot exists, so derive from action_type + entity name
    // per the 0267 / HEURISTIC_AGENT_ARCHITECTURE.md section 4 contract:
    //   action_type::makeSlotKey(kind, entity_name)
    // The entity name source depends on the action_type's payload shape:
    //   - create_client_site:              proposed_payload.name (top-level)
    //   - create_freedom_camping_zone:     proposed_payload.zone.name (nested)
    //   - create_zone_patrol_stop:         no name; use zone_id (the stop identity)
    //   - create_patrol_route_assignment:  no name; use patrol_route_id + site_id
    // Each shape was verified against the corresponding producer's payload contract.
    const entityName = typeof step.proposed_payload?.name === 'string' ? step.proposed_payload.name.trim() : typeof step.proposed_payload?.zone?.name === 'string' ? step.proposed_payload.zone.name.trim() : typeof step.proposed_payload?.zone_id === 'string' ? step.proposed_payload.zone_id.trim() : typeof step.proposed_payload?.patrol_route_id === 'string' ? `${step.proposed_payload.patrol_route_id}${typeof step.proposed_payload?.site_id === 'string' ? '_' + step.proposed_payload.site_id : ''}`.trim() : '';
    const slugifiedName = entityName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unnamed';
    const planIdempotencyKey = `${step.action_type}::plan_${slugifiedName}`;
    const { data: createdAction, error: insErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: plan.organization_id,
      user_id: BOB_SYSTEM_USER_ID,
      action_type: step.action_type,
      proposed_payload: {
        ...step.proposed_payload,
        plan_id: plan.id,
        plan_step_id: step.id
      },
      status: 'pending',
      bob_reasoning: `Job-plan step ${step.sequence} of plan ${plan.id} (approved by ${plan.approved_by}).`,
      context_summary: contextSummary,
      idempotency_key: planIdempotencyKey
    }).select('id').single();
    if (insErr || !createdAction) return await failStep(`Could not create the governed action: ${insErr?.message ?? 'unknown error'}`);
    // 2. Cascade-approve: stamped as the PLAN'S HUMAN APPROVER, never Bob,
    // never this worker's own identity. This is the one deliberate departure
    // from the chat path (which requires a fresh human tap per action) -- it
    // is justified ONLY because that same human already reviewed this EXACT
    // itemised step as part of approving the whole plan.
    const { error: approveErr } = await admin.from('bob_agentic_actions').update({
      status: 'approved',
      approved_by: plan.approved_by,
      approved_at: new Date().toISOString()
    }).eq('id', createdAction.id);
    if (approveErr) return await failStep(`Could not cascade-approve the governed action: ${approveErr.message}`);
    // 3. Execute -- the EXISTING, UNCHANGED governed executor. Same guards,
    // same rollback-on-failure, same audit trail as every other write path.
    const execRes = await fetch(`${SUPABASE_URL}/functions/v1/bob-proposal-execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        action_id: createdAction.id
      })
    });
    const execBody = await execRes.json().catch(()=>({}));
    if (!execRes.ok || execBody.error) {
      const msg = String(execBody.error ?? `bob-proposal-execute returned ${execRes.status}`);
      await admin.from('bob_job_plan_steps').update({
        status: 'needs_review',
        bob_agentic_action_id: createdAction.id,
        error_message: msg,
        updated_at: new Date().toISOString()
      }).eq('id', stepId);
      // Surface the plan itself as needing review too, WITHOUT touching any
      // sibling step's status -- independent steps may still complete.
      await admin.from('bob_job_plans').update({
        status: 'needs_review',
        updated_at: new Date().toISOString()
      }).eq('id', plan.id);
      return json({
        success: false,
        step_id: stepId,
        bob_agentic_action_id: createdAction.id,
        error: msg
      }, 422);
    }
    await admin.from('bob_job_plan_steps').update({
      status: 'applied',
      bob_agentic_action_id: createdAction.id,
      error_message: null,
      updated_at: new Date().toISOString()
    }).eq('id', stepId);
    return json({
      success: true,
      step_id: stepId,
      bob_agentic_action_id: createdAction.id,
      result_table: execBody.result_table ?? null,
      result_record_id: execBody.result_record_id ?? null
    });
  } catch (err) {
    console.error('[bob-plan-step-advance] error:', err);
    return json({
      error: 'Plan step advance failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
