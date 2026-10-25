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
    '- Read the Builder job ledger: owner_queue (what is waiting on the owner), list_jobs, job_status.',
    '- Plan a build and propose it with propose_job. The owner then confirms it in the UI; only that creates the job, which runs through specification, implementation and release approval gates and publishes a pull request.',
    '- For interactive, iterative edits suggest the Vibe Builder tab (chat-to-code on a live branch).',
    'RULES:',
    '- Ground every claim in a tool result from this conversation: name files, tables and jobs you actually read. Never invent tables, columns, files, job IDs or statuses. An empty search is not proof something is missing.',
    '- You cannot edit files, create or cancel jobs, approve gates, merge or deploy. Never say you did. Say "I propose" and use propose_job.',
    '- A good proposal names the user/role and job-to-be-done, the files or surfaces involved, the schema/Atlas path, acceptance checks, and what must not change. Set frontend_required/backend_required honestly.',
    '- Answer the question asked. A status question is answered from owner_queue/list_jobs/job_status; do not read source code for it.',
    '- Never guess file paths. If a path is missing, use did_you_mean from the error, search or list_dir. After a couple of failed calls, reply with what you know.',
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
      // The worker never reopens a thread the owner closed while a turn was running.
      const { error } = await supabase.from('builder_chat_threads').update({ ...patch, updated_at: now, last_activity_at: now }).eq('id', threadId).neq('status', 'closed');
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
        .in('kind', ['message', 'proposal', 'error'])
        // Owner turns before this one, plus every Bob reply already persisted (including answers to
        // earlier queued turns that were posted after this message was sent).
        .or(`and(role.eq.owner,seq.lt.${Number(beforeSeq)}),role.eq.bob`).order('seq', { ascending: false }).limit(HISTORY_MESSAGES);
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
  tools.job_status = async (args = {}) => {
    // Small models name the argument id/job_id/branch as often as job.
    const key = String(args.job || args.job_id || args.id || args.branch || '').trim().toLowerCase().replace(/^bob\/job-/, '');
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
  tools.owner_queue = async () => {
    const LIMIT = 50;
    const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
    const jobs = () => supabase.from('builder_jobs').select(`${JOB_COLUMNS}, autopilot_report`);
    // Each actionable set is queried on its own so a busy ledger cannot push a waiting item out of view.
    const [approvals, published, awaiting, blocked] = await Promise.all([
      supabase.from('builder_approvals').select('job_id, approval_type, requested_at, expires_at').eq('status', 'pending').order('requested_at').limit(LIMIT),
      jobs().eq('status', 'release_ready').not('workspace_pull_request_url', 'is', null).or('autopilot_state.is.null,autopilot_state.neq.done').order('updated_at', { ascending: false }).limit(LIMIT),
      jobs().eq('autopilot_state', 'awaiting_human').order('updated_at', { ascending: false }).limit(LIMIT),
      jobs().eq('autopilot_state', 'blocked').gte('updated_at', since).order('updated_at', { ascending: false }).limit(LIMIT),
    ]);
    for (const [label, result] of [['approval', approvals], ['published job', published], ['awaiting job', awaiting], ['blocked job', blocked]]) {
      if (result.error) return { error: `${label} read failed: ${result.error.message}` };
    }
    const gateIds = [...new Set((approvals.data || []).map(row => row.job_id))];
    const known = new Map([...(published.data || []), ...(awaiting.data || []), ...(blocked.data || [])].map(job => [job.id, job]));
    const missing = gateIds.filter(id => !known.has(id));
    if (missing.length) {
      const gateJobs = await supabase.from('builder_jobs').select(JOB_COLUMNS).in('id', missing);
      if (gateJobs.error) return { error: `job ledger read failed: ${gateJobs.error.message}` };
      for (const job of gateJobs.data || []) known.set(job.id, job);
    }
    const pendingIds = new Set(gateIds);
    const merged = job => job.autopilot_report?.merged === true;
    const truncated = [['approval_gates', approvals], ['pull_requests', published], ['awaiting_owner', awaiting], ['blocked_recently', blocked]]
      .filter(([, result]) => (result.data || []).length >= LIMIT).map(([name]) => name);
    return {
      approval_gates: (approvals.data || []).map(row => ({ job: known.has(row.job_id) ? jobSummary(known.get(row.job_id)) : { id: row.job_id }, gate: row.approval_type, requested_at: row.requested_at, expires_at: row.expires_at })),
      pull_requests_to_review: (published.data || []).filter(job => !merged(job) && !pendingIds.has(job.id)).map(jobSummary),
      merged_awaiting_deploy: (published.data || []).filter(merged).map(jobSummary),
      awaiting_owner: (awaiting.data || []).filter(job => !pendingIds.has(job.id)).map(jobSummary),
      blocked_recently: (blocked.data || []).map(jobSummary),
      ...(truncated.length ? { truncated } : {}),
      note: 'approval_gates are decided in the Builder queue; pull_requests_to_review need review and merge on GitHub; merged_awaiting_deploy need no action unless the release lane stalls; blocked jobs need a decision (retry, re-scope or cancel).'
        + (truncated.length ? ` Lists capped at ${LIMIT}: ${truncated.join(', ')} may hold more; open the Builder queue for the full list.` : ''),
    };
  };
  tools.propose_job = args => validateProposal(args || {});
  return tools;
}

