'use strict';

// Bob Builder chat: the Builder page's own conversation lane for the platform owner.
// Independent of in-app agentic Bob (onspace-ai-chat, bob_conversations, bob_self_memory),
// which serves app users. The browser writes owner turns through the builder_chat_* RPCs;
// this worker claims them with the service role, answers with the Builder model chain and
// read-only Builder tools (repository, Atlas, schema counts, Builder job ledger) and may
// PROPOSE a Builder job. It never edits code, creates jobs, approves gates, merges or deploys:
// a proposal becomes a job only when the owner confirms it through bob-builder-control-room.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTools, parseToolCall, compactMessages } = require('./builder-agentic-engineer');
const { applyVibeRouting, vibeCloudAllowed, vibeProviderCandidates, vibeNativeTools, vibeToolSchema } = require('./builder-vibe-session');
const { redactGitError, gitSpawnFault } = require('./builder-branch-workspace');
const { buildModelRunRequest, callModelGateway, fetchModelHealth, providerRequest } = require('./supabase/functions/_shared/builder-model-adapter');

const PROMPT_VERSION = 'builder-chat-v1';
const BUILDER_CHAT_LIMITS = Object.freeze({
  maxTurns: Math.max(4, Number(process.env.BOB_BUILDER_CHAT_TURNS || 14)),
  wallBudgetMs: Math.max(60_000, Number(process.env.BOB_BUILDER_CHAT_BUDGET_MS || 8 * 60_000)),
  turnTimeoutMs: Math.max(30_000, Number(process.env.BOB_BUILDER_TURN_TIMEOUT_MS || 300_000)),
  readCapChars: 20_000,
  searchCapLines: 120,
  listCapEntries: 300,
  runCapChars: 4_000,
  runTimeoutMs: 60_000,
  maxPatchBytes: 0,
});
const HISTORY_MESSAGES = 24;
const READ_TOOLS = ['list_dir', 'read_file', 'outline', 'search', 'git_log', 'read_canon', 'atlas', 'live_count'];
const JOB_COLUMNS = 'id, title, status, autopilot_state, workspace_branch, workspace_pull_request_url, requested_action, target_environment, created_at, updated_at';
// A reply may not tell the owner work was started on his behalf: this chat only proposes.
const ACTION_CLAIM = /\b(?:i|i've|bob|we)\b[^.!?\n]{0,24}\b(?:created|opened|started|queued|launched|kicked off|submitted|approved|merged|deployed|shipped|cancelled)\b[^.!?\n]{0,48}\b(?:jobs?|pull requests?|PRs?|branch(?:es)?|builds?|deploy(?:ment)?s?|releases?|gates?)\b/i;

const clip = (text, cap) => {
  const value = String(text ?? '');
  return value.length <= cap ? value : `${value.slice(0, cap)}\n[… ${value.length - cap} more chars]`;
};

function builderChatSystemPrompt() {
  return [
    'You are Bob Builder in the Builder chat of Field Compliance Manager (multi-tenant field-compliance SaaS: React/Vite web app in apps/web, Supabase edge functions in supabase/functions, Node control-plane modules at the repo root).',
    'You talk with the platform owner about building and repairing the platform itself. This lane is separate from in-app Bob: in-app Bob (OnSpace AI chat) serves users inside the app with operational questions, research and agentic work on business records. You never do that work here and never touch tenant data.',
    'WHAT YOU CAN DO HERE:',
    '- Investigate with read-only tools on the current main: search, read_file, outline, list_dir, git_log, read_canon, atlas (live build map), live_count (row counts).',
    '- Read the Builder job ledger: list_jobs, job_status.',
    '- Plan a build and propose it with propose_job. The owner then confirms it in the UI; only that creates the job, which runs through specification, implementation and release approval gates and publishes a pull request.',
    '- For interactive, iterative edits suggest the Vibe Builder tab (chat-to-code on a live branch).',
    'RULES:',
    '- Ground every claim in a tool result from this conversation: name files, tables and jobs you actually read. Never invent tables, columns, files, job IDs or statuses. An empty search is not proof something is missing.',
    '- You cannot edit files, create or cancel jobs, approve gates, merge or deploy. Never say you did. Say "I propose" and use propose_job.',
    '- A good proposal names the user/role and job-to-be-done, the files or surfaces involved, the schema/Atlas path, acceptance checks, and what must not change. Set frontend_required/backend_required honestly.',
    '- Ask one clarifying question with reply when the request is genuinely ambiguous; otherwise investigate and act.',
    '- Keep replies short and plain. Respond with exactly ONE JSON object per message: {"thought": string, "tool": string, "args": object}. Finish with reply {"message": string}.',
  ].join('\n');
}

function createBuilderChatStore(supabase) {
  return {
    async claimNext() {
      const { data, error } = await supabase.rpc('builder_chat_claim_next');
      if (error) throw new Error(`claim failed: ${error.message}`);
      return Array.isArray(data) ? data[0] || null : data || null;
    },
    async thread(threadId) {
      const { data, error } = await supabase.from('builder_chat_threads').select('*').eq('id', threadId).maybeSingle();
      if (error) throw new Error(`thread read failed: ${error.message}`);
      return data;
    },
    async updateThread(threadId, patch) {
      const now = new Date().toISOString();
      const { error } = await supabase.from('builder_chat_threads').update({ ...patch, updated_at: now, last_activity_at: now }).eq('id', threadId);
      if (error) throw new Error(`thread update failed: ${error.message}`);
    },
    async post(threadId, row) {
      const { error } = await supabase.from('builder_chat_messages').insert({ thread_id: threadId, role: 'bob', kind: 'message', payload: {}, ...row, content: clip(row.content, 39_000) });
      if (error) throw new Error(`message insert failed: ${error.message}`);
    },
    async complete(messageId, status) {
      const { error } = await supabase.from('builder_chat_messages').update({ status, completed_at: new Date().toISOString() }).eq('id', messageId);
      if (error) throw new Error(`message completion failed: ${error.message}`);
    },
    async history(threadId, beforeSeq) {
      const { data, error } = await supabase.from('builder_chat_messages').select('role, kind, content, payload, status, seq').eq('thread_id', threadId)
        .in('role', ['owner', 'bob']).in('kind', ['message', 'proposal', 'error']).lt('seq', beforeSeq).order('seq', { ascending: false }).limit(HISTORY_MESSAGES);
      if (error) throw new Error(`history read failed: ${error.message}`);
      return (data || []).reverse();
    },
    async releaseStaleClaims(olderThanMs = 30 * 60_000) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      await supabase.from('builder_chat_messages').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('status', 'claimed').lt('claimed_at', cutoff);
    },
  };
}

