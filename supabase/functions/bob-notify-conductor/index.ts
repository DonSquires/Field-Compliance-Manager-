/**
 * bob-notify-conductor — push notification to Bob after a bell decision
 *
 * Called by bob-proposal-approver after approve/apply/reject, and by
 * bob-job-plan-approve after a WHOLE PLAN is approved/rejected (#86 Phase 3
 * follow-up), so Bob can act on the outcome immediately rather than waiting
 * to be asked.
 *
 * Bob receives the decision, checks what happened, and if the workflow
 * has a next step he proposes it and posts a message back to the
 * conversation so the user sees it in the chat.
 *
 * POST /functions/v1/bob-notify-conductor
 *
 * SINGLE-ACTION shape (unchanged, from bob-proposal-approver):
 * Body: {
 *   action_id: string,
 *   decision: 'approved' | 'applied' | 'rejected' | 'failed',
 *   result_record_id?: string,
 *   result_table?: string,
 *   rejection_reason?: string,
 *   error_message?: string,
 *   conversation_id?: string,
 *   organization_id?: string,
 *   action_type?: string,
 *   payload_summary?: { name?: string },
 * }
 *
 * PLAN shape (new): mutually exclusive with action_id -- a payload carries
 * EITHER action_id OR plan_id, never both. This mirrors the exact same
 * decision vocabulary at plan granularity, matching bob_job_plans.status
 * values instead of bob_agentic_actions.status values.
 * Body: {
 *   plan_id: string,
 *   decision: 'plan_executing' | 'plan_cancelled',
 *   goal?: string,
 *   step_count?: number,
 *   conversation_id?: string,
 *   organization_id?: string,
 *   rejection_reason?: string,
 * }
 *
 * Auth: service-role only (called server-side from bob-proposal-approver /
 * bob-job-plan-approve).
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BOB_INFERENCE_URL = Deno.env.get('BOB_INFERENCE_URL') ?? '';
const BOB_INFERENCE_SECRET = Deno.env.get('BOB_INFERENCE_SECRET') ?? '';
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
  // Service-role only — this is an internal server-to-server call.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.includes(SUPABASE_SERVICE_ROLE_KEY) && !authHeader.startsWith('Bearer ')) {
    return json({
      error: 'Unauthorized'
    }, 401);
  }
  try {
    const body = await req.json().catch(()=>({}));
    // PLAN-shaped payload (mutually exclusive with action_id): a plan_id +
    // one of the plan_* decisions. Handled entirely separately from the
    // single-action path below since the wording, audience, and shape differ.
    if (body.plan_id && (body.decision === 'plan_executing' || body.decision === 'plan_cancelled')) {
      return await handlePlanDecision(body);
    }
    const { action_id, decision, conversation_id, organization_id, action_type, payload_summary } = body;
    if (!action_id || !decision) return json({
      error: 'action_id and decision are required (or plan_id with a plan_* decision)'
    }, 400);
    if (!conversation_id) {
      // No conversation to post back to — log and exit cleanly.
      console.log(`[bob-notify-conductor] no conversation_id for action ${action_id}, skipping`);
      return json({
        ok: true,
        skipped: true,
        reason: 'no conversation_id'
      });
    }
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    // Build a concise system message for Bob to reason over.
    const name = payload_summary?.name ?? action_type ?? 'proposal';
    let systemMessage = '';
    if (decision === 'applied') {
      systemMessage = `[BELL UPDATE] The proposal "${name}" (action_id: ${action_id}, type: ${action_type}) has been APPROVED AND APPLIED. result_record_id: ${body.result_record_id ?? 'unknown'}, result_table: ${body.result_table ?? 'unknown'}. The record now exists live. If this is part of a multi-step workflow, propose the next dependent step now without asking the user to confirm again. Tell the user what was applied and what you are doing next.`;
    } else if (decision === 'approved') {
      systemMessage = `[BELL UPDATE] The proposal "${name}" (action_id: ${action_id}, type: ${action_type}) has been APPROVED but not yet applied. The write will execute shortly. If there are dependent steps that require the record to exist first, wait for the applied notification before proposing them.`;
    } else if (decision === 'rejected') {
      systemMessage = `[BELL UPDATE] The proposal "${name}" (action_id: ${action_id}, type: ${action_type}) was REJECTED. Rejection reason: ${body.rejection_reason ?? 'no reason given'}. Explain to the user what was rejected and why, then ask the single most important question to fix it and re-propose.`;
    } else if (decision === 'failed') {
      systemMessage = `[BELL UPDATE] The proposal "${name}" (action_id: ${action_id}, type: ${action_type}) FAILED during execution. Error: ${body.error_message ?? 'unknown error'}. Classify the error, explain what happened in plain language, and propose a fix.`;
    } else {
      return json({
        ok: true,
        skipped: true,
        reason: `unknown decision: ${decision}`
      });
    }
    // Ask Bob's brain to reason over the bell update and produce a reply.
    if (!BOB_INFERENCE_URL || !BOB_INFERENCE_SECRET) {
      console.warn('[bob-notify-conductor] BOB_INFERENCE_URL/SECRET not set, cannot notify brain');
      return json({
        ok: true,
        skipped: true,
        reason: 'inference not configured'
      });
    }
    const inferenceRes = await fetch(BOB_INFERENCE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bob-Secret': BOB_INFERENCE_SECRET
      },
      body: JSON.stringify({
        action: 'plan',
        message: systemMessage,
        tools: [],
        persona: '[PERSONA] You are Bob. A bell decision just came in. Reason over it and produce a short, direct plain-language message for the user. If the workflow has a next step, state what you are proposing next. Be brief — one or two sentences.',
        history: []
      })
    });
    let bobReply = '';
    if (inferenceRes.ok) {
      const inferenceData = await inferenceRes.json().catch(()=>({}));
      bobReply = String(inferenceData.reply ?? '').trim();
    }
    if (!bobReply) {
      // Fallback: generate a plain reply without the brain.
      if (decision === 'applied') bobReply = `✅ **${name}** has been applied. Moving to the next step.`;
      else if (decision === 'rejected') bobReply = `❌ **${name}** was rejected: ${body.rejection_reason ?? 'no reason given'}. Let me know how you want to proceed.`;
      else if (decision === 'failed') bobReply = `⚠️ **${name}** failed to apply: ${body.error_message ?? 'unknown error'}. I will investigate.`;
      else bobReply = `**${name}** status updated to ${decision}.`;
    }
    // Post Bob's reply back to the conversation.
    const { error: insertErr } = await admin.from('bob_messages').insert({
      organization_id: organization_id ?? null,
      conversation_id,
      role: 'assistant',
      content: bobReply,
      metadata: {
        intent: 'bell_notification',
        action_id,
        decision,
        action_type,
        result_record_id: body.result_record_id ?? null,
        route_selected: 'answer'
      }
    });
    if (insertErr) {
      console.error(`[bob-notify-conductor] failed to post reply: ${insertErr.message}`);
      return json({
        ok: false,
        error: insertErr.message
      }, 500);
    }
    // Bump conversation updated_at so it surfaces in history.
    await admin.from('bob_conversations').update({
      updated_at: new Date().toISOString()
    }).eq('id', conversation_id);
    console.log(`[bob-notify-conductor] posted bell reply for action ${action_id} decision=${decision} conversation=${conversation_id}`);
    return json({
      ok: true,
      decision,
      action_id,
      reply_posted: true
    });
  } catch (err) {
    console.error('[bob-notify-conductor] error:', err);
    return json({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
/**
 * handlePlanDecision — plan-level counterpart to the single-action path
 * above. Called by bob-job-plan-approve after a WHOLE bob_job_plans plan is
 * approved (status='executing') or rejected (status='cancelled'). Posts one
 * plain-language message back to the conversation — unlike the single-action
 * path, this does NOT ask Bob's brain to reason about a "next step", because
 * a plan approval's next step is always the SAME thing (apps/planner begins
 * advancing steps automatically) — no branching decision for Bob to make
 * here, so a static, honest message is more reliable than an inference call.
 */ async function handlePlanDecision(body) {
  const { plan_id, decision, conversation_id, organization_id, goal, step_count, rejection_reason } = body;
  if (!conversation_id) {
    console.log(`[bob-notify-conductor] no conversation_id for plan ${plan_id}, skipping`);
    return json({
      ok: true,
      skipped: true,
      reason: 'no conversation_id'
    });
  }
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const label = goal ? `"${goal}"` : 'the plan';
  const steps = typeof step_count === 'number' ? ` (${step_count} step${step_count === 1 ? '' : 's'})` : '';
  let bobReply;
  if (decision === 'plan_executing') {
    bobReply = `✅ Plan approved — ${label}${steps}. I'll advance each step automatically, in order, and update you here as they complete. No need to approve them individually.`;
  } else {
    bobReply = `❌ Plan rejected — ${label}${rejection_reason ? `: ${rejection_reason}` : ''}. Nothing was run. Let me know how you'd like to proceed.`;
  }
  const { error: insertErr } = await admin.from('bob_messages').insert({
    organization_id: organization_id ?? null,
    conversation_id,
    role: 'assistant',
    content: bobReply,
    metadata: {
      intent: 'bell_notification',
      plan_id,
      decision,
      route_selected: 'answer'
    }
  });
  if (insertErr) {
    console.error(`[bob-notify-conductor] failed to post plan reply: ${insertErr.message}`);
    return json({
      ok: false,
      error: insertErr.message
    }, 500);
  }
  await admin.from('bob_conversations').update({
    updated_at: new Date().toISOString()
  }).eq('id', conversation_id);
  console.log(`[bob-notify-conductor] posted plan reply for plan ${plan_id} decision=${decision} conversation=${conversation_id}`);
  return json({
    ok: true,
    decision,
    plan_id,
    reply_posted: true
  });
}