const LEDGER_TOOLS = ['owner_queue', 'list_jobs', 'job_status'];
const OWNER_ACTION = /\b(?:waiting (?:on|for) me|what(?:'s| is) (?:waiting|pending|blocked|left|outstanding)|my queue|owner queue|(?:pending|outstanding) (?:approvals?|gates?|reviews?|prs?|pull requests?)|anything (?:waiting|pending|blocked|for me)|needs? (?:my )?(?:approval|review|decision)|what do i need to (?:do|approve|review))\b/i;
const JOB_STATUS = /\b(?:(?:jobs?|gates?|queue|builds?|release) status|status (?:of|for) (?:the |my |this |that )?(?:jobs?|builds?|queue|gates?|release)|how (?:is|are) (?:the |my |this |that )?(?:jobs?|builds?) (?:going|doing)|where (?:is|are) (?:the |my |this |that )?(?:jobs?|builds?) (?:at|up to))\b/i;
const JOB_REF = /\b(?:bob\/job-)?((?=[0-9a-f-]*\d)[0-9a-f]{8}[0-9a-f-]{0,28})\b/i;
// Edit requests open with an imperative verb ("Build status badges…", "Update the job status colour");
// investigation questions ask why/how/where about code. Neither is answered from the ledger alone.
const IMPERATIVE = /^(?:(?:please|can you|could you|would you|bob,?|hey bob,?)\s+)*(?:fix|build|add|create|change|update|implement|redesign|refactor|propose|investigate|plan|remove|delete|rename|move|make|style|restyle|show|display|wire|replace|improve|clean|write|design|draft|migrate)\b/i;
const INVESTIGATION = /\b(?:why|how (?:does|do))\b/i;

// The owner explicitly asked for a job to be proposed. The model must then end with propose_job,
// not a refusal: live thread 2026-10-25, qwen2.5-coder:7b read schema.sql 13 times and replied that
// it had "no permission to modify the file" instead of proposing the fix it was asked for.
const PROPOSE_REQUEST = /\b(?:propose|draft|plan|create|open|raise|queue|set up|make)\b[^.?!\n]{0,40}\b(?:builder\s+)?(?:job|build|fix|change)\b/i;
const PROPOSE_NEGATED = /\b(?:don'?t|do not|does not|no need to|not yet|never|without|instead of|rather than|before you)\b[^.?!\n]{0,24}\b(?:propose|draft|plan|create|open|raise|queue|set up|make)\b|\b(?:propose|draft|create|open|raise|queue|make)\b[^.?!\n]{0,40}\b(?:job|build|fix|change)\b[^.?!\n]{0,12}\b(?:yet|later)\b/i;
// "How do I create a job?" asks for an explanation; "Can you propose a job?" asks Bob to act.
const INFORMATIONAL = /^\s*(?:how|what|why|when|where|which|who|is|are|does|do|did|should|would it)\b/i;
const ADDRESSED_REQUEST = /\b(?:can|could|would|will) you\b|\bplease\b/i;
function proposeIntent(text) {
  const value = String(text || '');
  if (!PROPOSE_REQUEST.test(value) || PROPOSE_NEGATED.test(value)) return false;
  return !INFORMATIONAL.test(value) || ADDRESSED_REQUEST.test(value);
}

const FRONTEND_HINT = /\b(?:frontend|front-end|apps\/web|\.tsx|\.css|ui|ux|page|screen|panel|component|layout|button|composer)\b/i;
const BACKEND_HINT = /\b(?:backend|back-end|supabase|sql|migration|rpc|function|schema|table|edge function|worker|trigger|race|lock)\b/i;
// Last resort when the model never proposes: a draft built only from the owner's own brief and the
// paths Bob actually read, clearly labelled, for the owner to review before Create job.
function draftProposalFromBrief(brief, readPaths = []) {
  const text = String(brief || '').trim();
  const first = (text.replace(/^\s*please\s+/i, '').split(/(?<=[.!?])\s|\n/)[0] || text)
    .replace(/^(?:investigate and\s+)?(?:propose|draft|plan|create|open|raise)\s+(?:a\s+)?(?:builder\s+)?job\s+(?:for|to)\s+/i, '')
    .replace(/\s*\([^)]*\)/g, '').trim();
  const title = (first.charAt(0).toUpperCase() + first.slice(1)).slice(0, 150).trim().replace(/[.:;,]+$/, '');
  const paths = [...new Set(readPaths)].slice(0, 12);
  // validateProposal caps task_description at 8000 characters while the chat accepts 20000: keep the
  // head of the brief and say plainly that the rest is in the thread, never drop the draft silently.
  const BRIEF_CAP = 6800;
  const ownerBrief = text.length > BRIEF_CAP
    ? `${text.slice(0, BRIEF_CAP)}\n\n[Owner brief continues: ${text.length - BRIEF_CAP} more characters are in this Builder chat message. The specification step must read the full brief there before planning.]`
    : text;
  const task = [ownerBrief, paths.length ? `Evidence Bob read in chat: ${paths.join(', ')}.` : null,
    'Drafted from the owner brief because the chat model did not produce its own proposal; the specification gate must confirm the details against the code and schema before implementation.'].filter(Boolean).join('\n\n');
  const scope = text.replace(/\bno\s+(?:ui|ux|frontend|front-end|backend|schema)\s+changes?\b/gi, '');
  const frontend = FRONTEND_HINT.test(scope);
  const backend = BACKEND_HINT.test(scope) || !frontend;
  return validateProposal({ title, task_description: task, frontend_required: frontend, backend_required: backend, rationale: 'Owner asked for a proposal; drafted from the brief.' }).proposal || null;
}

// Classifies a ledger question: owner (what needs me), job (one job by id/branch) or jobs (general status).
function statusIntent(text) {
  const value = String(text || '').trim();
  if (!value || IMPERATIVE.test(value) || INVESTIGATION.test(value)) return null;
  const ref = value.match(JOB_REF);
  const owner = OWNER_ACTION.test(value);
  const status = JOB_STATUS.test(value);
  if (ref && (status || /\bstatus\b|\bwhere\b|\bhow\b|\bstuck\b|\bblocked\b|\bdone\b/i.test(value))) return { kind: 'job', job: ref[1] };
  if (owner) return { kind: 'owner' };
  if (status) return { kind: 'jobs' };
  return null;
}

function isStatusQuestion(text) {
  return statusIntent(text) !== null;
}

function formatJobStatus(result) {
  if (!result || result.error || !result.job) return null;
  const job = result.job;
  const lines = [`${job.title || 'Untitled job'} (${String(job.id || '').slice(0, 8)}): ${job.status}${job.autopilot ? `, autopilot ${job.autopilot}` : ''}.`];
  const steps = (result.steps || []).map(step => `${step.step}:${step.status}`).join(', ');
  if (steps) lines.push(`Steps: ${steps}.`);
  const pending = (result.approvals || []).filter(row => row.status === 'pending').map(row => String(row.gate || '').replace(/_/g, ' '));
  if (pending.length) lines.push(`Waiting on your ${pending.join(', ')} in the Builder queue.`);
  if (job.pull_request) lines.push(`Pull request: ${job.pull_request}`);
  return lines.join('\n');
}

function formatJobList(result) {
  if (!result || result.error || !Array.isArray(result.jobs)) return null;
  if (!result.jobs.length) return 'The job ledger has no Builder jobs to report.';
  return `Recent Builder jobs:\n${result.jobs.map(job => `- ${job.title || 'Untitled job'} (${String(job.id || '').slice(0, 8)}): ${job.status}${job.autopilot ? `, autopilot ${job.autopilot}` : ''}${job.pull_request ? ` — ${job.pull_request}` : ''}`).join('\n')}`;
}

const LEDGER_FORMATTERS = { owner_queue: queue => formatOwnerQueue(queue), job_status: formatJobStatus, list_jobs: formatJobList };

function formatOwnerQueue(queue) {
  if (!queue || queue.error) return null;
  const name = job => `${job?.title || 'Untitled job'} (${String(job?.id || '').slice(0, 8)})`;
  const sections = [];
  const gates = queue.approval_gates || [];
  if (gates.length) sections.push(`Approval gates waiting on you (decide in the Builder queue):\n${gates.map(row => `- ${name(row.job)}: ${String(row.gate || '').replace(/_/g, ' ')}`).join('\n')}`);
  const prs = queue.pull_requests_to_review || [];
  if (prs.length) sections.push(`Pull requests to review and merge on GitHub:\n${prs.map(job => `- ${name(job)}: ${job.pull_request || job.branch || 'no link'}`).join('\n')}`);
  const awaiting = queue.awaiting_owner || [];
  if (awaiting.length) sections.push(`Jobs waiting for you:\n${awaiting.map(job => `- ${name(job)}: ${job.status}`).join('\n')}`);
  const blocked = queue.blocked_recently || [];
  const SHOWN = 5;
  if (blocked.length) sections.push(`Blocked in the last 14 days (retry, re-scope or cancel), newest first:\n${blocked.slice(0, SHOWN).map(job => `- ${name(job)}: ${job.status}`).join('\n')}${blocked.length > SHOWN ? `\n- …and ${blocked.length - SHOWN} more in the Builder queue` : ''}`);
  const merged = queue.merged_awaiting_deploy || [];
  if (merged.length) sections.push(`Merged, waiting on the release lane (no action unless it stalls): ${merged.map(name).join(', ')}`);
  if (!sections.length) return 'Nothing is waiting on you: no pending gates, pull requests, waiting or blocked jobs.';
  if (queue.truncated?.length) sections.push(`Some lists are capped (${queue.truncated.join(', ')}); open the Builder queue for the rest.`);
  return sections.join('\n\n');
}

function builderChatNativeTools(tools) {
  const text = { type: 'string' };
  const custom = {
    list_jobs: { description: 'List recent Builder jobs from the job ledger (newest first).', parameters: { type: 'object', properties: { status: text, limit: { type: 'integer', minimum: 1, maximum: 25 } }, additionalProperties: false } },
    owner_queue: { description: 'Everything waiting on the owner: pending approval gates, published pull requests to review, jobs awaiting a human, and recently blocked jobs. Use for "what is waiting on me" questions.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
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
  const allTools = deps.tools || createBuilderChatTools({ supabase: deps.supabase, workspacePath, limits });
  const intent = statusIntent(message.content);
  const preloadTool = intent ? { owner: 'owner_queue', job: 'job_status', jobs: 'list_jobs' }[intent.kind] : null;
  const statusMode = Boolean(preloadTool && typeof allTools[preloadTool] === 'function');
  const proposeMode = !statusMode && proposeIntent(message.content) && typeof allTools.propose_job === 'function';
  const readPaths = [];
  let proposeNudged = false;
  const tools = statusMode ? Object.fromEntries(LEDGER_TOOLS.filter(name => typeof allTools[name] === 'function').map(name => [name, allTools[name]])) : allTools;
  // The fallback is only as good as the latest ledger read, and only for the question actually asked.
  let ledgerAnswer = null;
  const recordLedger = (tool, result) => {
    if (!statusMode || tool !== preloadTool) return;
    if (tool === 'job_status' && !String(result?.job?.id || '').replace(/-/g, '').startsWith(intent.job.toLowerCase().replace(/-/g, '')) && !String(result?.job?.branch || '').replace(/-/g, '').endsWith(intent.job.toLowerCase().replace(/-/g, ''))) return;
    const formatted = LEDGER_FORMATTERS[tool]?.(result);
    if (formatted) ledgerAnswer = formatted;
  };
  let preloaded = null;
  const preloadArgs = intent?.kind === 'job' ? { job: intent.job } : {};
  if (statusMode) {
    try { preloaded = await allTools[preloadTool](preloadArgs); } catch (error) { preloaded = { error: clip(error && error.message, 300) }; }
    recordLedger(preloadTool, preloaded);
    await store.post(thread.id, { role: 'tool', kind: 'tool', content: `${preloadTool}${preloadArgs.job ? ` ${preloadArgs.job}` : ''}`, payload: { message_id: message.id, tool: preloadTool, ok: !preloaded?.error, preview: clip(JSON.stringify(preloaded), 600), preloaded: true } });
  }
  const ledgerFallback = () => (ledgerAnswer ? { reply: `Straight from the job ledger:\n\n${ledgerAnswer}`, proposal: null, model: null, ledger: true } : null);
  const draftFallback = () => {
    if (!proposeMode) return null;
    const drafted = draftProposalFromBrief(message.content, readPaths);
    return drafted ? { reply: 'The model did not finish its own proposal, so I drafted this one from your brief and the files I read. Check the title and scope before you press Create job.', proposal: drafted, model: null, drafted: true } : null;
  };
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
    proposeMode ? 'THE OWNER ASKED FOR A PROPOSAL. Proposing changes nothing and needs no permission: investigate briefly with the read-only tools, then call propose_job. The owner reviews it and decides with Create job. Never answer that you cannot modify files.' : null,
  ].filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: builderChatSystemPrompt() }, { role: 'user', content: task }];
  if (statusMode) {
    messages.push(
      { role: 'assistant', content: JSON.stringify({ thought: 'This is a status question; read the job ledger.', tool: preloadTool, args: preloadArgs }) },
      { role: 'user', content: clip(JSON.stringify({ tool: preloadTool, result: preloaded, instruction: 'STATUS QUESTION: answer from this ledger result. Only ledger tools (owner_queue, list_jobs, job_status with a job id from above) are available. Do not read code. Reply now unless one job needs job_status detail.' }), limits.readCapChars) },
    );
  }
  const modelRequest = applyVibeRouting(buildModelRunRequest({
    organizationId: 'platform', jobId: thread.id, stepId: message.id, builderMode: 'builder_chat', workloadKind: 'builder_conversation',
    promptVersion: PROMPT_VERSION, systemPrompt: messages[0].content, userPrompt: task, outputSchema: vibeToolSchema(tools),
  }), { allowCloud: deps.allowCloud ?? vibeCloudAllowed() });
  const nativeTools = builderChatNativeTools(tools);
  const health = await (deps.fetchHealth || fetchModelHealth)(gateway);
  const candidates = vibeProviderCandidates(modelRequest, health);
  if (!candidates.length) return ledgerFallback() || { reply: 'No Builder model is available right now, so I could not answer. The model gateway health needs checking.', error: true };
  const callModel = deps.callModel || callModelGateway;
  const started = Date.now();
  let active = 0;
  let unavailable = 0;
  let unparseable = 0;
  let executedTools = 0;
  let claimCorrected = false;
  let proposal = null;
  let failedCalls = 0;
  const repeated = new Map();
  if (statusMode) repeated.set(`${preloadTool}:${JSON.stringify(preloadArgs)}`, 1);
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
  const answerReserveMs = Math.min(90_000, Math.floor(limits.wallBudgetMs / 4));
  for (let turn = 1; turn <= limits.maxTurns && Date.now() - started < limits.wallBudgetMs; turn++) {
    const candidate = candidates[active];
    // The last turn (by count or wall clock) is answer-only, so an investigation that ran long
    // still ends with what Bob found instead of a bare timeout.
    const elapsed = Date.now() - started;
    const final = turn === limits.maxTurns || (turn > 1 && elapsed >= limits.wallBudgetMs - answerReserveMs);
    if (final && !messages.some(entry => entry.final)) {
      messages.push({ role: 'user', final: true, content: JSON.stringify({ instruction: proposeMode && !proposal
        ? 'FINAL TURN: no more investigation. Call propose_job now with a title, a specific task_description built from what you found, and frontend_required/backend_required.'
        : 'FINAL TURN: no more tools. Call reply now with what you found so far, what is still unknown, and the next step you propose.' }) });
    }
    const status = health?.[candidate.provider] || {};
    const maxOutput = Math.min(Number(status.max_output_tokens || 4096), status.num_ctx ? Math.floor(status.num_ctx / 2) : 4096);
    const promptBudget = status.num_ctx ? Math.floor((status.num_ctx - maxOutput - 512) * 3.5) - JSON.stringify(nativeTools).length - 400 : Infinity;
    const baseRequest = providerRequest(modelRequest, candidate, null);
    const request = { ...baseRequest, idempotency_key: `${baseRequest.idempotency_key}::chat-${turn}`, request: { ...baseRequest.request, messages: compactMessages(messages.map(({ final: _final, ...entry }) => entry), { maxChars: promptBudget }), ...(candidate.provider === 'ollama_cloud' || final ? {} : { tools: nativeTools }), max_output_tokens: maxOutput } };
    // Investigation turns may not eat the reserve; the answer turn gets whatever budget remains.
    const timeoutMs = Math.max(5_000, Math.min(limits.turnTimeoutMs, final ? Math.max(answerReserveMs, limits.wallBudgetMs - elapsed) : limits.wallBudgetMs - answerReserveMs - elapsed));
    const response = await callModel({ ...gateway, modelRequest: request, timeoutMs });
    if (!response.ok) {
      const timedOut = response.timeout === true || response.status === 408 || response.code === 'provider_timeout';
      unavailable++;
      if ((timedOut || unavailable >= 2 || [413, 429].includes(response.status)) && await escalate(timedOut ? 'timeout' : 'unavailable', timedOut ? `did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s` : `is unavailable (${clip(response.error, 160)})`)) {
        unavailable = 0; turn--; continue;
      }
      if (unavailable >= 3) return ledgerFallback() || { reply: `The Builder model stopped responding (${clip(response.error, 200)}). Send the message again to retry.`, error: true };
      turn--;
      await new Promise(resolve => setTimeout(resolve, (deps.retryDelayMs ?? 1500) * unavailable));
      continue;
    }
    unavailable = 0;
    const content = String(response.data?.content ?? '');
    let call = parseToolCall(content);
    const prose = content.trim() && !content.trim().startsWith('{') && !/<\/?(?:tool_call|invoke|parameter|function)\b/i.test(content);
    // A required proposal must not escape through plain prose: treat it as a reply so it is nudged or drafted.
    if ((!call || typeof call.tool !== 'string') && prose && proposeMode && !proposal) call = { tool: 'reply', args: { message: content.trim() } };
    if (!call || typeof call.tool !== 'string') {
      unparseable++;
      // Plain prose is still an answer in a chat lane, but never one that claims an action.
      if (prose && !ACTION_CLAIM.test(content)) return { reply: clip(content.trim(), 8000), proposal, model: response.data?.model };
      messages.push({ role: 'assistant', content: content.slice(0, 4000) }, { role: 'user', content: JSON.stringify({ error: 'Reply with ONLY one JSON object {"thought": string, "tool": string, "args": object}. Use reply {message} to answer.' }) });
      if (unparseable >= 2 && await escalate('prose_without_tool', 'did not produce a usable step')) unparseable = 0;
      else if (unparseable >= 4) return ledgerFallback() || { reply: 'I could not produce a usable answer. Please send the request again or narrow it.', error: true };
      continue;
    }
    unparseable = 0;
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    if (final && call.tool !== 'reply' && call.tool !== 'finish' && !(proposeMode && !proposal && call.tool === 'propose_job')) break;
    if (call.tool === 'reply' || call.tool === 'finish') {
      let text = String(args.message || args.summary || call.thought || '').trim() || 'Done.';
      if (proposeMode && !proposal) {
        if (!proposeNudged && !final) {
          proposeNudged = true;
          messages.push({ role: 'assistant', content: JSON.stringify({ tool: call.tool, args }) }, { role: 'user', content: JSON.stringify({
            error: 'Reply refused: the owner asked you to PROPOSE a job. Proposing needs no permission and changes nothing. Call propose_job now with a title, a specific task_description from what you found, and frontend_required/backend_required.',
          }) });
          continue;
        }
        const drafted = draftFallback();
        if (drafted) return { ...drafted, executedTools };
      }
      if (ACTION_CLAIM.test(text) && !claimCorrected) {
        claimCorrected = true;
        messages.push({ role: 'assistant', content: JSON.stringify({ tool: call.tool, args }) }, { role: 'user', content: JSON.stringify({
          error: 'Reply refused: this chat cannot create, start, approve, merge or deploy anything, so do not say it did. If a build is wanted, call propose_job; the owner confirms it in the UI. Otherwise reply with what you found and what you propose.',
        }) });
        continue;
      }
      if (ACTION_CLAIM.test(text)) {
        text = proposal
          ? 'I proposed the job above. Nothing has been created, started, merged or deployed: it starts only when you confirm it with Create job.'
          : 'I cannot create, start, approve, merge or deploy anything from this chat, and nothing has been done. Ask me to propose a Builder job, or check a job\'s real status in the queue.';
      }
      return { reply: clip(text, 8000), proposal, model: response.data?.model, executedTools };
    }
    messages.push({ role: 'assistant', content: JSON.stringify({ thought: clip(call.thought, 1500), tool: call.tool, args }) });
    const key = `${call.tool}:${JSON.stringify(args)}`;
    const count = (repeated.get(key) || 0) + 1;
    repeated.set(key, count);
    let result;
    // A small model re-reading the same ledger is looping, not learning anything new: answer from it.
    if (count > 2 && statusMode && LEDGER_TOOLS.includes(call.tool) && ledgerAnswer) break;
    if (count > 2 && proposeMode && !proposal && proposeNudged) break;
    if (count > 2) result = { error: 'identical call already made; use the earlier result or reply' };
    else if (typeof tools[call.tool] !== 'function') result = { error: statusMode && typeof allTools[call.tool] === 'function' ? `${call.tool} is not used for status questions; answer from the ledger result above with reply` : `unknown tool ${call.tool}; available: ${Object.keys(tools).join(', ')}, reply` };
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
    if (!result?.error) recordLedger(call.tool, result);
    if (!result?.error && ['read_file', 'outline', 'list_dir'].includes(call.tool) && typeof args.path === 'string') readPaths.push(args.path);
    if (proposeMode && !proposal && !proposeNudged && (count > 2 || executedTools >= 6)) {
      proposeNudged = true;
      result = { ...(result && typeof result === 'object' ? result : { result }), instruction: 'Enough investigation for a proposal. Call propose_job now with what you found; the specification gate checks the details.' };
    }
    failedCalls = result?.error ? failedCalls + 1 : 0;
    if (failedCalls >= 3) {
      failedCalls = 0;
      result = { ...result, instruction: statusMode
        ? 'Three tool calls in a row failed. The ledger result above already answers this status question: reply with it now.'
        : 'Three tool calls in a row failed. Stop guessing: use search or list_dir to locate what you need, or reply now with what you already know.' };
    }
    messages.push({ role: 'user', content: clip(JSON.stringify({ tool: call.tool, result }), limits.readCapChars) });
  }
  if (proposal) return { reply: 'I have proposed the job above for your confirmation.', proposal };
  return ledgerFallback() || draftFallback() || { reply: 'I ran out of time on this one before reaching an answer. Ask again with a narrower question.', error: true };
}

async function retry(fn, attempts = 3, delayMs = 500) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}

async function processBuilderChatMessage({ store, message, deps, limits = BUILDER_CHAT_LIMITS }) {
  try {
    const thread = await store.thread(message.thread_id);
    if (!thread || thread.status === 'closed') { await retry(() => store.complete(message.id, 'failed'), 3, deps.retryDelayMs ?? 500); return { skipped: true }; }
    await store.updateThread(thread.id, { status: 'working' });
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
    await store.post(message.thread_id, { role: 'bob', kind: 'error', content: `Something went wrong: ${detail}`, payload: { message_id: message.id } }).catch(() => {});
    await store.updateThread(message.thread_id, { status: 'open' }).catch(() => {});
    // An unreleased claim would block later turns and VPS deploys until restart, so retry the release.
    await retry(() => store.complete(message.id, 'failed'), 3, deps.retryDelayMs ?? 500).catch(() => {});
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
  isStatusQuestion, statusIntent, proposeIntent, draftProposalFromBrief, formatOwnerQueue, formatJobStatus, formatJobList,
};
