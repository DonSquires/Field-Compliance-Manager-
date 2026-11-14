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
    read_file: async args => { toolCalls.push(['read_file', args]); return { path: args.path, content: '1: .cctv-review { color: #fff; }' }; },
    atlas: async args => { toolCalls.push(['atlas', args]); return { rows: [] }; },
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
  findings: [{ path: 'apps/web/src/pages/CctvReviewPage.css', source_quote: '.cctv-review { color: #fff; }', observation: 'The review selector hard-codes white instead of using the shared token.' }],
  plan: ['Replace the inspected color literal with the existing shared dark token.', 'Preserve the existing layout and exercise the review screen states.'],
  acceptance_checks: ['Run the existing focused review component tests without deleting guards.', 'Run web lint and inspect a fixture browser render for readable contrast.'],
};

const RESEARCH = [
  { tool: 'list_jobs', args: { limit: 25 } },
  { tool: 'read_file', args: { path: 'apps/web/src/pages/CctvReviewPage.css', start_line: 1, end_line: 120 } },
  { tool: 'atlas', args: { action: 'capability_map', name: 'CctvReviewPage' } },
];

test('chat source reads default to 120 lines and expose the next evidence range', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-chat-bounds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'source.js'), Array.from({ length: 300 }, (_, index) => `const value${index} = ${index};`).join('\n'));
  const tools = chat.createBuilderChatTools({ workspacePath: root, limits: chat.BUILDER_CHAT_LIMITS });
  const first = tools.read_file({ path: 'source.js' });
  assert.equal(first.start_line, 1);
  assert.equal(first.end_line, 120);
  assert.equal(first.next_start_line, 121);
  assert.match(first.content, /120: const value119/);
  assert.doesNotMatch(first.content, /value120/);
  const next = tools.read_file({ path: 'source.js', start_line: 121, end_line: 300 });
  assert.equal(next.end_line, 240);
  assert.equal(next.next_start_line, 241);
  assert.equal(next.requested_end_line, 300);
  for (const args of [{ start_line: 0 }, { start_line: 2, end_line: 1 }, { start_line: 1.5 }, { end_line: 'not-a-line' }]) {
    assert.match(tools.read_file({ path: 'source.js', ...args }).error, /positive integer/);
  }
});

test('chat search rejects invalid scope instead of silently searching the whole repository', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-chat-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/fixture.js'), 'const publicFixture = true;\n');
  execFileSync('git', ['add', 'src/fixture.js'], { cwd: root });
  const tools = chat.createBuilderChatTools({ workspacePath: root, limits: chat.BUILDER_CHAT_LIMITS });
  for (const scope of ['/srv/fcm/releases/missing', '../outside', 'src/../../outside', 'C:\\outside', ['src', '/srv'], ['']]) {
    const result = tools.search({ query: 'publicFixture', path: scope });
    assert.match(result.error, /repository-relative/);
    assert.equal(result.results, undefined);
  }
  assert.match(tools.search({ query: 'publicFixture', paths: ['src'] }).error, /path, not paths/);
  assert.match(tools.search({ query: 'publicFixture', path: null }).error, /repository-relative/);
  for (const scope of ['src', ['src'], '.', undefined]) {
    const result = tools.search({ query: 'publicFixture', path: scope });
    assert.equal(result.matches, 1);
    assert.match(result.results[0], /src\/fixture.js/);
  }
});

test('the Builder chat prompt keeps it separate from in-app Bob and forbids claiming actions', () => {
  const prompt = chat.builderChatSystemPrompt();
  assert.match(prompt, /separate from in-app Bob/);
  assert.match(prompt, /OnSpace AI chat/);
  assert.match(prompt, /never touch tenant data/);
  assert.match(prompt, /cannot edit files, create or cancel jobs, approve gates, merge or deploy/);
});

test('private source investigation never enables cloud even when the general cloud flag is available', async () => {
  const { store, model, deps } = setup([{ tool: 'reply', args: { message: 'No private source leaves this lane.' } }], {
    allowCloud: true,
    fetchHealth: async () => ({
      gpu_workstation: { configured: true, healthy: true, models: ['local-primary'], installed: ['local-primary'], ready_model: 'local-primary' },
      ollama_cloud: { configured: true, healthy: true, models: ['kimi-k2.7-code'], installed: ['kimi-k2.7-code'] },
    }),
  });
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage('Inspect private source for the current task.'), deps });
  assert.equal(outcome.error, undefined);
  assert.ok(model.calls.length > 0);
  assert.ok(!JSON.stringify(model.calls).includes('"provider":"ollama_cloud"'));
  assert.ok(!JSON.stringify(model.calls).includes('kimi-k2.7-code'));
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
  assert.match(firstRequest.messages[1].content, /BACKGROUND PAGE CONTEXT.*"job_id":"f2a6362e"/);
  assert.equal(JSON.parse(model.calls[1].request.messages.at(-1).content).current_owner_request,
    message.content);
  assert.ok(firstRequest.tools.some(tool => tool.function.name === 'propose_job'));
  assert.ok(!firstRequest.tools.some(tool => ['write_file', 'replace_in_file', 'apply_patch', 'run', 'finish'].includes(tool.function.name)));
});

