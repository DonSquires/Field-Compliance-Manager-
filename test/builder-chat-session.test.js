'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const chat = require('../builder-chat-session');

const THREAD_ID = '6f1d2c3b-0000-4000-8000-000000000001';

function memoryStore(thread = { id: THREAD_ID, status: 'open', title: 'Bob Builder chat' }) {
  const rows = [];
  const state = { thread: { ...thread }, completed: {}, history: [] };
  return {
    rows, state,
    async thread() { return state.thread ? { ...state.thread } : null; },
    async updateThread(_id, patch) { Object.assign(state.thread, patch); },
    async post(_id, row) { rows.push({ seq: rows.length + 100, ...row }); },
    async complete(id, status) { state.completed[id] = status; },
    async history() { return state.history; },
  };
}

function scriptedModel(steps) {
  const calls = [];
  return {
    calls,
    async callModel({ modelRequest }) {
      calls.push(modelRequest);
      const next = steps.shift();
      if (next && next.fail) return { ok: false, ...next.fail };
      if (!next) return { ok: true, data: { content: JSON.stringify({ tool: 'reply', args: { message: 'Done.' } }) } };
      return { ok: true, data: { content: typeof next === 'string' ? next : JSON.stringify(next), model: 'test-model' } };
    },
  };
}

function setup(steps, extra = {}) {
  const store = memoryStore();
  const model = scriptedModel(steps);
  const toolCalls = [];
  const tools = {
    search: async args => { toolCalls.push(['search', args]); return { matches: 1, results: ['apps/web/src/pages/DispatchConsolePage.css:12'] }; },
    list_jobs: async () => { toolCalls.push(['list_jobs']); return { jobs: [{ id: 'f2a6362e', title: 'Dispatch tokens', status: 'deployed' }] }; },
    propose_job: args => chat.validateProposal(args),
  };
  const deps = {
    workspacePath: '/nonexistent/read-only', head: 'a'.repeat(40),
    gateway: { gatewayUrl: 'http://gateway.invalid', apiToken: 'x' },
    fetchHealth: async () => null, callModel: model.callModel, tools, retryDelayMs: 0, ...extra,
  };
  return { store, model, deps, toolCalls };
}

const ownerMessage = (content, context = {}) => ({ id: `m-${Math.random()}`, seq: 10, thread_id: THREAD_ID, role: 'owner', content, payload: { context } });

const PROPOSAL = {
  title: 'CCTV review: move to shared dark tokens',
  task_description: 'Replace the hard-coded colour literals in apps/web/src/pages/CctvReviewPage.css with the existing shared dark tokens. Do not change layout or behaviour.',
  frontend_required: true, backend_required: false, rationale: 'Matches the Dispatch console token migration.',
};

test('the Builder chat prompt keeps it separate from in-app Bob and forbids claiming actions', () => {
  const prompt = chat.builderChatSystemPrompt();
  assert.match(prompt, /separate from in-app Bob/);
  assert.match(prompt, /OnSpace AI chat/);
  assert.match(prompt, /never touch tenant data/);
  assert.match(prompt, /cannot edit files, create or cancel jobs, approve gates, merge or deploy/);
});

test('a question is answered after a read-only tool, with the tool step recorded', async () => {
  const { store, model, deps, toolCalls } = setup([
    { thought: 'find it', tool: 'search', args: { query: 'dispatch-console' } },
    { tool: 'reply', args: { message: 'The Dispatch console styles live in DispatchConsolePage.css.' } },
  ]);
  const message = ownerMessage('Where are the dispatch console styles?', { surface: 'builder_control_room', job_id: 'f2a6362e' });
  const outcome = await chat.processBuilderChatMessage({ store, message, deps });
  assert.equal(outcome.error, undefined);
  assert.deepEqual(toolCalls, [['search', { query: 'dispatch-console' }]]);
  assert.equal(store.state.completed[message.id], 'done');
  assert.equal(store.state.thread.status, 'open');
  const kinds = store.rows.map(row => row.kind);
  assert.deepEqual(kinds, ['thinking', 'tool', 'message']);
  assert.match(store.rows.at(-1).content, /DispatchConsolePage\.css/);
  const firstRequest = model.calls[0].request;
  assert.equal(firstRequest.builder_mode, 'builder_chat');
  assert.match(firstRequest.messages[1].content, /BUILDER PAGE CONTEXT.*job_id=f2a6362e/);
  assert.ok(firstRequest.tools.some(tool => tool.function.name === 'propose_job'));
  assert.ok(!firstRequest.tools.some(tool => ['write_file', 'replace_in_file', 'apply_patch', 'run', 'finish'].includes(tool.function.name)));
});

