'use strict';

const { buildPlannerMessages } = require('./planPrompt');
const { normalizeDecision, parsePlanContent, salvageReplyFromTruncatedJson } = require('./planParse');
const { autoRepairArgs, runDeterministicChecks, scrubReply, verifyDecision, isCodeRequest, DRAFT_REQUEST_RE } = require('./verify');

const DELEGABLE_TOOL_RE = /^(query_records|client_site_compare|scv_lookup|schema_inspect|retrieve_knowledge|understand_documents|web_research|sql_read|repo_search|query_atlas|read_issues|resolve_address|resolve_geofence|self_audit|assess_system)$/;

// Drafting and synthesis passes are output-heavy: the thinking is mostly done
// (research gathered, decisions taken), so spend the turn budget on writing.
function authorEffort(input) {
  const lastUser = [...(input.history || [])].reverse().find((h) => h && h.role === 'user');
  const isDraft = (text) => DRAFT_REQUEST_RE.test(text) && !isCodeRequest(text);
  const drafting = isDraft(input.message) || (lastUser && isDraft(String(lastUser.content || '')));
  const synthesising = Boolean(input.taskState && (Array.isArray(input.taskState.subagent_results) && input.taskState.subagent_results.length || input.taskState.last_tool_result));
  return drafting || synthesising || input.tools.length === 0 ? 'low' : undefined;
}

function readBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const tools = Array.isArray(b.tools) ? b.tools.filter((t) => t && typeof t.tool === 'string') : [];
  return {
    message: String(b.message ?? '').trim(),
    attachment: b.attachment && typeof b.attachment === 'object' ? b.attachment : null,
    sessionAttachments: Array.isArray(b.session_attachments) ? b.session_attachments.filter((a) => a && typeof a.name === 'string').slice(0, 20) : [],
    tools,
    persona: typeof b.persona === 'string' ? b.persona : '',
    platformContext: typeof b.platform_context === 'string' ? b.platform_context : '',
    knowledge: typeof b.knowledge === 'string' ? b.knowledge : '',
    history: Array.isArray(b.history) ? b.history : [],
    pending: b.pending && typeof b.pending === 'object' ? b.pending : null,
    taskState: b.task_state && typeof b.task_state === 'object' ? b.task_state : null,
    conversationFacts: b.conversation_facts && typeof b.conversation_facts === 'object' ? b.conversation_facts : null,
    enabledModuleProfiles: Array.isArray(b.enabled_module_profiles) ? b.enabled_module_profiles : null,
    memoryContext: b.memory_context && typeof b.memory_context === 'object' ? b.memory_context : null,
    completedWork: Array.isArray(b.completed_work) ? b.completed_work.filter((w) => w && typeof w === 'object').slice(0, 5) : [],
    allowDelegation: b.allow_delegation !== false,
    verify: b.verify !== false,
    requestId: typeof b.request_id === 'string' ? b.request_id : null,
    // Milliseconds the caller can still wait for this turn (a reasoning-loop step late in the Edge
    // budget). Shortens the turn budget and, when tight, skips the in-house planner.
    deadlineMs: Number.isFinite(Number(b.deadline_ms)) && Number(b.deadline_ms) > 0 ? Math.floor(Number(b.deadline_ms)) : null,
  };
}

function delegableTools(tools) {
  return tools.map((t) => t.tool).filter((name) => DELEGABLE_TOOL_RE.test(name));
}

function builderSearchQuery(message) {
  const text = String(message || '');
  if (/\bbuilder\b/i.test(text)) return 'BuilderControlRoomPage|BobPanel|builder';
  const paths = text.match(/\b(?:apps|services|supabase|scripts|test)\/[\w./-]+/g);
  if (paths && paths.length) return [...new Set(paths)].slice(0, 4).join('|');
  const stop = new Set(['please', 'build', 'create', 'make', 'develop', 'design', 'redesign', 'generate', 'implement', 'change', 'improve', 'system', 'using', 'with', 'from', 'this', 'that', 'more']);
  const terms = [...new Set(text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || [])].filter((term) => !stop.has(term)).slice(0, 4);
  return terms.join('|') || 'BuilderControlRoomPage|BobPanel';
}