test('a request longer than the packet cap does not displace subsequent tool evidence', async () => {
  const { store, deps, model } = setup([
    { tool: 'search', args: { query: 'dispatch-console' } },
    { tool: 'reply', args: { message: 'The search returned a tracked stylesheet.' } },
  ]);
  const message = ownerMessage(`Locate the dispatch styles. ${'background text '.repeat(700)}`);
  assert.ok(message.content.length > chat.BUILDER_CHAT_LIMITS.readCapChars);
  await chat.processBuilderChatMessage({ store, message, deps });
  assert.ok(model.calls[0].request.messages[1].content.includes(message.content));
  const packet = model.calls[1].request.messages.at(-1).content;
  assert.ok(packet.length <= chat.BUILDER_CHAT_LIMITS.readCapChars);
  const parsed = JSON.parse(packet);
  assert.ok(parsed.current_owner_request.length < 1100);
  assert.match(parsed.current_owner_request, /more chars/);
  assert.equal(parsed.tool, 'search');
  assert.equal(parsed.result.matches, 1);
  assert.deepEqual(parsed.result.results, ['apps/web/src/pages/DispatchConsolePage.css:12']);
});

test('continuation reads same-thread evidence with revision/freshness limits and persists new tool receipts', async () => {
  const { store, deps } = setup([
    { tool: 'read_task_evidence', args: { seq: 12, limit: 1 } },
    { tool: 'read_file', args: { path: 'source.js' } },
    { tool: 'reply', args: { message: 'The previous observation is historical; the source was read again.' } },
  ]);
  store.evidence = async (thread, args) => {
    assert.equal(thread, THREAD_ID);
    assert.deepEqual(args, { seq: 12, limit: 1 });
    return [{ seq: 12, payload: { tool: 'inspect_platform', ok: false, main_head: 'old', observed_at: 'previous-time', result_text: '{"error":"not reachable"}', result_truncated: false } }];
  };
  await chat.processBuilderChatMessage({ store, message: ownerMessage('Continue from the earlier results.'), deps });
  const rows = store.rows.filter(row => row.role === 'tool');
  assert.match(rows[0].payload.preview, /"revision_matches":false/);
  assert.equal(rows[0].payload.result_text, undefined, 'do not recursively persist retrieved receipts');
  assert.equal(rows[1].payload.main_head, 'a'.repeat(40));
  assert.match(rows[1].payload.result_text, /cctv-review/);
  assert.equal(rows[1].payload.result_truncated, false);
});

test('task evidence queries cannot select another thread or accept invalid receipt bounds', async () => {
  const { store, deps } = setup([
    { tool: 'read_task_evidence', args: { seq: 0 } },
    { tool: 'read_task_evidence', args: { thread_id: 'another-thread' } },
    { tool: 'reply', args: { message: 'The invalid evidence reads were refused.' } },
  ]);
  store.evidence = async () => assert.fail('invalid arguments must not read any thread');
  await chat.processBuilderChatMessage({ store, message: ownerMessage('Read a previous receipt.'), deps });
  assert.ok(store.rows.filter(row => row.role === 'tool').every(row => row.payload.ok === false));
});

test('ordinary turns actually preload canonical guidance and record it without treating it as source evidence', async () => {
  const { store, deps, model } = setup([{ tool: 'reply', args: { message: 'I used the relevant guidance without claiming a source inspection.' } }]);
  deps.tools.retrieve_knowledge = async args => {
    assert.deepEqual(args, { query: 'How should I continue an interrupted investigation?', limit: 3 });
    return { cards: [{ key: 'continuation', content: 'Use prior evidence.' }], retrieval: { path: 'keyword', degradation: 'private_embedding_not_configured' } };
  };
  const result = await chat.processBuilderChatMessage({ store, message: ownerMessage('How should I continue an interrupted investigation?'), deps });
  assert.match(model.calls[0].request.user_prompt, /RETRIEVED CANONICAL GUIDANCE/);
  assert.match(model.calls[0].request.user_prompt, /private_embedding_not_configured/);
  assert.deepEqual(result.research.source_paths, []);
  const receipt = store.rows.find(row => row.payload?.preloaded && row.payload?.tool === 'retrieve_knowledge');
  assert.equal(receipt.payload.ok, true);
  assert.match(receipt.payload.result_text, /continuation/);
});

test('persistent evidence store applies exact thread, tool-role and receipt filters', async () => {
  const calls = [];
  const query = {};
  for (const method of ['select', 'eq', 'order', 'limit']) query[method] = (...args) => { calls.push([method, ...args]); return query; };
  query.then = resolve => resolve({ data: [{ seq: 7 }], error: null });
  const store = chat.createBuilderChatStore({ from: table => { assert.equal(table, 'builder_chat_messages'); return query; } });
  assert.deepEqual(await store.evidence(THREAD_ID, { seq: 7, limit: 1 }), [{ seq: 7 }]);
  for (const [field, value] of [['thread_id', THREAD_ID], ['role', 'tool'], ['kind', 'tool'], ['seq', 7]]) {
    assert.ok(calls.some(call => call[0] === 'eq' && call[1] === field && call[2] === value));
  }
});