// A detached, read-only checkout of main shared by every chat thread; refreshed to the head per turn.
function ensureChatCheckout({ workspaceRoot, sourceDirFor, resolveHead }) {
  const workspacePath = path.join(path.resolve(workspaceRoot), 'chat', 'main');
  const head = resolveHead();
  if (!/^[0-9a-f]{40}$/.test(String(head))) throw new Error('could not resolve the main head for the Builder chat');
  const run = (cwd, args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim();
    } catch (error) {
      throw new Error(gitSpawnFault(error, cwd) || redactGitError(error && (error.stderr || error.message)));
    }
  };
  const sourceDir = sourceDirFor(head);
  if (fs.existsSync(path.join(workspacePath, '.git'))) {
    if (run(workspacePath, ['rev-parse', 'HEAD']) !== head) run(workspacePath, ['checkout', '--force', '--detach', head]);
    run(workspacePath, ['clean', '-fdq']);
  } else {
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true, mode: 0o700 });
    try { run(sourceDir, ['worktree', 'prune']); } catch { /* best effort */ }
    run(sourceDir, ['worktree', 'add', '--force', '--detach', workspacePath, head]);
  }
  return { workspacePath, head };
}

function jobSummary(job) {
  return {
    id: job.id, title: job.title, status: job.status, autopilot: job.autopilot_state || null,
    branch: job.workspace_branch || null, pull_request: job.workspace_pull_request_url || null, updated_at: job.updated_at,
  };
}

