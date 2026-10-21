'use strict';

// Bob Builder vibe sessions: the owner talks, Bob codes on one live branch per session.
// The browser writes owner turns through governed RPCs (builder_vibe_send); this worker
// claims them with the service role, runs a conversational tool loop in the session's
// worktree, streams every step back as builder_vibe_messages rows (Realtime), commits each
// turn so it can be undone, and on "ship" pushes the branch and opens a pull request.
// It never touches main, never merges, and never deploys.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTools, parseToolCall, compactMessages } = require('./builder-agentic-engineer');
const { isProtectedPath, protectedReason, normalizeRepoPath } = require('./builder-path-policy');
const { VIBE_BRANCH_PREFIX, builderCommitIdentity, redactGitError } = require('./builder-branch-workspace');
const { buildModelRunRequest, callModelGateway, fetchModelHealth, selectProviders, providerRequest } = require('./supabase/functions/_shared/builder-model-adapter');

const PROMPT_VERSION = 'vibe-v1';
const VIBE_LIMITS = Object.freeze({
  maxTurns: Math.max(6, Number(process.env.BOB_VIBE_TURNS || 40)),
  wallBudgetMs: Math.max(60_000, Number(process.env.BOB_VIBE_BUDGET_MS || 20 * 60_000)),
  readCapChars: 30_000,
  searchCapLines: 150,
  listCapEntries: 300,
  runCapChars: 12_000,
  runTimeoutMs: 8 * 60_000,
  turnTimeoutMs: Math.max(60_000, Number(process.env.BOB_BUILDER_TURN_TIMEOUT_MS || 300_000)),
  maxPatchBytes: 2 * 1024 * 1024,
});
const HISTORY_MESSAGES = 30;
const STREAM_PREVIEW_CHARS = 1500;

const id8 = sessionId => String(sessionId).replace(/-/g, '').slice(0, 8).toLowerCase();
const vibeBranchName = sessionId => `${VIBE_BRANCH_PREFIX}${id8(sessionId)}`;
function vibeWorkspacePath(workspaceRoot, sessionId) {
  const root = path.resolve(workspaceRoot, 'vibe');
  const target = path.join(root, `vibe-${id8(sessionId)}`);
  if (!/^[0-9a-f]{8}$/.test(id8(sessionId)) || path.dirname(target) !== root) throw new Error('vibe session id is invalid');
  return target;
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (error) {
    throw new Error(redactGitError(error && (error.stderr || error.message)));
  }
}

const clip = (text, cap) => {
  const value = String(text ?? '');
  return value.length <= cap ? value : `${value.slice(0, cap)}\n[… ${value.length - cap} more chars]`;
};

function vibeSystemPrompt(limits = VIBE_LIMITS) {
  return [
    'You are Bob Builder in a live vibe-coding session with the platform owner of Field Compliance Manager (multi-tenant field-compliance SaaS: React/Vite web app in apps/web, Supabase edge functions in supabase/functions, Node control-plane modules at the repo root, tests in test/ and apps/web).',
    'The owner describes what they want in plain language. You make it real in your worktree, the way a senior engineer pairing with them would: understand, change, verify, then reply briefly in plain language.',
    'WORKING RULES:',
    '- Read before you write: search / outline / read_file the code you will change; check the live Atlas (atlas, live_count) before touching a shared table, RPC or edge function. Never invent tables, columns or behaviour; verify against supabase/schema.sql.',
    '- Make the smallest change that does what the owner asked. Prefer replace_in_file. Keep existing conventions, accessibility, loading/empty/error states.',
    '- Verify: run the relevant tests (node --test test/<file>.test.js, npm run test --prefix apps/web -- <pattern>, npm run lint|build --prefix apps/web) and fix failures you caused.',
    '- If the request is ambiguous or risky, ask ONE short question with reply instead of guessing. If the owner is just chatting or asking a question, answer with reply without editing.',
    '- Protected paths (CI workflows, deploy/, Dockerfiles, package manifests/lockfiles, .env/secrets, supabase/schema.sql, auth/identity code) are refused: tell the owner which file needs a human instead. Migrations must be NEW additive files under supabase/migrations; they are NOT applied by you.',
    '- Each of your turns is committed to the session branch automatically; the owner can undo it, preview it live, and ship it as a pull request. You never merge or deploy. Never claim a deployment, migration application or live write.',
    '',
    'Reply with ONLY one JSON object per message: {"thought": string, "tool": string, "args": object}.',
    'TOOLS:',
    '- list_dir {path} | read_file {path, start_line?, end_line?} | outline {path, pattern?} | search {query, path?, regex?, context?} | git_log {path?, limit?} | git_diff {}',
    '- write_file {path, content} | replace_in_file {path, old_text, new_text, all?} | apply_patch {diff} | delete_file {path}',
    `- run {command}  allowed: node --test [test files], node --check <file>, npm run lint|build --prefix apps/web, npm run test --prefix apps/web -- <pattern>, git status|diff|log|show|blame (timeout ${Math.round(limits.runTimeoutMs / 60000)} min)`,
    '- atlas {action: capability_map|terrain_edges|gap_report|blast_radius, name?, type?, direction?, depth?, limit?}  live build map (flow_reach and fk_reach are different truths)',
    '- live_count {table, column?, equals?}  aggregate row counts only',
    '- read_canon {} | read_notes {limit?} | write_note {text}',
    '- reply {message}  END YOUR TURN: tell the owner, in a few plain sentences, what you changed (files), what you verified, and anything they should check in the preview. Use markdown sparingly.',
  ].join('\n');
}

