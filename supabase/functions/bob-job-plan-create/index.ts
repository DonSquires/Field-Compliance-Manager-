/**
 * bob-job-plan-create -- governed producer: assemble a multi-step bob_job_plans
 * plan into the approval bell (#86 Phase 3, the missing PRODUCER).
 *
 * POST /functions/v1/bob-job-plan-create
 * Body: {
 *   goal: string,
 *   organization_id?: string,           // defaults to caller's home org
 *   conversation_id?: string,
 *   steps: [
 *     {
 *       action_type: string,             // must be in SUPPORTED_PLAN_ACTIONS
 *       proposed_payload: object,        // same shape a human-driven propose_*
 *                                        // call for this action_type would use
 *       depends_on_step_index?: number,  // 0-based index into THIS steps array;
 *                                        // the step at that index must come
 *                                        // before this one (parent-first)
 *     }, ...
 *   ],
 *   reasoning?: string,
 * }
 *
 * THE GAP THIS CLOSES: 0184 (bob_job_plans/bob_job_plan_steps), !850
 * (bob-plan-step-advance, apps/planner), and !852 (bob-job-plan-approve) built
 * the entire EXECUTION engine for a durable multi-step plan -- but nothing
 * could actually CREATE one. Bob had no tool to turn "back-fill all 9 LINZ
 * zone geofences" into a real bob_job_plans row; the runner has been inert end
 * to end because it has no producer. This is that producer.
 *
 * WHY A NEW FUNCTION, NOT bob-plan-step-advance OR A bob-propose-* PRODUCER:
 * this creates the PLAN WRAPPER (bob_job_plans + bob_job_plan_steps), not a
 * bob_agentic_actions row directly -- those are only created later, one at a
 * time, by bob-plan-step-advance as each step becomes ready and is cascaded
 * through the human who approved the WHOLE PLAN (bob-job-plan-approve). This
 * function's OWN output (the plan + its steps) is itself the thing a human
 * reviews and approves in one action via bob-job-plan-approve -- mirroring
 * exactly how a bob-propose-* producer's OWN output (one pending
 * bob_agentic_actions row) is reviewed and approved via bob-proposal-approver.
 *
 * GOVERNANCE (matches every bob-propose-* producer's shape):
 *   - Requires a live human JWT (auth.getUser()) -- Bob acts through the
 *     user's own session in chat, same as every other propose_* tool.
 *   - CAN_PROPOSE roles: grand_master, master, admin (same as
 *     bob-propose-zone-patrol-stop and its siblings).
 *   - Creates the plan in status='proposed' -- NOT 'draft' and NOT
 *     'executing'. A human must still call bob-job-plan-approve before any
 *     step can ever be advanced; this function alone never authorises a
 *     write.
 *   - Every step's action_type MUST already be in SUPPORTED_PLAN_ACTIONS
 *     (the SAME allow-list bob-plan-step-advance enforces) -- re-verified
 *     here at creation time too, so an unsupported action_type is rejected
 *     immediately rather than silently sitting in the plan until the worker
 *     eventually fails it.
 *   - depends_on_step_index is validated to only ever point EARLIER in the
 *     SAME steps array (never forward, never to itself) -- a plan can only
 *     express a parent-first DAG, never a cycle.
 *   - Every step is created in status='pending' (never 'ready', never
 *     'applied') -- exactly matching bob-job-plan-approve's own "refuses to
 *     approve a plan whose steps are not all pending" guard, so a plan this
 *     function creates is always immediately approvable.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_PROPOSE = [
  'grand_master',
  'master',
  'admin'
];
// MUST stay identical to bob-plan-step-advance's SUPPORTED_PLAN_ACTIONS --
// re-verify against that file's live content before editing either list.
// Re-verified against the live bob-proposal-execute SUPPORTED_ACTIONS set
// and bob-plan-step-advance's own allow-list on 2026-07-12.
const SUPPORTED_PLAN_ACTIONS = new Set([
  'create_freedom_camping_zone',
  'create_zone_patrol_stop',
  'create_client_site',
  'create_patrol_route_assignment'
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
    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !caller) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile } = await admin.from('user_profiles').select('role, organization_id, authorized_organization_ids').eq('id', caller.id).single();
    if (!callerProfile || !CAN_PROPOSE.includes(callerProfile.role)) {
      return json({
        error: 'Forbidden: insufficient role'
      }, 403);
    }
    const body = await req.json();
    const goal = (body.goal ?? '').trim();
    if (!goal) return json({
      error: 'goal is required'
    }, 400);
    const rawSteps = Array.isArray(body.steps) ? body.steps : [];
    if (rawSteps.length === 0) return json({
      error: 'steps must be a non-empty array -- assemble at least one step before creating a plan'
    }, 400);
    if (rawSteps.length > 50) return json({
      error: 'A plan may not exceed 50 steps in one create call -- split into multiple plans'
    }, 400);
    // Validate every step's action_type BEFORE creating anything -- an
    // all-or-nothing check so we never leave a half-valid plan behind.
    for(let i = 0; i < rawSteps.length; i++){
      const actionType = String(rawSteps[i]?.action_type ?? '').trim();
      if (!actionType) return json({
        error: `steps[${i}].action_type is required`
      }, 400);
      if (!SUPPORTED_PLAN_ACTIONS.has(actionType)) {
        return json({
          error: `steps[${i}].action_type '${actionType}' is not supported by the job-plan runner. Supported: ${[
            ...SUPPORTED_PLAN_ACTIONS
          ].join(', ')}`
        }, 422);
      }
      const payload = rawSteps[i]?.proposed_payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return json({
          error: `steps[${i}].proposed_payload is required and must be an object`
        }, 400);
      }
      const dep = rawSteps[i]?.depends_on_step_index;
      if (dep !== undefined && dep !== null) {
        if (!Number.isInteger(dep) || dep < 0 || dep >= i) {
          return json({
            error: `steps[${i}].depends_on_step_index must be an integer pointing to an EARLIER step in the same array (0..${i - 1}); got ${dep}`
          }, 400);
        }
      }
    }
    // Org resolution: explicit organization_id (authorised against the caller's
    // tree, same pattern as every propose_* producer) or the caller's home org.
    const requestedOrgId = (body.organization_id ?? '').trim();
    const orgId = requestedOrgId || String(callerProfile.organization_id);
    if (requestedOrgId && requestedOrgId !== String(callerProfile.organization_id)) {
      const authorizedOrgs = callerProfile.authorized_organization_ids ?? [];
      let allowed = authorizedOrgs.includes(requestedOrgId) || callerProfile.role === 'grand_master';
      if (!allowed) {
        const { data: mtree } = await callerClient.rpc('is_master_for_org', {
          p_org_id: requestedOrgId
        });
        allowed = mtree === true;
      }
      if (!allowed) return json({
        error: 'Not authorised for the requested organization_id'
      }, 403);
    }
    const reasoning = typeof body.reasoning === 'string' && body.reasoning.trim() ? body.reasoning.trim() : `Bob assembled a ${rawSteps.length}-step plan: ${goal}`;
    // 1. Create the plan wrapper -- status='proposed', NEVER 'executing'. Only
    // bob-job-plan-approve may ever move it to 'executing', and only after a
    // human reviews this exact itemised step list.
    const { data: plan, error: planErr } = await admin.from('bob_job_plans').insert({
      organization_id: orgId,
      created_by: caller.id,
      conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
      goal,
      reasoning,
      status: 'proposed'
    }).select('id').single();
    if (planErr || !plan) return json({
      error: 'Could not create the plan',
      details: planErr?.message
    }, 500);
    // 2. Create every step in one pass, all status='pending'. Insert in
    // sequence order and keep each created row's id so a later step's
    // depends_on_step_index can resolve to the REAL bob_job_plan_steps.id.
    const createdStepIds = [];
    for(let i = 0; i < rawSteps.length; i++){
      const dep = rawSteps[i].depends_on_step_index;
      const dependsOnStepId = dep !== undefined && dep !== null ? createdStepIds[dep] : null;
      const { data: step, error: stepErr } = await admin.from('bob_job_plan_steps').insert({
        plan_id: plan.id,
        sequence: i + 1,
        depends_on_step_id: dependsOnStepId,
        action_type: rawSteps[i].action_type,
        proposed_payload: rawSteps[i].proposed_payload,
        status: 'pending'
      }).select('id').single();
      if (stepErr || !step) {
        // Partial failure: clean up the plan (cascades to any steps already
        // inserted) rather than leaving an incomplete, unapprovable plan behind.
        await admin.from('bob_job_plans').delete().eq('id', plan.id);
        return json({
          error: `Could not create step ${i + 1}, plan rolled back`,
          details: stepErr?.message
        }, 500);
      }
      createdStepIds.push(step.id);
    }
    return json({
      success: true,
      plan_id: plan.id,
      step_count: createdStepIds.length,
      note: `Plan assembled (${createdStepIds.length} step${createdStepIds.length === 1 ? '' : 's'}), awaiting your approval. Review it and approve the WHOLE plan once via bob-job-plan-approve -- individual steps are never approved separately.`
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