function builderRequestText(input) {
  const current = String(input.message || '').trim();
  if (isCodeRequest(current)) return current;
  const goal = String(input.taskState?.goal || '').trim();
  if (isCodeRequest(goal)) return goal;
  const history = Array.isArray(input.history) ? input.history : [];
  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index];
    const content = item && item.role === 'user' ? String(item.content || '').trim() : '';
    if (isCodeRequest(content)) return content;
  }
  return current;
}

function builderEvidence(input) {
  const taskState = input.taskState && typeof input.taskState === 'object' ? input.taskState : {};
  const steps = Array.isArray(taskState.steps_taken) ? taskState.steps_taken : [];
  const subagents = Array.isArray(taskState.subagent_results) ? taskState.subagent_results : [];
  const flattened = [...steps];
  for (const agent of subagents) {
    const agentSteps = Array.isArray(agent?.steps) ? agent.steps : [];
    for (const step of agentSteps) flattened.push({ ...step, result_summary: step.result_summary || agent.findings || agent.findings_preview });
  }
  const completed = (tool) => flattened.some((step) => step?.tool === tool && !['not_found', 'empty', 'error', 'failed'].includes(String(step.outcome || '').toLowerCase()));
  return {
    steps: flattened,
    researched: completed('web_research'),
    sourceInspected: completed('repo_search'),
  };
}

function builderProposalArgs(input) {
  const message = builderRequestText(input);
  const evidenceState = builderEvidence(input);
  const evidence = evidenceState.steps
    .filter((step) => step && typeof step.tool === 'string')
    .map((step) => `${step.tool}: ${String(step.result_summary || step.outcome || 'completed').slice(0, 700)}`)
    .join('\n');
  const title = message.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0].slice(0, 160) || 'Implement the requested FCM change';
  return {
    title,
    task_description: [
      'Builder mode: chat_to_code',
      message,
      '',
      'Evidence gathered before proposal:',
      evidence || 'No evidence summary was returned; inspect the named surface before editing.',
      '',
      'Required delivery contract:',
      '- Preserve Bob Builder job, step, approval, artifact, worker-run, review, and draft-pull-request truth.',
      '- Verify the affected user role and job-to-be-done before, during, and after the change.',
      '- Cross-check schema and Atlas; keep proven flow reach separate from FK adjacency and weak references.',
      '- Add focused unit/guard and desktop/mobile human-browser coverage for loading, empty, error, permission, active, success, and safe-next-action states.',
      '- Keep merge, deployment, migrations, auth/RLS, dependencies, environment, and evidential changes behind their protected human gates.',
    ].join('\n').slice(0, 12000),
    frontend_required: true,
    backend_required: false,
    code_review_mode: 'independent_ai',
  };
}