function describeArgs(tool, args) {
  if (tool === 'write_file') return { path: args.path, bytes: Buffer.byteLength(String(args.content ?? '')) };
  if (tool === 'replace_in_file') return { path: args.path, all: args.all === true };
  if (tool === 'apply_patch') return { bytes: Buffer.byteLength(String(args.diff ?? '')) };
  if (tool === 'write_note') return { bytes: Buffer.byteLength(String(args.text ?? '')) };
  return args;
}

function toolHeadline(tool, args) {
  const target = args.path || args.query || args.command || args.name || args.table || '';
  const verbs = { list_dir: 'Listing', read_file: 'Reading', outline: 'Outlining', search: 'Searching', git_log: 'Checking history', git_diff: 'Reviewing diff', write_file: 'Writing', replace_in_file: 'Editing', apply_patch: 'Patching', delete_file: 'Deleting', run: 'Running', atlas: 'Querying Atlas', live_count: 'Counting live rows', read_canon: 'Reading the canon', read_notes: 'Reading notes', write_note: 'Saving a note' };
  return `${verbs[tool] || tool}${target ? ` ${String(target).slice(0, 160)}` : ''}`;
}

function resultPreview(result) {
  if (!result || typeof result !== 'object') return clip(result, STREAM_PREVIEW_CHARS);
  if (result.error) return clip(result.error, STREAM_PREVIEW_CHARS);
  if (typeof result.exit_code !== 'undefined') return clip(`exit ${result.exit_code}${result.timed_out ? ' (timed out)' : ''}\n${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`, STREAM_PREVIEW_CHARS);
  return clip(JSON.stringify(result), STREAM_PREVIEW_CHARS);
}

