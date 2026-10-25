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
  assert.deepEqual(Object.keys(tools).sort(), ['job_status', 'list_jobs', 'owner_queue', 'propose_job']);
  const byPrefix = await tools.job_status({ job: 'aae6d519' });
  assert.equal(byPrefix.job.title, 'CCTV tokens');
  assert.deepEqual(byPrefix.approvals, [{ gate: 'specification_review', status: 'pending', at: 'specification_ready' }]);
  const byBranch = await tools.job_status({ job: 'bob/job-f2a6362e5ef34cf38c84' });
  assert.equal(byBranch.job.title, 'Dispatch tokens');
  assert.match((await tools.job_status({ job: 'zz' })).error, /job id/);
  assert.match((await tools.job_status({ job: 'deadbeef' })).error, /no Builder job/);
});

function filteringSupabase(tables) {
  const query = rows => {
    let out = rows;
    const b = {
      select: () => b, order: () => b,
      limit: n => { out = out.slice(0, n); return b; },
      eq: (column, value) => { out = out.filter(row => row[column] === value); return b; },
      not: (column, _op, _value) => { out = out.filter(row => row[column] != null); return b; },
      gte: (column, value) => { out = out.filter(row => row[column] >= value); return b; },
      in: (column, values) => { out = out.filter(row => values.includes(row[column])); return b; },
      or: filter => {
        const tests = filter.split(',').map(part => { const [column, op, value] = part.split('.'); return row => op === 'is' ? row[column] == null : op === 'neq' ? row[column] !== value : row[column] === value; });
        out = out.filter(row => tests.some(match => match(row)));
        return b;
      },
      then: resolve => resolve({ data: out, error: null }),
    };
    return b;
  };
  return { from: table => query(tables[table] || []) };
}

test('owner_queue sorts what is waiting on the owner by kind of decision', async () => {
  const now = new Date().toISOString();
  const jobs = [
    { id: 'a1', title: 'Gate pending', status: 'specification_ready', autopilot_state: 'awaiting_human', updated_at: now },
    { id: 'b2', title: 'PR published', status: 'release_ready', autopilot_state: 'published', workspace_pull_request_url: 'https://github.com/x/y/pull/1', updated_at: now },
    { id: 'b3', title: 'PR merged', status: 'release_ready', autopilot_state: 'published', workspace_pull_request_url: 'https://github.com/x/y/pull/2', autopilot_report: { merged: true }, updated_at: now },
    { id: 'c3', title: 'Blocked lately', status: 'failed', autopilot_state: 'blocked', updated_at: now },
    { id: 'd4', title: 'Blocked long ago', status: 'failed', autopilot_state: 'blocked', updated_at: '2020-01-01T00:00:00Z' },
    { id: 'e5', title: 'Done', status: 'deployed', autopilot_state: 'done', updated_at: now },
  ];
  const supabase = filteringSupabase({ builder_jobs: jobs, builder_approvals: [{ job_id: 'a1', status: 'pending', approval_type: 'specification_review', requested_at: now, expires_at: now }] });
  const queue = await chat.createBuilderChatTools({ supabase, workspacePath: null, limits: chat.BUILDER_CHAT_LIMITS }).owner_queue();
  assert.deepEqual(queue.approval_gates.map(row => [row.job.title, row.gate]), [['Gate pending', 'specification_review']]);
  assert.deepEqual(queue.pull_requests_to_review.map(job => job.title), ['PR published']);
  assert.deepEqual(queue.merged_awaiting_deploy.map(job => job.title), ['PR merged']);
  assert.deepEqual(queue.awaiting_owner, []);
  assert.deepEqual(queue.blocked_recently.map(job => job.title), ['Blocked lately']);
  assert.equal(queue.truncated, undefined);
});

test('owner_queue finds actionable jobs behind many newer jobs and flags capped lists', async () => {
  const now = new Date().toISOString();
  const noise = Array.from({ length: 150 }, (_, i) => ({ id: `n${i}`, title: `Noise ${i}`, status: 'deployed', autopilot_state: 'done', updated_at: now }));
  const blocked = Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, title: `Blocked ${i}`, status: 'failed', autopilot_state: 'blocked', updated_at: now }));
  const old = { id: 'p1', title: 'Old PR', status: 'release_ready', autopilot_state: 'published', workspace_pull_request_url: 'https://github.com/x/y/pull/9', updated_at: '2026-01-01T00:00:00Z' };
  const supabase = filteringSupabase({ builder_jobs: [...noise, ...blocked, old], builder_approvals: [] });
  const queue = await chat.createBuilderChatTools({ supabase, workspacePath: null, limits: chat.BUILDER_CHAT_LIMITS }).owner_queue();
  assert.deepEqual(queue.pull_requests_to_review.map(job => job.title), ['Old PR']);
  assert.equal(queue.blocked_recently.length, 50);
  assert.deepEqual(queue.truncated, ['blocked_recently']);
  assert.match(queue.note, /capped at 50/);
});