test('a proposed job is posted for owner confirmation and never created by the worker', async () => {
  const { store, deps } = setup([
    ...RESEARCH,
    { tool: 'propose_job', args: PROPOSAL },
    { tool: 'reply', args: { message: 'I propose the CCTV token job above; confirm it to start.' } },
  ]);
  const message = ownerMessage('Queue the CCTV review token migration');
  await chat.processBuilderChatMessage({ store, message, deps });
  const proposal = store.rows.find(row => row.kind === 'proposal');
  assert.ok(proposal, 'a proposal row is posted');
  assert.deepEqual(proposal.payload.proposal, chat.validateProposal(PROPOSAL).proposal);
  assert.equal(proposal.payload.proposal.frontend_required, true);
  assert.equal(proposal.payload.proposal.backend_required, true);
  assert.equal(proposal.payload.job_id, undefined);
  assert.deepEqual(proposal.payload.research, {
    source_paths: ['apps/web/src/pages/CctvReviewPage.css'], ledger_checked: true,
    atlas_queries: [{ action: 'capability_map', name: 'CctvReviewPage' }],
  });
  assert.equal(store.rows.at(-1).kind, 'message');
  assert.equal(store.state.completed[message.id], 'done');
});

test('rejected unsolicited proposals cannot convert a guidance question into required planning', async () => {
  for (const invalidArgs of [
    { ...PROPOSAL, frontend_required: false, backend_required: false },
    PROPOSAL,
  ]) {
    const { store, deps, model } = setup([
      { tool: 'propose_job', args: invalidArgs },
      { tool: 'reply', args: { message: 'Atlas is a map, not evidence; investigate the mapped source to establish facts.' } },
    ]);
    const message = ownerMessage('Explain how Atlas guides research. This is a guidance question, not a job request.');
    const outcome = await chat.processBuilderChatMessage({
      store, message, deps,
      limits: { ...chat.BUILDER_CHAT_LIMITS, maxTurns: 2 },
    });
    assert.equal(outcome.error, undefined);
    assert.match(outcome.reply, /Atlas is a map, not evidence/);
    assert.equal(store.state.completed[message.id], 'done');
    assert.equal(store.rows.some(row => row.kind === 'proposal'), false);
    const final = model.calls.at(-1).request;
    assert.deepEqual(final.output_schema.oneOf.map(branch => branch.properties.tool.const), ['reply']);
    assert.doesNotMatch(final.messages.at(-1).content, /call propose_job|Missing checks/);
  }
});