function createVibeStore(supabase) {
  return {
    async claimNext() {
      const { data, error } = await supabase.rpc('builder_vibe_claim_next');
      if (error) throw new Error(`claim failed: ${error.message}`);
      return Array.isArray(data) ? data[0] || null : data || null;
    },
    async session(sessionId) {
      const { data, error } = await supabase.from('builder_vibe_sessions').select('*').eq('id', sessionId).maybeSingle();
      if (error) throw new Error(`session read failed: ${error.message}`);
      return data;
    },
    async updateSession(sessionId, patch) {
      const { error } = await supabase.from('builder_vibe_sessions').update({ ...patch, updated_at: new Date().toISOString(), last_activity_at: new Date().toISOString() }).eq('id', sessionId);
      if (error) throw new Error(`session update failed: ${error.message}`);
    },
    async post(sessionId, row) {
      const { error } = await supabase.from('builder_vibe_messages').insert({ session_id: sessionId, role: 'bob', kind: 'message', payload: {}, ...row, content: clip(row.content, 39_000) });
      if (error) throw new Error(`message insert failed: ${error.message}`);
    },
    async complete(messageId, status) {
      const { error } = await supabase.from('builder_vibe_messages').update({ status, completed_at: new Date().toISOString() }).eq('id', messageId);
      if (error) throw new Error(`message completion failed: ${error.message}`);
    },
    async history(sessionId, beforeSeq) {
      const { data, error } = await supabase.from('builder_vibe_messages').select('role, kind, content, seq').eq('session_id', sessionId)
        .in('role', ['owner', 'bob']).eq('kind', 'message').lt('seq', beforeSeq).order('seq', { ascending: false }).limit(HISTORY_MESSAGES);
      if (error) throw new Error(`history read failed: ${error.message}`);
      return (data || []).reverse();
    },
    async releaseStaleClaims(olderThanMs = 45 * 60_000) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      await supabase.from('builder_vibe_messages').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('status', 'claimed').lt('claimed_at', cutoff);
    },
  };
}

// One worktree per session on bob/vibe-<id8>, created from the current main the first time.
function ensureVibeWorkspace({ workspaceRoot, session, sourceDirFor, resolveHead }) {
  const workspacePath = vibeWorkspacePath(workspaceRoot, session.id);
  const branch = vibeBranchName(session.id);
  if (fs.existsSync(path.join(workspacePath, '.git'))) {
    if (git(workspacePath, ['branch', '--show-current']) !== branch) throw new Error('vibe workspace is on an unexpected branch');
    return { workspacePath, branch, baseSha: session.base_sha, created: false, recovered: false };
  }
  const baseSha = session.base_sha || resolveHead();
  if (!/^[0-9a-f]{40}$/.test(String(baseSha))) throw new Error('could not resolve the main head for the vibe branch');
  const sourceDir = sourceDirFor(baseSha);
  fs.mkdirSync(path.dirname(workspacePath), { recursive: true, mode: 0o700 });
  try { git(sourceDir, ['worktree', 'prune']); } catch { /* best effort */ }
  git(sourceDir, ['worktree', 'add', '--force', '-B', branch, workspacePath, baseSha]);
  return { workspacePath, branch, baseSha, created: true, recovered: Boolean(session.base_sha && session.head_sha && session.head_sha !== session.base_sha) };
}

function commitTurn({ workspacePath, message, identity }) {
  git(workspacePath, ['add', '-A']);
  if (!git(workspacePath, ['diff', '--cached', '--name-only'])) return null;
  const subject = `vibe: ${String(message || 'update').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 64) || 'update'}`;
  git(workspacePath, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', subject, '-m', 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>']);
  return git(workspacePath, ['rev-parse', 'HEAD']);
}

// Anything a run produced that the policy refuses (or the model wrote around it) never reaches a commit.
function revertRefusedChanges(tools, workspacePath) {
  const refused = [];
  for (const file of tools.__changedFiles()) {
    const normalized = normalizeRepoPath(file.replace(/\/$/, ''));
    if (!normalized || isProtectedPath(normalized)) {
      refused.push({ file, reason: normalized ? protectedReason(normalized) : 'unsafe path' });
      try { git(workspacePath, ['checkout', '--', file]); } catch { fs.rmSync(path.resolve(workspacePath, file), { recursive: true, force: true }); }
    }
  }
  return refused;
}

function branchState(workspacePath, baseSha) {
  const head = git(workspacePath, ['rev-parse', 'HEAD']);
  const files = baseSha ? git(workspacePath, ['diff', '--name-only', `${baseSha}..HEAD`]).split('\n').filter(Boolean) : [];
  const commits = baseSha ? git(workspacePath, ['log', '--format=%h %s', `${baseSha}..HEAD`]).split('\n').filter(Boolean) : [];
  return { head, files, commits };
}