function validateProposal(args) {
  const title = String(args.title || '').trim();
  const task = String(args.task_description || '').trim();
  const frontend = args.frontend_required === true;
  const backend = args.backend_required === true;
  if (title.length < 4 || title.length > 160) return { error: 'title must be 4-160 characters' };
  if (task.length < 40 || task.length > 8000) return { error: 'task_description must be 40-8000 characters and specific enough to build from' };
  if (!frontend && !backend) return { error: 'set frontend_required and/or backend_required to true' };
  return { proposal: { title, task_description: task, frontend_required: frontend, backend_required: backend, rationale: clip(String(args.rationale || '').trim(), 1500) } };
}

function createBuilderChatTools({ supabase, workspacePath, limits }) {
  const base = workspacePath ? createTools({ workspacePath, repoRoot: workspacePath, lane: 'fullstack', supabase, limits, log: () => {} }) : {};
  const tools = Object.fromEntries(READ_TOOLS.filter(name => typeof base[name] === 'function').map(name => [name, base[name]]));
  tools.list_jobs = async ({ status, limit } = {}) => {
    let query = supabase.from('builder_jobs').select(JOB_COLUMNS).order('updated_at', { ascending: false }).limit(Math.min(Math.max(Number(limit) || 10, 1), 25));
    if (typeof status === 'string' && status.trim()) query = query.eq('status', status.trim());
    const { data, error } = await query;
    if (error) return { error: `job ledger read failed: ${error.message}` };
    return { jobs: (data || []).map(jobSummary) };
  };
  tools.job_status = async ({ job } = {}) => {
    const key = String(job || '').trim().toLowerCase().replace(/^bob\/job-/, '');
    if (key.length < 6 || !/^[0-9a-f-]+$/.test(key)) return { error: 'give a job id (at least 6 hex characters) or its bob/job-… branch' };
    const { data, error } = await supabase.from('builder_jobs').select(JOB_COLUMNS).order('updated_at', { ascending: false }).limit(200);
    if (error) return { error: `job ledger read failed: ${error.message}` };
    const compact = value => String(value || '').replace(/-/g, '');
    const match = (data || []).find(row => compact(row.id).startsWith(compact(key)) || compact(row.workspace_branch).endsWith(compact(key)));
    if (!match) return { error: `no Builder job matches ${key}` };
    const [steps, approvals] = await Promise.all([
      supabase.from('builder_job_steps').select('step_id, status, ordinal_position, error').eq('job_id', match.id).order('ordinal_position'),
      supabase.from('builder_approvals').select('approval_type, triggered_at_status, status, created_at').eq('job_id', match.id).order('created_at'),
    ]);
    return {
      job: jobSummary(match),
      steps: (steps.data || []).map(step => ({ step: step.step_id, status: step.status, error: step.error ? clip(step.error, 300) : null })),
      approvals: (approvals.data || []).map(row => ({ gate: row.approval_type, status: row.status, at: row.triggered_at_status })),
    };
  };
  tools.propose_job = args => validateProposal(args || {});
  return tools;
}

function builderChatNativeTools(tools) {
  const text = { type: 'string' };
  const custom = {
    list_jobs: { description: 'List recent Builder jobs from the job ledger (newest first).', parameters: { type: 'object', properties: { status: text, limit: { type: 'integer', minimum: 1, maximum: 25 } }, additionalProperties: false } },
    job_status: { description: 'Read one Builder job with its steps and approval gates. job is an id, id prefix or bob/job-… branch.', parameters: { type: 'object', properties: { job: { type: 'string', minLength: 6 } }, required: ['job'], additionalProperties: false } },
    propose_job: {
      description: 'Propose a Builder job for the owner to confirm. Only the owner creates it. Use after investigating.',
      parameters: { type: 'object', properties: { title: { type: 'string', minLength: 4 }, task_description: { type: 'string', minLength: 40 }, frontend_required: { type: 'boolean' }, backend_required: { type: 'boolean' }, rationale: text }, required: ['title', 'task_description', 'frontend_required', 'backend_required'], additionalProperties: false },
    },
  };
  return vibeNativeTools(tools)
    .filter(entry => entry.function.name !== 'finish')
    .map(entry => custom[entry.function.name] ? { type: 'function', function: { name: entry.function.name, ...custom[entry.function.name] } } : entry);
}