test('a proposed job is posted for owner confirmation and never created by the worker', async () => {
  const { store, deps } = setup([
    { tool: 'list_jobs', args: {} },
    { tool: 'propose_job', args: PROPOSAL },
    { tool: 'reply', args: { message: 'I propose the CCTV token job above; confirm it to start.' } },
  ]);
  const message = ownerMessage('Queue the CCTV review token migration');
  await chat.processBuilderChatMessage({ store, message, deps });
  const proposal = store.rows.find(row => row.kind === 'proposal');
  assert.ok(proposal, 'a proposal row is posted');
  assert.deepEqual(proposal.payload.proposal, { ...PROPOSAL });
  assert.equal(proposal.payload.proposal.frontend_required, true);
  assert.equal(proposal.payload.job_id, undefined);
  assert.equal(store.rows.at(-1).kind, 'message');
  assert.equal(store.state.completed[message.id], 'done');
});

test('an invalid proposal is returned to the model as an error, not posted', async () => {
  const { store, model, deps } = setup([
    { tool: 'propose_job', args: { ...PROPOSAL, frontend_required: false, backend_required: false } },
    { tool: 'propose_job', args: PROPOSAL },
    { tool: 'reply', args: { message: 'Proposed.' } },
  ]);
  await chat.processBuilderChatMessage({ store, message: ownerMessage('Build it'), deps });
  assert.equal(store.rows.filter(row => row.kind === 'proposal').length, 1);
  assert.match(model.calls[1].request.messages.at(-1).content, /frontend_required and\/or backend_required/);
});

test('a reply claiming it created a job is refused once, then replaced if repeated', async () => {
  const refusedOnce = setup([
    { tool: 'reply', args: { message: "I've created the Builder job for the CCTV page." } },
    { tool: 'reply', args: { message: 'I can propose a CCTV token job if you want it.' } },
  ]);
  await chat.processBuilderChatMessage({ store: refusedOnce.store, message: ownerMessage('Do the CCTV page'), deps: refusedOnce.deps });
  assert.equal(refusedOnce.store.rows.at(-1).content, 'I can propose a CCTV token job if you want it.');
  assert.match(refusedOnce.model.calls[1].request.messages.at(-1).content, /cannot create, start, approve, merge or deploy/);

  const repeated = setup([
    { tool: 'reply', args: { message: 'I started the job.' } },
    { tool: 'reply', args: { message: 'I have opened a pull request for it.' } },
  ]);
  await chat.processBuilderChatMessage({ store: repeated.store, message: ownerMessage('Do it'), deps: repeated.deps });
  const finalReply = repeated.store.rows.at(-1).content;
  assert.doesNotMatch(finalReply, /opened a pull request/);
  assert.doesNotMatch(finalReply, chat.ACTION_CLAIM);
  assert.match(finalReply, /nothing has been done/);

  const merged = setup([
    { tool: 'propose_job', args: PROPOSAL },
    { tool: 'reply', args: { message: 'I have merged the pull request.' } },
    { tool: 'reply', args: { message: 'I have merged the pull request.' } },
  ]);
  await chat.processBuilderChatMessage({ store: merged.store, message: ownerMessage('Ship it'), deps: merged.deps });
  assert.ok(merged.store.rows.some(row => row.kind === 'proposal'), 'a valid proposal is kept');
  assert.doesNotMatch(merged.store.rows.at(-1).content, /merged the pull request/);
  assert.match(merged.store.rows.at(-1).content, /starts only when you confirm it/);
});