async function runConversation({ store, session, message, workspacePath, branch, baseSha, gateway, deps, limits }) {
  const supabase = deps.supabase;
  const tools = createTools({ workspacePath, repoRoot: workspacePath, lane: 'fullstack', supabase, limits, log: () => {} });
  const history = await store.history(session.id, message.seq);
  const state = branchState(workspacePath, baseSha);
  const transcript = history.map(entry => `${entry.role === 'owner' ? 'OWNER' : 'BOB'}: ${clip(entry.content, 3000)}`).join('\n\n');
  const task = [
    `SESSION: ${session.title} (branch ${branch}, based on main ${String(baseSha).slice(0, 10)})`,
    state.commits.length ? `BRANCH SO FAR (${state.commits.length} commit(s)):\n${state.commits.slice(0, 20).join('\n')}\nFiles changed vs main: ${state.files.slice(0, 40).join(', ')}` : 'BRANCH SO FAR: no changes yet.',
    transcript ? `CONVERSATION SO FAR:\n${transcript}` : 'CONVERSATION SO FAR: (this is the first message)',
    `OWNER NOW SAYS:\n${message.content}`,
  ].join('\n\n');
  const messages = [{ role: 'system', content: vibeSystemPrompt(limits) }, { role: 'user', content: task }];
  const baseRequest = buildModelRunRequest({
    organizationId: 'platform', jobId: session.id, stepId: message.id, builderMode: 'vibe_engineer', workloadKind: 'vibe_implementation',
    promptVersion: PROMPT_VERSION, systemPrompt: messages[0].content, userPrompt: task, outputSchema: { type: 'object', required: ['tool', 'args'] },
  });
  const health = await (deps.fetchHealth || fetchModelHealth)(gateway);
  const candidates = selectProviders(baseRequest, { health });
  if (!candidates.length) return { reply: 'No model provider is available right now, so I could not work on this. The model gateway health needs checking.', error: true, tools };
  const callModel = deps.callModel || callModelGateway;
  const started = Date.now();
  let active = 0;
  let unparseable = 0;
  let unavailable = 0;
  for (let turn = 1; turn <= limits.maxTurns && Date.now() - started < limits.wallBudgetMs; turn++) {
    const candidate = candidates[active];
    const status = health?.[candidate.provider] || {};
    const maxOutput = Math.min(Number(status.max_output_tokens || 8192), status.num_ctx ? Math.floor(status.num_ctx / 2) : 8192);
    const promptBudget = status.num_ctx ? Math.floor((status.num_ctx - maxOutput - 512) * 3.5) : Infinity;
    const base = providerRequest(baseRequest, candidate, null);
    const request = { ...base, idempotency_key: `${base.idempotency_key}::vibe-${turn}`, request: { ...base.request, messages: compactMessages(messages, { maxChars: promptBudget }), max_output_tokens: maxOutput } };
    const response = await callModel({ ...gateway, modelRequest: request, timeoutMs: limits.turnTimeoutMs });
    if (!response.ok) {
      unavailable++;
      if (active + 1 < candidates.length && (unavailable >= 2 || [413, 429].includes(response.status))) { active++; unavailable = 0; turn--; continue; }
      if (unavailable >= 3) return { reply: `The model stopped responding (${clip(response.error, 200)}). Your branch keeps whatever was done so far; send another message to continue.`, error: true, tools };
      turn--;
      await new Promise(resolve => setTimeout(resolve, 1500 * unavailable));
      continue;
    }
    unavailable = 0;
    const content = String(response.data?.content ?? '');
    const call = parseToolCall(content);
    if (!call || typeof call.tool !== 'string') {
      // A conversational model that answers in prose is still answering the owner.
      unparseable++;
      if (content.trim() && !content.trim().startsWith('{') && unparseable >= 2) return { reply: clip(content.trim(), 8000), tools, model: response.data?.model };
      messages.push({ role: 'assistant', content: content.slice(0, 4000) }, { role: 'user', content: JSON.stringify({ error: 'Reply with ONLY one JSON object: {"thought": string, "tool": string, "args": object}. Use reply {message} to answer the owner.' }) });
      if (unparseable >= 4) return { reply: 'I could not produce a usable step. Please rephrase or narrow the request.', error: true, tools };
      continue;
    }
    unparseable = 0;
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    if (call.tool === 'reply' || call.tool === 'finish') {
      return { reply: clip(args.message || args.summary || call.thought || 'Done.', 8000), tools, model: response.data?.model };
    }
    messages.push({ role: 'assistant', content: JSON.stringify({ thought: String(call.thought ?? '').slice(0, 1500), tool: call.tool, args }) });
    let result;
    if (typeof tools[call.tool] === 'function' && !call.tool.startsWith('__')) {
      try { result = await tools[call.tool](args); } catch (error) { result = { error: clip(redactGitError(error && error.message), 1500) }; }
    } else {
      result = { error: `unknown tool ${call.tool}` };
    }
    await store.post(session.id, {
      role: 'tool', kind: call.tool === 'run' ? 'test' : 'tool', content: toolHeadline(call.tool, args),
      payload: { tool: call.tool, thought: String(call.thought ?? '').slice(0, 600), args: describeArgs(call.tool, args), ok: !result?.error, preview: resultPreview(result), turn },
    });
    const remaining = limits.maxTurns - turn;
    messages.push({ role: 'user', content: JSON.stringify(remaining <= 3 ? { tool_result: result, budget: `${remaining} step(s) left: verify and reply now.` } : { tool_result: result }) });
  }
  return { reply: 'I ran out of steps for this message. What I changed so far is kept on the branch; say "continue" to carry on.', tools, budget: true };
}