test('an invalid proposal is returned to the model as an error, not posted', async () => {
  const { store, model, deps } = setup([
    ...RESEARCH,
    { tool: 'propose_job', args: { ...PROPOSAL, title: 'x' } },
    { tool: 'propose_job', args: PROPOSAL },
    { tool: 'reply', args: { message: 'Proposed.' } },
  ]);
  await chat.processBuilderChatMessage({ store, message: ownerMessage('Build it'), deps });
  assert.equal(store.rows.filter(row => row.kind === 'proposal').length, 1);
  assert.match(model.calls[4].request.messages.at(-1).content, /title must be 4-160 characters/);
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
    ...RESEARCH,
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

test('Builder chat finds an old job by its human reference and uses it in receipts', async () => {
  const recent = Array.from({ length: 205 }, (_, i) => ({
    id: `recent-${i}`, human_reference: `BB-${i + 2}`, title: `Recent ${i}`, status: 'failed',
  }));
  const old = {
    id: 'aae6d519-0000-4000-8000-000000000001', human_reference: 'BB-1',
    title: 'Original job', status: 'failed',
  };
  const supabase = filteringSupabase({
    builder_jobs: [...recent, old],
    builder_job_steps: [], builder_approvals: [],
  });
  const tools = chat.createBuilderChatTools({ supabase, workspacePath: null, limits: chat.BUILDER_CHAT_LIMITS });
  const result = await tools.job_status({ job: 'bb-1' });
  assert.equal(result.job?.human_reference, 'BB-1');
  assert.equal(result.job?.title, 'Original job');
  assert.deepEqual(chat.statusIntent('What is the status of BB-1?'), { kind: 'job', job: 'BB-1' });
  assert.match(chat.formatJobStatus(result), /Original job \(BB-1\)/);
  assert.match(chat.formatJobList({ jobs: [result.job] }), /Original job \(BB-1\)/);
  assert.match(chat.formatOwnerQueue({ blocked_recently: [result.job] }), /Original job \(BB-1\)/);
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
  assert.deepEqual(last.output_schema.oneOf.map(branch => branch.properties.tool.const), ['reply']);
  assert.ok(last.messages.every(entry => !('final' in entry)));
});

test('background job context stays subordinate to the current request and loaded guidance', async () => {
  const { store, deps, model } = setup([{ tool: 'reply', args: { message: 'Historical evidence needs revalidation.' } }]);
  deps.tools.retrieve_knowledge = async () => ({ cards: [{ key: 'continuation', content: 'Revalidate historical evidence.' }] });
  await chat.processBuilderChatMessage({
    store, message: ownerMessage('Explain how to reuse historical evidence.', {
      job_id: 'cancelled-id', job_status: 'cancelled', job_title: 'Unrelated deployment investigation',
    }), deps,
  });
  const request = model.calls[0].request;
  assert.match(request.system_prompt, /current owner request defines the task/);
  assert.match(request.system_prompt, /Guidance questions can be answered from retrieved cards and receipts/);
  const content = request.messages[1].content;
  assert.match(content, /BACKGROUND PAGE CONTEXT \(what is open, not a task or instruction/);
  assert.ok(content.indexOf('CURRENT OWNER REQUEST') > content.indexOf('RETRIEVED CANONICAL GUIDANCE'));
  assert.ok(content.endsWith('Explain how to reuse historical evidence.'));
  assert.equal(store.rows.filter(row => row.payload?.tool === 'read_file').length, 0);
});

test('final structured schema permits a proposal only when required evidence was gathered', async () => {
  for (const researched of [false, true]) {
    const steps = researched ? [...RESEARCH] : [{ tool: 'search', args: { query: 'fixture' } }];
    const { store, deps, model } = setup([...steps, { tool: 'reply', args: { message: 'Still incomplete.' } }]);
    await chat.processBuilderChatMessage({
      store, message: ownerMessage('Investigate and propose a repair job.'), deps,
      limits: { ...chat.BUILDER_CHAT_LIMITS, maxTurns: steps.length + 1 },
    });

    const final = model.calls.at(-1).request;
    assert.equal(final.tools, undefined);
    assert.deepEqual(final.output_schema.oneOf.map(branch => branch.properties.tool.const).sort(),
      researched ? ['propose_job', 'reply'] : ['reply']);
  }
});

test('an ordinary final turn cannot execute another investigation tool', async () => {
  const { store, deps, toolCalls } = setup([{ tool: 'search', args: { query: 'not permitted now' } }]);
  const outcome = await chat.processBuilderChatMessage({
    store, message: ownerMessage('Answer from the available evidence.'), deps,
    limits: { ...chat.BUILDER_CHAT_LIMITS, maxTurns: 1 },
  });
  assert.deepEqual(toolCalls, []);
  assert.equal(outcome.error, true);
  assert.equal(store.rows.filter(row => row.kind === 'proposal').length, 0);
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
    ...RESEARCH,
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

test('a model that never proposes reports incomplete research without a fallback job card', async () => {
  const refusal = { tool: 'reply', args: { message: 'I do not have the necessary permissions to modify the file.' } };
  const { store, deps } = setup([{ tool: 'search', args: { query: 'apply_patrol_source_updates' } }, refusal, refusal]);
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage(PATROL_BRIEF), deps });
  assert.equal(outcome.error, true);
  assert.equal(store.rows.some(row => row.kind === 'proposal'), false);
  assert.match(store.rows.at(-1).content, /Missing successful checks: list_jobs.*read_file.*atlas/);
  assert.equal(store.rows.at(-1).kind, 'error');
});

test('a proposal request that loops on searches is stopped without creating a draft', async () => {
  const read = { tool: 'search', args: { query: 'apply_patrol_source_updates' } };
  const { store, model, deps } = setup([read, read, read, read, read, read, read, read], { tools: undefined });
  deps.tools = { search: async () => ({ matches: 1 }), propose_job: args => chat.validateProposal(args) };
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage(PATROL_BRIEF), deps });
  assert.ok(model.calls.some(call => /Finish focused research before proposing/.test(call.request.messages.at(-1).content)));
  assert.equal(outcome.error, true);
  assert.equal(store.rows.some(row => row.kind === 'proposal'), false);
});

test('proposal requests are told apart from questions and status checks', () => {
  assert.equal(chat.proposeIntent(PATROL_BRIEF), true);
  assert.equal(chat.proposeIntent('Draft a fix for the dispatch page spacing'), true);
  assert.equal(chat.proposeIntent('What is waiting on me?'), false);
  assert.equal(chat.proposeIntent('Where are the dispatch console styles?'), false);
  assert.equal(chat.proposeIntent('Continue investigating. Propose your own concrete repair plan with actual source findings. Do not create a job or start implementation.'), true);
  assert.equal(chat.proposeIntent('Please propose a Builder job. Do not create or start it yet.'), true);
});

test('explanations and negated requests are not mandatory proposals', () => {
  assert.equal(chat.proposeIntent('How do I create a Builder job?'), false);
  assert.equal(chat.proposeIntent("Don't propose a job yet, just look at the dispatch page"), false);
  assert.equal(chat.proposeIntent('Can you propose a job for the dispatch spacing?'), true);
  assert.equal(chat.proposeIntent('Do not propose a repair plan yet; just inspect the source.'), false);
  assert.equal(chat.proposeIntent('How will you use Atlas to guide your research into an app change and understand its blast radius and butterfly effect? Explain how you would choose the next useful check, distinguish flow reach from foreign-key structure, interpret graph direction, and verify before/during/after. This is a guidance question: do not investigate or change any particular feature, create a job, or read business records. Say what this method can and cannot prove.'), false);
  assert.equal(chat.proposeIntent('Please do not investigate or change any feature, create a Builder job or draft a repair plan; explain the method.'), false);
  assert.equal(chat.proposeIntent('Do not weaken the guards; please propose a Builder job to fix the source.'), true);
  assert.equal(chat.proposeIntent('Do not create a job, but please propose a repair plan.'), true);
  assert.equal(chat.proposeIntent('Explain the process instead of proposing a job.'), false);
});

test('a coordinated no-job instruction does not inject mandatory planning into the model packet', async () => {
  const { store, deps, model } = setup([
    { tool: 'reply', args: { message: 'Atlas guides where to investigate; source and authorized checks establish facts.' } },
  ]);
  const message = ownerMessage('How will you use Atlas to guide your research? This is a guidance question: do not investigate or change any particular feature, create a job, or read business records. Say what the method can and cannot prove.');
  const outcome = await chat.processBuilderChatMessage({ store, message, deps });
  assert.equal(outcome.error, undefined);
  assert.equal(store.state.completed[message.id], 'done');
  assert.equal(model.calls.length, 1);
  assert.doesNotMatch(model.calls[0].request.messages[1].content, /THE OWNER ASKED FOR A PROPOSAL/);
  assert.match(model.calls[0].request.messages[1].content, /CURRENT OWNER REQUEST/);
  assert.equal(store.rows.some(row => row.kind === 'proposal'), false);
});

test('proposal intent respects independent positive clauses, explanatory clauses and parenthetical modifiers', async () => {
  const cases = [
    ['Please do not edit any application files, just propose a Builder job to fix dispatch spacing.', true],
    ['Without changing any source files, please propose a Builder job.', true],
    ['Please do not, however, create a Builder job; just explain the method.', false],
    ['Please do not create a job, but instead explain how to create a Builder job.', false],
    ['Please do not create a Builder job; explain how to create a job.', false],
    ['Do not just propose a Builder job; explain the options.', false],
    ['Please do not edit any application files, however, propose a Builder job to fix dispatch spacing.', true],
    ['How do I, just as an example, create a Builder job?', false],
    ['Please explain the dispatch spacing issue and propose a Builder job to fix it.', true],
    ['Please explain the dispatch spacing issue and then propose a Builder job to fix it.', true],
    ['Please do propose a Builder job to fix dispatch spacing.', true],
    ['Please explain how to draft and propose a Builder job.', false],
    ['Do not explain the issue and propose a Builder job.', false],
    ['Please do not create a Builder job and then propose a repair plan.', false],
  ];
  for (const [content, expected] of cases) {
    assert.equal(chat.proposeIntent(content), expected, content);
    const { store, deps, model } = setup([
      { tool: 'reply', args: { message: 'This is the requested explanation, not a proposal.' } },
    ]);
    await chat.processBuilderChatMessage({
      store, message: ownerMessage(content), deps,
      limits: { ...chat.BUILDER_CHAT_LIMITS, maxTurns: 1 },
    });
    assert.equal(model.calls[0].request.messages[1].content.includes('THE OWNER ASKED FOR A PROPOSAL'), expected, content);
  }
});

test('a rejected owner-requested proposal cannot end as a successfully answered ordinary conversation', async () => {
  const { store, deps } = setup([
    { tool: 'propose_job', args: PROPOSAL },
    { tool: 'reply', args: { message: 'Next step: propose a job to restore the file.' } },
    { tool: 'reply', args: { message: 'The investigation is complete.' } },
  ]);
  const message = ownerMessage('Continue investigating the missing Compose source and propose a repair plan.');
  const outcome = await chat.processBuilderChatMessage({ store, message, deps });
  assert.equal(outcome.error, true);
  assert.equal(store.state.completed[message.id], 'failed');
  assert.equal(store.rows.at(-1).kind, 'error');
  assert.match(store.rows.at(-1).content, /did not complete an evidence-based repair plan/);
  assert.equal(store.rows.some(row => row.kind === 'proposal'), false);
});

test('structured JSON mode preserves the same required proposal and reader arguments as native tools', () => {
  const tools = { propose_job() {}, read_file() {}, atlas() {} };
  const schema = chat.builderChatToolSchema(tools);
  for (const entry of chat.builderChatNativeTools(tools)) {
    const branch = schema.oneOf.find(branch => branch.properties.tool.const === entry.function.name);
    assert.deepEqual(branch.properties.args, entry.function.parameters);
  }
  const proposal = schema.oneOf.find(branch => branch.properties.tool.const === 'propose_job').properties.args;
  assert.deepEqual(proposal.required, ['title', 'task_description', 'findings', 'plan', 'acceptance_checks']);
  assert.equal(chat.validateProposal({ ...PROPOSAL, frontend_required: false, backend_required: false }).proposal.backend_required, true);
  assert.equal(proposal.properties.title.maxLength, 160);
  assert.equal(proposal.properties.task_description.maxLength, 8000);
  assert.ok(!schema.oneOf.some(branch => branch.properties.tool.enum), 'no generic argument branch bypasses the contracts');
});

test('a plain-prose refusal to a proposal request is nudged, not returned as the answer', async () => {
  const { store, model, deps } = setup([
    'I cannot proceed; I do not have permission to modify the file.',
    ...RESEARCH,
    { tool: 'propose_job', args: { ...PROPOSAL, title: 'Lock the patrol sync target row', frontend_required: false, backend_required: true } },
    { tool: 'reply', args: { message: 'I propose the migration above.' } },
  ]);
  await chat.processBuilderChatMessage({ store, message: ownerMessage(PATROL_BRIEF), deps });
  assert.match(model.calls[1].request.messages.at(-1).content, /owner asked you to PROPOSE a job/);
  assert.equal(store.rows.find(row => row.kind === 'proposal').payload.proposal.title, 'Lock the patrol sync target row');
});

test('search matches and claimed investigation cannot bypass the source, ledger and Atlas gate', async () => {
  const { store, deps } = setup([
    { tool: 'search', args: { query: 'CctvReviewPage' } },
    { tool: 'propose_job', args: PROPOSAL },
    { tool: 'reply', args: { message: 'I researched everything; the plan is ready.' } },
    { tool: 'reply', args: { message: 'Here is the plan.' } },
  ]);
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage('Investigate and propose a Builder job'), deps });
  assert.equal(outcome.error, true);
  assert.equal(store.rows.some(row => row.kind === 'proposal'), false);
  assert.deepEqual(outcome.research.source_paths, []);
});