test('a thread the owner closes mid-turn is not reopened by the worker', async () => {
  const { store, deps } = setup([{ tool: 'reply', args: { message: 'Answer.' } }]);
  const real = store.updateThread;
  let closedDuringTurn = false;
  store.updateThread = async (id, patch) => {
    if (store.state.thread.status === 'closed') return; // mirrors .neq('status', 'closed')
    await real(id, patch);
    if (patch.status === 'working' && !closedDuringTurn) { closedDuringTurn = true; store.state.thread.status = 'closed'; }
  };
  await chat.processBuilderChatMessage({ store, message: ownerMessage('Hello'), deps });
  assert.equal(store.state.thread.status, 'closed');
});

test('a failure before the turn starts still releases the claim, retrying the release', async () => {
  const { store, deps } = setup([]);
  store.thread = async () => { throw new Error('thread read failed: network'); };
  let attempts = 0;
  store.complete = async (id, status) => { attempts++; if (attempts < 2) throw new Error('transient'); store.state.completed[id] = status; };
  const message = ownerMessage('Hello');
  const outcome = await chat.processBuilderChatMessage({ store, message, deps });
  assert.match(outcome.error, /network/);
  assert.equal(store.state.completed[message.id], 'failed');
  assert.equal(attempts, 2);
});

test('history includes Bob replies posted after this turn was queued, and the store never reopens closed threads', async () => {
  const calls = [];
  const awaited = { data: [], error: null };
  const query = new Proxy({}, { get: (_t, name) => name === 'then' ? (resolve => resolve(awaited)) : (...args) => { calls.push([name, ...args]); return query; } });
  const store = chat.createBuilderChatStore({ from: () => query });
  await store.history(THREAD_ID, 42);
  const or = calls.find(([name]) => name === 'or');
  assert.equal(or[1], 'and(role.eq.owner,seq.lt.42),role.eq.bob');
  assert.ok(!calls.some(([name]) => name === 'lt'), 'Bob replies are not cut off by sequence');
  calls.length = 0;
  await store.updateThread(THREAD_ID, { status: 'open' });
  assert.deepEqual(calls.find(([name]) => name === 'neq'), ['neq', 'status', 'closed']);
});

test('ordinary investigation wording is not treated as an action claim', () => {
  assert.doesNotMatch('I opened the file and read the CSS.', chat.ACTION_CLAIM);
  assert.doesNotMatch('I propose a job that migrates the tokens.', chat.ACTION_CLAIM);
  assert.match('I have merged the pull request.', chat.ACTION_CLAIM);
  assert.match('Bob has queued the job.', chat.ACTION_CLAIM);
});

test('plain prose is an answer unless it claims an action', async () => {
  const prose = setup(['The Builder has three gates: specification, implementation and release.']);
  await chat.processBuilderChatMessage({ store: prose.store, message: ownerMessage('What gates does a job pass?'), deps: prose.deps });
  assert.equal(prose.store.rows.at(-1).kind, 'message');
  assert.match(prose.store.rows.at(-1).content, /three gates/);

  const claim = setup(['I deployed the release.', { tool: 'reply', args: { message: 'Nothing has been deployed by this chat.' } }]);
  await chat.processBuilderChatMessage({ store: claim.store, message: ownerMessage('Deploy?'), deps: claim.deps });
  assert.equal(claim.store.rows.at(-1).content, 'Nothing has been deployed by this chat.');
});