function enforceBuilderProgression(decision, input) {
  const tools = new Set((input.tools || []).map((tool) => tool && tool.tool).filter(Boolean));
  const request = builderRequestText(input);
  if (!tools.has('create_builder_job') || !isCodeRequest(request)) return decision;
  const evidence = builderEvidence(input);
  const used = new Set(evidence.steps.map((step) => step && step.tool).filter(Boolean));
  const repeatedRead = decision.action === 'use_tool' && used.has(decision.tool);
  const asksForResearch = /\b(?:internet|online|web|research|inspiration|inspire|other apps?|examples?)\b/i.test(request);

  if (asksForResearch && !evidence.researched && tools.has('web_research') && ['answer', 'use_tool'].includes(decision.action) && decision.tool !== 'web_research') {
    return {
      ...decision,
      action: 'use_tool',
      tool: 'web_research',
      args: {},
      reply: 'I am gathering current professional product patterns before changing the existing Builder interface.',
      reasoning: 'The owner explicitly requested external inspiration; gather that evidence before source inspection and implementation.',
      route_selected: 'web_research',
    };
  }

  if (!evidence.sourceInspected && tools.has('repo_search') && (evidence.researched || decision.action === 'answer' || decision.tool === 'create_builder_job' || repeatedRead)) {
    return {
      ...decision,
      action: 'use_tool',
      tool: 'repo_search',
      args: { action: 'search', query: builderSearchQuery(request) },
      reply: 'I have the external design evidence. I am now inspecting the existing Builder source and tests so the redesign brief is grounded in the real system.',
      reasoning: 'Advance the natural-language Builder request from completed external research to repository evidence instead of repeating the same research step.',
      route_selected: 'repo_search',
    };
  }

  if (evidence.sourceInspected && (repeatedRead || decision.action === 'answer' || decision.action === 'delegate' || decision.tool === 'create_builder_job')) {
    return {
      ...decision,
      action: 'use_tool',
      tool: 'create_builder_job',
      args: builderProposalArgs(input),
      reply: 'I have grounded the redesign in external design evidence and the existing Builder source. I am preparing the governed Builder job for your confirmation.',
      reasoning: 'Evidence gathering is complete; advance to the governed two-turn Builder proposal instead of stopping at prose.',
      route_selected: 'create_builder_job',
    };
  }

  return decision;
}

async function runPlannerOnce(gateway, input, { reviewerNotes = [], timeoutMs, role = 'planner', chain } = {}) {
  const messages = buildPlannerMessages({ ...input, reviewerNotes });
  const completion = await gateway.chatJson(role, messages, { timeoutMs, reasoningEffort: authorEffort(input), ...(chain ? { chain } : {}) });
  const parsed = parsePlanContent(completion.content);
  let raw = parsed;
  if (!raw) {
    const salvaged = salvageReplyFromTruncatedJson(completion.content);
    raw = salvaged
      ? { action: 'answer', tool: null, args: {}, reply: `${salvaged}\n\n_(This draft was cut off by the model\'s output limit. Say "continue" and I will finish it.)_`, questions: [], reasoning: 'truncated model output salvaged', confidence: 0.4 }
      : { action: 'answer', tool: null, args: {}, reply: String(completion.content).slice(0, 3000), questions: [], reasoning: 'non-JSON model output', confidence: 0.3 };
  }
  const decision = normalizeDecision(raw, input.tools, { delegableTools: delegableTools(input.tools) });
  if (decision.tool) {
    const repaired = autoRepairArgs(decision.tool, decision.args);
    decision.args = repaired.args;
    decision.args_auto_repaired = repaired.repaired;
  }
  return { decision, completion, parsedOk: Boolean(parsed) };
}

/**
 * One planning turn: author → verify → (repair once) → response contract.
 *
 * Budget: the conductor aborts the whole call at BOB_PLAN_TIMEOUT_MS (90 s live),
 * so verification and the repair pass only run while there is headroom.
 */