test('failed research cannot count as evidence and a model can repair the missing checks', async () => {
  const { store, model, deps } = setup([
    { tool: 'read_file', args: { path: 'missing.css' } },
    { tool: 'atlas', args: { action: 'capability_map' } },
    { tool: 'list_jobs', args: {} },
    { tool: 'propose_job', args: PROPOSAL },
    ...RESEARCH,
    { tool: 'propose_job', args: PROPOSAL },
    { tool: 'reply', args: { message: 'The inspected source and ledger support the proposed change.' } },
  ]);
  const read = deps.tools.read_file;
  deps.tools.read_file = args => args.path === 'missing.css' ? { error: 'missing path' } : read(args);
  const atlas = deps.tools.atlas;
  deps.tools.atlas = args => !args.name ? { error: 'name is required' } : atlas(args);
  const list = deps.tools.list_jobs;
  let lists = 0;
  deps.tools.list_jobs = args => ++lists === 1 ? { error: 'ledger unavailable' } : list(args);
  await chat.processBuilderChatMessage({ store, message: ownerMessage('Investigate and propose a Builder job'), deps });
  assert.match(model.calls[4].request.messages.at(-1).content, /Missing checks: list_jobs.*read_file.*atlas/);
  assert.equal(store.rows.filter(row => row.kind === 'proposal').length, 1);
});