test('repeated failed calls get a stop-guessing nudge and the last turn is answer-only', async () => {
  const guess = ext => ({ tool: 'read_file', args: { path: `apps/web/src/components/DispatchConsole.${ext}` } });
  const { store, model, deps } = setup([guess('js'), guess('jsx'), guess('tsx'), guess('ts'),
    { tool: 'reply', args: { message: 'One job is waiting on your specification review.' } }]);
  deps.tools.read_file = async ({ path: file }) => ({ error: `not a file: ${file}` });
  const limits = { ...chat.BUILDER_CHAT_LIMITS, maxTurns: 5 };
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage('What is waiting on me?'), deps, limits });
  assert.equal(outcome.error, undefined);
  assert.match(store.rows.at(-1).content, /specification review/);
  assert.match(model.calls[3].request.messages.at(-1).content, /Stop guessing/);
  const last = model.calls[4].request;
  assert.equal(last.tools, undefined);
  assert.match(last.messages.at(-1).content, /FINAL TURN/);
  assert.ok(last.messages.every(entry => !('final' in entry)));
});

test('a status question is answered from a preloaded owner queue with only ledger tools offered', async () => {
  const queue = { approval_gates: [{ job: { id: 'aae6d519-a0b9', title: 'CCTV tokens' }, gate: 'implementation_review' }], pull_requests_to_review: [], merged_awaiting_deploy: [], awaiting_owner: [], blocked_recently: [] };
  const { store, model, deps, toolCalls } = setup([
    { tool: 'search', args: { query: 'job status update' } },
    { tool: 'reply', args: { message: 'CCTV tokens is waiting on your implementation review.' } },
  ]);
  deps.tools.owner_queue = async () => { toolCalls.push(['owner_queue']); return queue; };
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage('What is waiting on me across Builder jobs?'), deps });
  assert.equal(outcome.error, undefined);
  assert.deepEqual(toolCalls, [['owner_queue']], 'code search must not run for a status question');
  const first = model.calls[0].request;
  assert.deepEqual(first.tools.map(tool => tool.function.name).sort(), ['list_jobs', 'owner_queue', 'reply']);
  assert.match(first.messages.at(-1).content, /STATUS QUESTION/);
  assert.match(model.calls[1].request.messages.at(-1).content, /not used for status questions/);
  assert.match(store.rows.at(-1).content, /implementation review/);
});

test('a status question still gets a ledger answer when the model fails or runs out of turns', async () => {
  const queue = { approval_gates: [{ job: { id: 'aae6d519-a0b9', title: 'CCTV tokens' }, gate: 'implementation_review' }], pull_requests_to_review: [{ id: 'f2a6362e-5ef3', title: 'Dispatch tokens', pull_request: 'https://github.com/x/y/pull/195' }], merged_awaiting_deploy: [], awaiting_owner: [], blocked_recently: [] };
  const { store, deps } = setup([{ tool: 'job_status', args: {} }, { tool: 'job_status', args: { x: 1 } }]);
  deps.tools.owner_queue = async () => queue;
  deps.tools.job_status = async () => ({ error: 'give a job id' });
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage("What's waiting on me?"), deps, limits: { ...chat.BUILDER_CHAT_LIMITS, maxTurns: 2 } });
  assert.equal(outcome.error, undefined);
  const reply = store.rows.at(-1);
  assert.equal(reply.kind, 'message');
  assert.match(reply.content, /Straight from the job ledger/);
  assert.match(reply.content, /CCTV tokens \(aae6d519\): implementation review/);
  assert.match(reply.content, /pull\/195/);
});