function contextLine(context) {
  if (!context || typeof context !== 'object') return null;
  const fields = ['surface', 'job_id', 'job_title', 'job_status', 'target_sha', 'requested_action', 'target_environment', 'workspace_view']
    .filter(key => context[key] !== null && context[key] !== undefined && context[key] !== '')
    .map(key => `${key}=${clip(String(context[key]), 160)}`);
  return fields.length ? `BUILDER PAGE CONTEXT (what the owner has open): ${fields.join(', ')}` : null;
}

async function runBuilderChat({ store, thread, message, workspacePath, head, gateway, deps, limits = BUILDER_CHAT_LIMITS }) {
  const tools = deps.tools || createBuilderChatTools({ supabase: deps.supabase, workspacePath, limits });
  const history = await store.history(thread.id, message.seq);
  const transcript = history.map(entry => {
    const label = entry.role === 'owner' ? 'OWNER' : entry.kind === 'proposal' ? 'BOB (proposed job)' : 'BOB';
    const accepted = entry.kind === 'proposal' ? (entry.payload?.job_id ? ` [owner created job ${entry.payload.job_id}]` : ' [not created]') : '';
    return `${label}${accepted}: ${clip(entry.content, 2500)}`;
  }).join('\n\n');
  const task = [
    `MAIN HEAD: ${String(head || 'unknown').slice(0, 12)} (read-only checkout)`,
    contextLine(message.payload?.context),
    transcript ? `CONVERSATION SO FAR:\n${transcript}` : 'CONVERSATION SO FAR: (first message)',
    `OWNER NOW SAYS:\n${message.content}`,
  ].filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: builderChatSystemPrompt() }, { role: 'user', content: task }];
  const modelRequest = applyVibeRouting(buildModelRunRequest({
    organizationId: 'platform', jobId: thread.id, stepId: message.id, builderMode: 'builder_chat', workloadKind: 'builder_conversation',
    promptVersion: PROMPT_VERSION, systemPrompt: messages[0].content, userPrompt: task, outputSchema: vibeToolSchema(tools),
  }), { allowCloud: deps.allowCloud ?? vibeCloudAllowed() });
  const nativeTools = builderChatNativeTools(tools);
  const health = await (deps.fetchHealth || fetchModelHealth)(gateway);
  const candidates = vibeProviderCandidates(modelRequest, health);
  if (!candidates.length) return { reply: 'No Builder model is available right now, so I could not answer. The model gateway health needs checking.', error: true };
  const callModel = deps.callModel || callModelGateway;
  const started = Date.now();
  let active = 0;
  let unavailable = 0;
  let unparseable = 0;
  let executedTools = 0;
  let claimCorrected = false;
  let proposal = null;
  const repeated = new Map();
  const escalate = async (reason, detail) => {
    if (active + 1 >= candidates.length) return false;
    const previous = candidates[active];
    active++;
    await store.post(thread.id, {
      role: 'system', kind: 'status', content: `${previous.provider}/${previous.model} ${detail}; switching to ${candidates[active].provider}/${candidates[active].model}.`,
      payload: { message_id: message.id, reason, previous_model: previous.model, provider: candidates[active].provider, model: candidates[active].model, external_egress: candidates[active].provider === 'ollama_cloud' },
    });
    return true;
  };
  for (let turn = 1; turn <= limits.maxTurns && Date.now() - started < limits.wallBudgetMs; turn++) {
    const candidate = candidates[active];
    const status = health?.[candidate.provider] || {};
    const maxOutput = Math.min(Number(status.max_output_tokens || 4096), status.num_ctx ? Math.floor(status.num_ctx / 2) : 4096);
    const promptBudget = status.num_ctx ? Math.floor((status.num_ctx - maxOutput - 512) * 3.5) - JSON.stringify(nativeTools).length - 400 : Infinity;
    const baseRequest = providerRequest(modelRequest, candidate, null);
    const request = { ...baseRequest, idempotency_key: `${baseRequest.idempotency_key}::chat-${turn}`, request: { ...baseRequest.request, messages: compactMessages(messages, { maxChars: promptBudget }), ...(candidate.provider === 'ollama_cloud' ? {} : { tools: nativeTools }), max_output_tokens: maxOutput } };
    const response = await callModel({ ...gateway, modelRequest: request, timeoutMs: limits.turnTimeoutMs });
    if (!response.ok) {
      const timedOut = response.timeout === true || response.status === 408 || response.code === 'provider_timeout';
      unavailable++;
      if ((timedOut || unavailable >= 2 || [413, 429].includes(response.status)) && await escalate(timedOut ? 'timeout' : 'unavailable', timedOut ? `did not answer within ${Math.round(limits.turnTimeoutMs / 60_000)} min` : `is unavailable (${clip(response.error, 160)})`)) {
        unavailable = 0; turn--; continue;
      }
      if (unavailable >= 3) return { reply: `The Builder model stopped responding (${clip(response.error, 200)}). Send the message again to retry.`, error: true };
      turn--;
      await new Promise(resolve => setTimeout(resolve, (deps.retryDelayMs ?? 1500) * unavailable));
      continue;
    }
    unavailable = 0;
    const content = String(response.data?.content ?? '');
    const call = parseToolCall(content);
    if (!call || typeof call.tool !== 'string') {
      unparseable++;
      const prose = content.trim() && !content.trim().startsWith('{') && !/<\/?(?:tool_call|invoke|parameter|function)\b/i.test(content);
      // Plain prose is still an answer in a chat lane, but never one that claims an action.
      if (prose && !ACTION_CLAIM.test(content)) return { reply: clip(content.trim(), 8000), proposal, model: response.data?.model };
      messages.push({ role: 'assistant', content: content.slice(0, 4000) }, { role: 'user', content: JSON.stringify({ error: 'Reply with ONLY one JSON object {"thought": string, "tool": string, "args": object}. Use reply {message} to answer.' }) });
      if (unparseable >= 2 && await escalate('prose_without_tool', 'did not produce a usable step')) unparseable = 0;
      else if (unparseable >= 4) return { reply: 'I could not produce a usable answer. Please send the request again or narrow it.', error: true };
      continue;
    }
    unparseable = 0;
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    if (call.tool === 'reply' || call.tool === 'finish') {
      let text = String(args.message || args.summary || call.thought || '').trim() || 'Done.';
      if (ACTION_CLAIM.test(text) && !claimCorrected) {
        claimCorrected = true;
        messages.push({ role: 'assistant', content: JSON.stringify({ tool: call.tool, args }) }, { role: 'user', content: JSON.stringify({
          error: 'Reply refused: this chat cannot create, start, approve, merge or deploy anything, so do not say it did. If a build is wanted, call propose_job; the owner confirms it in the UI. Otherwise reply with what you found and what you propose.',
        }) });
        continue;
      }
      if (ACTION_CLAIM.test(text)) text = `Note: this chat has not created or started anything; Builder jobs start only when you confirm a proposal.\n\n${text}`;
      return { reply: clip(text, 8000), proposal, model: response.data?.model, executedTools };
    }
    messages.push({ role: 'assistant', content: JSON.stringify({ thought: clip(call.thought, 1500), tool: call.tool, args }) });
    const key = `${call.tool}:${JSON.stringify(args)}`;
    const count = (repeated.get(key) || 0) + 1;
    repeated.set(key, count);
    let result;
    if (count > 2) result = { error: 'identical call already made; use the earlier result or reply' };
    else if (typeof tools[call.tool] !== 'function') result = { error: `unknown tool ${call.tool}; available: ${Object.keys(tools).join(', ')}, reply` };
    else {
      executedTools++;
      try { result = await tools[call.tool](args); } catch (error) { result = { error: clip(redactGitError(error && error.message), 1200) }; }
    }
    if (call.tool === 'propose_job' && result?.proposal) {
      proposal = result.proposal;
      result = { proposed: true, instruction: 'The proposal is shown to the owner with a Create job button. Now reply briefly with what it will do and what the owner should check.' };
    }
    await store.post(thread.id, {
      role: 'tool', kind: 'tool', content: `${call.tool}${args.path ? ` ${args.path}` : args.query ? ` "${clip(args.query, 80)}"` : args.job ? ` ${args.job}` : ''}`,
      payload: { message_id: message.id, tool: call.tool, ok: !result?.error, preview: clip(JSON.stringify(result), 600) },
    });
    messages.push({ role: 'user', content: clip(JSON.stringify({ tool: call.tool, result }), limits.readCapChars) });
  }
  if (proposal) return { reply: 'I have proposed the job above for your confirmation.', proposal };
  return { reply: 'I ran out of time on this one before reaching an answer. Ask again with a narrower question.', error: true };
}