test('a plan must cite inspected source and may not merely copy the owner request', async () => {
  for (const copy of [false, true]) {
    const brief = copy ? PROPOSAL.task_description : 'Please investigate and propose a job for the CCTV review.';
    const proposal = copy ? PROPOSAL : { ...PROPOSAL, findings: [{ ...PROPOSAL.findings[0], source_quote: 'This quote was invented, not returned by read_file.' }] };
    const { store, deps } = setup([...RESEARCH, { tool: 'propose_job', args: proposal }]);
    const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage(brief), deps, limits: { ...chat.BUILDER_CHAT_LIMITS, maxTurns: 6 } });
    assert.equal(store.rows.some(row => row.kind === 'proposal'), false);
    assert.equal(outcome.proposal ?? null, null);
    assert.ok(store.rows.some(row => row.kind === 'tool' && /Do not copy the owner request/.test(row.payload.preview)));
  }
});

test('the model must supply findings, concrete plan and acceptance checks, not a job to investigate later', () => {
  const { findings, plan, acceptance_checks, ...onlyBrief } = PROPOSAL;
  assert.match(chat.validateProposal(onlyBrief).error, /findings/);
  assert.match(chat.validateProposal({ ...PROPOSAL, plan: ['Investigate later.'] }).error, /plan and acceptance_checks/);
  const valid = chat.validateProposal(PROPOSAL);
  assert.match(valid.proposal.task_description, /Source findings:.*\n- apps\/web/s);
  assert.match(valid.proposal.task_description, /Repair plan:\n1\./);
  assert.match(valid.proposal.task_description, /Acceptance checks:\n-/);
  assert.match(chat.validateProposal({ ...PROPOSAL, task_description: 'x'.repeat(7900) }).error, /complete proposal/);
});