test('status questions are told apart from build requests', () => {
  for (const text of ['What is waiting on me?', 'any pending approvals?', "what's blocked right now", 'What is waiting on me for this build?', 'what do I need to approve?']) assert.equal(chat.statusIntent(text)?.kind, 'owner', text);
  for (const text of ['job status please', 'How are the builds going?']) assert.equal(chat.statusIntent(text)?.kind, 'jobs', text);
  assert.deepEqual(chat.statusIntent('Job status for aae6d519 please'), { kind: 'job', job: 'aae6d519' });
  assert.deepEqual(chat.statusIntent('where is bob/job-aae6d519a0b9 up to?'), { kind: 'job', job: 'aae6d519a0b9' });
  for (const text of ['Fix the job status badge colour on the queue page', 'Build status badges for the Builder queue', 'Update the job status badge colour',
    'Remove the pending approvals banner', 'Rename the job status column', 'Please add a release status chip', 'Where is the dispatch console CSS?', 'Why is the build status wrong?', 'Plan a redesign of the queue']) {
    assert.equal(chat.statusIntent(text), null, text);
  }
  assert.match(chat.formatOwnerQueue({ approval_gates: [], pull_requests_to_review: [], merged_awaiting_deploy: [], awaiting_owner: [], blocked_recently: [] }), /Nothing is waiting on you/);
});

test('a job-specific status question preloads that job and falls back to its status, not the owner queue', async () => {
  const { store, model, deps, toolCalls } = setup(Array.from({ length: 20 }, () => ({ fail: { status: 503, error: 'down' } })));
  deps.tools.owner_queue = async () => { toolCalls.push(['owner_queue']); return { approval_gates: [], pull_requests_to_review: [], merged_awaiting_deploy: [], awaiting_owner: [], blocked_recently: [] }; };
  deps.tools.job_status = async args => { toolCalls.push(['job_status', args]); return { job: { id: 'aae6d519-a0b9', title: 'CCTV tokens', status: 'frontend_implementation', autopilot: 'driving' }, steps: [{ step: 'ui_design', status: 'completed' }], approvals: [] }; };
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage('Job status for aae6d519 please'), deps });
  assert.equal(outcome.error, undefined);
  assert.deepEqual(toolCalls, [['job_status', { job: 'aae6d519' }]]);
  assert.ok(model.calls.length >= 1);
  assert.match(store.rows.at(-1).content, /CCTV tokens \(aae6d519\): frontend_implementation, autopilot driving/);
  assert.doesNotMatch(store.rows.at(-1).content, /Nothing is waiting/);
});

test('the ledger fallback uses the latest successful read, not a failed or stale preload', async () => {
  let reads = 0;
  const fresh = { approval_gates: [], pull_requests_to_review: [], merged_awaiting_deploy: [], awaiting_owner: [], blocked_recently: [{ id: 'bbbb1111-0000', title: 'Patrol lock', status: 'blocked' }] };
  const { store, deps } = setup([{ tool: 'owner_queue', args: {} }, { tool: 'list_jobs', args: {} }]);
  deps.tools.owner_queue = async () => (++reads === 1 ? { error: 'approval read failed: timeout' } : fresh);
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage('What is waiting on me?'), deps, limits: { ...chat.BUILDER_CHAT_LIMITS, maxTurns: 2 } });
  assert.equal(outcome.error, undefined);
  assert.equal(reads, 2);
  assert.match(store.rows.at(-1).content, /Patrol lock \(bbbb1111\): blocked/);
});

test('job_status accepts the id under the argument names small models use', async () => {
  const rows = [{ id: 'aae6d519-a0b9-46fd-a3ca-df859c889aad', title: 'CCTV', status: 'security_review', workspace_branch: null, updated_at: 'now' }];
  const query = data => { const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, then: (resolve) => resolve({ data, error: null }) }; return q; };
  const supabase = { from: table => query(table === 'builder_jobs' ? rows : []) };
  const tools = chat.createBuilderChatTools({ supabase, workspacePath: null, limits: chat.BUILDER_CHAT_LIMITS });
  for (const args of [{ job: 'aae6d519' }, { job_id: 'aae6d519' }, { id: 'aae6d519' }]) assert.equal((await tools.job_status(args)).job?.title, 'CCTV', JSON.stringify(args));
});

test('a tool call on the answer-only turn is not executed', async () => {
  const { store, deps, toolCalls } = setup([{ tool: 'search', args: { query: 'a' } }, { tool: 'search', args: { query: 'b' } }]);
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage('Look'), deps, limits: { ...chat.BUILDER_CHAT_LIMITS, maxTurns: 2 } });
  assert.equal(toolCalls.length, 1);
  assert.equal(outcome.error, true);
});