async function planTurn(body, { gateway, now = Date.now, logger = console, env = process.env } = {}) {
  const started = now();
  const input = readBody(body);
  if (!input.message && !input.attachment) {
    return { status: 400, body: { ok: false, error: 'message or attachment is required' } };
  }
  const turnBudgetMs = Math.max(20000, Math.min(Number(env.BOB_PLAN_TURN_BUDGET_MS || 80000), input.deadlineMs || Infinity));
  const verifyEnabled = input.verify && env.BOB_VERIFY_ENABLED !== 'false';
  const useCritic = env.BOB_VERIFY_MODE !== 'deterministic';
  const elapsed = () => now() - started;
  // In-house first, but not when the caller is nearly out of time: a 7B laptop planner takes
  // 40-50 s a call, so a tight deadline goes straight to the fastest configured tier.
  const FAST_TURN_MS = Math.max(20000, Number(env.BOB_PLAN_FAST_TURN_MS || 45000));
  // Owner-level code work (repo_search / create_builder_job in the catalogue) needs tool discipline the
  // 7B in-house planner does not have: it restated the request or narrated a procedure on every try
  // (proving-series round 2/3, 2026-09-26). "In-house unless stuck" — for this class we are stuck.
  const codeRequest = isCodeRequest(input.message) && input.tools.some((t) => t.tool === 'repo_search' || t.tool === 'create_builder_job') && env.BOB_PLAN_CODE_REQUESTS_IN_HOUSE !== 'true';
  const fastChain = ((input.deadlineMs && input.deadlineMs < FAST_TURN_MS) || codeRequest) && typeof gateway.fastChain === 'function' ? gateway.fastChain('planner') : null;

  let attempt;
  try {
    attempt = await runPlannerOnce(gateway, input, { timeoutMs: Math.max(15000, turnBudgetMs - 5000), ...(fastChain ? { chain: fastChain } : {}) });
  } catch (error) {
    const attempts = error && Array.isArray(error.attempts) ? error.attempts : [];
    const attemptsLog = JSON.stringify(attempts);
    if (logger && logger.error) logger.error(`[bob/plan] planner unavailable: ${String(error && error.message || error)} attempts=${attemptsLog}`);
    // Name the real cause for the person reading the chat: an empty OpenAI balance is something the
    // owner can fix in a minute, "API returned 502" is not.
    const quota = attempts.some((a) => a && a.error === 'insufficient_quota');
    const summary = attempts.map((a) => `${a.provider}: ${a.error}`).join('; ');
    return {
      status: 502,
      body: {
        ok: false,
        error: quota
          ? `My outsourced model (OpenAI) has no credits left and the in-house model could not take this turn (${summary}). Add credits at platform.openai.com/settings/organization/billing, or make sure the laptop model is on.`
          : `Planner unavailable${summary ? ` (${summary})` : ''}`,
        quota_exhausted: quota,
        route_selected: 'error',
        attempts,
        observability: { route: 'error', degraded: true, latency_ms: elapsed(), timestamp: new Date().toISOString() },
      },
    };
  }

  let { decision } = attempt;
  const passes = [{ pass: 'author', provider: attempt.completion.provider, model: attempt.completion.model, latency_ms: attempt.completion.latency_ms, parsed_ok: attempt.parsedOk }];
  let verification = { checked: false, verdict: 'skipped', issues: [], notes: [], critic: null, latency_ms: 0 };
  let replanned = false;
  let scrubbed = false;
  let escalated = false;

  // In-house first, outsource when stuck: a local author (laptop/VPS model) whose plan did not parse
  // hands the turn to the next provider in the chain while there is budget to do so.
  const inHouse = (provider) => typeof gateway.providerKind === 'function' && gateway.providerKind(provider) !== 'openai';
  const nextChain = (provider) => (typeof gateway.chainAfter === 'function' ? gateway.chainAfter('planner', provider) : null);
  if (!attempt.parsedOk && inHouse(attempt.completion.provider) && nextChain(attempt.completion.provider) && turnBudgetMs - elapsed() > 25000) {
    try {
      const escalation = await runPlannerOnce(gateway, input, { timeoutMs: Math.max(15000, turnBudgetMs - elapsed() - 5000), chain: nextChain(attempt.completion.provider) });
      passes.push({ pass: 'escalate', reason: 'unparseable_in_house_plan', from: attempt.completion.provider, provider: escalation.completion.provider, model: escalation.completion.model, latency_ms: escalation.completion.latency_ms, parsed_ok: escalation.parsedOk });
      attempt = escalation;
      decision = escalation.decision;
      escalated = true;
    } catch (error) {
      passes.push({ pass: 'escalate', ok: false, error: String(error && error.message || error).slice(0, 200) });
    }
  }

  if (verifyEnabled) {
    const remaining = turnBudgetMs - elapsed();
    const criticBudget = Math.min(30000, remaining - 30000);
    verification = await verifyDecision({ decision, input, gateway, now, budgetMs: criticBudget, useCritic: useCritic && criticBudget > 4000, logger, avoid: { provider: attempt.completion.provider, model: attempt.completion.model } });

    if (verification.verdict === 'repair' && turnBudgetMs - elapsed() > 20000) {
      try {
        // A blocked in-house plan is repaired by the next provider in the chain (escalation); an OpenAI
        // plan is repaired by the same author from the reviewer notes.
        const escalateTo = inHouse(attempt.completion.provider) ? nextChain(attempt.completion.provider) : null;
        const repair = await runPlannerOnce(gateway, input, { reviewerNotes: verification.notes, timeoutMs: Math.max(15000, turnBudgetMs - elapsed() - 2000), ...(escalateTo ? { chain: escalateTo } : {}) });
        replanned = true;
        if (escalateTo) escalated = true;
        passes.push({ pass: 'repair', provider: repair.completion.provider, model: repair.completion.model, latency_ms: repair.completion.latency_ms, parsed_ok: repair.parsedOk, addressed: verification.issues.map((issue) => issue.code), ...(escalateTo ? { escalated_from: attempt.completion.provider } : {}) });
        const recheck = runDeterministicChecks(repair.decision, input);
        const stillBlocked = recheck.filter((issue) => issue.severity === 'block');
        // Keep the repaired draft unless it introduced NEW blocking problems the original did not have.
        const originalBlocks = new Set(verification.issues.filter((issue) => issue.severity === 'block').map((issue) => issue.code));
        const regressed = stillBlocked.some((issue) => !originalBlocks.has(issue.code));
        if (!regressed) decision = repair.decision;
        verification = { ...verification, repaired: true, recheck_issues: recheck, regressed };
      } catch (error) {
        passes.push({ pass: 'repair', ok: false, error: String(error && error.message || error).slice(0, 200) });
        if (logger && logger.warn) logger.warn(`[bob/plan] repair pass unavailable: ${String(error && error.message || error)}`);
      }
    }

    const finalBlocks = runDeterministicChecks(decision, input).filter((issue) => ['internal_marker_leak', 'uuid_leak', 'sql_error_leak'].includes(issue.code));
    if (finalBlocks.length) {
      decision = { ...decision, reply: scrubReply(decision.reply) };
      scrubbed = true;
    }
  }

  decision = enforceBuilderProgression(decision, input);

  const authorPass = passes[0];
  return {
    status: 200,
    body: {
      ok: true,
      action: decision.action,
      tool: decision.tool,
      args: decision.args,
      reply: decision.reply,
      questions: decision.questions,
      subagents: decision.subagents,
      proposed_entities: decision.proposed_entities,
      reasoning: decision.reasoning,
      confidence: decision.confidence,
      model: passes[passes.length - 1].model || authorPass.model,
      provider: passes[passes.length - 1].provider || authorPass.provider,
      planned_tool_rejected: decision.planned_tool_rejected,
      route_selected: decision.route_selected,
      verification: {
        checked: verification.checked,
        verdict: verification.verdict,
        issues: verification.issues.map((issue) => ({ code: issue.code, severity: issue.severity, source: issue.source || 'deterministic' })),
        critic: verification.critic ? { verdict: verification.critic.verdict, provider: verification.critic.provider || null, model: verification.critic.model || null, summary: verification.critic.summary || '' } : null,
        replanned,
        escalated,
        scrubbed,
        regressed: Boolean(verification.regressed),
        latency_ms: verification.latency_ms,
      },
      passes,
      observability: { route: decision.route_selected, degraded: !attempt.parsedOk || scrubbed, latency_ms: elapsed(), request_id: input.requestId, timestamp: new Date().toISOString() },
    },
  };
}

module.exports = { DELEGABLE_TOOL_RE, authorEffort, builderEvidence, builderProposalArgs, builderRequestText, builderSearchQuery, delegableTools, enforceBuilderProgression, planTurn, readBody, runPlannerOnce };