test('documentation reads and directory discovery are not source investigation', async () => {
  const { store, deps } = setup([
    { tool: 'list_jobs', args: {} },
    { tool: 'read_file', args: { path: 'docs/REBUILD_PLAN.md' } },
    { tool: 'atlas', args: { action: 'capability_map', name: 'CctvReviewPage' } },
    { tool: 'propose_job', args: { ...PROPOSAL, task_description: 'Fix the CCTV review colors based only on docs/REBUILD_PLAN.md without inspecting the actual CSS.' } },
  ]);
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage('Investigate and propose a Builder job'), deps, limits: { ...chat.BUILDER_CHAT_LIMITS, maxTurns: 6 } });
  assert.equal(outcome.error, true);
  assert.deepEqual(outcome.research.source_paths, []);
  assert.equal(store.rows.some(row => row.kind === 'proposal'), false);
});

test('empty natural-language searches get a method correction and advance the model candidate', async () => {
  const { store, model, deps } = setup([
    ...['deployment lifecycle', 'cleanup writers', 'release deployment paths'].map(query => ({ tool: 'search', args: { query } })),
    { tool: 'reply', args: { message: 'I need to inspect the owning source before I can diagnose this.' } },
  ], {
    fetchHealth: async () => ({
      gpu_workstation: { configured: true, healthy: true, models: ['local-primary', 'local-recovery'], installed: ['local-primary', 'local-recovery'], ready_model: 'local-primary' },
    }),
  });
  deps.tools.search = async () => ({ matches: 0, results: [] });
  await chat.processBuilderChatMessage({ store, message: ownerMessage('Why did the deployment disappear?'), deps });
  assert.match(model.calls[1].request.messages.at(-1).content, /Do not search another natural-language paraphrase/);
  assert.ok(store.rows.some(row => row.kind === 'status' && row.payload.reason === 'unproductive_search'));
  assert.notEqual(model.calls[0].request.model_name, model.calls[3].request.model_name);
});

test('empty replies are corrected and never become a success-shaped Done message', async () => {
  const { store, model, deps } = setup([
    { tool: 'reply', args: {} },
    { tool: 'reply', args: {} },
  ]);
  const outcome = await chat.processBuilderChatMessage({ store, message: ownerMessage('Continue the investigation'), deps, limits: { ...chat.BUILDER_CHAT_LIMITS, maxTurns: 2 } });
  assert.equal(outcome.error, true);
  assert.match(model.calls[1].request.messages.some(row => /reply requires a non-empty message/.test(row.content)) ? 'corrected' : '', /corrected/);
  assert.equal(store.rows.at(-1).kind, 'error');
  assert.doesNotMatch(store.rows.at(-1).content, /^Done\.$/);
});

test('alternating repeated reads trigger recovery even when errors are not consecutive', async () => {
  const { store, deps } = setup([
    ...[1, 2, 3].flatMap(() => [
      { tool: 'read_file', args: { path: 'docker-compose.full.yml' } },
      { tool: 'read_file', args: { path: 'deploy/vision-worker/deploy.sh' } },
    ]),
    { tool: 'reply', args: { message: 'The release lifecycle is still unknown.' } },
  ], {
    fetchHealth: async () => ({
      gpu_workstation: { configured: true, healthy: true, models: ['local-primary', 'local-recovery'], installed: ['local-primary', 'local-recovery'], ready_model: 'local-primary' },
    }),
  });
  await chat.processBuilderChatMessage({ store, message: ownerMessage('Investigate the missing deployment file'), deps });
  assert.ok(store.rows.some(row => row.kind === 'status' && row.payload.reason === 'repeated_tool_call'));
});

test('filename discovery finds tracked lifecycle paths without pretending to read them', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-chat-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts/release-cleanup.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(dir, 'scripts/release-deploy.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'release-cleanup.sh mentioned only in content');
  fs.writeFileSync(path.join(dir, 'untracked-release.txt'), 'not part of current main');
  execFileSync('git', ['add', 'scripts', 'unrelated.txt'], { cwd: dir });
  const tools = chat.createBuilderChatTools({ workspacePath: dir, supabase: null, limits: chat.BUILDER_CHAT_LIMITS });
  assert.deepEqual(tools.find_files({ name: 'RELEASE', limit: 1 }), {
    name: 'release', matches: 2, paths: ['scripts/release-cleanup.sh'], truncated: true,
  });
  assert.deepEqual(tools.find_files({ name: 'missing' }).paths, []);
  assert.match(tools.find_files({}).error, /name must be/);
  const schema = chat.builderChatToolSchema(tools);
  assert.deepEqual(schema.oneOf.find(row => row.properties.tool.const === 'find_files').properties.args.required, ['name']);
});

const changeRequestMessage = (content, packetId = 'packet-1') => ({
  id: `m-${Math.random()}`, seq: 10, thread_id: THREAD_ID, role: 'owner', content,
  payload: { context: { surface: 'change_request_intake', packet_id: packetId }, change_request: { packet_id: packetId, auto_implement: true } },
});