test('a small wall budget still gives the first turn tools and keeps an answer reserve', async () => {
  const { store, model, deps } = setup([{ tool: 'search', args: { query: 'a' } }, { tool: 'reply', args: { message: 'Found it.' } }]);
  const timeouts = [];
  const inner = deps.callModel;
  deps.callModel = async args => { timeouts.push(args.timeoutMs); return inner(args); };
  const limits = { ...chat.BUILDER_CHAT_LIMITS, wallBudgetMs: 60_000, turnTimeoutMs: 300_000 };
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage('Look'), deps, limits });
  assert.equal(outcome.error, undefined);
  assert.ok(model.calls[0].request.tools, 'first turn must offer tools');
  assert.ok(timeouts[0] <= 45_000, `investigation turn must leave the 15s reserve, got ${timeouts[0]}`);
});

test('a slow investigation turn cannot consume the answer reserve', async () => {
  let clock = 1_000_000;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const { store, model, deps } = setup([{ tool: 'search', args: { query: 'a' } }, { tool: 'reply', args: { message: 'Partial answer.' } }]);
    const timeouts = [];
    const inner = deps.callModel;
    deps.callModel = async args => { timeouts.push(args.timeoutMs); clock += args.timeoutMs; return inner(args); };
    const limits = { ...chat.BUILDER_CHAT_LIMITS, wallBudgetMs: 480_000, turnTimeoutMs: 600_000 };
    const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage('Look'), deps, limits });
    assert.equal(outcome.error, undefined);
    assert.equal(timeouts[0], 390_000);
    assert.equal(model.calls[1].request.tools, undefined);
    assert.match(model.calls[1].request.messages.at(-1).content, /FINAL TURN/);
    assert.equal(timeouts[1], 90_000);
  } finally { Date.now = realNow; }
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

test('a model re-reading the preloaded ledger is cut short with the ledger answer', async () => {
  const queue = { approval_gates: [], pull_requests_to_review: [], merged_awaiting_deploy: [], awaiting_owner: [], blocked_recently: Array.from({ length: 8 }, (_, i) => ({ id: `${i}aaaaaaa-0000`, title: `Old repair ${i}`, status: 'failed' })) };
  const { store, model, deps } = setup(Array.from({ length: 6 }, () => ({ tool: 'owner_queue', args: {} })));
  let reads = 0;
  deps.tools.owner_queue = async () => { reads++; return queue; };
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage('What is waiting on me?'), deps });
  assert.equal(outcome.error, undefined);
  assert.equal(reads, 2, 'preload plus one model read; the repeat ends the loop');
  assert.equal(model.calls.length, 2);
  const reply = store.rows.at(-1).content;
  assert.match(reply, /Old repair 4/);
  assert.doesNotMatch(reply, /Old repair 5/);
  assert.match(reply, /…and 3 more in the Builder queue/);
});

test('owner_queue leaves out a published job whose pull request the owner closed', async () => {
  const now = new Date().toISOString();
  const supabase = filteringSupabase({
    builder_approvals: [],
    builder_jobs: [
      { id: 'c1', title: 'Closed PR', status: 'release_ready', autopilot_state: 'done', workspace_pull_request_url: 'https://github.com/o/r/pull/1', autopilot_report: { state: 'closed_unmerged' }, updated_at: now },
      { id: 'c2', title: 'Open PR', status: 'release_ready', autopilot_state: 'published', workspace_pull_request_url: 'https://github.com/o/r/pull/2', autopilot_report: {}, updated_at: now },
      { id: 'c3', title: 'Manual PR', status: 'release_ready', autopilot_state: null, workspace_pull_request_url: 'https://github.com/o/r/pull/3', autopilot_report: null, updated_at: now },
    ],
  });
  const queue = await chat.createBuilderChatTools({ supabase, workspacePath: null, limits: chat.BUILDER_CHAT_LIMITS }).owner_queue();
  assert.deepEqual(queue.pull_requests_to_review.map(job => job.title), ['Open PR', 'Manual PR']);
});

const PATROL_BRIEF = 'Please investigate and propose a Builder job for a backend race in public.apply_patrol_source_updates (supabase/schema.sql). Add a forward migration that locks the target row before reading v_before. No UI change.';