async function shipSession({ store, session, workspacePath, branch, baseSha, deps }) {
  const state = branchState(workspacePath, baseSha);
  if (!state.commits.length) return { reply: 'There is nothing to ship yet: the branch has no changes from main.' };
  builderCommitIdentity({ requireVerified: true });
  await store.updateSession(session.id, { status: 'shipping' });
  await deps.publish({ workspacePath, branch, head: state.head });
  let prUrl = session.pr_url;
  let prNumber = session.pr_number;
  if (!prUrl) {
    const body = [
      `Opened from a Bob Builder vibe session (\`${session.id}\`) at the owner's request.`,
      '', '### Commits', ...state.commits.map(line => `- ${line}`),
      '', '### Files', ...state.files.map(file => `- \`${file}\``),
      '', 'Review before merge. Vibe sessions never merge or deploy on their own; migrations in this branch are not applied.',
    ].join('\n');
    const pr = await deps.openPullRequest({ workspacePath, branch, head: state.head, title: session.title, body });
    prUrl = pr.url;
    prNumber = pr.number;
  }
  await store.updateSession(session.id, { status: 'shipped', head_sha: state.head, changed_files: state.files, pr_url: prUrl, pr_number: prNumber });
  return { reply: `${session.pr_url ? 'Pushed the latest changes to' : 'Opened'} pull request ${prUrl} with ${state.commits.length} commit(s) across ${state.files.length} file(s). It needs review and a merge before it goes live.`, payload: { pr_url: prUrl, pr_number: prNumber } };
}

function revertLastTurn({ workspacePath, baseSha }) {
  const head = git(workspacePath, ['rev-parse', 'HEAD']);
  if (!baseSha || head === baseSha) return { reply: 'Nothing to undo: the branch is back at main.' };
  const subject = git(workspacePath, ['log', '-1', '--format=%s']);
  git(workspacePath, ['reset', '--hard', 'HEAD~1']);
  git(workspacePath, ['clean', '-fd']);
  return { reply: `Undid the last change ("${subject}").` };
}