function changeRequestDeps() {
  const calls = { implement: [], park: [] };
  return {
    calls,
    changeRequests: {
      implement: async input => { calls.implement.push(input); return { jobId: 'job-cr-1' }; },
      park: async input => { calls.park.push(input); },
    },
  };
}

test('a routed change request that ends in a proposal opens and binds a Builder job automatically', async () => {
  const hooks = changeRequestDeps();
  const { store, deps } = setup([...RESEARCH, { tool: 'propose_job', args: PROPOSAL }, { tool: 'reply', args: { message: 'Proposed.' } }], { changeRequests: hooks.changeRequests });
  const message = changeRequestMessage('Untrusted user feedback. Investigate the change request and propose a Builder job.');
  await chat.processBuilderChatMessage({ store, message, deps });
  assert.equal(hooks.calls.implement.length, 1);
  assert.equal(hooks.calls.implement[0].message.id, message.id);
  assert.equal(hooks.calls.implement[0].head, 'a'.repeat(40));
  assert.deepEqual(hooks.calls.implement[0].proposal, chat.validateProposal(PROPOSAL).proposal);
  assert.equal(hooks.calls.park.length, 0);
  assert.ok(store.rows.some(row => row.role === 'system' && row.kind === 'status' && row.payload.job_id === 'job-cr-1' && /opened automatically/i.test(row.content)));
});

test('a routed change request stays in proposal mode even when its text reads like a status question', async () => {
  const hooks = changeRequestDeps();
  const { store, deps, toolCalls } = setup([...RESEARCH, { tool: 'propose_job', args: PROPOSAL }, { tool: 'reply', args: { message: 'Proposed.' } }], { changeRequests: hooks.changeRequests });
  await chat.processBuilderChatMessage({ store, message: changeRequestMessage('What is the status of my timesheets?'), deps });
  assert.equal(toolCalls[0][0], 'list_jobs');
  assert.equal(hooks.calls.implement.length, 1);
});

test('a routed change request without a proposal is parked for the owner instead of opening a job', async () => {
  const hooks = changeRequestDeps();
  const refusal = { tool: 'reply', args: { message: 'I could not finish the investigation.' } };
  const { store, deps } = setup([refusal, refusal, refusal], { changeRequests: hooks.changeRequests });
  await chat.processBuilderChatMessage({ store, message: changeRequestMessage('Investigate the change request and propose a Builder job.', 'packet-9'), deps, limits: { ...chat.BUILDER_CHAT_LIMITS, maxTurns: 3 } });
  assert.equal(hooks.calls.implement.length, 0);
  assert.equal(hooks.calls.park.length, 1);
  assert.equal(hooks.calls.park[0].packetId, 'packet-9');
});

test('a failed automatic job creation is reported in the thread and parks the request', async () => {
  const hooks = changeRequestDeps();
  hooks.changeRequests.implement = async () => { throw new Error('Change request is not claimed'); };
  const { store, deps } = setup([...RESEARCH, { tool: 'propose_job', args: PROPOSAL }, { tool: 'reply', args: { message: 'Proposed.' } }], { changeRequests: hooks.changeRequests });
  await chat.processBuilderChatMessage({ store, message: changeRequestMessage('Investigate the change request and propose a Builder job.'), deps });
  assert.ok(store.rows.some(row => row.kind === 'error' && /could not open the Builder job automatically/i.test(row.content) && /not claimed/.test(row.content)));
  assert.ok(store.rows.some(row => row.kind === 'proposal'), 'the proposal stays available for manual creation');
});

test('an ordinary owner proposal never creates a job without the owner confirming it', async () => {
  const hooks = changeRequestDeps();
  const { store, deps } = setup([...RESEARCH, { tool: 'propose_job', args: PROPOSAL }, { tool: 'reply', args: { message: 'Proposed.' } }], { changeRequests: hooks.changeRequests });
  await chat.processBuilderChatMessage({ store, message: ownerMessage('Queue the CCTV review token migration'), deps });
  assert.equal(hooks.calls.implement.length, 0);
  assert.equal(hooks.calls.park.length, 0);
});

test('a routed change request whose turn fails or whose thread was closed is parked, never left claimed', async () => {
  const failing = changeRequestDeps();
  const { store, deps } = setup([], { changeRequests: failing.changeRequests });
  store.history = async () => { throw new Error('history unavailable'); };
  await chat.processBuilderChatMessage({ store, message: changeRequestMessage('Investigate the change request and propose a Builder job.', 'packet-err'), deps });
  assert.deepEqual(failing.calls.park.map(call => call.packetId), ['packet-err']);
  assert.match(failing.calls.park[0].reason, /history unavailable/);

  const closed = changeRequestDeps();
  const setupClosed = setup([], { changeRequests: closed.changeRequests });
  setupClosed.store.state.thread.status = 'closed';
  await chat.processBuilderChatMessage({ store: setupClosed.store, message: changeRequestMessage('Investigate.', 'packet-closed'), deps: setupClosed.deps });
  assert.deepEqual(closed.calls.park.map(call => call.packetId), ['packet-closed']);
  assert.equal(closed.calls.implement.length, 0);
});