test('a requested proposal is not answered with a refusal: Bob is told to call propose_job', async () => {
  const { store, model, deps } = setup([
    { tool: 'search', args: { query: 'apply_patrol_source_updates' } },
    { tool: 'reply', args: { message: 'I cannot proceed; I do not have permission to modify the file.' } },
    { tool: 'propose_job', args: { ...PROPOSAL, title: 'Lock the patrol sync target row', frontend_required: false, backend_required: true } },
    { tool: 'reply', args: { message: 'I propose the migration above.' } },
  ]);
  await chat.processBuilderChatMessage({ store, message: ownerMessage(PATROL_BRIEF), deps });
  assert.match(model.calls[0].request.messages[1].content, /THE OWNER ASKED FOR A PROPOSAL/);
  assert.match(model.calls[2].request.messages.at(-1).content, /owner asked you to PROPOSE a job/);
  const proposal = store.rows.find(row => row.kind === 'proposal');
  assert.equal(proposal.payload.proposal.title, 'Lock the patrol sync target row');
  assert.match(store.rows.at(-1).content, /I propose the migration above/);
});

test('a model that never proposes still leaves the owner a labelled draft from the brief', async () => {
  const refusal = { tool: 'reply', args: { message: 'I do not have the necessary permissions to modify the file.' } };
  const { store, deps } = setup([{ tool: 'search', args: { query: 'apply_patrol_source_updates' } }, refusal, refusal]);
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage(PATROL_BRIEF), deps });
  assert.equal(outcome.drafted, true);
  const proposal = store.rows.find(row => row.kind === 'proposal').payload.proposal;
  assert.equal(proposal.title, 'A backend race in public.apply_patrol_source_updates');
  assert.equal(proposal.backend_required, true);
  assert.equal(proposal.frontend_required, false, '"No UI change" is not a frontend signal');
  assert.match(proposal.task_description, /^Please investigate and propose/);
  assert.match(proposal.task_description, /Drafted from the owner brief/);
  assert.match(store.rows.at(-1).content, /did not finish its own proposal/);
});

test('a proposal request that loops on reads is nudged to propose, then drafted', async () => {
  const read = { tool: 'search', args: { query: 'apply_patrol_source_updates' } };
  const { store, model, deps } = setup([read, read, read, read, read, read, read, read], { tools: undefined });
  deps.tools = { search: async () => ({ matches: 1 }), propose_job: args => chat.validateProposal(args) };
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage(PATROL_BRIEF), deps });
  assert.ok(model.calls.some(call => /Enough investigation for a proposal/.test(call.request.messages.at(-1).content)));
  assert.equal(outcome.drafted, true);
  assert.ok(store.rows.some(row => row.kind === 'proposal'));
});

test('proposal requests are told apart from questions and status checks', () => {
  assert.equal(chat.proposeIntent(PATROL_BRIEF), true);
  assert.equal(chat.proposeIntent('Draft a fix for the dispatch page spacing'), true);
  assert.equal(chat.proposeIntent('What is waiting on me?'), false);
  assert.equal(chat.proposeIntent('Where are the dispatch console styles?'), false);
});

test('explanations and negated requests are not mandatory proposals', () => {
  assert.equal(chat.proposeIntent('How do I create a Builder job?'), false);
  assert.equal(chat.proposeIntent("Don't propose a job yet, just look at the dispatch page"), false);
  assert.equal(chat.proposeIntent('Can you propose a job for the dispatch spacing?'), true);
});

test('the drafted proposal honours explicit scope words and stays within proposal limits', () => {
  const frontend = chat.draftProposalFromBrief('Propose a Builder job for frontend accessibility improvements on the roster screens.');
  assert.equal(frontend.frontend_required, true);
  assert.equal(frontend.backend_required, false);
  const long = chat.draftProposalFromBrief(`Please propose a job to ${'tidy '.repeat(80)}. ${'Keep every existing behaviour. '.repeat(700)}`);
  assert.ok(long, 'a long brief still yields a draft');
  assert.ok(long.title.length <= 160 && !/OMITTED|…/.test(long.title));
  assert.ok(long.task_description.length <= 8000);
  assert.match(long.task_description, /more characters are in this Builder chat message/);
});

test('a plain-prose refusal to a proposal request is nudged, not returned as the answer', async () => {
  const { store, model, deps } = setup([
    'I cannot proceed; I do not have permission to modify the file.',
    { tool: 'propose_job', args: { ...PROPOSAL, title: 'Lock the patrol sync target row', frontend_required: false, backend_required: true } },
    { tool: 'reply', args: { message: 'I propose the migration above.' } },
  ]);
  await chat.processBuilderChatMessage({ store, message: ownerMessage(PATROL_BRIEF), deps });
  assert.match(model.calls[1].request.messages.at(-1).content, /owner asked you to PROPOSE a job/);
  assert.equal(store.rows.find(row => row.kind === 'proposal').payload.proposal.title, 'Lock the patrol sync target row');
});