async function processBuilderChatMessage({ store, message, deps, limits = BUILDER_CHAT_LIMITS }) {
  const thread = await store.thread(message.thread_id);
  if (!thread || thread.status === 'closed') { await store.complete(message.id, 'failed'); return { skipped: true }; }
  await store.updateThread(thread.id, { status: 'working' });
  try {
    await store.post(thread.id, { role: 'bob', kind: 'thinking', content: 'Looking into it…', payload: { message_id: message.id } });
    const checkout = deps.workspacePath ? { workspacePath: deps.workspacePath, head: deps.head || null }
      : ensureChatCheckout({ workspaceRoot: deps.workspaceRoot, sourceDirFor: deps.sourceDirFor, resolveHead: deps.resolveHead });
    const outcome = await runBuilderChat({ store, thread, message, workspacePath: checkout.workspacePath, head: checkout.head, gateway: deps.gateway, deps, limits });
    if (outcome.proposal) {
      await store.post(thread.id, {
        role: 'bob', kind: 'proposal', content: `${outcome.proposal.title}\n\n${outcome.proposal.task_description}`,
        payload: { message_id: message.id, proposal: outcome.proposal, main_head: checkout.head || null },
      });
    }
    await store.post(thread.id, { role: 'bob', kind: outcome.error ? 'error' : 'message', content: outcome.reply, payload: { message_id: message.id, model: outcome.model || null } });
    await store.complete(message.id, outcome.error ? 'failed' : 'done');
    await store.updateThread(thread.id, { status: 'open' });
    return outcome;
  } catch (error) {
    const detail = clip(redactGitError(error && error.message), 600);
    await store.post(thread.id, { role: 'bob', kind: 'error', content: `Something went wrong: ${detail}` }).catch(() => {});
    await store.updateThread(thread.id, { status: 'open' }).catch(() => {});
    await store.complete(message.id, 'failed').catch(() => {});
    return { error: detail };
  }
}

function createBuilderChatWorker({ supabase, deps, intervalMs = 2500, log = console }) {
  const store = createBuilderChatStore(supabase);
  let running = false;
  let timer = null;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (let claimed = await store.claimNext(); claimed; claimed = await store.claimNext()) {
        await processBuilderChatMessage({ store, message: claimed, deps: { ...deps, supabase } });
      }
    } catch (error) {
      log.error?.(`builder chat worker: ${redactGitError(error && error.message)}`);
    } finally {
      running = false;
    }
  };
  return {
    store,
    tick,
    start() {
      // This process is the only Builder chat worker: a claim left from before a restart is orphaned.
      store.releaseStaleClaims(0).catch(() => {});
      timer = setInterval(() => { tick(); }, intervalMs);
      timer.unref?.();
      setTimeout(() => { tick(); }, 2000).unref?.();
    },
    stop() { if (timer) clearInterval(timer); },
  };
}

module.exports = {
  PROMPT_VERSION, BUILDER_CHAT_LIMITS, ACTION_CLAIM, builderChatSystemPrompt, createBuilderChatStore, ensureChatCheckout,
  validateProposal, createBuilderChatTools, builderChatNativeTools, runBuilderChat, processBuilderChatMessage, createBuilderChatWorker,
};