async function processVibeMessage({ store, message, deps, limits = VIBE_LIMITS }) {
  let session = await store.session(message.session_id);
  if (!session || session.status === 'closed') { await store.complete(message.id, 'failed'); return { skipped: true }; }
  const action = message.payload?.action || 'message';
  await store.updateSession(session.id, { status: 'working' });
  let outcome;
  try {
    const ws = ensureVibeWorkspace({ workspaceRoot: deps.workspaceRoot, session, sourceDirFor: deps.sourceDirFor, resolveHead: deps.resolveHead });
    if (deps.prepareWorkspace) await deps.prepareWorkspace(ws.workspacePath);
    if (ws.created) {
      await store.updateSession(session.id, { base_sha: ws.baseSha, branch: ws.branch, head_sha: ws.baseSha });
      await store.post(session.id, { role: 'system', kind: 'status', content: ws.recovered ? `The session workspace was missing, so the branch was recreated from main ${ws.baseSha.slice(0, 10)}; earlier unshipped changes are not in it.` : `Working on branch ${ws.branch} from main ${ws.baseSha.slice(0, 10)}.` });
      session = { ...session, base_sha: ws.baseSha, branch: ws.branch };
    }
    if (action === 'ship') {
      outcome = await shipSession({ store, session, workspacePath: ws.workspacePath, branch: ws.branch, baseSha: ws.baseSha, deps });
    } else if (action === 'revert') {
      outcome = revertLastTurn({ workspacePath: ws.workspacePath, baseSha: ws.baseSha });
    } else {
      await store.post(session.id, { role: 'bob', kind: 'thinking', content: 'Working on it…', payload: { message_id: message.id } });
      const result = await runConversation({ store, session, message, workspacePath: ws.workspacePath, branch: ws.branch, baseSha: ws.baseSha, gateway: deps.gateway, deps, limits });
      const refused = revertRefusedChanges(result.tools, ws.workspacePath);
      const commit = commitTurn({ workspacePath: ws.workspacePath, message: message.content, identity: builderCommitIdentity() });
      if (commit) {
        const stat = git(ws.workspacePath, ['show', '--stat', '--format=', commit]);
        const diff = git(ws.workspacePath, ['show', '--format=', commit]);
        await store.post(session.id, { role: 'bob', kind: 'diff', content: stat, payload: { commit, diff: clip(diff, 30_000), files: git(ws.workspacePath, ['show', '--name-only', '--format=', commit]).split('\n').filter(Boolean) } });
      }
      if (refused.length) await store.post(session.id, { role: 'system', kind: 'error', content: `Refused and reverted protected changes: ${refused.map(entry => `${entry.file} (${entry.reason})`).join('; ')}` });
      outcome = { reply: result.reply, error: result.error, payload: { model: result.model || null, commit } };
    }
    const state = branchState(ws.workspacePath, ws.baseSha);
    const status = session.pr_url || outcome.payload?.pr_url ? 'shipped' : 'open';
    await store.updateSession(session.id, { status, head_sha: state.head, changed_files: state.files });
    await store.post(session.id, { role: 'bob', kind: outcome.error ? 'error' : 'message', content: outcome.reply, payload: outcome.payload || {} });
    await store.complete(message.id, outcome.error ? 'failed' : 'done');
    if (state.head && deps.onHeadChanged) deps.onHeadChanged(session.id);
    return outcome;
  } catch (error) {
    const detail = clip(redactGitError(error && error.message), 600);
    await store.post(session.id, { role: 'bob', kind: 'error', content: `Something went wrong: ${detail}` }).catch(() => {});
    await store.updateSession(session.id, { status: session.pr_url ? 'shipped' : 'open' }).catch(() => {});
    await store.complete(message.id, 'failed').catch(() => {});
    return { error: detail };
  }
}

function createVibeWorker({ supabase, deps, intervalMs = 3000, log = console }) {
  const store = createVibeStore(supabase);
  let running = false;
  let timer = null;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (let claimed = await store.claimNext(); claimed; claimed = await store.claimNext()) {
        await processVibeMessage({ store, message: claimed, deps: { ...deps, supabase } });
      }
    } catch (error) {
      log.error?.(`vibe worker: ${redactGitError(error && error.message)}`);
    } finally {
      running = false;
    }
  };
  return {
    store,
    tick,
    start() {
      // This process is the only vibe worker: a claim left over from before a restart is orphaned.
      store.releaseStaleClaims(0).catch(() => {});
      timer = setInterval(() => { tick(); }, intervalMs);
      timer.unref?.();
      setTimeout(() => { tick(); }, 2000).unref?.();
    },
    stop() { if (timer) clearInterval(timer); },
  };
}

module.exports = { PROMPT_VERSION, VIBE_LIMITS, vibeBranchName, vibeWorkspacePath, vibeSystemPrompt, ensureVibeWorkspace, commitTurn, revertLastTurn, revertRefusedChanges, branchState, createVibeStore, runConversation, shipSession, processVibeMessage, createVibeWorker };