test('a model timeout escalates to the next candidate and says so', async () => {
  const { store, model, deps } = setup([
    { fail: { status: 504, code: 'provider_timeout', error: 'timed out' } },
    { tool: 'reply', args: { message: 'Answered by the next model.' } },
  ], {
    fetchHealth: async () => ({
      gpu_workstation: { configured: true, healthy: true, models: ['local-primary', 'local-recovery'], installed: ['local-primary', 'local-recovery'], ready_model: 'local-primary' },
    }),
  });
  await chat.processBuilderChatMessage({ store, message: ownerMessage('Hello?'), deps });
  const status = store.rows.find(row => row.kind === 'status');
  assert.ok(status, 'a status row explains the switch');
  assert.equal(status.payload.reason, 'timeout');
  assert.notEqual(model.calls[0].model_name ?? model.calls[0].request.model_name, model.calls[1].model_name ?? model.calls[1].request.model_name);
  assert.equal(store.rows.at(-1).content, 'Answered by the next model.');
});

test('a closed thread is skipped and its message marked failed', async () => {
  const { store, model, deps } = setup([]);
  store.state.thread.status = 'closed';
  const message = ownerMessage('Anything?');
  const outcome = await chat.processBuilderChatMessage({ store, message, deps });
  assert.equal(outcome.skipped, true);
  assert.equal(store.state.completed[message.id], 'failed');
  assert.equal(model.calls.length, 0);
});

test('job_status resolves a job by id prefix or branch from the job ledger', async () => {
  const jobs = [
    { id: 'f2a6362e-5ef3-4c38-8c84-000000000001', title: 'Dispatch tokens', status: 'deployed', workspace_branch: 'bob/job-f2a6362e5ef34cf38c84', updated_at: '2026-10-24T00:00:00Z' },
    { id: 'aae6d519-0000-4000-8000-000000000002', title: 'CCTV tokens', status: 'specification_ready', workspace_branch: null, updated_at: '2026-10-24T01:00:00Z' },
  ];
  const query = rows => {
    const builder = {
      select: () => builder, order: () => builder, limit: () => builder, eq: (_column, value) => query(rows.filter(row => row.job_id === undefined || row.job_id === value)),
      then: (resolve) => resolve({ data: rows, error: null }),
    };
    return builder;
  };
  const supabase = {
    from: table => table === 'builder_jobs' ? query(jobs)
      : table === 'builder_job_steps' ? query([{ job_id: jobs[1].id, step_id: 'specification', status: 'awaiting_human', ordinal_position: 1, error: null }])
        : query([{ job_id: jobs[1].id, approval_type: 'specification_review', status: 'pending', triggered_at_status: 'specification_ready', created_at: 'x' }]),
  };
  const tools = chat.createBuilderChatTools({ supabase, workspacePath: null, limits: chat.BUILDER_CHAT_LIMITS });
  assert.deepEqual(Object.keys(tools).sort(), ['job_status', 'list_jobs', 'propose_job']);
  const byPrefix = await tools.job_status({ job: 'aae6d519' });
  assert.equal(byPrefix.job.title, 'CCTV tokens');
  assert.deepEqual(byPrefix.approvals, [{ gate: 'specification_review', status: 'pending', at: 'specification_ready' }]);
  const byBranch = await tools.job_status({ job: 'bob/job-f2a6362e5ef34cf38c84' });
  assert.equal(byBranch.job.title, 'Dispatch tokens');
  assert.match((await tools.job_status({ job: 'zz' })).error, /job id/);
  assert.match((await tools.job_status({ job: 'deadbeef' })).error, /no Builder job/);
});

test('the shared read-only checkout follows main and discards stray files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-src-'));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(['add', '.']);
  git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'one']);
  const first = git(['rev-parse', 'HEAD']);
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-ws-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(workspaceRoot, { recursive: true, force: true }); });
  let head = first;
  const checkout = () => chat.ensureChatCheckout({ workspaceRoot, sourceDirFor: () => dir, resolveHead: () => head });
  const opened = checkout();
  assert.equal(opened.head, first);
  fs.writeFileSync(path.join(opened.workspacePath, 'stray.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qam', 'two']);
  head = git(['rev-parse', 'HEAD']);
  const refreshed = checkout();
  assert.equal(refreshed.workspacePath, opened.workspacePath);
  assert.equal(fs.readFileSync(path.join(refreshed.workspacePath, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(fs.existsSync(path.join(refreshed.workspacePath, 'stray.txt')), false);
});
