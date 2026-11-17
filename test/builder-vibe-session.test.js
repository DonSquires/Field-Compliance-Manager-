'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const vibe = require('../builder-vibe-session');
const preview = require('../builder-vibe-preview');
const { ensureSourceCheckout } = require('../builder-branch-workspace');

const SESSION_ID = '1a2b3c4d-0000-4000-8000-000000000001';
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function sourceRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-src-'));
  git(dir, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(dir, 'apps/web/src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'apps/web/node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps/web/src/hello.ts'), 'export const hello = "hi";\n');
  fs.writeFileSync(path.join(dir, 'apps/web/package.json'), JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"' } }));
  fs.writeFileSync(path.join(dir, 'apps/web/node_modules/.gitkeep'), '');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  git(dir, ['add', '-A']);
  git(dir, ['add', '-f', 'apps/web/node_modules/.gitkeep']);
  git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base']);
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

function memoryStore(session, ownerMessages = []) {
  const rows = [...ownerMessages];
  const state = { session: { ...session }, rows, completed: {}, ownerQueued: false };
  return {
    state,
    async session() { return { ...state.session }; },
    async updateSession(_id, patch, { unlessClosed = false } = {}) {
      if (unlessClosed && state.session.status === 'closed') return false;
      Object.assign(state.session, patch);
      return true;
    },
    async continuationState() { return { closed: state.session.status === 'closed', ownerQueued: state.ownerQueued }; },
    async continuationHistory(_id, messageId) {
      return rows.filter(row => row.payload?.message_id === messageId && row.payload?.reason === 'automatic_continuation');
    },
    async post(_id, row) { rows.push({ seq: rows.length + 100, ...row }); },
    async complete(id, status) { state.completed[id] = status; },
    async history() { return []; },
    async recentExecution() { return []; },
    async executionForMessage(_id, messageId) {
      return rows.filter(row => row.payload?.message_id === messageId && ['tool', 'test', 'error', 'status', 'diff'].includes(row.kind));
    },
    async verificationHistory(sessionId, beforeSeq, { messageId } = {}) {
      if (messageId) return rows.filter(row => row.payload?.message_id === messageId && ['run', 'human_test', 'browser_test'].includes(row.payload?.tool));
      return this.recentExecution(sessionId, beforeSeq);
    },
  };
}

function scriptedModel(steps) {
  const calls = [];
  return {
    calls,
    async callModel({ modelRequest }) {
      calls.push(modelRequest);
      const next = steps.shift();
      if (!next) return { ok: true, data: { content: JSON.stringify({ thought: 'done', tool: 'reply', args: { message: 'Done.' } }) } };
      return { ok: true, data: { content: typeof next === 'string' ? next : JSON.stringify(next), model: 'test-model' } };
    },
  };
}

function setup(steps, extra = {}) {
  const repo = sourceRepo();
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ws-'));
  const session = { id: SESSION_ID, title: 'Make hello friendlier', status: 'open', base_sha: null, head_sha: null, pr_url: null, pr_number: null };
  const store = memoryStore(session);
  const model = scriptedModel(steps);
  const deps = {
    workspaceRoot,
    gateway: { gatewayUrl: 'http://gateway.invalid', apiToken: 'x' },
    sourceDirFor: () => repo.dir,
    resolveHead: () => repo.sha,
    fetchHealth: async () => null,
    callModel: model.callModel,
    supabase: null,
    ...extra,
  };
  return { repo, workspaceRoot, store, model, deps };
}

const ownerMessage = (content, action = 'message') => ({ id: `m-${Math.random()}`, seq: 10, session_id: SESSION_ID, role: 'owner', content, payload: { action } });

function interruptedWorkspace(fixture, message) {
  const ws = vibe.ensureVibeWorkspace({
    workspaceRoot: fixture.workspaceRoot,
    session: fixture.store.state.session,
    sourceDirFor: fixture.deps.sourceDirFor,
    resolveHead: fixture.deps.resolveHead,
  });
  Object.assign(fixture.store.state.session, { base_sha: ws.baseSha, branch: ws.branch, head_sha: ws.baseSha });
  message.payload.restart_retries = 1;
  return ws.workspacePath;
}

function installFixtureTypecheck(repo) {
  fs.writeFileSync(path.join(repo.dir, 'apps/web/package.json'), JSON.stringify({ scripts: { lint: 'node verify.cjs' } }));
  fs.writeFileSync(path.join(repo.dir, 'apps/web/verify.cjs'), 'const source=require("fs").readFileSync("src/hello.ts","utf8");if(source.includes("BROKEN")){console.error("fixture TypeScript failure");process.exit(2);}\n');
  git(repo.dir, ['add', '.']);
  git(repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'add verification fixture']);
  repo.sha = git(repo.dir, ['rev-parse', 'HEAD']);
}

function installFixtureChecks(repo) {
  fs.writeFileSync(path.join(repo.dir, 'apps/web/package.json'), JSON.stringify({ scripts: { lint: 'node verify.cjs', test: 'node verify-test.cjs' } }));
  fs.writeFileSync(path.join(repo.dir, 'apps/web/verify.cjs'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(repo.dir, 'apps/web/verify-test.cjs'), [
    'const source = require("fs").readFileSync("src/hello.ts", "utf8");',
    'if (source.includes("BROKEN")) {',
    '  console.log("verbose output ".repeat(1500));',
    '  console.log("AssertionError: expected the repaired greeting");',
    '  process.exit(1);',
    '}',
    'console.log("1 test passed");',
  ].join('\n'));
  git(repo.dir, ['add', '.']);
  git(repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'add test fixture']);
  repo.sha = git(repo.dir, ['rev-parse', 'HEAD']);
}

function installBrowserSpec(repo) {
  const dir = path.join(repo.dir, 'apps/web/e2e');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'greeting.spec.ts'), '// fixture spec\n');
  git(repo.dir, ['add', '.']);
  git(repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'add browser fixture']);
  repo.sha = git(repo.dir, ['rev-parse', 'HEAD']);
}

function verifiedFixtureIdentity(t) {
  const previous = { name: process.env.BOB_BUILDER_GIT_NAME, email: process.env.BOB_BUILDER_GIT_EMAIL };
  process.env.BOB_BUILDER_GIT_NAME = 'DonSquires';
  process.env.BOB_BUILDER_GIT_EMAIL = 'squires.don@gmail.com';
  t.after(() => {
    if (previous.name === undefined) delete process.env.BOB_BUILDER_GIT_NAME;
    else process.env.BOB_BUILDER_GIT_NAME = previous.name;
    if (previous.email === undefined) delete process.env.BOB_BUILDER_GIT_EMAIL;
    else process.env.BOB_BUILDER_GIT_EMAIL = previous.email;
  });
}

test('an inaccessible source checkout reports a host permission fault instead of spawnSync EACCES', { skip: process.getuid && process.getuid() === 0 }, t => {
  const { dir, sha } = sourceRepo();
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ws-'));
  fs.chmodSync(dir, 0o000);
  t.after(() => fs.chmodSync(dir, 0o755));
  assert.throws(
    () => vibe.ensureVibeWorkspace({ workspaceRoot, session: { id: SESSION_ID }, sourceDirFor: () => dir, resolveHead: () => sha }),
    error => /not accessible to the Builder runtime/.test(error.message) && error.message.includes(dir) && !/spawnSync/.test(error.message),
  );
});

test('an inaccessible source checkout during source preparation reports a host fault, not spawnSync EACCES', { skip: process.getuid && process.getuid() === 0 }, t => {
  const { dir: upstream, sha } = sourceRepo();
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-source-root-'));
  const sourceDir = path.join(sourceRoot, 'builder-source');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ws-'));
  ensureSourceCheckout({ sourceDir, repoUrl: upstream, sha });
  fs.chmodSync(sourceRoot, 0o000);
  t.after(() => { fs.chmodSync(sourceRoot, 0o755); fs.rmSync(sourceRoot, { recursive: true, force: true }); fs.rmSync(upstream, { recursive: true, force: true }); fs.rmSync(workspaceRoot, { recursive: true, force: true }); });
  const sourceDirFor = targetSha => ensureSourceCheckout({ sourceDir, repoUrl: upstream, sha: targetSha }).sourceDir;
  assert.throws(
    () => vibe.ensureVibeWorkspace({ workspaceRoot, session: { id: SESSION_ID }, sourceDirFor, resolveHead: () => sha }),
    error => /not accessible to the Builder runtime/.test(error.message) && error.message.includes(sourceRoot) && !/spawnSync/.test(error.message),
  );
});

test('web TypeScript drafts are automatically checked even when the model skips verification', async () => {
  const { store, deps, repo } = setup([
    { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { thought: 'claim success', tool: 'reply', args: { message: 'Fixed and ready.' } },
    { thought: 'blocked', tool: 'reply', args: { blocked_reason: 'The draft still needs a syntax repair.' } },
  ]);
  installFixtureTypecheck(repo);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('improve greeting'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /fixture TypeScript failure/);
  const checks = store.state.rows.filter(row => row.payload?.automatic);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].payload.ok, false);
  assert.match(checks[0].payload.source_fingerprint, /^[a-f0-9]{64}$/);
});

test('a real edit permits the same verification command again after more than three repairs', async t => {
  const steps = [];
  let oldText = '"hi"';
  for (let index = 0; index < 4; index++) {
    const newText = index === 3 ? '"repaired"' : `BROKEN${index}`;
    steps.push(
      { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: oldText, new_text: newText } },
      { tool: 'run', args: { command: 'npm run lint --prefix apps/web' } },
    );
    oldText = newText;
  }
  steps.push({ tool: 'reply', args: { message: 'Repaired and checked.' } });
  const { store, deps, repo, workspaceRoot } = setup(steps);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  installFixtureTypecheck(repo);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('repair the greeting'), deps });
  assert.equal(result.error, undefined);
  const checks = store.state.rows.filter(row => row.payload?.tool === 'run' && !row.payload.automatic);
  assert.equal(checks.length, 4);
  assert.deepEqual(checks.map(row => row.payload.ok), [false, false, false, true]);
});

test('no-op edits do not reset the repeated verification guard', async t => {
  const steps = Array.from({ length: 4 }, () => [
    { tool: 'run', args: { command: 'node --check missing.js' } },
    { tool: 'write_file', args: { path: 'apps/web/src/hello.ts', content: 'export const hello = "hi";\n' } },
  ]).flat();
  const { store, deps, repo, workspaceRoot } = setup(steps);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('verify the source'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /identical tool call limit/);
});

test('Playwright specs are refused by the Vitest command with a runner-specific correction', async t => {
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'run', args: { command: 'npm run test --prefix apps/web -- e2e/dr-bob-human-test.spec.ts' } },
    { tool: 'reply', args: { blocked_reason: 'Use the browser worker instead.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('run the human test'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /Wrong test runner/);
  assert.match(store.state.rows.find(row => row.payload?.tool === 'run').payload.preview, /Do not rewrite Playwright imports/);
});

test('the advertised human_test tool clears a misrouted browser check using the correct runner', async t => {
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'run', args: { command: 'npm run test --prefix apps/web -- e2e/dr-bob-human-test.spec.ts' } },
    { tool: 'human_test', args: { reason: 'Use Playwright rather than Vitest.' } },
    { tool: 'reply', args: { message: 'Browser checks passed using the correct runner.' } },
  ], { humanTest: async () => ({ ok: true, passed: 1, failed: 0 }) });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('run the browser test'), deps });
  assert.equal(result.error, undefined);
  assert.ok(model.calls[0].request.output_schema.properties.tool.enum.includes('human_test'));
  assert.ok(model.calls[0].request.tools.some(tool => tool.function.name === 'human_test'));
  assert.equal(store.state.rows.find(row => row.payload?.tool === 'run').payload.ok, false);
  assert.equal(store.state.rows.find(row => row.payload?.tool === 'human_test').payload.ok, true);
});

test('native tools share edit contracts and describe literal source discovery precisely', () => {
  const definitions = vibe.vibeNativeTools({ read_file() {}, search() {}, find_files() {}, replace_in_file() {}, __policyCheck() {} });
  const replacement = definitions.find(tool => tool.function.name === 'replace_in_file').function;
  assert.deepEqual(replacement.parameters.required, ['path', 'old_text', 'new_text']);
  assert.equal(replacement.parameters.properties.new_text.type, 'string');
  const read = definitions.find(tool => tool.function.name === 'read_file').function;
  assert.deepEqual(read.parameters.required, ['path']);
  assert.equal(read.parameters.properties.start_line.type, 'integer');
  assert.match(definitions.find(tool => tool.function.name === 'search').function.description, /not semantic questions/);
  const discovery = definitions.find(tool => tool.function.name === 'find_files').function;
  assert.deepEqual(discovery.parameters.required, ['name']);
  assert.equal(discovery.parameters.properties.limit.maximum, 100);
  assert.match(discovery.description, /filename/);
  assert.ok(definitions.every(tool => !tool.function.name.startsWith('__')));
});

test('Vibe can discover source filenames through its actual guarded tool loop', async t => {
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'find_files', args: { name: 'hello' } },
    { tool: 'reply', args: { message: 'Located the greeting source.', no_change_reason: 'Only filename discovery was requested.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('Find the greeting source filename.'), deps });
  assert.equal(result.error, undefined, result.reply);
  const receipt = store.state.rows.find(row => row.payload?.tool === 'find_files');
  assert.equal(receipt.payload.ok, true);
  assert.match(receipt.payload.preview, /apps\/web\/src\/hello\.ts/);
});

test('Vibe invalidates filename discovery after an edit and searches its new draft file', async t => {
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'find_files', args: { name: 'draft-greeting' } },
    { tool: 'write_file', args: { path: 'lib/draft-greeting.js', content: 'module.exports = "Bob Test draft greeting";\n' } },
    { tool: 'find_files', args: { name: 'draft-greeting' } },
    { tool: 'search', args: { query: 'Bob Test draft greeting', path: 'lib' } },
    { tool: 'reply', args: { message: 'Added and checked the draft greeting.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('Add a draft greeting module.'), deps });
  assert.equal(result.error, undefined, result.reply);
  const discoveries = store.state.rows.filter(row => row.payload?.tool === 'find_files');
  assert.match(discoveries[0].payload.preview, /"matches":0/);
  assert.match(discoveries[1].payload.preview, /lib\/draft-greeting\.js/);
  const search = store.state.rows.find(row => row.payload?.tool === 'search');
  assert.equal(search.payload.ok, true);
  assert.match(search.payload.preview, /lib\/draft-greeting\.js/);
});

for (const [refusal, protocol] of [
  ['native_tool_batch_refused', 'native'],
  ['native_tool_call_missing', 'json'],
]) test(`${refusal} gets bounded correction, then uses the unchanged guarded tool loop`, async () => {
  let calls = 0;
  const { store, deps, workspaceRoot } = setup([], {
    callModel: async ({ modelRequest }) => {
      calls++;
      assert.ok(modelRequest.request.tools.some(tool => tool.function.name === 'replace_in_file'));
      if (calls === 1) return { ok: false, status: 422, code: refusal, error: 'Native response refused; none executed.' };
      if (calls === 2 && protocol === 'json') assert.match(modelRequest.request.messages.at(-1).content, /structured JSON compatibility/);
      const call = calls === 2
        ? { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"native"' } }
        : { tool: 'reply', args: { message: 'Changed and checked.' } };
      return { ok: true, data: { content: JSON.stringify(call), tool_protocol: protocol } };
    },
  });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('improve greeting'), deps });
  assert.equal(result.error, undefined);
  assert.equal(calls, 3);
  assert.equal(store.state.rows.filter(row => row.payload?.tool_protocol === protocol).length, 1);
  assert.equal(store.state.rows.find(row => row.payload?.stage === 'native_tool_validation').payload.executed, false);
  assert.equal(store.state.rows.filter(row => row.payload?.tool === 'replace_in_file').length, 1);
  assert.match(fs.readFileSync(path.join(vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID), 'apps/web/src/hello.ts'), 'utf8'), /native/);
});

test('four malformed native batches stop without executing any tools', async () => {
  let calls = 0;
  const { store, deps } = setup([], {
    callModel: async () => {
      calls++;
      return { ok: false, status: 422, code: 'native_tool_arguments_invalid', error: 'Invalid arguments; none executed.' };
    },
  });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('improve greeting'), deps });
  assert.equal(result.error, true);
  assert.equal(calls, 4);
  assert.deepEqual(store.state.session.changed_files, []);
  assert.equal(store.state.rows.filter(row => row.role === 'tool').length, 0);
});

test('automatic verification gives the model a repair chance and rechecks the edited source', async () => {
  const { store, deps, repo } = setup([
    { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { thought: 'claim', tool: 'reply', args: { message: 'Done.' } },
    { thought: 'repair', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'BROKEN', new_text: '"fixed"' } },
    { thought: 'handoff', tool: 'reply', args: { message: 'Fixed the draft and verified.' } },
  ]);
  installFixtureTypecheck(repo);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('improve greeting'), deps });
  assert.equal(result.error, undefined);
  const checks = store.state.rows.filter(row => row.payload?.automatic);
  assert.deepEqual(checks.map(row => row.payload.ok), [false, true]);
  assert.notEqual(checks[0].payload.source_fingerprint, checks[1].payload.source_fingerprint);
});

test('a continuation repairs the preserved failing draft and clears its exact verification failure', async () => {
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'BROKEN', new_text: '"repaired"' } },
    { tool: 'reply', args: { message: 'Repaired and verified the preserved draft.' } },
  ]);
  installFixtureTypecheck(repo);
  const first = await vibe.processVibeMessage({
    store, message: ownerMessage('improve greeting without changing other behavior'), deps,
    limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 0 },
  });
  assert.equal(first.error, true);
  const firstCommit = store.state.session.head_sha;
  const priorRows = store.state.rows.slice();
  store.recentExecution = async () => priorRows.filter(row => ['test', 'diff', 'error'].includes(row.kind));
  store.history = async () => [{ role: 'owner', content: 'improve greeting without changing other behavior' }, { role: 'bob', kind: 'error', content: first.reply }];
  const second = await vibe.processVibeMessage({ store, message: ownerMessage('continue'), deps });
  assert.equal(second.error, undefined);
  assert.notEqual(store.state.session.head_sha, firstCommit);
  assert.match(model.calls[1].request.messages[1].content, /fixture TypeScript failure/);
  assert.match(model.calls[1].request.messages[1].content, /without changing other behavior/);
  assert.match(fs.readFileSync(path.join(vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID), 'apps/web/src/hello.ts'), 'utf8'), /repaired/);
  assert.equal(store.state.rows.filter(row => row.payload?.automatic).at(-1).payload.ok, true);
});

test('a continuation retains failure tails and clears a previous failure only when that step passes in a chain', async t => {
  const testCommand = 'npm run test --prefix apps/web -- src/greeting.test.tsx';
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { tool: 'run', args: { command: testCommand } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'BROKEN', new_text: '"repaired"' } },
    { tool: 'run', args: { command: `npm run lint --prefix apps/web && ${testCommand}` } },
    { tool: 'reply', args: { message: 'Repaired and verified.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  installFixtureChecks(repo);
  const first = await vibe.processVibeMessage({
    store, message: ownerMessage('repair the greeting'), deps,
    limits: { ...vibe.VIBE_LIMITS, maxTurns: 2, repairTurns: 0 },
  });
  assert.equal(first.error, true);
  const failed = store.state.rows.find(row => row.payload?.tool === 'run' && row.payload.ok === false);
  assert.match(failed.payload.preview, /AssertionError: expected the repaired greeting/);
  assert.match(first.reply, /AssertionError: expected the repaired greeting/);
  const previous = store.state.rows.slice();
  store.recentExecution = async () => previous.filter(row => ['test', 'diff', 'error'].includes(row.kind));
  const second = await vibe.processVibeMessage({ store, message: ownerMessage('continue'), deps });
  assert.equal(second.error, undefined, second.reply);
  assert.match(model.calls[2].request.messages[1].content, /AssertionError: expected the repaired greeting/);
  const chain = store.state.rows.find(row => row.payload?.args?.command?.includes(' && '));
  assert.deepEqual(chain.payload.verification_steps.map(step => [step.command, step.ok]), [
    ['npm run lint --prefix apps/web', true], [testCommand, true],
  ]);
  assert.match(chain.payload.preview, /1 test passed/);
});

test('an unexecuted later step in a failed chain does not clear an earlier failure', async t => {
  const testCommand = 'npm run test --prefix apps/web -- src/greeting.test.tsx';
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'run', args: { command: `node --check missing.js && ${testCommand}` } },
    { tool: 'write_file', args: { path: 'missing.js', content: 'const valid = true;\n' } },
    { tool: 'run', args: { command: 'node --check missing.js' } },
    { tool: 'reply', args: { blocked_reason: 'The previous test still needs repair.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  installFixtureChecks(repo);
  store.recentExecution = async () => [{
    kind: 'test', payload: { tool: 'run', args: { command: testCommand }, ok: false, preview: 'exit 1\nEarlier test failed' },
  }];
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('check the prior failure'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /Earlier test failed/);
  const receipt = store.state.rows.find(row => row.payload?.args?.command?.includes(' && '));
  assert.deepEqual(receipt.payload.verification_steps.map(step => step.command), ['node --check missing.js']);
  assert.ok(store.state.rows.some(row => row.payload?.ok === false));
});

test('continuation git_diff includes committed changes relative to the session base', async t => {
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"saved"' } },
    { tool: 'reply', args: { message: 'Saved the greeting.' } },
    { tool: 'git_diff', args: {} },
    { tool: 'reply', args: { message: 'The greeting changed.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('change the greeting'), deps });
  await vibe.processVibeMessage({ store, message: ownerMessage('what changed?'), deps });
  const result = model.calls.at(-1).request.messages.at(-1).content;
  assert.match(result, /base_sha/);
  assert.match(result, /apps\/web\/src\/hello\.ts/);
  assert.match(result, /\+export const hello = \\"saved\\"/);
});

test('continuation git_diff combines committed changes, the current draft and untracked paths', async t => {
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"saved"' } },
    { tool: 'reply', args: { message: 'Saved.' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"saved"', new_text: '"draft"' } },
    { tool: 'write_file', args: { path: 'apps/web/src/new.ts', content: 'export const added = true;\n' } },
    { tool: 'git_diff', args: {} },
    { tool: 'reply', args: { message: 'Draft updated.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('change the greeting'), deps });
  await vibe.processVibeMessage({ store, message: ownerMessage('continue editing the draft'), deps });
  const result = model.calls.at(-1).request.messages.at(-1).content;
  assert.match(result, /\+export const hello = \\"draft\\"/);
  assert.match(result, /untracked_files.*apps\/web\/src\/new\.ts/);
});

test('an earlier passing model check cannot verify a later broken edit', async () => {
  const { store, deps, repo } = setup([
    { thought: 'check', tool: 'run', args: { command: 'npm run lint --prefix apps/web' } },
    { thought: 'break', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { thought: 'handoff', tool: 'reply', args: { blocked_reason: 'Needs repair.' } },
  ]);
  installFixtureTypecheck(repo);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('improve greeting'), deps });
  assert.equal(result.error, true);
  assert.equal(store.state.rows.find(row => row.payload?.automatic).payload.ok, false);
});

test('step-budget exhaustion still verifies and labels a broken draft', async () => {
  const { store, deps, repo } = setup([
    { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
  ]);
  installFixtureTypecheck(repo);
  const result = await vibe.processVibeMessage({
    store, message: ownerMessage('improve greeting'), deps, limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 0, autoContinuationRounds: 0 },
  });
  assert.equal(result.error, true);
  assert.match(result.reply, /Changes are not verified/);
  assert.match(result.reply, /automatic continuation reached its safety limit/);
});

test('a step budget that runs out mid-repair is extended once so Bob can fix the failing check', async () => {
  const { store, deps, repo, model } = setup([
    { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { thought: 'repair', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'BROKEN', new_text: '"hello"' } },
    { thought: 'done', tool: 'reply', args: { message: 'Greeting repaired and checked.' } },
  ]);
  installFixtureTypecheck(repo);
  const result = await vibe.processVibeMessage({
    store, message: ownerMessage('improve greeting'), deps, limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 3 },
  });
  assert.equal(result.error, undefined, result.reply);
  assert.doesNotMatch(result.reply, /ran out of steps|not verified/);
  const extension = store.state.rows.find(row => row.payload?.reason === 'verification_repair_extension');
  assert.ok(extension, 'the extension is visible to the owner');
  assert.equal(extension.payload.command, 'npm run lint --prefix apps/web');
  assert.ok(model.calls[1].request.messages.some(row => String(row.content).includes('Step budget reached while npm run lint --prefix apps/web is failing')));
  assert.equal(store.state.rows.filter(row => row.payload?.automatic).at(-1).payload.ok, true);

  // The extension is granted once; a second exhaustion hands off the unverified draft.
  const stuck = setup([
    { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { thought: 'look', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { thought: 'look again', tool: 'git_diff', args: {} },
  ]);
  installFixtureTypecheck(stuck.repo);
  const unverified = await vibe.processVibeMessage({
    store: stuck.store, message: ownerMessage('improve greeting'), deps: stuck.deps, limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 2, autoContinuationRounds: 0 },
  });
  assert.equal(unverified.error, true);
  assert.match(unverified.reply, /Changes are not verified/);
  assert.equal(stuck.store.state.rows.filter(row => row.payload?.reason === 'verification_repair_extension').length, 1);
});

test('unfinished coding continues through multiple progress rounds and verifies the final draft', async () => {
  let browserChecks = 0;
  const { store, deps, model } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"first"' } },
    { tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"first"', new_text: '"second"' } },
    { tool: 'run', args: { command: 'npm run lint --prefix apps/web' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"second"', new_text: '"final"' } },
    { tool: 'reply', args: { message: 'The greeting is updated and checked.' } },
  ], {
    humanTest: async ({ workspacePath }) => {
      browserChecks++;
      assert.match(fs.readFileSync(path.join(workspacePath, 'apps/web/src/hello.ts'), 'utf8'), /"final"/);
      return { ok: true, complete: true, status: 'succeeded', passed: 1, failed: 0, errors: [] };
    },
  });
  const message = ownerMessage('improve greeting');
  const result = await vibe.processVibeMessage({
    store, message, deps, limits: { ...vibe.VIBE_LIMITS, maxTurns: 2, repairTurns: 0 },
  });
  assert.equal(result.error, undefined, result.reply);
  assert.equal(store.state.completed[message.id], 'done');
  assert.equal(browserChecks, 1);
  assert.equal(store.state.rows.filter(row => row.payload?.reason === 'automatic_continuation').length, 2);
  assert.equal(new Set(model.calls.map(call => call.idempotency_key)).size, 6);
  assert.equal(store.state.rows.filter(row => row.role === 'owner').length, 0, 'continuation does not invent an owner message');
});

test('automatic continuation stops on no progress, a round cap, and a wall-clock cap', async () => {
  const read = { tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } };
  const stuck = setup([read, read, read]);
  const stuckMessage = ownerMessage('improve greeting');
  const noProgress = await vibe.processVibeMessage({
    store: stuck.store, message: stuckMessage, deps: stuck.deps,
    limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 0 },
  });
  assert.equal(noProgress.error, true);
  assert.match(noProgress.reply, /no new code, investigation evidence, or verification progress/);
  assert.equal(stuck.model.calls.length, 2);
  assert.equal(stuck.store.state.completed[stuckMessage.id], 'failed');

  const edits = [
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"one"' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"one"', new_text: '"two"' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"two"', new_text: '"three"' } },
    { tool: 'reply', args: { message: 'Done.' } },
  ];
  const capped = setup([...edits]);
  const cappedMessage = ownerMessage('improve greeting');
  const capResult = await vibe.processVibeMessage({
    store: capped.store, message: cappedMessage, deps: capped.deps,
    limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 0, autoContinuationRounds: 2 },
  });
  assert.equal(capResult.error, true);
  assert.match(capResult.reply, /automatic continuation reached its safety limit/);
  assert.equal(capped.model.calls.length, 3);
  assert.equal(capped.store.state.rows.filter(row => row.payload?.reason === 'automatic_continuation').length, 2);
  assert.equal(capped.store.state.completed[cappedMessage.id], 'failed');

  const timed = setup([...edits]);
  const timedMessage = ownerMessage('improve greeting');
  const timeResult = await vibe.processVibeMessage({
    store: timed.store, message: timedMessage, deps: timed.deps,
    limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 0, autoContinuationWallMs: 0 },
  });
  assert.equal(timeResult.error, true);
  assert.match(timeResult.reply, /automatic continuation reached its safety limit/);
  assert.equal(timed.model.calls.length, 1);
  assert.equal(timed.store.state.completed[timedMessage.id], 'failed');
});

test('distinct completed checks advance continuation once per source revision, including after restart', async () => {
  const check = { tool: 'run', args: { command: 'node --check verify.js' } };
  const edit = { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"draft"' } };
  const prepare = fixture => {
    fs.writeFileSync(path.join(fixture.repo.dir, 'verify.js'), 'const verified = true;\n');
    git(fixture.repo.dir, ['add', 'verify.js']);
    git(fixture.repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'add verification fixture']);
    fixture.repo.sha = git(fixture.repo.dir, ['rev-parse', 'HEAD']);
  };
  const limits = { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 0 };
  const passing = setup([edit, check, { tool: 'reply', args: { message: 'Checked the greeting.' } }]);
  prepare(passing);
  const passed = await vibe.processVibeMessage({ store: passing.store, message: ownerMessage('improve greeting'), deps: passing.deps, limits });
  assert.equal(passed.error, undefined, passed.reply);
  assert.equal(passing.store.state.rows.filter(row => row.payload?.reason === 'automatic_continuation').length, 2);
  assert.ok(passing.store.state.rows.find(row => row.payload?.args?.command === 'node --check verify.js').payload.verification_progress.length);

  const steps = [edit, check, check, { tool: 'reply', args: { message: 'Done.' } }];
  const repeated = setup(steps);
  prepare(repeated);
  const message = ownerMessage('improve greeting');
  const stopped = await vibe.processVibeMessage({ store: repeated.store, message, deps: repeated.deps, limits });
  assert.equal(stopped.error, true);
  assert.match(stopped.reply, /no new code, investigation evidence, or verification progress/);
  const checkReceipts = repeated.store.state.rows.filter(row => row.payload?.args?.command === 'node --check verify.js');
  assert.deepEqual(checkReceipts[0].payload.verification_progress, checkReceipts[1].payload.verification_progress);
  assert.equal(repeated.model.calls.length, 3);
  const rounds = repeated.store.state.rows.filter(row => row.payload?.reason === 'automatic_continuation').length;
  assert.equal(rounds, 2);

  message.payload.restart_retries = 1;
  message.payload.governed_recovery_committed_edits = true;
  steps.unshift(check);
  const resumed = await vibe.processVibeMessage({ store: repeated.store, message, deps: repeated.deps, limits });
  assert.equal(resumed.error, true);
  assert.match(resumed.reply, /no new code, investigation evidence, or verification progress/);
  assert.equal(repeated.store.state.rows.filter(row => row.payload?.reason === 'automatic_continuation').length, rounds);
});

test('execution timing is recorded before the model call and survives a restart before any continuation', async () => {
  const fresh = setup([{ tool: 'reply', args: { blocked_reason: 'A human decision is required.' } }]);
  fresh.deps.callModel = async request => {
    const receipts = fresh.store.state.rows.filter(row => row.payload?.reason === 'vibe_execution_started');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].payload.timing_source, 'new_turn');
    return fresh.model.callModel(request);
  };
  await vibe.processVibeMessage({ store: fresh.store, message: ownerMessage('improve greeting'), deps: fresh.deps });

  const interrupted = setup([{ tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } }]);
  const message = ownerMessage('improve greeting');
  interruptedWorkspace(interrupted, message);
  const startedAt = new Date(Date.now() - 2_000).toISOString();
  interrupted.store.state.rows.push({
    seq: 11, role: 'system', kind: 'status',
    payload: { message_id: message.id, reason: 'vibe_execution_started', started_at: startedAt },
  });
  const result = await vibe.processVibeMessage({
    store: interrupted.store, message, deps: interrupted.deps,
    limits: { ...vibe.VIBE_LIMITS, autoContinuationWallMs: 1_000 },
  });
  assert.equal(result.error, true);
  assert.match(result.reply, /automatic continuation reached its safety limit/);
  assert.equal(interrupted.model.calls.length, 0);
  assert.equal(interrupted.store.state.rows.filter(row => row.payload?.reason === 'vibe_execution_started').length, 1);
  assert.equal(interrupted.store.state.completed[message.id], 'failed');
});

test('automatic continuation repairs a failing check and requires a fresh pass', async () => {
  const { store, deps, repo, model } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'BROKEN', new_text: '"repaired"' } },
    { tool: 'reply', args: { message: 'The greeting is repaired.' } },
  ]);
  installFixtureTypecheck(repo);
  const result = await vibe.processVibeMessage({
    store, message: ownerMessage('improve greeting'), deps,
    limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 0 },
  });
  assert.equal(result.error, undefined, result.reply);
  assert.deepEqual(store.state.rows.filter(row => row.payload?.reason === 'web_typescript_handoff').map(row => row.payload.ok), [false, true]);
  assert.match(JSON.stringify(model.calls[1].request.messages), /fixture TypeScript failure/);
  assert.equal(store.state.rows.filter(row => row.payload?.reason === 'automatic_continuation').length, 2);
});

test('verification repairs continue automatically after the correction limit when the draft advances', async () => {
  const { store, deps, repo, model } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { tool: 'reply', args: { message: 'Done.' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'BROKEN', new_text: 'BROKEN /* partial */' } },
    { tool: 'reply', args: { message: 'Done now.' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'BROKEN /* partial */', new_text: '"fixed"' } },
    { tool: 'reply', args: { message: 'The greeting is repaired.' } },
  ]);
  installFixtureTypecheck(repo);
  const message = ownerMessage('improve greeting');
  const result = await vibe.processVibeMessage({
    store, message, deps, limits: { ...vibe.VIBE_LIMITS, repairRounds: 1 },
  });
  assert.equal(result.error, undefined, result.reply);
  assert.equal(store.state.completed[message.id], 'done');
  assert.equal(model.calls.length, 6);
  assert.equal(store.state.rows.filter(row => row.payload?.reason === 'automatic_continuation').length, 1);
  assert.deepEqual(store.state.rows.filter(row => row.payload?.reason === 'web_typescript_handoff').map(row => row.payload.ok), [false, false, true]);
});

for (const interruption of ['owner', 'closed']) test(`automatic continuation stops for ${interruption === 'owner' ? 'a newer owner instruction' : 'session closure'}`, async () => {
  const { store, deps, model } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"first"' } },
    { tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"first"', new_text: '"too late"' } },
  ]);
  deps.callModel = async request => {
    const response = await model.callModel(request);
    if (model.calls.length === 2) {
      if (interruption === 'owner') store.state.ownerQueued = true;
      else store.state.session.status = 'closed';
    }
    return response;
  };
  const message = ownerMessage('improve greeting');
  const result = await vibe.processVibeMessage({
    store, message, deps, limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 0 },
  });
  assert.equal(model.calls.length, 2);
  assert.equal(store.state.rows.filter(row => row.payload?.tool === 'read_file').length, 0, 'a newly returned model action is not run after the interruption');
  assert.equal(store.state.completed[message.id], 'failed');
  if (interruption === 'owner') {
    assert.equal(result.error, true);
    assert.match(result.reply, /newer owner instruction/);
    assert.equal(store.state.session.status, 'open');
  } else {
    assert.deepEqual(result, { skipped: true });
    assert.equal(store.state.session.status, 'closed');
  }
});

test('a model-reported blocker leaves the owner turn failed even without a failing check', async () => {
  const { store, deps } = setup([{ tool: 'reply', args: { blocked_reason: 'A human decision is required.' } }]);
  const message = ownerMessage('improve greeting');
  const result = await vibe.processVibeMessage({ store, message, deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /A human decision is required/);
  assert.equal(store.state.completed[message.id], 'failed');
});

test('an interrupted owner turn restores its later verification and uses fresh model idempotency keys', async () => {
  const fixture = setup([
    { tool: 'reply', args: { message: 'All done.' } },
    { tool: 'reply', args: { blocked_reason: 'The earlier test still needs repair.' } },
  ]);
  const message = ownerMessage('improve greeting');
  const workspace = interruptedWorkspace(fixture, message);
  fs.writeFileSync(path.join(workspace, 'apps/web/src/hello.ts'), 'export const hello = "draft";\n');
  fixture.store.state.rows.push(
    { seq: 11, role: 'tool', kind: 'tool', payload: { message_id: message.id, tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts' }, edit_targets: ['apps/web/src/hello.ts'], ok: true } },
    { seq: 12, role: 'tool', kind: 'test', payload: { message_id: message.id, tool: 'run', args: { command: 'npm test -- --testNamePattern greeting' }, ok: false, preview: 'AssertionError: interrupted failure' } },
  );
  const result = await vibe.processVibeMessage({ store: fixture.store, message, deps: fixture.deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /AssertionError: interrupted failure/);
  assert.match(fixture.model.calls[0].request.messages[1].content, /AssertionError: interrupted failure/);
  assert.match(fixture.model.calls[0].idempotency_key, /::restart-1::vibe-1$/);
  assert.ok(fixture.model.calls[1].request.messages.some(row => String(row.content).includes('Handoff refused')));
  assert.equal(fixture.store.state.completed[message.id], 'failed');
});

test('governed recovery can verify an already-committed draft without inventing another edit', async () => {
  const fixture = setup([
    { tool: 'run', args: { command: 'npm run lint --prefix apps/web' } },
    { tool: 'reply', args: { message: 'The current draft is verified.' } },
  ]);
  const message = ownerMessage('improve greeting');
  const workspace = interruptedWorkspace(fixture, message);
  fs.writeFileSync(path.join(workspace, 'apps/web/src/hello.ts'), 'export const hello = "draft";\n');
  git(workspace, ['add', 'apps/web/src/hello.ts']);
  git(workspace, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'interrupted draft']);
  fixture.store.state.session.head_sha = git(workspace, ['rev-parse', 'HEAD']);
  message.payload.governed_recovery_committed_edits = true;
  message.payload.governed_recovery_expected_head = fixture.store.state.session.head_sha;
  fixture.store.state.rows.push(
    { seq: 11, role: 'tool', kind: 'tool', payload: { message_id: message.id, tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts' }, ok: true } },
    { seq: 12, role: 'tool', kind: 'test', payload: { message_id: message.id, tool: 'run', args: { command: 'npm run lint --prefix apps/web' }, ok: false, preview: 'The earlier check failed.' } },
  );
  const result = await vibe.processVibeMessage({ store: fixture.store, message, deps: fixture.deps });
  assert.equal(result.error, undefined, result.reply);
  assert.doesNotMatch(result.reply, /No files changed during this message/);
  assert.equal(fixture.model.calls.length, 2);
  assert.equal(fixture.store.state.completed[message.id], 'done');
});

test('interrupted failed patch targets remain blockers after an unrelated successful edit', async () => {
  const fixture = setup([{ tool: 'reply', args: { blocked_reason: 'The patch needs repair.' } }]);
  const message = ownerMessage('change both files');
  const workspace = interruptedWorkspace(fixture, message);
  fs.writeFileSync(path.join(workspace, 'apps/web/src/other.ts'), 'export const other = 1;\n');
  fixture.store.state.rows.push(
    { seq: 11, role: 'tool', kind: 'tool', payload: { message_id: message.id, tool: 'apply_patch', args: { bytes: 42 }, edit_targets: ['apps/web/src/hello.ts'], ok: false, preview: 'Patch did not apply' } },
    { seq: 12, role: 'tool', kind: 'tool', payload: { message_id: message.id, tool: 'write_file', args: { path: 'apps/web/src/other.ts' }, edit_targets: ['apps/web/src/other.ts'], ok: true } },
  );
  const result = await vibe.processVibeMessage({ store: fixture.store, message, deps: fixture.deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /Not done: these edits failed and were not applied — apps\/web\/src\/hello\.ts/);
});

test('legacy failed patches without recorded targets stop rather than being cleared by an unrelated patch', async () => {
  const fixture = setup([{ tool: 'reply', args: { message: 'Done.' } }]);
  const message = ownerMessage('change both files');
  interruptedWorkspace(fixture, message);
  fixture.store.state.rows.push(
    { seq: 11, role: 'tool', kind: 'tool', payload: { message_id: message.id, tool: 'apply_patch', args: { bytes: 42 }, ok: false, preview: 'Patch did not apply' } },
    { seq: 12, role: 'tool', kind: 'tool', payload: { message_id: message.id, tool: 'apply_patch', args: { bytes: 56 }, ok: true } },
  );
  const result = await vibe.processVibeMessage({ store: fixture.store, message, deps: fixture.deps });
  assert.match(result.error, /Interrupted edit targets are unavailable/);
  assert.equal(fixture.model.calls.length, 0);
  assert.equal(fixture.store.state.completed[message.id], 'failed');
});

test('restart recovery honors the previous automatic-round limit and newer owner instructions', async () => {
  const capped = setup([{ tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"draft"' } }]);
  const message = ownerMessage('improve greeting');
  interruptedWorkspace(capped, message);
  capped.store.state.rows.push({
    seq: 11, role: 'system', kind: 'status',
    payload: { message_id: message.id, reason: 'automatic_continuation', round: 1, started_at: new Date().toISOString(), state_fingerprint: 'a'.repeat(64) },
  });
  const result = await vibe.processVibeMessage({
    store: capped.store, message, deps: capped.deps,
    limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 0, autoContinuationRounds: 1 },
  });
  assert.equal(result.error, true);
  assert.match(result.reply, /automatic continuation reached its safety limit/);
  assert.equal(capped.store.state.rows.filter(row => row.payload?.reason === 'automatic_continuation').length, 1);

  const interrupted = setup([{ tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } }]);
  const superseded = ownerMessage('improve greeting');
  interruptedWorkspace(interrupted, superseded);
  interrupted.store.state.ownerQueued = true;
  const stopped = await vibe.processVibeMessage({ store: interrupted.store, message: superseded, deps: interrupted.deps });
  assert.equal(stopped.error, true);
  assert.match(stopped.reply, /newer owner instruction/);
  assert.equal(interrupted.model.calls.length, 0);
});

test('restart recovery refuses to recreate a missing worktree or reset its branch', async () => {
  const fixture = setup([{ tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } }]);
  const message = ownerMessage('improve greeting');
  message.payload.restart_retries = 1;
  Object.assign(fixture.store.state.session, { base_sha: fixture.repo.sha, head_sha: fixture.repo.sha, branch: vibe.vibeBranchName(SESSION_ID) });
  const result = await vibe.processVibeMessage({ store: fixture.store, message, deps: fixture.deps });
  assert.match(result.error, /workspace is missing.*without recreating or resetting the branch/);
  assert.equal(fixture.model.calls.length, 0);
  assert.equal(git(fixture.repo.dir, ['branch', '--list', vibe.vibeBranchName(SESSION_ID)]), '');
  assert.equal(fixture.store.state.completed[message.id], 'failed');
});

test('governed recovery refuses a workspace or session head that moved after scheduling', async () => {
  for (const moved of ['workspace', 'session']) {
    const fixture = setup([{ tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } }]);
    const message = ownerMessage('improve greeting');
    const workspace = interruptedWorkspace(fixture, message);
    const expected = fixture.store.state.session.head_sha;
    message.payload.governed_recovery_expected_head = expected;
    if (moved === 'workspace') {
      fs.writeFileSync(path.join(workspace, 'moved.js'), 'const moved = true;\n');
      git(workspace, ['add', 'moved.js']);
      git(workspace, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'workspace moved']);
    } else {
      fixture.store.state.session.head_sha = 'b'.repeat(40);
    }
    const before = git(workspace, ['rev-parse', 'HEAD']);
    const result = await vibe.processVibeMessage({ store: fixture.store, message, deps: fixture.deps });
    assert.match(result.error, /branch head no longer matches/);
    assert.equal(git(workspace, ['rev-parse', 'HEAD']), before);
    assert.equal(fixture.model.calls.length, 0);
    assert.equal(fixture.store.state.completed[message.id], 'failed');
  }
});

test('a restart does not repeat a live configuration change without a fresh owner instruction', async () => {
  let liveChanges = 0;
  const fixture = setup([
    { tool: 'firewall_change', args: { op: 'add', rule: { chain: 'input', action: 'allow', port: 4321 }, purpose: 'fixture' } },
  ], {
    firewall: { status: () => ({}), change: async () => { liveChanges++; return { changed: true }; } },
  });
  const message = ownerMessage('change the firewall');
  interruptedWorkspace(fixture, message);
  const result = await vibe.processVibeMessage({ store: fixture.store, message, deps: fixture.deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /cannot be repeated after an interrupted turn/);
  assert.equal(liveChanges, 0);
  assert.equal(fixture.store.state.completed[message.id], 'failed');
});

test('automatic continuation keeps attachment-derived verification details out of cloud requests', async t => {
  const health = { ollama_cloud: { configured: true, healthy: true, models: ['cloud'], ready_model: 'cloud' } };
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"draft"' } },
    { tool: 'reply', args: { blocked_reason: 'The earlier check still needs repair.' } },
  ], { allowCloud: true, fetchHealth: async () => health });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  store.hasEarlierAttachments = async () => true;
  store.recentExecution = async () => [{
    seq: 1, kind: 'test', payload: { tool: 'run', args: { command: 'npm test -- --testNamePattern private-command-marker' }, ok: false, preview: 'private-failure-marker' },
  }];
  const result = await vibe.processVibeMessage({
    store, message: ownerMessage('improve greeting'), deps,
    limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 0 },
  });
  assert.equal(result.error, true);
  assert.equal(model.calls.length, 2);
  const continuation = JSON.stringify(model.calls[1].request);
  assert.match(continuation, /arguments withheld/);
  assert.doesNotMatch(continuation, /private-command-marker|private-failure-marker/);
});

test('restored failed-edit details stay private while remaining available to a local model and owner', async () => {
  for (const external of [false, true]) {
    const provider = external ? 'ollama_cloud' : 'gpu_workstation';
    const health = { [provider]: { configured: true, healthy: true, models: ['model'], installed: ['model'], ready_model: 'model' } };
    const fixture = setup([
      { tool: 'reply', args: { message: 'The draft is complete.' } },
      { tool: 'reply', args: { blocked_reason: 'The earlier edit still needs repair.' } },
    ], { allowCloud: external, fetchHealth: async () => health });
    const message = ownerMessage('improve greeting');
    const workspace = interruptedWorkspace(fixture, message);
    fs.writeFileSync(path.join(workspace, 'apps/web/src/hello.ts'), 'export const hello = "draft";\n');
    fixture.store.hasEarlierAttachments = async () => true;
    fixture.store.state.rows.push(
      { seq: 11, role: 'tool', kind: 'tool', payload: { message_id: message.id, tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts' }, ok: true } },
      { seq: 12, role: 'tool', kind: 'tool', payload: { message_id: message.id, tool: 'replace_in_file', args: { path: 'private-path-marker.ts' },
        edit_targets: ['private-path-marker.ts'], ok: false, preview: 'private-output-marker' } },
    );
    const result = await vibe.processVibeMessage({ store: fixture.store, message, deps: fixture.deps });
    assert.equal(result.error, true);
    assert.match(result.reply, /private-path-marker/);
    const correction = JSON.stringify(fixture.model.calls[1].request);
    if (external) {
      assert.doesNotMatch(correction, /private-path-marker|private-output-marker/);
      assert.match(correction, /failed edit paths and output withheld/);
    } else {
      assert.match(correction, /private-path-marker/);
      assert.match(correction, /private-output-marker/);
    }
  }
});

test('failing checks get several repair rounds while Bob makes progress, then an honest unverified handoff', async () => {
  const { store, deps, repo, model } = setup([
    { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { thought: 'claim', tool: 'reply', args: { message: 'Done.' } },
    { thought: 'partial', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'BROKEN', new_text: 'BROKEN /* still */' } },
    { thought: 'claim', tool: 'reply', args: { message: 'Done now.' } },
    { thought: 'repair', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'BROKEN /* still */', new_text: '"hello"' } },
    { thought: 'done', tool: 'reply', args: { message: 'Greeting repaired.' } },
  ]);
  installFixtureTypecheck(repo);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('improve greeting'), deps });
  assert.equal(result.error, undefined, result.reply);
  const refusals = model.calls.flatMap(call => call.request.messages).filter(row => String(row.content).includes('Handoff refused: the latest verification failed'));
  assert.ok(JSON.stringify(refusals).includes('repair round 2 of 3'));

  // A repeated claim with no new edit and the same failure is not refused again.
  const stuck = setup([
    { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { thought: 'claim', tool: 'reply', args: { message: 'Done.' } },
    { thought: 'claim again', tool: 'reply', args: { message: 'Done.' } },
  ]);
  installFixtureTypecheck(stuck.repo);
  const unverified = await vibe.processVibeMessage({ store: stuck.store, message: ownerMessage('improve greeting'), deps: stuck.deps });
  assert.equal(unverified.error, true);
  assert.match(unverified.reply, /Changes are not verified: npm run lint --prefix apps\/web failed/);
  assert.equal(stuck.model.calls.length, 3);
});

test('vibe branch and workspace names are fixed to the session id', () => {
  assert.equal(vibe.vibeBranchName(SESSION_ID), 'bob/vibe-1a2b3c4d');
  assert.match(vibe.vibeWorkspacePath('/data/ws', SESSION_ID), /\/data\/ws\/vibe\/vibe-1a2b3c4d$/);
  assert.throws(() => vibe.vibeWorkspacePath('/data/ws', '../../etc'));
});

test('model output schema requires exact typed edit arguments without a generic edit escape', () => {
  const schema = vibe.vibeToolSchema({
    replace_in_file() {}, write_file() {}, delete_file() {}, apply_patch() {}, run() {},
    generate_visual_baselines() {}, read_file() {}, __policyCheck() {},
  });
  const edit = schema.oneOf.find(branch => branch.properties.tool.const === 'replace_in_file');
  assert.deepEqual(edit.required, ['tool', 'args']);
  assert.deepEqual(edit.properties.args.required, ['path', 'old_text', 'new_text']);
  assert.equal(edit.properties.args.properties.new_text.type, 'string');
  assert.equal(edit.properties.args.properties.new_text.minLength, undefined);
  assert.equal(edit.properties.args.properties.all.type, 'boolean');
  assert.equal(edit.properties.args.additionalProperties, false);
  const fallback = schema.oneOf.at(-1).properties.tool.enum;
  assert.ok(fallback.includes('read_file'));
  assert.ok(fallback.includes('reply'));
  assert.ok(!fallback.includes('replace_in_file'));
  assert.ok(!schema.properties.tool.enum.includes('__policyCheck'));
  for (const name of ['write_file', 'delete_file', 'apply_patch', 'run', 'generate_visual_baselines']) {
    const branch = schema.oneOf.find(item => item.properties.tool.const === name);
    assert.ok(branch.properties.args.required.length > 0, name);
    assert.equal(branch.additionalProperties, false, name);
    assert.ok(!fallback.includes(name), name);
  }
});

test('empty literal searches explain the actual tool contract instead of inviting semantic query loops', async () => {
  const { store, deps, model } = setup([
    { thought: 'semantic guess', tool: 'search', args: { path: 'apps/web/src/hello.ts', query: 'Greeting component layout structure' } },
    { thought: 'read source', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { thought: 'reply', tool: 'reply', args: { message: 'Read the actual greeting.' } },
  ]);
  await vibe.processVibeMessage({ store, message: ownerMessage('inspect greeting'), deps });
  const result = model.calls[1].request.messages.filter(entry => entry.role === 'user').at(-1);
  const payload = JSON.parse(result.content).tool_result;
  assert.equal(payload.matches, 0);
  assert.match(payload.hint, /not semantic search/);
  assert.match(payload.hint, /read_file or outline/);
  assert.equal(payload.error, undefined);
});

test('an owner message edits the branch, commits the turn and replies', async () => {
  const { store, model, deps, workspaceRoot, repo } = setup([
    { thought: 'look', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"kia ora"' } },
    { thought: 'tell', tool: 'reply', args: { message: 'Changed the greeting to kia ora.' } },
  ]);
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('say kia ora instead'), deps });
  assert.equal(outcome.reply, 'Changed the greeting to kia ora.');
  const ws = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
  assert.equal(git(ws, ['branch', '--show-current']), 'bob/vibe-1a2b3c4d');
  assert.match(fs.readFileSync(path.join(ws, 'apps/web/src/hello.ts'), 'utf8'), /kia ora/);
  assert.equal(git(ws, ['status', '--porcelain']), '');
  assert.match(git(ws, ['log', '-1', '--format=%s']), /^vibe: say kia ora instead/);
  assert.equal(store.state.session.base_sha, repo.sha);
  assert.deepEqual(store.state.session.changed_files, ['apps/web/src/hello.ts']);
  assert.equal(store.state.session.status, 'open');
  const kinds = store.state.rows.map(row => row.kind);
  assert.ok(kinds.includes('tool'));
  assert.ok(kinds.includes('diff'));
  assert.equal(store.state.rows.at(-1).kind, 'message');
  assert.equal(Object.values(store.state.completed)[0], 'done');
  assert.equal(model.calls[0].request.builder_mode, 'vibe_engineer');
  assert.equal(model.calls[0].request.workload_kind, 'vibe_implementation');
  assert.match(model.calls[0].request.messages[0].content, /\.agents\/skills\/supabase\/SKILL\.md/);
  assert.match(model.calls[0].request.messages[0].content, /\.agents\/skills\/supabase-postgres-best-practices\/SKILL\.md/);
  assert.match(model.calls[0].request.messages[0].content, /managed-release rules take precedence/);
  assert.deepEqual(model.calls[0].chain, ['gpu_workstation', 'ollama']);
  assert.equal(model.calls[0].routing_reason, 'private_repository_local_only');
  assert.ok(model.calls[0].request.output_schema.properties.tool.enum.includes('replace_in_file'));
  assert.ok(!model.calls[0].request.output_schema.properties.tool.enum.includes('__policyCheck'));
});

test('Vibe can edit, verify and commit backend source in its full-stack worktree', async t => {
  const { store, model, deps, workspaceRoot, repo } = setup([
    { thought: 'edit backend source', tool: 'replace_in_file', args: { path: 'services/fcm-api/src/bob/plan.js', old_text: '"old"', new_text: '"new"' } },
    { thought: 'verify backend source', tool: 'run', args: { command: 'node --check services/fcm-api/src/bob/plan.js' } },
    { thought: 'report result', tool: 'reply', args: { message: 'Updated and checked the backend planner.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const backendFile = 'services/fcm-api/src/bob/plan.js';
  fs.mkdirSync(path.dirname(path.join(repo.dir, backendFile)), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, backendFile), 'module.exports = { plan: () => "old" };\n');
  git(repo.dir, ['add', backendFile]);
  git(repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'add backend fixture']);
  repo.sha = git(repo.dir, ['rev-parse', 'HEAD']);

  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('update the backend planner'), deps });
  assert.equal(outcome.error, undefined, outcome.reply);
  const workspace = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
  assert.match(fs.readFileSync(path.join(workspace, backendFile), 'utf8'), /"new"/);
  assert.deepEqual(store.state.session.changed_files, [backendFile]);
  const run = store.state.rows.find(row => row.payload?.tool === 'run');
  assert.equal(run.payload.ok, true, run.payload.preview);
  assert.match(model.calls[0].request.messages[0].content, /Full-stack scope: backend work is supported/);
  assert.match(git(workspace, ['log', '-1', '--format=%s']), /^vibe: update the backend planner/);
});

test('Vibe edits and verifies backend source in its full-stack session', async t => {
  const backendPath = 'services/fcm-api/src/bob/vibe_backend_fixture.js';
  const { store, model, deps, workspaceRoot, repo } = setup([
    { thought: 'Create the backend helper.', tool: 'write_file', args: { path: backendPath, content: 'module.exports = { ready: true };\n' } },
    { thought: 'Check the backend file parses.', tool: 'run', args: { command: `node --check ${backendPath}` } },
    { thought: 'Report the verified backend change.', tool: 'reply', args: { message: 'Created and syntax-checked the backend helper.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });

  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('Create a backend helper and verify it.'), deps });
  assert.equal(outcome.error, undefined, outcome.reply);
  const workspace = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
  assert.equal(fs.readFileSync(path.join(workspace, backendPath), 'utf8'), 'module.exports = { ready: true };\n');
  assert.deepEqual(store.state.session.changed_files, [backendPath]);
  const backendCheck = store.state.rows.map(row => row.payload).find(payload => payload?.tool === 'run' && payload.args?.command === `node --check ${backendPath}`);
  assert.equal(backendCheck?.ok, true, 'the backend check ran successfully before the Vibe turn was committed');
  assert.deepEqual(git(workspace, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean), [backendPath]);
  assert.match(vibe.vibeSystemPrompt(), /Full-stack scope: backend work is supported/);
});

test('dependency preparation does not become a false protected-edit refusal', async () => {
  const { store, deps, workspaceRoot } = setup([], {
    prepareWorkspace: async workspace => fs.unlinkSync(path.join(workspace, 'apps/web/node_modules/.gitkeep')),
  });
  await vibe.processVibeMessage({ store, message: ownerMessage('explain the page'), deps });
  assert.equal(store.state.rows.some(row => row.kind === 'error'), false);
  assert.equal(fs.existsSync(path.join(vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID), 'apps/web/node_modules/.gitkeep')), true);
  assert.equal(store.state.session.head_sha, store.state.session.base_sha);
});

test('Vibe opening packet grounds natural screen labels in tracked source and outlines', async () => {
  const { store, deps, model, repo } = setup([]);
  fs.writeFileSync(path.join(repo.dir, 'apps/web/src/OverviewApprovals.tsx'),
    Array.from({ length: 24 }, (_, index) => `export function OverviewApprovals${index}() { return "Overview and approvals"; }`).join('\n'));
  git(repo.dir, ['add', '.']);
  git(repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'add overview fixture']);
  repo.sha = git(repo.dir, ['rev-parse', 'HEAD']);
  await vibe.processVibeMessage({ store, message: ownerMessage('Align overview approvals with our theme'), deps });
  const packet = model.calls[0].request.messages[1].content;
  assert.match(packet, /VERIFIED STARTING FILES/);
  assert.match(packet, /apps\/web\/src\/OverviewApprovals.tsx/);
  assert.match(packet, /export function OverviewApprovals/);
  assert.match(packet, /no Atlas client/);
  const startingPacket = JSON.parse(packet.match(/VERIFIED STARTING FILES[^\n]*\n([^\n]+)/)[1]);
  assert.equal(startingPacket.outlines[0].entries.length, 16);
  assert.equal(startingPacket.outlines[0].truncated, true);
});

test('repeated unchanged reads reuse results and a distinct local model can recover once', async () => {
  const repeated = { thought: 'inspect', tool: 'list_dir', args: { path: 'apps/web/src/' } };
  const { store, deps, model } = setup([
    repeated, repeated, repeated, repeated,
    { thought: 'read actual source', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { thought: 'implement', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"recovered"' } },
    { thought: 'report', tool: 'reply', args: { message: 'Recovered locally and edited the greeting.' } },
  ], {
    fetchHealth: async () => ({
      gpu_workstation: { configured: true, healthy: true, models: ['local-primary', 'local-recovery'], installed: ['local-primary', 'local-recovery'], ready_model: 'local-primary' },
      ollama_cloud: { configured: true, healthy: true, ready_model: 'external-model' },
    }),
  });
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('improve greeting'), deps });
  assert.equal(outcome.error, undefined);
  assert.ok(model.calls[2].request.messages.some(entry => entry.content.includes('"reused":true')));
  assert.equal(model.calls[4].model_name, 'local-recovery');
  assert.ok(model.calls.every(call => call.provider === 'gpu_workstation'));
  assert.equal(store.state.rows.filter(row => row.payload?.reason === 'repeated_tool_call').length, 1);
  assert.deepEqual(store.state.session.changed_files, ['apps/web/src/hello.ts']);
});

test('owner-approved Ollama Cloud recovers loops in JSON mode and redacts earlier attachments', async () => {
  assert.equal(vibe.vibeCloudAllowed({}), false);
  assert.equal(vibe.vibeCloudAllowed({ BOB_VIBE_ALLOW_OLLAMA_CLOUD: 'true' }), true);
  const health = async () => ({
    gpu_workstation: { configured: true, healthy: true, models: ['local-primary', 'local-recovery'], installed: ['local-primary', 'local-recovery'], ready_model: 'local-primary' },
    ollama_cloud: { configured: true, healthy: true, models: ['cloud-strong'], ready_model: 'cloud-strong' },
    openai: { configured: true, healthy: true, ready_model: 'external' },
  });
  const repeated = { thought: 'inspect', tool: 'list_dir', args: { path: 'apps/web/src/' } };
  const { store, deps, model } = setup([
    repeated, repeated, repeated, repeated,
    { thought: 'implement', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"cloud"' } },
    { thought: 'report', tool: 'reply', args: { message: 'Edited.' } },
  ], { fetchHealth: health, allowCloud: true });
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('improve greeting'), deps });
  assert.equal(outcome.error, undefined);
  assert.deepEqual(model.calls[0].chain, ['gpu_workstation', 'ollama', 'ollama_cloud']);
  assert.equal(model.calls[0].provider, 'gpu_workstation');
  assert.ok(model.calls[0].request.tools);
  assert.equal(model.calls[4].provider, 'ollama_cloud');
  assert.equal(model.calls[4].request.tools, undefined);
  assert.ok(model.calls.every(call => call.provider !== 'openai'));
  assert.ok(store.state.rows.some(row => row.payload?.reason === 'repeated_tool_call' && row.payload.external_egress === true));

  const attached = setup([{ thought: 'answer', tool: 'reply', args: { message: 'ok' } }], {
    fetchHealth: async () => ({ ollama_cloud: { configured: true, healthy: true, models: ['cloud-strong'], ready_model: 'cloud-strong' } }), allowCloud: true,
  });
  const routed = vibe.applyVibeRouting({}, { allowCloud: false });
  assert.deepEqual(routed.chain, ['gpu_workstation', 'ollama']);
  attached.store.history = async () => [
    { seq: 1, role: 'owner', kind: 'message', content: 'earlier', payload: { external_attachment_consent: true, attachment_context: [{ context: 'private screenshot' }] } },
    { seq: 2, role: 'bob', kind: 'message', content: 'A paraphrase of private screenshot detail.', payload: {} },
  ];
  attached.store.recentExecution = async () => [{ seq: 3, kind: 'tool', content: 'private screenshot output', payload: { ok: true, preview: 'prior confidential extraction' } }];
  await vibe.processVibeMessage({ store: attached.store, message: ownerMessage('look again'), deps: attached.deps });
  assert.equal(attached.model.calls[0].provider, 'ollama_cloud');
  const sent = JSON.stringify(attached.model.calls[0].request.messages);
  assert.doesNotMatch(sent, /private screenshot/);
  assert.doesNotMatch(sent, /prior confidential extraction/);
  assert.match(sent, /earlier attachment analysis withheld/);
});

test('cloud packets withhold attachment history beyond the window, earlier search terms and earlier check output', async () => {
  const cloudOnly = async () => ({ ollama_cloud: { configured: true, healthy: true, models: ['cloud-strong'], ready_model: 'cloud-strong' } });

  // The attachment-bearing owner message has scrolled out of the history window; Bob's paraphrase has not.
  const scrolled = setup([{ thought: 'answer', tool: 'reply', args: { message: 'ok' } }], { fetchHealth: cloudOnly, allowCloud: true });
  const lookups = [];
  scrolled.store.hasEarlierAttachments = async (sessionId, beforeSeq) => { lookups.push([sessionId, beforeSeq]); return true; };
  scrolled.store.history = async () => [
    { seq: 40, role: 'owner', kind: 'message', content: 'Compare the quokkaledger figures', payload: {} },
    { seq: 41, role: 'bob', kind: 'message', content: 'The scrolled-out document lists quokkaledger totals.', payload: {} },
  ];
  await vibe.processVibeMessage({ store: scrolled.store, message: ownerMessage('Why is the greeting clipped?'), deps: scrolled.deps });
  assert.deepEqual(lookups, [[SESSION_ID, 10]]);
  assert.equal(scrolled.model.calls[0].provider, 'ollama_cloud');
  const opening = scrolled.model.calls[0].request.messages[1].content;
  assert.doesNotMatch(JSON.stringify(scrolled.model.calls[0].request.messages), /quokkaledger/);
  assert.match(opening, /earlier attachment analysis withheld/);
  assert.match(opening, /"search_terms":\[[^\]]*"greeting"/);

  // A failed check recorded before this message is still enforced, but its output stays private.
  const checked = setup([
    { thought: 'answer', tool: 'reply', args: { message: 'It looks fixed.' } },
    { thought: 'blocked', tool: 'reply', args: { blocked_reason: 'The earlier failing check must be rerun first.' } },
  ], { fetchHealth: cloudOnly, allowCloud: true });
  checked.store.hasEarlierAttachments = async () => true;
  checked.store.recentExecution = async () => [{
    seq: 42, role: 'tool', kind: 'test', content: 'Running npm test',
    payload: { tool: 'run', args: { command: 'npm test -- --testNamePattern quokkaledger' }, ok: false, preview: 'exit 1: expected quokkaledger invoice 4417' },
  }];
  const outcome = await vibe.processVibeMessage({ store: checked.store, message: ownerMessage('Is the greeting fixed now?'), deps: checked.deps });
  assert.equal(checked.model.calls.length, 2);
  assert.ok(checked.model.calls.every(call => call.provider === 'ollama_cloud'));
  const followUp = JSON.stringify(checked.model.calls[1].request.messages);
  assert.match(followUp, /Handoff refused: the latest verification failed/);
  assert.match(followUp, /npm test/);
  assert.match(followUp, /earlier output withheld from external models/);
  assert.doesNotMatch(followUp, /quokkaledger|4417/);
  assert.equal(outcome.error, true);
  assert.match(outcome.reply, /Changes are not verified: npm test .* failed/);
});

for (const compact of [false, true]) test(`cloud ${compact ? 'compacted ' : ''}continuations withhold prior branch subjects and paths after attachments`, async t => {
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'write_file', args: { path: 'apps/web/src/private-branch-marker.js', content: 'export const value = 1;\n' } },
    { tool: 'reply', args: { message: 'File updated.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const draft = await vibe.processVibeMessage({ store, message: ownerMessage('Update private-commit-marker.'), deps });
  assert.equal(draft.error, undefined, draft.reply);
  store.state.session.title = 'private-session-title-marker';
  store.hasEarlierAttachments = async () => true;
  store.recentExecution = async () => [{
    kind: 'test', payload: { tool: 'run', args: { command: 'node --check private-check-marker.js' }, ok: false, preview: 'private-output-marker' },
  }];
  const cloudModel = scriptedModel([{ tool: 'reply', args: { blocked_reason: 'The check still needs repair.' } }]);
  deps.callModel = cloudModel.callModel;
  deps.allowCloud = true;
  deps.fetchHealth = async () => ({
    ollama_cloud: { configured: true, healthy: true, models: ['cloud'], ready_model: 'cloud', num_ctx: 24576, max_output_tokens: 8192 },
  });
  await vibe.processVibeMessage({
    store, message: ownerMessage(compact ? `Continue ${'a'.repeat(54000 - vibe.vibeSystemPrompt().length)}` : 'Continue.'), deps,
  });
  assert.ok(cloudModel.calls.length);
  assert.doesNotMatch(JSON.stringify(cloudModel.calls), /private-(?:branch|commit|session-title|check|output)-marker/);
  if (compact) assert.ok(store.state.rows.some(row => row.payload?.reason === 'context_compacted'));
});

test('private continuations retain owner and branch context after attachments', async t => {
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'write_file', args: { path: 'apps/web/src/private-branch-marker.js', content: 'export const value = 1;\n' } },
    { tool: 'reply', args: { message: 'File updated.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const draft = await vibe.processVibeMessage({ store, message: ownerMessage('Update private-commit-marker.'), deps });
  assert.equal(draft.error, undefined, draft.reply);
  store.state.session.title = 'private-session-title-marker';
  store.history = async () => [{
    role: 'owner', content: 'Keep existing browser specs intact.',
    payload: { attachment_context: [{ context: 'private-attachment-marker' }] },
  }];
  const privateModel = scriptedModel([{ tool: 'reply', args: { blocked_reason: 'The check still needs repair.' } }]);
  deps.callModel = privateModel.callModel;
  deps.fetchHealth = async () => ({
    gpu_workstation: { configured: true, healthy: true, models: ['local'], ready_model: 'local' },
  });
  await vibe.processVibeMessage({ store, message: ownerMessage('Continue.'), deps });
  const request = JSON.stringify(privateModel.calls[0].request);
  assert.match(request, /private-session-title-marker/);
  assert.match(request, /private-commit-marker/);
  assert.match(request, /private-branch-marker/);
  assert.match(request, /Keep existing browser specs intact/);
  assert.match(request, /private-attachment-marker/);
});

test('the Vibe store detects attachment history across the whole session', async () => {
  const filters = [];
  const query = {
    select(columns) { filters.push(['select', columns]); return this; },
    eq(column, value) { filters.push(['eq', column, value]); return this; },
    lt(column, value) { filters.push(['lt', column, value]); return this; },
    not(column, operator, value) { filters.push(['not', column, operator, value]); return this; },
    neq(column, value) { filters.push(['neq', column, value]); return this; },
    limit(count) { filters.push(['limit', count]); return Promise.resolve({ data: [{ seq: 3 }], error: null }); },
  };
  const store = vibe.createVibeStore({ from(table) { filters.push(['from', table]); return query; } });
  assert.equal(await store.hasEarlierAttachments(SESSION_ID, 90), true);
  assert.deepEqual(filters, [
    ['from', 'builder_vibe_messages'], ['select', 'seq'], ['eq', 'session_id', SESSION_ID], ['eq', 'role', 'owner'], ['lt', 'seq', 90],
    ['not', 'payload->attachment_ids', 'is', null], ['neq', 'payload->attachment_ids', '[]'], ['limit', 1],
  ]);
  query.limit = () => Promise.resolve({ data: null, error: { message: 'permission denied' } });
  await assert.rejects(store.hasEarlierAttachments(SESSION_ID, 90), /attachment history read failed: permission denied/);
});

test('verification history is paginated across the entire session and fails explicitly on read errors', async () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({
    seq: index + 1, kind: 'test', payload: { tool: 'run', ok: true },
  }));
  const pages = [];
  let failPage = 0;
  const store = vibe.createVibeStore({
    from(table) {
      assert.equal(table, 'builder_vibe_messages');
      let cursor;
      const filters = [];
      return {
        select() { return this; },
        eq(column, value) { assert.deepEqual([column, value], ['session_id', SESSION_ID]); return this; },
        lt(column, value) { assert.equal(column, 'seq'); cursor = value; return this; },
        in(column, values) { filters.push([column, values]); return this; },
        order(column, options) { assert.deepEqual([column, options], ['seq', { ascending: false }]); return this; },
        limit(count) {
          pages.push({ cursor, count, filters });
          if (failPage && pages.length === failPage) return Promise.resolve({ data: null, error: { message: 'permission denied' } });
          return Promise.resolve({ data: rows.filter(row => row.seq < cursor).reverse().slice(0, count), error: null });
        },
      };
    },
  });
  const result = await store.verificationHistory(SESSION_ID, 206);
  assert.equal(result.length, 205);
  assert.deepEqual(result.map(row => row.seq), rows.map(row => row.seq));
  assert.deepEqual(pages.map(page => page.cursor), [206, 6]);
  assert.ok(pages.every(page => page.filters.some(([column]) => column === 'payload->>tool')));
  pages.length = 0;
  failPage = 2;
  await assert.rejects(store.verificationHistory(SESSION_ID, 206), /verification history read failed: permission denied/);
});

test('current attachment context reaches Ollama Cloud only after per-message owner opt-in', async () => {
  const health = async () => ({
    gpu_workstation: { configured: true, healthy: true, models: ['local-primary'], installed: ['local-primary'], ready_model: 'local-primary' },
    ollama_cloud: { configured: true, healthy: true, models: ['cloud-strong'], ready_model: 'cloud-strong' },
  });
  const attachmentId = '2b3c4d5e-0000-4000-8000-000000000002';
  const attachment = {
    id: attachmentId, session_id: SESSION_ID, uploaded_by: 'owner-uuid',
    file_name: 'non-sensitive-ui-note.txt', file_type: 'text/plain',
    file_size_bytes: 80, storage_bucket: 'bob-uploads',
    storage_path: `desktop/owner-uuid/vibe/${SESSION_ID}/${attachmentId}-non-sensitive-ui-note.txt`,
    extraction_status: 'extracted', extracted_text: 'The non-sensitive preview heading is clipped.',
    sha256: 'a'.repeat(64),
  };
  const prepare = async (consent, withHistory = false) => {
    const repeated = { thought: withHistory ? 'earlier private attachment marker' : 'inspect', tool: 'list_dir', args: { path: 'apps/web/src/' } };
    const { store, deps, model } = setup([
      ...(consent === true ? [repeated, repeated, repeated, repeated] : [{ tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } }]),
      { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"cloud"' } },
      { thought: 'reply', tool: 'reply', args: { message: 'Updated and verified.' } },
    ], { fetchHealth: health, allowCloud: true });
    store.state.session.created_by = 'owner-uuid';
    const message = ownerMessage('Fix the attached non-sensitive preview issue.');
    message.payload.attachment_ids = [attachmentId];
    message.payload.external_attachment_consent = consent;
    store.attachments = async (sessionId, ids) => {
      assert.equal(sessionId, SESSION_ID);
      assert.deepEqual(ids, [attachmentId]);
      return [attachment];
    };
    store.updateOwnerPayload = async (_messageId, payload) => { message.payload = payload; };
    if (withHistory) {
      store.history = async () => [{ seq: 1, role: 'owner', kind: 'message', content: 'Earlier question', payload: { attachment_context: [{ context: 'earlier private attachment marker' }] } }];
    }
    const outcome = await vibe.processVibeMessage({ store, message, deps });
    assert.equal(outcome.error, undefined);
    return { store, model };
  };

  const optedIn = await prepare(true);
  const cloudCall = optedIn.model.calls.find(call => call.provider === 'ollama_cloud');
  assert.ok(cloudCall, 'an explicitly approved attachment turn may use the configured cloud fallback');
  assert.match(JSON.stringify(cloudCall.request.messages), /The non-sensitive preview heading is clipped/);
  assert.ok(optedIn.store.state.rows.some(row => /owner-approved non-sensitive attachment context/.test(row.content)));
  const receipt = optedIn.store.state.rows.find(row => row.payload?.tool_protocol === 'json' && row.payload.external_egress);
  assert.deepEqual(receipt.payload.attachment_context_ids, [attachmentId]);
  assert.equal(receipt.payload.raw_attachments_sent, false);
  assert.ok(optedIn.store.state.rows.some(row => row.payload?.stage === 'external_egress' && row.payload.attachment_context_ids.includes(attachmentId)));

  const withHistory = await prepare(true, true);
  const historicalPrivateCall = withHistory.model.calls.find(call => call.provider !== 'ollama_cloud');
  assert.match(JSON.stringify(historicalPrivateCall.request.messages), /earlier private attachment marker/);
  for (const call of withHistory.model.calls.filter(call => call.provider === 'ollama_cloud')) {
    assert.doesNotMatch(JSON.stringify(call.request.messages), /earlier private attachment marker/);
    assert.match(JSON.stringify(call.request.messages), /The non-sensitive preview heading is clipped/);
  }

  for (const consent of [false, undefined, 'true']) {
    const localOnly = await prepare(consent);
    assert.ok(localOnly.model.calls.length > 0);
    assert.ok(localOnly.model.calls.every(call => call.provider !== 'ollama_cloud'));
  }
});

test('a prose promise with no executed tool is never handed off and escalates to a stronger model', async () => {
  const { store, deps, model } = setup([
    'Understood. I will continue with the redesign.',
    'Sure, continuing the redesign now.',
    { thought: 'start', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"redesigned"' } },
    { thought: 'report', tool: 'reply', args: { message: 'Edited hello.ts.' } },
  ], {
    allowCloud: true,
    fetchHealth: async () => ({
      gpu_workstation: { configured: true, healthy: true, models: ['weak'], installed: ['weak'], ready_model: 'weak' },
      ollama_cloud: { configured: true, healthy: true, models: ['cloud-strong'], ready_model: 'cloud-strong' },
    }),
  });
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('continue the redesign'), deps });
  assert.equal(outcome.error, undefined);
  assert.doesNotMatch(outcome.reply, /Understood/);
  assert.equal(model.calls[2].provider, 'ollama_cloud');
  assert.ok(model.calls[1].request.messages.some(entry => entry.content.includes('No tool has executed this turn')));
  assert.ok(store.state.rows.some(row => row.payload?.reason === 'prose_without_tool'));
  assert.deepEqual(store.state.session.changed_files, ['apps/web/src/hello.ts']);
});

test('local recovery is memory-filtered, installed, distinct, and never expands to external providers', () => {
  const candidates = vibe.vibeProviderCandidates({ chain: ['gpu_workstation', 'ollama'] }, {
    gpu_workstation: { configured: true, healthy: true, ready_model: 'small', models: ['small', 'fits', 'not-installed'], installed: ['small', 'fits', 'oversized'], excluded_models: ['oversized'] },
    ollama: { configured: true, healthy: true, ready_model: 'small', models: ['small', 'cpu-model'], installed: ['small', 'cpu-model'] },
    openai: { configured: true, healthy: true, ready_model: 'external' },
  });
  assert.deepEqual(candidates, [
    { provider: 'gpu_workstation', model: 'small' },
    { provider: 'gpu_workstation', model: 'fits' },
    { provider: 'ollama', model: 'cpu-model' },
  ]);
});

test('Vibe considers every owner-approved Ollama Cloud model after the ready model', () => {
  const models = ['kimi-k2.7-code', 'deepseek-v4.1-flash:1017', 'deepseek-v4-pro:0813', 'gpt-oss:120b'];
  const candidates = vibe.vibeProviderCandidates({ chain: ['ollama_cloud'] }, {
    ollama_cloud: { configured: true, healthy: true, ready_model: 'gpt-oss:120b', models, installed: models },
  });
  assert.deepEqual(candidates, [
    { provider: 'ollama_cloud', model: 'gpt-oss:120b' },
    { provider: 'ollama_cloud', model: 'kimi-k2.7-code' },
    { provider: 'ollama_cloud', model: 'deepseek-v4.1-flash:1017' },
    { provider: 'ollama_cloud', model: 'deepseek-v4-pro:0813' },
  ]);
});

test('Vibe continues past models duplicated across providers to reach a later distinct fallback', () => {
  const candidates = vibe.vibeProviderCandidates({ chain: ['gpu_workstation', 'ollama'] }, {
    gpu_workstation: { configured: true, healthy: true, ready_model: 'A', models: ['A', 'B'], installed: ['A', 'B'] },
    ollama: { configured: true, healthy: true, ready_model: 'A', models: ['A', 'B', 'C'], installed: ['A', 'B', 'C'] },
  });
  assert.deepEqual(candidates, [
    { provider: 'gpu_workstation', model: 'A' },
    { provider: 'gpu_workstation', model: 'B' },
    { provider: 'ollama', model: 'C' },
  ]);
});

test('malformed Vibe responses advance through Cloud candidates until one can act', async () => {
  const models = ['gpt-oss:120b', 'kimi-k2.7-code', 'deepseek-v4.1-flash:1017'];
  const { store, deps, model } = setup([
    '{malformed response',
    '{still malformed',
    { thought: 'read source', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"fixed"' } },
    { thought: 'reply', tool: 'reply', args: { message: 'Fixed and verified the focused edit.' } },
  ], {
    allowCloud: true,
    fetchHealth: async () => ({ ollama_cloud: { configured: true, healthy: true, models, installed: models, ready_model: models[0] } }),
  });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('fix the greeting'), deps });
  assert.equal(result.error, undefined);
  assert.deepEqual(model.calls.map(call => call.model_name), [
    'gpt-oss:120b', 'gpt-oss:120b', 'kimi-k2.7-code', 'kimi-k2.7-code', 'kimi-k2.7-code',
  ]);
  assert.ok(store.state.rows.some(row => row.payload?.reason === 'prose_without_tool' && row.payload.model === 'kimi-k2.7-code'));
  assert.deepEqual(store.state.session.changed_files, ['apps/web/src/hello.ts']);
});

test('repeated failed edits still stop even when another local recovery model is available', async () => {
  const edit = { thought: 'guess edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'missing', new_text: 'bad' } };
  const { store, deps, model } = setup(Array.from({ length: 12 }, () => edit), {
    fetchHealth: async () => ({
      gpu_workstation: { configured: true, healthy: true, models: ['primary', 'alternate'], installed: ['primary', 'alternate'], ready_model: 'primary' },
    }),
  });
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('fix greeting'), deps });
  assert.equal(outcome.error, true);
  assert.equal(model.calls.length, 8);
  assert.equal(store.state.rows.filter(row => row.payload?.reason === 'repeated_tool_call').length, 1);
  assert.deepEqual(store.state.session.changed_files, []);
});

test('successful edits invalidate cached source reads', async () => {
  const read = { thought: 'inspect source', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } };
  const { store, deps, model } = setup([
    read,
    { thought: 'change source', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"updated"' } },
    read,
    { thought: 'report', tool: 'reply', args: { message: 'Updated source read back.' } },
  ]);
  await vibe.processVibeMessage({ store, message: ownerMessage('update the greeting'), deps });
  const lastResult = model.calls[3].request.messages.filter(entry => entry.role === 'user').at(-1).content;
  assert.match(lastResult, /updated/);
  assert.doesNotMatch(lastResult, /"reused":true/);
});

test('blocked publishing commands cannot reset the repetition limit', async () => {
  const run = { thought: 'publish tooling', tool: 'run', args: { command: 'npm publish' } };
  const { store, deps, model } = setup(Array.from({ length: 8 }, () => run));
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('verify greeting'), deps });
  assert.equal(outcome.error, true);
  assert.equal(model.calls.length, 4);
});

test('an identical successful edit is not applied twice after rereading the source', async () => {
  const edit = { thought: 'add greeting', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'export const hello', new_text: '// greeting\nexport const hello' } };
  const { store, deps, workspaceRoot } = setup([
    edit,
    { thought: 'inspect', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    edit,
    { thought: 'report', tool: 'reply', args: { message: 'Added comment once.' } },
  ]);
  await vibe.processVibeMessage({ store, message: ownerMessage('describe the greeting'), deps });
  const source = fs.readFileSync(path.join(vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID), 'apps/web/src/hello.ts'), 'utf8');
  assert.equal(source.split('// greeting').length - 1, 1);
  assert.ok(store.state.rows.some(row => row.payload?.preview?.includes('This exact edit already succeeded') && row.payload.ok === false));
});

test('a change request cannot end on a no-op edit and a vague reply', async () => {
  const { store, deps, model } = setup([
    { thought: 'same text', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"hi"' } },
    { thought: 'vague', tool: 'reply', args: { message: 'Search for MetricCard in repo.' } },
    { thought: 'honest', tool: 'reply', args: { message: 'I could not locate the right lines.' } },
  ]);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('revert the greeting and restore the tone'), deps });
  assert.ok(store.state.rows.some(row => row.payload?.tool === 'replace_in_file' && /no-op edit refused/.test(row.payload.preview)));
  assert.ok(model.calls[2].request.messages.some(row => String(row.content).includes('no file changed during this message')));
  assert.match(result.reply, /^No files changed during this message\.\n\nI could not locate the right lines\./);
});

test('a real edit for a change request is handed off without a no-change notice', async () => {
  const { store, deps } = setup([
    { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"kia ora"' } },
    { thought: 'report', tool: 'reply', args: { message: 'Greeting updated.' } },
  ]);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('update the greeting'), deps });
  assert.match(result.reply, /^Greeting updated\./);
});

test('a reply cannot claim a file whose edits failed just because another file changed', async () => {
  const { store, deps, model } = setup([
    { thought: 'guess', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'import { ClipboardCheck }', new_text: '' } },
    { thought: 'other', tool: 'write_file', args: { path: 'apps/web/src/other.ts', content: 'export const other = 1;\n' } },
    { thought: 'claim', tool: 'reply', args: { message: 'The ClipboardCheck import has been removed from hello.ts.' } },
    { thought: 'honest', tool: 'reply', args: { message: 'Added other.ts.', blocked_reason: 'hello.ts edit failed: old_text not found.' } },
  ], {
    allowCloud: true,
    fetchHealth: async () => ({
      gpu_workstation: { configured: true, healthy: true, models: ['weak'], installed: ['weak'], ready_model: 'weak' },
      ollama_cloud: { configured: true, healthy: true, models: ['cloud-strong'], ready_model: 'cloud-strong' },
    }),
  });
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('remove the import and add other.ts'), deps });
  const refusal = model.calls[3].request.messages.find(entry => String(entry.content).includes('these edits failed and were never applied'));
  assert.ok(refusal);
  assert.match(refusal.content, /apps\/web\/src\/hello\.ts/);
  assert.equal(model.calls[3].provider, 'ollama_cloud');
  assert.ok(store.state.rows.some(row => row.payload?.reason === 'failed_edits_outstanding'));
  assert.match(outcome.reply, /^Not done: these edits failed and were not applied — apps\/web\/src\/hello\.ts\./);
  assert.doesNotMatch(outcome.reply, /has been removed/);
});

test('an unnecessary secret-file edit can be abandoned after the full web suite actually passes', async t => {
  const reason = 'No environment file is required; the configured suite runs from the existing package script.';
  const fixture = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/.env.test', old_text: 'TOKEN=placeholder', new_text: 'TOKEN=unnecessary' } },
    { tool: 'run', args: { command: 'npm test --prefix apps/web' } },
    { tool: 'abandon_failed_edit', args: { path: 'apps/web/.env.test', reason } },
    { tool: 'reply', args: { message: 'The configured web suite passed without changing protected environment files.' } },
  ]);
  t.after(() => { fs.rmSync(fixture.repo.dir, { recursive: true, force: true }); fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true }); });
  installFixtureChecks(fixture.repo);
  const original = fs.readFileSync(path.join(fixture.repo.dir, 'apps/web/package.json'), 'utf8');
  fixture.store.recentExecution = async () => [{
    role: 'tool', kind: 'test', payload: { tool: 'run', command: 'npm test --prefix apps/web', ok: false, preview: 'command not allowed' },
  }];
  const message = ownerMessage('verify the web suite');
  const outcome = await vibe.processVibeMessage({ store: fixture.store, message, deps: fixture.deps });
  assert.equal(outcome.error, undefined, outcome.reply);
  assert.equal(fixture.store.state.completed[message.id], 'done');
  assert.match(outcome.reply, /Unneeded edits not applied:\n- apps\/web\/\.env\.test:/);
  assert.doesNotMatch(outcome.reply, /Changes are not verified|Not done:|human.*approval/i);
  const receipts = fixture.store.state.rows.filter(row => row.role === 'tool').map(row => row.payload);
  assert.equal(receipts.find(row => row.tool === 'replace_in_file').ok, false, 'protected environment edits remain refused');
  assert.equal(receipts.find(row => row.tool === 'run').ok, true, 'the full command really ran');
  assert.equal(receipts.find(row => row.tool === 'abandon_failed_edit').ok, true);
  const workspace = vibe.vibeWorkspacePath(fixture.workspaceRoot, SESSION_ID);
  assert.equal(fs.readFileSync(path.join(workspace, 'apps/web/package.json'), 'utf8'), original);
  assert.equal(git(workspace, ['status', '--porcelain']), '');
  const contract = fixture.model.calls[0].request.output_schema.oneOf.find(item => item.properties.tool.const === 'abandon_failed_edit');
  assert.deepEqual(contract.properties.args.required, ['path', 'reason']);
});

test('Vibe can edit a dependency manifest, install an offline tool and invoke the Playwright runner', async t => {
  const fixture = setup([
    { tool: 'replace_in_file', args: {
      path: 'apps/web/package.json', old_text: '"scripts":{',
      new_text: '"devDependencies":{"playwright":"file:./playwright-fixture"},"scripts":{"test:e2e":"playwright test",',
    } },
    { tool: 'run', args: { command: 'npm install --offline --ignore-scripts --prefix apps/web' } },
    { tool: 'run', args: { command: 'npm exec --prefix apps/web -- playwright install chromium' } },
    { tool: 'run', args: { command: 'npm run test:e2e --prefix apps/web -- e2e/FieldReportsPage.spec.ts' } },
    { tool: 'reply', args: { message: 'Installed the workspace fixture and ran the Playwright command.' } },
  ]);
  t.after(() => { fs.rmSync(fixture.repo.dir, { recursive: true, force: true }); fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true }); });
  const localPackage = path.join(fixture.repo.dir, 'apps/web/playwright-fixture');
  fs.mkdirSync(localPackage, { recursive: true });
  fs.writeFileSync(path.join(localPackage, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.0.0', bin: { playwright: 'cli.cjs' } }));
  fs.writeFileSync(path.join(localPackage, 'cli.cjs'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const browser = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH || "", "chromium-installed");',
    'if (!process.env.PLAYWRIGHT_BROWSERS_PATH || !process.env.PLAYWRIGHT_BROWSERS_PATH.includes("/workspace/node_modules/.cache/bob-tooling/.cache/ms-playwright")) process.exit(3);',
    'if (process.argv[2] === "install" && process.argv[3] === "chromium") { fs.mkdirSync(path.dirname(browser), {recursive:true}); fs.writeFileSync(browser, "installed"); console.log("chromium installed in isolated cache"); }',
    'else if (process.argv[2] === "test" && fs.existsSync(browser)) console.log(process.argv.slice(3).join(" "));',
    'else process.exit(4);',
  ].join('\n') + '\n');
  git(fixture.repo.dir, ['add', '.']);
  git(fixture.repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'add local package fixture']);
  fixture.repo.sha = git(fixture.repo.dir, ['rev-parse', 'HEAD']);
  const outcome = await vibe.processVibeMessage({ store: fixture.store, message: ownerMessage('install the Playwright tool and run its check'), deps: fixture.deps });
  assert.equal(outcome.error, undefined, outcome.reply);
  const receipts = fixture.store.state.rows.filter(row => row.role === 'tool').map(row => row.payload);
  assert.equal(receipts.find(row => row.tool === 'replace_in_file')?.ok, true);
  assert.equal(receipts.find(row => row.tool === 'run' && row.args?.command?.startsWith('npm install'))?.ok, true);
  assert.equal(receipts.find(row => row.tool === 'run' && row.args?.command?.includes('playwright install chromium'))?.ok, true);
  const playwrightRun = receipts.find(row => row.tool === 'run' && row.args?.command?.includes('test:e2e'));
  assert.equal(playwrightRun?.ok, true);
  assert.match(playwrightRun?.preview ?? '', /e2e\/FieldReportsPage\.spec\.ts/);
  const workspace = vibe.vibeWorkspacePath(fixture.workspaceRoot, SESSION_ID);
  const packageJson = JSON.parse(fs.readFileSync(path.join(workspace, 'apps/web/package.json'), 'utf8'));
  assert.equal(packageJson.devDependencies.playwright, 'file:./playwright-fixture');
  assert.equal(fs.existsSync(path.join(workspace, 'apps/web/node_modules/.bin/playwright')), true);
});

test('abandoning an unnecessary edit never clears a failing test or permits a green handoff', async t => {
  const fixture = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/.env.test', old_text: 'TOKEN=placeholder', new_text: 'TOKEN=unnecessary' } },
    { tool: 'run', args: { command: 'npm test --prefix apps/web' } },
    { tool: 'abandon_failed_edit', args: { path: 'apps/web/.env.test', reason: 'Changing a protected environment file would only hide the real failing application test.' } },
    { tool: 'reply', args: { message: 'All tests passed.' } },
  ]);
  t.after(() => { fs.rmSync(fixture.repo.dir, { recursive: true, force: true }); fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true }); });
  installFixtureChecks(fixture.repo);
  fs.writeFileSync(path.join(fixture.repo.dir, 'apps/web/src/hello.ts'), 'export const hello = "BROKEN";\n');
  git(fixture.repo.dir, ['add', '.']);
  git(fixture.repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'failing test fixture']);
  fixture.repo.sha = git(fixture.repo.dir, ['rev-parse', 'HEAD']);
  const message = ownerMessage('verify the web suite');
  const outcome = await vibe.processVibeMessage({
    store: fixture.store, message, deps: fixture.deps, limits: { ...vibe.VIBE_LIMITS, repairRounds: 0 },
  });
  assert.equal(outcome.error, true);
  assert.equal(fixture.store.state.completed[message.id], 'failed');
  assert.match(outcome.reply, /Changes are not verified: npm test --prefix apps\/web failed/);
  assert.match(outcome.reply, /Unneeded edits not applied/);
  assert.doesNotMatch(outcome.reply, /All tests passed/);
});

test('failed-edit abandonment rejects unknown paths and invalid reasons without clearing the real blocker', async t => {
  const fixture = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/.env.test', old_text: 'TOKEN=placeholder', new_text: 'TOKEN=other' } },
    { tool: 'abandon_failed_edit', args: { path: 'apps/web/.env.test', reason: ' ' } },
    { tool: 'abandon_failed_edit', args: { path: 'apps/web/.env.test', reason: 'x'.repeat(1001) } },
    { tool: 'abandon_failed_edit', args: { path: 'apps/web/src/hello.ts', reason: 'This different file is not needed for the current verification task.' } },
    { tool: 'reply', args: { message: 'The environment edit remains blocked.', blocked_reason: 'The failed edit has not been resolved.' } },
  ]);
  t.after(() => { fs.rmSync(fixture.repo.dir, { recursive: true, force: true }); fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true }); });
  const outcome = await vibe.processVibeMessage({ store: fixture.store, message: ownerMessage('verify configuration'), deps: fixture.deps });
  assert.equal(outcome.error, true);
  assert.match(outcome.reply, /Not done: these edits failed.*apps\/web\/\.env\.test/);
  const receipts = fixture.store.state.rows.filter(row => row.payload?.tool === 'abandon_failed_edit');
  assert.equal(receipts.length, 3);
  assert.ok(receipts.every(row => row.payload.ok === false));
});

test('restarted turns retain a recorded failed-workaround abandonment without replaying the edit', async t => {
  const reason = 'The existing environment file is protected and was not needed for this test.';
  const fixture = setup([{ tool: 'reply', args: { message: 'The earlier test pass remains recorded; the protected environment edit was not applied.' } }]);
  t.after(() => { fs.rmSync(fixture.repo.dir, { recursive: true, force: true }); fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true }); });
  const message = ownerMessage('verify configuration');
  interruptedWorkspace(fixture, message);
  fixture.store.state.rows.push(
    { role: 'tool', kind: 'tool', payload: { message_id: message.id, tool: 'replace_in_file', args: { path: 'apps/web/.env.test' }, edit_targets: ['apps/web/.env.test'], ok: false, preview: 'protected file refused' } },
    { role: 'tool', kind: 'tool', payload: { message_id: message.id, tool: 'abandon_failed_edit', args: { path: 'apps/web/.env.test', reason }, ok: true } },
  );
  const outcome = await vibe.processVibeMessage({ store: fixture.store, message, deps: fixture.deps });
  assert.equal(outcome.error, undefined, outcome.reply);
  assert.match(outcome.reply, /Unneeded edits not applied:\n- apps\/web\/\.env\.test:/);
  assert.doesNotMatch(outcome.reply, /Not done: these edits failed/);
  assert.equal(fixture.store.state.rows.filter(row => row.payload?.tool === 'replace_in_file').length, 1);
});

test('a failed edit later retried successfully on the same file does not block the reply', async () => {
  const { store, deps, model } = setup([
    { thought: 'guess', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"missing"', new_text: '"x"' } },
    { thought: 'retry', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"kia ora"' } },
    { thought: 'report', tool: 'reply', args: { message: 'Greeting updated.' } },
  ]);
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('update the greeting'), deps });
  assert.equal(model.calls.length, 3);
  assert.match(outcome.reply, /^Greeting updated\./);
});

test('edit targets come from the files a patch or baseline call touches, not the tool name', () => {
  assert.deepEqual(vibe.editTargets('replace_in_file', { path: 'a.ts' }), ['a.ts']);
  assert.deepEqual(vibe.editTargets('apply_patch', { diff: '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n' }), ['x.ts']);
  assert.deepEqual(vibe.editTargets('apply_patch', { diff: '--- /dev/null\n+++ b/new.ts\n' }), ['new.ts']);
  assert.deepEqual(vibe.editTargets('apply_patch', { diff: '*** Begin Patch\n*** Update File: y.ts\n*** Move to: z.ts\n@@\n-a\n+b\n*** End Patch' }), ['y.ts', 'z.ts']);
  assert.deepEqual(vibe.editTargets('generate_visual_baselines', { paths: ['e2e/a.spec.ts'], reason: 'r' }), ['e2e/a.spec.ts']);
});

test('a successful patch to an unrelated file does not clear an earlier failed patch', async () => {
  const { store, deps } = setup([
    { thought: 'bad', tool: 'apply_patch', args: { diff: '*** Begin Patch\n*** Update File: apps/web/src/hello.ts\n@@\n-export const missing = 1;\n+export const missing = 2;\n*** End Patch' } },
    { thought: 'other', tool: 'write_file', args: { path: 'apps/web/src/other.ts', content: 'export const other = 1;\n' } },
    { thought: 'claim', tool: 'reply', args: { message: 'Both files are done.', blocked_reason: 'hello.ts patch did not apply.' } },
  ]);
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('change hello and add other.ts'), deps });
  assert.match(outcome.reply, /^Not done: these edits failed and were not applied — apps\/web\/src\/hello\.ts\./);
});

test('a failed edit repaired through a different edit tool is no longer reported as undone', async () => {
  const { store, deps } = setup([
    { thought: 'guess', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"missing"', new_text: '"x"' } },
    { thought: 'patch', tool: 'apply_patch', args: { diff: '*** Begin Patch\n*** Update File: apps/web/src/hello.ts\n@@\n-export const hello = "hi";\n+export const hello = "kia ora";\n*** End Patch' } },
    { thought: 'report', tool: 'reply', args: { message: 'Greeting updated.' } },
  ]);
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('update the greeting'), deps });
  assert.match(outcome.reply, /^Greeting updated\./);
});

test('when every edit failed the handoff carries both the no-change notice and the Not done list', async () => {
  const { store, deps } = setup([
    { thought: 'guess', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"missing"', new_text: '"x"' } },
    { thought: 'honest', tool: 'reply', args: { message: 'I could not apply it.', blocked_reason: 'old_text not found in hello.ts.' } },
  ]);
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('update the greeting'), deps });
  assert.match(outcome.reply, /^No files changed during this message\.\n\nNot done: these edits failed and were not applied — apps\/web\/src\/hello\.ts\./);
});

test('owner requests are classified as change, verification or question in both directions', () => {
  for (const text of ['change the greeting', 'edit the greeting', 'Can you fix the greeting?', 'Please add a spinner', 'check the build then fix the header']) {
    assert.deepEqual(vibe.classifyOwnerRequest(text), { asked: false, wantsChange: true }, text);
  }
  for (const text of ['run the build', 'verify the fix without editing files', 'npm run build and report', 'check whether the tests pass', 'verify the fix']) {
    assert.equal(vibe.classifyOwnerRequest(text).wantsChange, false, text);
  }
  assert.deepEqual(vibe.classifyOwnerRequest('What does MetricCard do?'), { asked: true, wantsChange: false });
  assert.equal(vibe.isClarifyingQuestion('Which card should be red?'), true);
  assert.equal(vibe.isClarifyingQuestion('Fixed. Can you check the preview?'), false);
});

test('a verification-only request that changes nothing is not refused or relabelled', async () => {
  const { store, deps, model } = setup([
    { thought: 'inspect', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { thought: 'report', tool: 'reply', args: { message: 'The fix is in place.' } },
  ]);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('verify the fix without editing files'), deps });
  assert.equal(model.calls.length, 2);
  assert.doesNotMatch(result.reply, /No files changed/);
});

test('a completion claim ending in a question still gets the no-change safeguards', async () => {
  const { store, deps, model } = setup([
    { thought: 'look', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { thought: 'claim', tool: 'reply', args: { message: 'Fixed. Can you check the preview?' } },
    { thought: 'claim again', tool: 'reply', args: { message: 'Fixed. Can you check the preview?' } },
  ]);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('Can you fix the greeting?'), deps });
  assert.ok(model.calls[2].request.messages.some(row => String(row.content).includes('no file changed during this message')));
  assert.match(result.reply, /^No files changed during this message\./);
});

test('no_change_reason is honoured even before any tool runs', async () => {
  const { store, deps, model } = setup([
    { thought: 'already done', tool: 'reply', args: { message: 'Already in place.', no_change_reason: 'The previous message already restored the greeting.' } },
  ]);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('restore the greeting'), deps });
  assert.equal(model.calls.length, 1);
  assert.match(result.reply, /The previous message already restored the greeting\./);
});

test('a blocked response with failed verification gets one bounded self-triage retry', async t => {
  const command = 'node --test test/vibe-self-triage.test.js';
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'run', args: { command } },
    { tool: 'reply', args: { blocked_reason: 'The browser startup timeout needs an owner to interpret.' } },
    { tool: 'run', args: { command } },
    { tool: 'reply', args: { message: 'The targeted check passed on retry; the first timeout was transient.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(repo.dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, 'test/vibe-self-triage.test.js'), [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "test('a transient browser startup timeout can be retried', () => {",
    "  const marker = path.join(__dirname, '../apps/web/node_modules/.cache/vibe-self-triage-attempt');",
    '  const retried = fs.existsSync(marker);',
    '  fs.mkdirSync(path.dirname(marker), { recursive: true });',
    "  fs.writeFileSync(marker, 'attempted');",
    "  if (!retried) assert.fail('Navigation timeout at /admin/bob');",
    '});',
  ].join('\n'));
  git(repo.dir, ['add', '.']);
  git(repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'add retry fixture']);
  repo.sha = git(repo.dir, ['rev-parse', 'HEAD']);

  const result = await vibe.processVibeMessage({ store, message: ownerMessage('check the failed browser run'), deps });

  assert.equal(result.error, undefined, result.reply);
  assert.match(result.reply, /passed on retry/);
  const receipts = store.state.rows.filter(row => row.payload?.tool === 'run');
  assert.deepEqual(receipts.map(row => row.payload.ok), [false, true]);
  assert.match(JSON.stringify(model.calls[2].request.messages), /self-triage/i);
});

test('self-triage can inspect and repair a failed draft before a verified handoff', async t => {
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { tool: 'reply', args: { blocked_reason: 'The compiler failure needs investigation.' } },
    { tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'BROKEN', new_text: '"repaired"' } },
    { tool: 'reply', args: { message: 'The greeting is repaired and verified.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  installFixtureTypecheck(repo);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('repair the greeting'), deps });
  assert.equal(result.error, undefined, result.reply);
  assert.match(result.reply, /repaired and verified/);
  const checks = store.state.rows.filter(row => row.payload?.reason === 'web_typescript_handoff');
  assert.deepEqual(checks.map(row => row.payload.ok), [false, true]);
  assert.notEqual(checks[0].payload.source_fingerprint, checks[1].payload.source_fingerprint);
  const ws = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
  assert.match(fs.readFileSync(path.join(ws, 'apps/web/src/hello.ts'), 'utf8'), /"repaired"/);
  assert.notEqual(store.state.session.head_sha, repo.sha);
});

test('self-triage stops on the same failed check and preserves the unresolved blocker', async t => {
  const reason = 'The target is still missing after inspecting the failure.';
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'run', args: { command: 'node --check missing.js' } },
    { tool: 'reply', args: { blocked_reason: 'The missing target needs investigation.' } },
    { tool: 'read_file', args: { path: 'package.json' } },
    { tool: 'reply', args: { blocked_reason: reason } },
    { tool: 'write_file', args: { path: 'test/should-not-run.js', content: 'module.exports = true;\n' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('verify syntax'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /Changes are not verified: node --check missing.js failed/);
  assert.ok(result.reply.includes(reason));
  assert.equal(model.calls.length, 4);
  assert.equal(store.state.rows.filter(row => row.payload?.tool === 'run').length, 1);
  assert.equal(store.state.rows.some(row => row.payload?.tool === 'write_file'), false);
});

for (const reason of [
  'Owner approval is required before changing the access policy.',
  'A human decision is needed about the expected product behavior.',
  'Dedicated test credentials are unavailable; do not use a real user session.',
  'Access denied: the test identity lacks permission.',
  'The owner must choose the expected product behavior before I continue.',
  'I need access to the private test environment.',
  'The protected file requires an owner grant before it can be edited.',
]) test(`self-triage respects a human-only boundary: ${reason}`, async t => {
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'run', args: { command: 'node --check missing.js' } },
    { tool: 'reply', args: { blocked_reason: reason } },
    { tool: 'write_file', args: { path: 'test/should-not-run.js', content: 'module.exports = true;\n' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('verify syntax'), deps });
  assert.equal(result.error, true);
  assert.ok(result.reply.includes(reason));
  assert.equal(model.calls.length, 2);
  assert.equal(store.state.rows.some(row => row.payload?.tool === 'write_file'), false);
});

test('failed verification cannot become a successful handoff just because the model says done', async () => {
  const { store, deps, model } = setup([
    { thought: 'check', tool: 'run', args: { command: 'node --check missing.js' } },
    { thought: 'optimistic', tool: 'reply', args: { message: 'All fixed.' } },
    { thought: 'blocked', tool: 'reply', args: { message: 'Done.', blocked_reason: 'The syntax check could not find the target.' } },
  ]);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('verify the change'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /Changes are not verified: node --check missing.js failed/);
  assert.ok(model.calls[2].request.messages.some(row => row.content.includes('Handoff refused')));
  assert.equal(store.state.rows.at(-1).kind, 'error');
});

test('a passing rerun clears the failed-verification handoff blocker', async () => {
  const { store, deps } = setup([
    { thought: 'check missing target', tool: 'run', args: { command: 'node --check test/syntax.js' } },
    { thought: 'create target', tool: 'write_file', args: { path: 'test/syntax.js', content: 'module.exports = 1;\n' } },
    { thought: 'verify correct target', tool: 'run', args: { command: 'node --check test/syntax.js' } },
    { thought: 'report', tool: 'reply', args: { message: 'Syntax verified.' } },
  ]);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('verify syntax'), deps });
  assert.equal(result.error, undefined);
  assert.equal(result.reply, 'Syntax verified.');
});

test('an unrelated passing check does not clear a failed verification', async () => {
  const { store, deps } = setup([
    { thought: 'check missing target', tool: 'run', args: { command: 'node --check missing.js' } },
    { thought: 'create other target', tool: 'write_file', args: { path: 'test/other.js', content: 'module.exports = 1;\n' } },
    { thought: 'check unrelated target', tool: 'run', args: { command: 'node --check test/other.js' } },
    { thought: 'report', tool: 'reply', args: { message: 'Done.', blocked_reason: 'missing.js still cannot be checked.' } },
  ]);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('verify syntax'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /node --check missing.js failed/);
});

test('continuation retains a failed check even if the next model only replies', async () => {
  const { store, deps } = setup([
    { thought: 'optimistic', tool: 'reply', args: { message: 'Done.', blocked_reason: 'Previous lint is still failing.' } },
  ]);
  store.recentExecution = async () => [{
    kind: 'test', seq: 8, payload: { tool: 'run', args: { command: 'npm run lint --prefix apps/web' }, ok: false, preview: 'exit 2\nTypeScript syntax error' },
  }];
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('continue'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /npm run lint --prefix apps\/web failed/);
});

test('the same source-guard selection can be verified in its correct Node environment', async () => {
  const { store, deps, repo } = setup([
    { thought: 'check default', tool: 'run', args: { command: 'npm run test --prefix apps/web -- guard' } },
    { thought: 'correct runner environment', tool: 'run', args: { command: 'npm run test --prefix apps/web -- guard --environment node' } },
    { thought: 'report', tool: 'reply', args: { message: 'Guard verified in Node.' } },
  ]);
  fs.writeFileSync(path.join(repo.dir, 'apps/web/package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }));
  fs.writeFileSync(path.join(repo.dir, 'apps/web/check.cjs'), 'process.exit(process.argv.includes("--environment") ? 0 : 1);\n');
  git(repo.dir, ['add', '.']);
  git(repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'add runner fixture']);
  repo.sha = git(repo.dir, ['rev-parse', 'HEAD']);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('verify guard'), deps });
  assert.equal(result.error, undefined);
  assert.equal(result.reply, 'Guard verified in Node.');
});

test('vibe stops after four identical tool calls rather than spending the full turn budget', async () => {
  const repeated = Array.from({ length: 10 }, () => ({ thought: 'inspect', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } }));
  const { store, deps, model } = setup(repeated);
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('inspect the greeting'), deps, limits: { ...vibe.VIBE_LIMITS, maxTurns: 10 } });
  assert.equal(outcome.error, true);
  assert.match(outcome.reply, /stopped after repeating the same tool call/);
  assert.equal(model.calls.length, 4);
  assert.match(JSON.stringify(model.calls[2].request.messages), /This exact call has already run 2 times/);
  assert.equal(store.state.rows.filter(row => row.payload?.tool === 'read_file').length, 4);
  assert.equal(store.state.rows.at(-1).kind, 'error');
});

test('Vibe can recover from a repeated broad search without disabling its loop guard', async () => {
  const search = { thought: 'find routing', tool: 'search', args: { path: 'apps/web/src', query: 'routes' } };
  const { store, deps, model } = setup([
    search,
    search,
    { thought: 'narrow to known source', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { thought: 'fix', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"fixed"' } },
    { thought: 'report', tool: 'reply', args: { message: 'Fixed and kept the existing context.' } },
  ]);
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('fix navigation'), deps });
  assert.equal(outcome.error, undefined);
  assert.match(JSON.stringify(model.calls[2].request.messages), /narrow path\/query/);
  assert.deepEqual(store.state.session.changed_files, ['apps/web/src/hello.ts']);
  assert.match(vibe.vibeSystemPrompt(), /routing\/RoleRouter.tsx/);
  assert.match(vibe.vibeSystemPrompt(), /pages\/StaffProfilePage/);
  assert.match(vibe.vibeSystemPrompt(), /\.agents\/skills\/supabase\/SKILL\.md/);
  assert.match(vibe.vibeSystemPrompt(), /\.agents\/skills\/supabase-postgres-best-practices\/SKILL\.md/);
  assert.match(vibe.vibeSystemPrompt(), /AGENTS\.md, the repository canon, credential boundaries, live schema and Atlas govern this product/);
  assert.match(vibe.vibeSystemPrompt(), /React hooks may only be called at the top level/);
  assert.match(vibe.vibeSystemPrompt(), /Preserve existing tests and imports/);
  assert.match(vibe.vibeSystemPrompt(), /run tool forces NODE_ENV=test/);
  assert.match(vibe.vibeSystemPrompt(), /map each failing assertion to the changed code path/);
  assert.match(vibe.vibeSystemPrompt(), /Do not rerun an unchanged full walk/);
  assert.match(vibe.vibeSystemPrompt(), /claim it is pre-existing without reproducing it on the pinned base/);
  assert.match(vibe.vibeSystemPrompt(), /passing focused test does not erase a failed browser walk/);
});

test('continuation receives prior answers, failures, successful edits and committed files', async () => {
  const { store, deps, model } = setup([]);
  store.history = async () => [
    { role: 'owner', kind: 'message', status: 'done', content: 'The start date is in Staff profile, Employment & pay.', payload: {} },
    { role: 'bob', kind: 'error', content: 'Stopped after repeating a search.', payload: {} },
  ];
  store.recentExecution = async () => [
    { seq: 1, kind: 'tool', content: 'Searching apps/web/src', payload: { tool: 'search', args: { path: 'apps/web/src', query: 'routes' }, ok: true, preview: '409 matches; truncated' } },
    { seq: 2, kind: 'tool', content: 'Reading guessed route', payload: { tool: 'read_file', args: { path: 'apps/web/src/routes.tsx' }, ok: false, preview: 'not a file' } },
    { seq: 3, kind: 'tool', content: 'Editing profile', payload: { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts' }, ok: true, preview: 'replaced one occurrence' } },
    { seq: 4, kind: 'test', content: 'Running check', payload: { tool: 'run', args: { command: 'node --check missing.js' }, ok: true, preview: 'exit 1\nCannot find module' } },
    { seq: 5, kind: 'diff', content: 'One file changed', payload: { files: ['apps/web/src/hello.ts'] } },
  ];
  await vibe.processVibeMessage({ store, message: ownerMessage('continue'), deps });
  const task = model.calls[0].request.messages[1].content;
  assert.match(task, /OWNER \[done\]: The start date is in Staff profile, Employment & pay/);
  assert.match(task, /BOB \[failed\]: Stopped after repeating/);
  assert.match(task, /SUCCEEDED search:.*"query":"routes"/);
  assert.match(task, /FAILED read_file:.*routes.tsx.*not a file/);
  assert.match(task, /SUCCEEDED replace_in_file:.*hello.ts/);
  assert.match(task, /FAILED run:.*Cannot find module/);
  assert.match(task, /COMMITTED diff:.*files=apps\/web\/src\/hello.ts/);
});

test('continuation sees an unresolved verification beyond the recent execution window', async t => {
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'reply', args: { blocked_reason: 'The earlier check still needs repair.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  store.recentExecution = async () => [];
  store.verificationHistory = async () => [{
    kind: 'test', payload: { tool: 'run', args: { command: 'node --check missing.js' }, ok: false, preview: 'exit 1\nEarlier syntax failure' },
  }];
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('Continue.'), deps });
  assert.equal(result.error, true);
  assert.match(model.calls[0].request.messages[1].content, /Earlier syntax failure/);
});

test('oversized continuation fits the real local context budget and retains the owner request and failed receipt', async t => {
  const { promptFitsProvider } = require('../builder-model-gateway');
  const health = { gpu_workstation: { configured: true, healthy: true, models: ['local'], installed: ['local'], ready_model: 'local', num_ctx: 24576, max_output_tokens: 8192 } };
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'reply', args: { blocked_reason: 'The browser failure still needs repair.' } },
  ], { fetchHealth: async () => health });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const detailedConstraint = `Only edit BuilderControlRoomPage.tsx. ${'detail '.repeat(500)}Keep all existing browser specs intact.`;
  store.history = async () => Array.from({ length: 30 }, (_, index) => ({
    role: [0, 15, 28, 29].includes(index) ? 'owner' : 'bob',
    content: index === 0 ? 'Original task: preserve the existing branch and do not ship.'
      : index === 15 ? detailedConstraint : `Earlier message ${index}: ${'detail '.repeat(500)}`,
  }));
  store.recentExecution = async () => [{
    seq: 5, kind: 'test', content: 'Browser failed',
    payload: { tool: 'human_test', ok: false, preview: 'FAILED: timeout selecting Jobs & approvals' },
  }];
  const current = 'Continue the same work without opening a pull request.';
  await vibe.processVibeMessage({ store, message: ownerMessage(current), deps });
  const request = model.calls[0].request;
  assert.equal(promptFitsProvider(request, { kind: 'ollama', numCtx: 24576, maxOutputTokens: 8192 }), true);
  const task = request.messages[1].content;
  assert.match(task, /Original task: preserve the existing branch and do not ship/);
  assert.ok(task.includes(detailedConstraint));
  assert.match(task, /timeout selecting Jobs & approvals/);
  assert.ok(task.includes(current));
  assert.match(task, /condensed to fit the model/);
  assert.ok(store.state.rows.some(row => row.payload?.reason === 'context_compacted'));
});

test('continuation blocks instead of dropping owner instructions that exceed the context window', async t => {
  const health = { gpu_workstation: { configured: true, healthy: true, models: ['local'], ready_model: 'local', num_ctx: 24576, max_output_tokens: 8192 } };
  const { store, deps, repo, workspaceRoot, model } = setup([], { fetchHealth: async () => health });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  store.history = async () => Array.from({ length: 20 }, (_, index) => ({
    role: 'owner', content: `Earlier owner instruction ${index}: ${'required detail '.repeat(250)}`,
  }));
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('Continue.'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /context is too small/);
  assert.equal(model.calls.length, 0);
});

test('compaction never sends earlier attachment history or its failure output to a cloud fallback', async t => {
  const health = { ollama_cloud: { configured: true, healthy: true, models: ['cloud'], ready_model: 'cloud', num_ctx: 24576, max_output_tokens: 8192 } };
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'reply', args: { blocked_reason: 'Need local evidence.' } },
  ], { allowCloud: true, fetchHealth: async () => health });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  store.history = async () => [{
    role: 'owner', content: 'private-history-marker '.repeat(3000),
    payload: { attachment_context: [{ context: 'private-attachment-marker' }] },
  }];
  store.recentExecution = async () => [{
    seq: 1, kind: 'test',     payload: { tool: 'run', args: { command: 'node --check private-command-marker.js' }, ok: false, preview: 'private-failure-marker' },
  }];
  await vibe.processVibeMessage({ store, message: ownerMessage('continue without attachments'), deps });
  assert.equal(model.calls[0].provider, 'ollama_cloud');
  const request = JSON.stringify(model.calls[0].request);
  assert.doesNotMatch(request, /private-history-marker|private-attachment-marker|private-failure-marker|private-command-marker/);
  assert.match(request, /withheld from external models/);
  assert.match(request, /node --check \(arguments withheld\)/);
});

test('a compacted cloud continuation retains failed check types without earlier attachment output', async t => {
  const { promptFitsProvider } = require('../builder-model-gateway');
  const health = { ollama_cloud: { configured: true, healthy: true, models: ['cloud'], ready_model: 'cloud', num_ctx: 24576, max_output_tokens: 8192 } };
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'reply', args: { blocked_reason: 'Need local evidence.' } },
  ], { allowCloud: true, fetchHealth: async () => health });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  store.history = async () => [{
    role: 'owner', content: 'private-history-marker',
    payload: { attachment_context: [{ context: 'private-attachment-marker' }] },
  }];
  store.recentExecution = async () => [
    { seq: 1, kind: 'test', payload: { tool: 'run', args: { command: 'node --check private-command-marker.js' }, ok: false, preview: 'private-failure-marker' } },
    { seq: 2, kind: 'test', payload: { tool: 'browser_test', ok: false, preview: 'private-browser-output', browser_test: { revision: 'worktree', specs: ['e2e/private-spec-marker.spec.ts'] } } },
  ];
  const current = `Continue ${'a'.repeat(54000 - vibe.vibeSystemPrompt().length)}`;
  await vibe.processVibeMessage({ store, message: ownerMessage(current), deps });
  const request = model.calls[0].request;
  assert.equal(promptFitsProvider(request, { kind: 'ollama', numCtx: 24576, maxOutputTokens: 8192 }), true);
  assert.ok(request.messages[1].content.includes(current));
  assert.match(request.messages[1].content, /node --check \(arguments withheld\)/);
  assert.match(request.messages[1].content, /browser_test \(spec paths withheld\)/);
  assert.doesNotMatch(JSON.stringify(request), /private-history-marker|private-attachment-marker|private-failure-marker|private-command-marker|private-spec-marker|private-browser-output/);
  assert.ok(store.state.rows.some(row => row.payload?.reason === 'context_compacted'));
});

test('a cloud repair extension withholds prior verification arguments', async t => {
  const health = { ollama_cloud: { configured: true, healthy: true, models: ['cloud'], ready_model: 'cloud' } };
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { tool: 'reply', args: { blocked_reason: 'The earlier check is still outstanding.' } },
  ], { allowCloud: true, fetchHealth: async () => health });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  store.hasEarlierAttachments = async () => true;
  store.recentExecution = async () => [{
    seq: 1, kind: 'test', payload: { tool: 'run', args: { command: 'npm test -- --testNamePattern private-command-marker' }, ok: false, preview: 'private-failure-marker' },
  }];
  const limits = { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 1 };
  await vibe.processVibeMessage({ store, message: ownerMessage('Review the current work.'), deps, limits });
  assert.equal(model.calls.length, 2);
  const request = JSON.stringify(model.calls[1].request);
  assert.match(request, /Step budget reached while npm test \(arguments withheld\)/);
  assert.doesNotMatch(request, /private-command-marker|private-failure-marker/);
});

test('cloud loop recovery does not automatically send a previous attachment-derived branch diff', async t => {
  const localHealth = { gpu_workstation: { configured: true, healthy: true, models: ['local'], ready_model: 'local' } };
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"private-diff-marker"' } },
    { tool: 'reply', args: { message: 'Changed the greeting.' } },
  ], { allowCloud: true, fetchHealth: async () => localHealth });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const first = await vibe.processVibeMessage({ store, message: ownerMessage('Change the greeting.'), deps });
  assert.equal(first.error, undefined);
  store.hasEarlierAttachments = async () => true;
  const repeated = { tool: 'list_dir', args: { path: 'apps/web/src/' } };
  const cloudModel = scriptedModel([repeated, repeated, repeated, repeated, { tool: 'reply', args: { blocked_reason: 'Need private history.' } }]);
  deps.callModel = cloudModel.callModel;
  deps.fetchHealth = async () => ({ ollama_cloud: { configured: true, healthy: true, models: ['cloud-one', 'cloud-two'], ready_model: 'cloud-one' } });
  await vibe.processVibeMessage({ store, message: ownerMessage('Review the current work.'), deps });
  const recovery = cloudModel.calls.find(call => JSON.stringify(call.request.messages).includes('previous model got stuck'));
  assert.ok(recovery, 'the second cloud candidate receives the recovery packet');
  const packet = JSON.stringify(recovery.request);
  assert.match(packet, /branch diff may contain earlier attachment context/);
  assert.doesNotMatch(packet, /private-diff-marker/);
});

test('a request that cannot fit mandatory context is not silently truncated or sent', async t => {
  const health = { gpu_workstation: { configured: true, healthy: true, models: ['small'], ready_model: 'small', num_ctx: 16384, max_output_tokens: 8192 } };
  const { store, deps, repo, workspaceRoot, model } = setup([], { fetchHealth: async () => health });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage(`Continue: ${'required owner text '.repeat(2000)}`), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /context is too small/);
  assert.match(result.reply, /This oversized request was not truncated or sent/);
  assert.equal(model.calls.length, 0);
  assert.deepEqual(store.state.session.changed_files, []);
});

test('a gateway context limit discovered after health lookup is fitted before retrying', async t => {
  const { promptFitsProvider } = require('../builder-model-gateway');
  const calls = [];
  const { store, deps, repo, workspaceRoot } = setup([], {
    callModel: async ({ modelRequest }) => {
      calls.push(modelRequest);
      if (calls.length === 1) return { ok: false, status: 413, code: 'context_exceeded', error: 'prompt exceeds the gpu_workstation context window (24576 tokens)' };
      return { ok: true, data: { content: JSON.stringify({ tool: 'reply', args: { blocked_reason: 'No further change requested.' } }) } };
    },
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  store.history = async () => Array.from({ length: 30 }, (_, i) => ({
    role: i % 7 === 0 ? 'owner' : 'bob', content: `Previous ${i}: ${'context '.repeat(500)}`,
  }));
  await vibe.processVibeMessage({ store, message: ownerMessage('continue safely'), deps });
  assert.equal(calls.length, 2);
  assert.equal(promptFitsProvider(calls[1].request, { kind: 'ollama', numCtx: 24576, maxOutputTokens: 8192 }), true);
  assert.ok(calls[1].request.messages[1].content.includes('continue safely'));
  assert.ok(store.state.rows.some(row => row.payload?.reason === 'context_window_discovered'));
});

test('a command with nonzero exit status is recorded as failed for subsequent turns', async () => {
  const { store, deps } = setup([
    { thought: 'check missing file', tool: 'run', args: { command: 'node --check missing.js' } },
  ]);
  await vibe.processVibeMessage({ store, message: ownerMessage('check syntax'), deps });
  const receipt = store.state.rows.find(row => row.payload?.tool === 'run');
  assert.equal(receipt.payload.ok, false);
  assert.match(receipt.payload.preview, /^exit 1/);
  assert.ok(receipt.payload.message_id);
});

test('a contradictory legacy success flag cannot clear a failed test or produce a success claim', async t => {
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'reply', args: { blocked_reason: 'All tests passed.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  store.recentExecution = async () => [{
    kind: 'test', payload: { tool: 'run', args: { command: 'node --check missing.js' }, ok: true, preview: 'exit 1\nSyntaxError: failed' },
  }];
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('check the prior test'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /SyntaxError: failed/);
  assert.match(result.reply, /completion claim was withheld/);
  assert.doesNotMatch(result.reply, /All tests passed/);
});

test('secret paths are refused and never committed while dependency manifests remain editable', async () => {
  const { store, deps, workspaceRoot } = setup([
    { thought: 'edit secret', tool: 'write_file', args: { path: '.env', content: 'SECRET=evil\n' } },
    { thought: 'tell', tool: 'reply', args: { message: 'Tried.' } },
  ]);
  await vibe.processVibeMessage({ store, message: ownerMessage('change the package name'), deps });
  const ws = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
  assert.equal(fs.existsSync(path.join(ws, '.env')), false);
  assert.equal(store.state.rows.find(row => row.payload?.tool === 'write_file').payload.ok, false);
  assert.equal(store.state.rows.some(row => row.kind === 'diff'), false);
});

test('XML tool-call markup from hosted models executes instead of being shown as a reply', async () => {
  const { store, deps } = setup([
    { thought: 'read', tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    '<tool_call>\n<tool_call name="replace_in_file">\n<parameter name="path" string="true">apps/web/src/hello.ts</parameter>\n<parameter name="old_text" string="true">"hi"</parameter>\n<parameter name="new_text" string="true">"xml"</parameter>\n</invoke>\n</tool_call>',
    { thought: 'report', tool: 'reply', args: { message: 'Edited via markup.' } },
  ]);
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('change greeting'), deps });
  assert.equal(outcome.reply, 'Edited via markup.');
  assert.deepEqual(store.state.session.changed_files, ['apps/web/src/hello.ts']);
});

test('a JSON reply promising work before any tool ran is refused and escalated', async () => {
  const { store, deps, model } = setup([
    { thought: 'ack', tool: 'reply', args: { message: "Understood. I'll continue with the Overview & approvals redesign using structured JSON compatibility." } },
    { thought: 'start', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"redesigned"' } },
    { thought: 'report', tool: 'reply', args: { message: 'Edited hello.ts.' } },
  ], {
    allowCloud: true,
    fetchHealth: async () => ({
      gpu_workstation: { configured: true, healthy: true, models: ['weak'], installed: ['weak'], ready_model: 'weak' },
      ollama_cloud: { configured: true, healthy: true, models: ['cloud-strong'], ready_model: 'cloud-strong' },
    }),
  });
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('continue the Overview & approvals redesign'), deps });
  assert.equal(outcome.reply, 'Edited hello.ts.');
  assert.equal(model.calls[1].provider, 'ollama_cloud');
  assert.ok(model.calls[1].request.messages.some(entry => entry.content.includes('Reply refused: no tool has executed')));
  assert.ok(store.state.rows.some(row => row.payload?.reason === 'reply_without_tool'));
  assert.deepEqual(store.state.session.changed_files, ['apps/web/src/hello.ts']);
});

test('a prose answer is accepted as the reply after one correction', async () => {
  const { store, deps } = setup(['Sure — the greeting lives in hello.ts.', 'It currently says hi.']);
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('where is the greeting?'), deps });
  assert.equal(outcome.reply, 'It currently says hi.');
});

test('Vibe image attachments use only a private, installed local vision model', async () => {
  const image = Buffer.from('image-fixture');
  const attachmentId = '2b3c4d5e-0000-4000-8000-000000000002';
  const attachment = {
    id: attachmentId,
    session_id: SESSION_ID,
    uploaded_by: 'owner-uuid',
    file_name: 'error-screen.png',
    file_type: 'image/png',
    file_size_bytes: image.length,
    storage_bucket: 'bob-uploads',
    storage_path: `desktop/owner-uuid/vibe/${SESSION_ID}/${attachmentId}-error-screen.png`,
    extraction_status: 'not_applicable',
  };
  const calls = [];
  let savedPayload;
  const store = {
    async attachments(sessionId, ids) {
      assert.equal(sessionId, SESSION_ID);
      assert.deepEqual(ids, [attachmentId]);
      return [attachment];
    },
    async downloadAttachment(row) {
      assert.equal(row.id, attachmentId);
      return image;
    },
    async updateOwnerPayload(_id, payload) { savedPayload = payload; },
  };
  const context = await vibe.prepareVibeAttachmentContext({
    store,
    session: { id: SESSION_ID, created_by: 'owner-uuid' },
    message: { id: 'owner-message', payload: { attachment_ids: [attachmentId] } },
    supabase: null,
    deps: {
      visionUrl: 'http://127.0.0.1:11434',
      downloadAttachment: async () => image,
      visionFetch: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'moondream:latest' }] }) };
        return { ok: true, json: async () => ({ response: 'A staff form is open with a red validation alert at the top.' }) };
      },
    },
  });
  assert.match(context[0].context, /Local visual analysis \(advisory\)/);
  assert.match(context[0].context, /red validation alert/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'http://127.0.0.1:11434/api/generate');
  assert.equal(JSON.parse(calls[1].options.body).prompt, 'What UI controls and error messages are visible in this screenshot?');
  assert.deepEqual(JSON.parse(calls[1].options.body).images, [image.toString('base64')]);
  assert.match(savedPayload.attachment_context[0].context, /red validation alert/);
});

test('Vibe rejects public vision endpoints and attachment IDs from other sessions', async () => {
  await assert.rejects(
    vibe.assertLocalVisionUrl('https://ollama.example.com', async () => [{ address: '203.0.113.4' }]),
    /restricted to private local vision endpoints/,
  );
  await assert.rejects(vibe.assertLocalVisionUrl('http://169.254.169.254'));
  const attachmentId = '2b3c4d5e-0000-4000-8000-000000000002';
  await assert.rejects(vibe.prepareVibeAttachmentContext({
    store: { attachments: async () => [] },
    session: { id: SESSION_ID },
    message: { id: 'owner-message', payload: { attachment_ids: [attachmentId] } },
    supabase: null,
  }), /not registered to this Vibe session/);
});

test('revert undoes the last turn and ship pushes the branch and opens one pull request', async () => {
  process.env.BOB_BUILDER_GIT_EMAIL = 'squires.don@gmail.com';
  process.env.BOB_BUILDER_GIT_NAME = 'DonSquires';
  try {
    const published = [];
    const opened = [];
    const { store, deps, workspaceRoot, repo } = setup([
      { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"one"' } },
      { thought: 'tell', tool: 'reply', args: { message: 'one' } },
      { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"one"', new_text: '"two"' } },
      { thought: 'tell', tool: 'reply', args: { message: 'two' } },
    ], {
      humanTest: async () => ({ ok: true, passed: 1, failed: 0, skipped: 0, warnings: [] }),
      publish: async args => { published.push(args); },
      openPullRequest: async args => { opened.push(args); return { url: 'https://github.com/o/r/pull/7', number: 7 }; },
    });
    await vibe.processVibeMessage({ store, message: ownerMessage('one'), deps });
    await vibe.processVibeMessage({ store, message: ownerMessage('two'), deps });
    const ws = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
    const undo = await vibe.processVibeMessage({ store, message: ownerMessage('revert', 'revert'), deps });
    assert.match(undo.reply, /Undid the last change/);
    assert.match(fs.readFileSync(path.join(ws, 'apps/web/src/hello.ts'), 'utf8'), /"one"/);
    const shipped = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
    assert.match(shipped.reply, /pull\/7/);
    assert.equal(published.length, 1);
    assert.equal(published[0].branch, 'bob/vibe-1a2b3c4d');
    assert.equal(opened.length, 1);
    assert.match(opened[0].body, /never merge or deploy/);
    assert.match(opened[0].body, /human_test: passed/);
    assert.equal(store.state.session.status, 'shipped');
    assert.equal(store.state.session.pr_url, 'https://github.com/o/r/pull/7');
    assert.equal(git(ws, ['log', '-1', '--format=%an <%ae>']), 'DonSquires <squires.don@gmail.com>');
    assert.notEqual(git(ws, ['rev-parse', 'HEAD']), repo.sha);
  } finally {
    delete process.env.BOB_BUILDER_GIT_EMAIL;
    delete process.env.BOB_BUILDER_GIT_NAME;
  }
});

test('publication freshly checks a failing draft and permits shipping only after repair', async t => {
  verifiedFixtureIdentity(t);
  const published = [];
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: 'BROKEN' } },
    { tool: 'reply', args: { blocked_reason: 'Needs repair.' } },
    { tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { tool: 'reply', args: { blocked_reason: 'Needs repair after inspecting the failing draft.' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: 'BROKEN', new_text: '"fixed"' } },
    { tool: 'reply', args: { message: 'Repaired.' } },
  ], {
    humanTest: async () => ({ ok: true, passed: 1 }),
    publish: async args => published.push(args),
    openPullRequest: async () => ({ url: 'https://github.com/o/r/pull/7', number: 7 }),
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  installFixtureTypecheck(repo);
  await vibe.processVibeMessage({ store, message: ownerMessage('edit the greeting'), deps });
  const head = store.state.session.head_sha;
  const refused = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(refused.error, true);
  assert.match(refused.reply, /Publication refused.*lint/);
  assert.equal(published.length, 0);
  assert.equal(store.state.session.head_sha, head);
  assert.equal(store.state.session.status, 'open');
  await vibe.processVibeMessage({ store, message: ownerMessage('repair the error'), deps });
  const shipped = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(shipped.error, undefined);
  assert.equal(published.length, 1);
  const checks = store.state.rows.filter(row => row.payload?.reason === 'pre_publish' && row.payload.tool === 'run');
  assert.deepEqual(checks.map(row => row.payload.ok), [false, true]);
  assert.notEqual(checks[0].payload.head_sha, checks[1].payload.head_sha);
});

for (const mode of ['failed', 'missing', 'drift']) test(`publication refuses ${mode} browser verification without pushing`, async t => {
  verifiedFixtureIdentity(t);
  let published = 0;
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"draft"' } },
    { tool: 'reply', args: { blocked_reason: 'Preserve draft for review.' } },
  ], {
    publish: async () => { published++; },
    humanTest: mode === 'missing' ? undefined : async ({ workspacePath }) => {
      if (mode === 'drift') fs.writeFileSync(path.join(workspacePath, 'apps/web/src/hello.ts'), 'export const changed = true;\n');
      return { ok: mode !== 'failed', passed: 1, failed: mode === 'failed' ? 1 : 0 };
    },
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('update the greeting'), deps: { ...deps, humanTest: undefined } });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /Publication refused/);
  assert.equal(published, 0);
});

test('edits to the browser harness itself trigger browser verification at handoff', async t => {
  let walked = 0;
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'write_file', args: { path: 'apps/web/e2e/example.spec.ts', content: 'export {};\n' } },
    { tool: 'reply', args: { message: 'Test added.' } },
  ], {
    humanTest: async ({ changedFiles }) => {
      walked++;
      assert.ok(changedFiles.includes('apps/web/e2e/example.spec.ts'));
      return { ok: true, passed: 1 };
    },
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('add a browser test'), deps });
  assert.equal(result.error, undefined);
  assert.equal(walked, 1);
});

test('ship with no changes does not publish', async () => {
  let published = 0;
  const { store, deps } = setup([], { publish: async () => { published++; } });
  const outcome = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.match(outcome.reply, /nothing to ship/);
  assert.equal(published, 0);
});

test('a closed session is skipped', async () => {
  const { store, deps } = setup([]);
  store.state.session.status = 'closed';
  const message = ownerMessage('hello');
  assert.deepEqual(await vibe.processVibeMessage({ store, message, deps }), { skipped: true });
  assert.equal(store.state.completed[message.id], 'failed');
});

test('continuation state and guarded session updates fail closed on database errors or closure', async () => {
  const calls = [];
  let queueError = null;
  const supabase = {
    from(table) {
      let updated = false;
      const query = {
        select() { return this; },
        update() { updated = true; return this; },
        eq(field, value) { calls.push([table, 'eq', field, value]); return this; },
        neq(field, value) { calls.push([table, 'neq', field, value]); return this; },
        gt(field, value) { calls.push([table, 'gt', field, value]); return this; },
        limit() { return this; },
        async maybeSingle() { return { data: updated ? null : { status: 'working' }, error: null }; },
        then(resolve, reject) { return Promise.resolve({ data: queueError ? null : [{ id: 'later' }], error: queueError }).then(resolve, reject); },
      };
      return query;
    },
  };
  const store = vibe.createVibeStore(supabase);
  assert.deepEqual(await store.continuationState(SESSION_ID, 10), { closed: false, ownerQueued: true });
  assert.ok(calls.some(call => call[0] === 'builder_vibe_messages' && call[1] === 'gt' && call[2] === 'seq' && call[3] === 10));
  assert.equal(await store.updateSession(SESSION_ID, { status: 'open' }, { unlessClosed: true }), false);
  assert.ok(calls.some(call => call[0] === 'builder_vibe_sessions' && call[1] === 'neq' && call[2] === 'status' && call[3] === 'closed'));
  queueError = { message: 'queue unavailable' };
  await assert.rejects(store.continuationState(SESSION_ID, 10), /continuation queue read failed: queue unavailable/);
});

test('interrupted execution and verification receipts are message-scoped and paginated', async () => {
  const wanted = Array.from({ length: 205 }, (_, i) => ({
    seq: i + 1, session_id: SESSION_ID, role: 'tool', kind: 'test',
    payload: { message_id: 'wanted', tool: 'run', ok: false },
  }));
  const other = Array.from({ length: 5 }, (_, i) => ({
    seq: i + 206, session_id: SESSION_ID, role: 'tool', kind: 'test',
    payload: { message_id: 'other', tool: 'run', ok: true },
  }));
  const rows = [...wanted, ...other];
  const requests = [];
  const supabase = {
    from(table) {
      const filters = [];
      let limit = 0;
      const query = {
        select() { return this; },
        eq(field, value) { filters.push(['eq', field, value]); return this; },
        lt(field, value) { filters.push(['lt', field, value]); return this; },
        in(field, value) { filters.push(['in', field, value]); return this; },
        order() { return this; },
        limit(value) { limit = value; return this; },
        then(resolve, reject) {
          requests.push({ table, filters: [...filters], limit });
          const valueFor = (row, field) => field.startsWith('payload->>') ? row.payload[field.slice(10)] : row[field];
          const page = rows.filter(row => filters.every(([op, field, value]) => {
            const actual = valueFor(row, field);
            return op === 'eq' ? actual === value : op === 'lt' ? actual < value : value.includes(actual);
          })).sort((a, b) => b.seq - a.seq).slice(0, limit);
          return Promise.resolve({ data: page, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const store = vibe.createVibeStore(supabase);
  const execution = await store.executionForMessage(SESSION_ID, 'wanted');
  const verification = await store.verificationHistory(SESSION_ID, Number.MAX_SAFE_INTEGER, { messageId: 'wanted' });
  assert.equal(execution.length, 205);
  assert.equal(verification.length, 205);
  assert.deepEqual(execution.map(row => row.seq), wanted.map(row => row.seq));
  assert.deepEqual(verification.map(row => row.seq), wanted.map(row => row.seq));
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.filters.some(filter => filter[1] === 'payload->>message_id' && filter[2] === 'wanted')));
});

test('preview cookies are bound to one session and expire', () => {
  const secret = Buffer.from('s3cret');
  const now = Date.now();
  const header = preview.cookieHeader(secret, SESSION_ID, now);
  assert.match(header, /Path=\/vibe\/1a2b3c4d-0000-4000-8000-000000000001\/; .*HttpOnly; Secure; SameSite=None; Partitioned/);
  const cookie = header.split(';')[0];
  assert.equal(preview.verifyCookie(secret, `a=b; ${cookie}`, SESSION_ID, now), true);
  assert.equal(preview.verifyCookie(secret, cookie, '1a2b3c4d-0000-4000-8000-000000000002', now), false);
  assert.equal(preview.verifyCookie(Buffer.from('other'), cookie, SESSION_ID, now), false);
  assert.equal(preview.verifyCookie(secret, cookie, SESSION_ID, now + 9 * 3600_000), false);
  assert.equal(preview.verifyCookie(secret, cookie.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), SESSION_ID, now), false);
  assert.deepEqual(preview.parseVibePath(`/vibe/${SESSION_ID}/src/main.tsx`), { sessionId: SESSION_ID, rest: '/src/main.tsx' });
  assert.equal(preview.parseVibePath('/vibe/not-a-session/'), null);
});

test('the preview proxy refuses without a cookie and unlocks from a valid ticket only', async () => {
  const manager = preview.createVibePreviewManager({ workspaceRoot: os.tmpdir(), secret: Buffer.from('k'), onStatus: async () => {} });
  const goodTicket = 'a'.repeat(64);
  const server = http.createServer(async (req, res) => {
    if (!(await manager.handleHttp(req, res, { redeemTicket: async (_id, ticket) => (ticket === goodTicket ? 'owner-uuid' : null) }))) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const get = (urlPath, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers }, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
  });
  try {
    assert.equal((await get(`/vibe/${SESSION_ID}/`)).statusCode, 401);
    assert.equal((await get(`/vibe/${SESSION_ID}/__open?ticket=${'b'.repeat(64)}`)).statusCode, 403);
    const opened = await get(`/vibe/${SESSION_ID}/__open?ticket=${goodTicket}`);
    assert.equal(opened.statusCode, 302);
    assert.equal(opened.headers.location, `/vibe/${SESSION_ID}/`);
    assert.match(opened.headers['content-security-policy'], /frame-ancestors/);
    const cookie = opened.headers['set-cookie'][0].split(';')[0];
    const notRunning = await get(`/vibe/${SESSION_ID}/`, { cookie });
    assert.equal(notRunning.statusCode, 503);
    assert.equal((await get('/other')).statusCode, 404);
  } finally {
    server.close();
  }
});

test('the vite wrapper config serves the app under the session base path', () => {
  const config = preview.viteWrapperConfig({ sessionId: SESSION_ID });
  assert.match(config, /import config from '\.\.\/\.\.\/vite\.config\.ts'/);
  assert.match(config, new RegExp(`base = '/vibe/${SESSION_ID}/'`));
  assert.match(config, /allowedHosts: true/);
});

test('preview dependency install always includes devDependencies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-preview-'));
  const workspacePath = path.join(root, 'vibe', 'vibe-12345678');
  const web = path.join(workspacePath, 'apps', 'web');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), '{"name":"web"}\n');
  fs.writeFileSync(path.join(web, 'package-lock.json'), '{"name":"web","lockfileVersion":3}\n');
  const cacheHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(web, 'package-lock.json'))).update(fs.readFileSync(path.join(web, 'package.json'))).digest('hex').slice(0, 16);
  const staleCache = path.join(root, 'vibe-cache', cacheHash);
  fs.mkdirSync(path.join(staleCache, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(staleCache, '.complete'), 'stale cache entry without Vite');
  const calls = [];
  const previousCredential = process.env.BOB_ADMIN_TOKEN;
  process.env.BOB_ADMIN_TOKEN = 'fixture-control-plane-secret';
  const spawnImpl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (cmd === 'npm') {
        fs.mkdirSync(path.join(options.cwd, 'node_modules', 'vite'), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, 'node_modules', 'vite', 'package.json'), '{"name":"vite"}\n');
        child.emit('close', 0);
        return;
      }
      child.emit('error', new Error(`unexpected command: ${cmd}`));
    });
    return child;
  };
  const manager = preview.createVibePreviewManager({ workspaceRoot: root, secret: Buffer.from('k'), onStatus: async () => {}, spawnImpl });
  try {
    await manager.ensureWebDependencies(workspacePath);
    const install = calls.find(call => call.cmd === 'npm');
    assert.ok(install, 'npm ci was called');
    assert.ok(install.args.includes('--include=dev'));
    assert.equal(install.options.env.NODE_ENV, 'development');
    assert.equal(install.options.env.NPM_CONFIG_PRODUCTION, 'false');
    assert.equal(install.options.env.npm_config_production, 'false');
    assert.equal(install.options.env.BOB_ADMIN_TOKEN, undefined);
    assert.equal(install.options.env.PLAYWRIGHT_BROWSERS_PATH.includes('tool-homes'), true);
    assert.equal(install.options.env.PLAYWRIGHT_BROWSERS_PATH.startsWith(root), true);
    assert.equal(fs.existsSync(path.join(web, 'node_modules', 'vite', 'package.json')), true);
  } finally {
    if (previousCredential === undefined) delete process.env.BOB_ADMIN_TOKEN;
    else process.env.BOB_ADMIN_TOKEN = previousCredential;
  }
});

function fakeHumanTest(outcomes) {
  const calls = [];
  const humanTest = async options => {
    calls.push(options);
    const next = outcomes.length > 1 ? outcomes.shift() : outcomes[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, humanTest };
}
const walkPassed = { ok: true, status: 'succeeded', passed: 7, failed: 0, skipped: 1, flaky: 0, specs: ['e2e/dr-bob-human-test.spec.ts'], failures: [], errors: [], warnings: [{ severity: 'warning', message: 'UX/layout: crowded header' }], screenshot_mismatches: [], duration_ms: 1000 };
const walkFailed = { ok: false, status: 'failed', passed: 6, failed: 1, skipped: 1, flaky: 0, specs: ['e2e/dr-bob-human-test.spec.ts'], failures: [{ file: 'dr-bob-human-test.spec.ts', title: 'admin walk', status: 'failed', error: 'Dr Bob found 1 error finding' }], errors: [{ severity: 'error', message: 'Console error: boom' }], warnings: [], screenshot_mismatches: [], duration_ms: 1000 };
const editHello = { thought: 'edit', tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"hello"' } };

test('web UI changes get Dr Bob\'s browser walk before the reply is accepted', async () => {
  const walk = fakeHumanTest([walkPassed]);
  const { store, deps } = setup([editHello, { thought: 'done', tool: 'reply', args: { message: 'Greeting updated.' } }], { humanTest: walk.humanTest });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('friendlier greeting'), deps });
  assert.equal(result.error, undefined);
  assert.equal(walk.calls.length, 1);
  assert.deepEqual(walk.calls[0].changedFiles, ['apps/web/src/hello.ts']);
  assert.match(result.reply, /Dr Bob's browser walk \(fixture data, desktop\): 7 passed, 0 failed, 1 skipped; 1 UX\/request warning/);
  const row = store.state.rows.find(entry => entry.payload?.tool === 'human_test');
  assert.equal(row.kind, 'test');
  assert.equal(row.payload.automatic, true);
  assert.equal(row.payload.ok, true);
  assert.match(row.payload.source_fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(store.state.rows.some(entry => entry.payload?.stage === 'human_test'));
});

test('a failing browser walk refuses the handoff once and then reports the change as unverified', async () => {
  const walk = fakeHumanTest([walkFailed]);
  const { store, deps, model } = setup([
    editHello,
    { thought: 'done', tool: 'reply', args: { message: 'All good.' } },
    { thought: 'blocked', tool: 'reply', args: { blocked_reason: 'The console error predates this change.' } },
  ], { humanTest: walk.humanTest });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('friendlier greeting'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /Changes are not verified: human_test failed/);
  assert.match(result.reply, /Console error: boom/);
  assert.equal(walk.calls.length, 1, 'unchanged UI files are not walked twice');
  assert.ok(model.calls.some(request => JSON.stringify(request).includes('Handoff refused: the latest verification failed')));
});

for (const reason of [
  'The repair is not done because the fixture is missing.',
  'Unit tests passed, but browser checks failed.',
]) test(`an unverified handoff preserves the blocker: ${reason}`, async t => {
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'reply', args: { blocked_reason: reason } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  store.recentExecution = async () => [{
    kind: 'test', payload: { tool: 'human_test', ok: false, preview: 'The browser check failed.' },
  }];
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('What is the status?'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /Changes are not verified/);
  assert.ok(result.reply.includes(reason));
});

test('an unverified mixed-result explanation is retained without claiming overall completion', async t => {
  const reason = 'Unit tests passed, but browser checks failed.';
  const { store, deps, repo, workspaceRoot } = setup([{ tool: 'reply', args: { message: reason } }]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  store.recentExecution = async () => [{
    kind: 'test', payload: { tool: 'human_test', ok: false, preview: 'The browser check failed.' },
  }];
  const result = await vibe.processVibeMessage({
    store, message: ownerMessage('What is the status?'), deps, limits: { ...vibe.VIBE_LIMITS, repairRounds: 0 },
  });
  assert.equal(result.error, true);
  assert.match(result.reply, /Changes are not verified/);
  assert.ok(result.reply.includes(reason));
});

for (const reason of [
  'Everything is fixed. The browser checks failed.',
  'All tests passed, but browser checks failed.',
]) test(`an unverified handoff suppresses a contradictory overall claim: ${reason}`, async t => {
  const { store, deps, repo, workspaceRoot } = setup([{ tool: 'reply', args: { blocked_reason: reason } }]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  store.recentExecution = async () => [{
    kind: 'test', payload: { tool: 'human_test', ok: false, preview: 'The browser check failed.' },
  }];
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('What is the status?'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /completion claim was withheld/);
  assert.match(result.reply, /browser checks failed/i);
  assert.doesNotMatch(result.reply, /Everything is fixed|All tests passed/);
});

test('browser walk infrastructure failures block verification without repeating the unchanged walk', async () => {
  const walk = fakeHumanTest([new Error('docker unavailable')]);
  const { store, deps } = setup([editHello, { thought: 'done', tool: 'reply', args: { message: 'Greeting updated.' } }], { humanTest: walk.humanTest });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('friendlier greeting'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /browser walk \(fixture, desktop\) could not run: docker unavailable/);
  assert.equal(walk.calls.length, 1);
  const row = store.state.rows.find(entry => entry.payload?.tool === 'human_test');
  assert.equal(row.payload.infrastructure, true);
});

test('targeted browser checks compare the pinned base and draft without changing the branch', async t => {
  const calls = [];
  const humanTest = async options => {
    calls.push({
      ...options,
      head: git(options.workspacePath, ['rev-parse', 'HEAD']),
      source: fs.readFileSync(path.join(options.workspacePath, 'apps/web/src/hello.ts'), 'utf8'),
    });
    if (!options.specs) return walkPassed;
    return {
      ok: options.reason !== 'reproduce on base', status: options.reason === 'reproduce on base' ? 'failed' : 'succeeded',
      complete: true, passed: 1, failed: options.reason === 'reproduce on base' ? 1 : 0,
      skipped: 0, failures: [], errors: [], warnings: [],
    };
  };
  const { store, deps, repo, workspaceRoot, model } = setup([
    editHello,
    { tool: 'browser_test', args: { specs: ['apps/web/e2e/greeting.spec.ts'], revision: 'base', reason: 'reproduce on base' } },
    { tool: 'browser_test', args: { specs: ['e2e/greeting.spec.ts'], revision: 'worktree', reason: 'test the draft' } },
    { tool: 'reply', args: { message: 'Greeting changed and checked.' } },
  ], { humanTest });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  installBrowserSpec(repo);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('change the greeting'), deps });
  assert.equal(result.error, undefined, result.reply);
  assert.ok(model.calls[0].request.tools.some(entry => entry.function.name === 'browser_test'));
  assert.ok(model.calls[0].request.output_schema.properties.tool.enum.includes('browser_test'));
  assert.equal(calls.length, 3, 'targeted tests do not replace the full walk');
  assert.equal(calls[0].head, repo.sha);
  assert.deepEqual(calls[0].specs, ['e2e/greeting.spec.ts'], 'repo-root browser paths are normalized before worker execution');
  assert.match(calls[0].source, /"hi"/);
  assert.match(calls[1].source, /"hello"/);
  assert.notEqual(calls[0].workspacePath, calls[1].workspacePath);
  assert.equal(fs.existsSync(calls[0].workspacePath), false, 'the pinned-base worktree is removed');
  assert.equal(calls[2].specs, undefined);
  const receipts = store.state.rows.filter(row => row.payload?.tool === 'browser_test');
  assert.deepEqual(receipts.map(row => [row.payload.browser_test.revision, row.payload.ok]), [['base', false], ['worktree', true]]);
  assert.match(receipts[1].payload.preview, /Targeted browser check \(worktree/);
});

test('a passing targeted browser check cannot clear a failed full walk', async t => {
  const targetedPass = { ok: true, status: 'succeeded', complete: true, passed: 1, failed: 0, skipped: 0, failures: [], errors: [], warnings: [] };
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'browser_test', args: { specs: ['e2e/greeting.spec.ts'], revision: 'worktree', reason: 'inspect the specific failure' } },
    { tool: 'reply', args: { blocked_reason: 'The full walk still needs repair.' } },
  ], { humanTest: async () => targetedPass });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  installBrowserSpec(repo);
  store.recentExecution = async () => [{
    kind: 'test', payload: { tool: 'human_test', ok: false, preview: 'The complete browser walk failed.' },
  }];
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('check the browser failure'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /human_test failed/);
  assert.match(result.reply, /complete browser walk failed/);
});

test('publication includes unresolved targeted specs in its fresh full browser walk', async t => {
  verifiedFixtureIdentity(t);
  const calls = [];
  const humanTest = async options => {
    calls.push(options);
    if (options.specs) return { ok: false, status: 'failed', complete: true, passed: 1, failed: 1, failures: [], errors: [], warnings: [] };
    return walkPassed;
  };
  const published = [];
  const { store, deps, repo, workspaceRoot } = setup([
    editHello,
    { tool: 'browser_test', args: { specs: ['e2e/greeting.spec.ts'], revision: 'worktree', reason: 'check the draft' } },
    { tool: 'reply', args: { blocked_reason: 'Targeted browser check failed.' } },
  ], { humanTest, publish: async value => published.push(value), openPullRequest: async () => ({ url: 'https://github.com/o/r/pull/12', number: 12 }) });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  installBrowserSpec(repo);
  const draft = await vibe.processVibeMessage({ store, message: ownerMessage('change the greeting'), deps });
  assert.equal(draft.error, true);
  const previous = store.state.rows.slice();
  const later = Array.from({ length: 70 }, (_, index) => ({
    seq: 1000 + index, kind: 'test', payload: { tool: 'run', args: { command: 'node --check package.json' }, ok: true, preview: 'exit 0' },
  }));
  store.recentExecution = async () => later.slice(-60);
  store.verificationHistory = async () => [...previous.filter(row => row.kind === 'test'), ...later];
  const shipped = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(shipped.error, undefined, shipped.reply);
  assert.equal(published.length, 1);
  assert.ok(calls.at(-1).changedFiles.includes('apps/web/e2e/greeting.spec.ts'));
  assert.equal(calls.at(-1).specs, undefined, 'publication still runs the complete human walk');
});

test('publication reruns previously passing targeted specs against the final draft', async t => {
  verifiedFixtureIdentity(t);
  const calls = [];
  const passed = { ok: true, status: 'succeeded', complete: true, passed: 1, failed: 0, errors: [], warnings: [] };
  const { store, deps, repo, workspaceRoot } = setup([
    editHello,
    { tool: 'browser_test', args: { specs: ['e2e/greeting.spec.ts'], revision: 'worktree', reason: 'check the first draft' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hello"', new_text: '"final"' } },
    { tool: 'reply', args: { message: 'Draft updated.' } },
  ], {
    humanTest: async options => { calls.push(options); return passed; },
    publish: async () => {},
    openPullRequest: async () => ({ url: 'https://github.com/o/r/pull/12', number: 12 }),
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  installBrowserSpec(repo);
  const draft = await vibe.processVibeMessage({ store, message: ownerMessage('change the greeting'), deps });
  assert.equal(draft.error, undefined, draft.reply);
  const previous = store.state.rows.slice();
  store.recentExecution = async () => previous.filter(row => row.kind === 'test');
  const shipped = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(shipped.error, undefined, shipped.reply);
  assert.ok(calls.at(-1).changedFiles.includes('apps/web/e2e/greeting.spec.ts'));
  assert.equal(calls.at(-1).specs, undefined);
});

test('publication refuses when an unresolved targeted browser spec is missing', async t => {
  verifiedFixtureIdentity(t);
  let published = false;
  const { store, deps, repo, workspaceRoot } = setup([
    editHello,
    { tool: 'browser_test', args: { specs: ['e2e/missing.spec.ts'], revision: 'worktree', reason: 'check the missing workflow' } },
    { tool: 'reply', args: { blocked_reason: 'The requested browser spec is missing.' } },
  ], {
    humanTest: async () => walkPassed,
    publish: async () => { published = true; },
    openPullRequest: async () => ({ url: 'https://github.com/o/r/pull/12', number: 12 }),
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const draft = await vibe.processVibeMessage({ store, message: ownerMessage('change the greeting'), deps });
  assert.equal(draft.error, true);
  const receipt = store.state.rows.find(row => row.payload?.tool === 'browser_test');
  assert.equal(receipt.payload.ok, false);
  assert.deepEqual(receipt.payload.browser_test.specs, ['e2e/missing.spec.ts']);
  assert.match(receipt.payload.preview, /missing or not a regular file/);
  const previous = store.state.rows.slice();
  store.recentExecution = async () => previous.filter(row => row.kind === 'test');
  const shipped = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(shipped.error, true);
  assert.match(shipped.reply, /unresolved browser spec cannot be rerun/);
  assert.equal(published, false);
});

test('a corrected targeted request clears a malformed-request blocker', async t => {
  const passed = { ok: true, status: 'succeeded', complete: true, passed: 1, failed: 0, errors: [], warnings: [] };
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'browser_test', args: { specs: ['bad-path'], revision: 'worktree', reason: 'invalid request' } },
    { tool: 'browser_test', args: { specs: ['e2e/greeting.spec.ts'], revision: 'worktree', reason: 'corrected request' } },
    { tool: 'reply', args: { message: 'The targeted check passed.' } },
  ], { humanTest: async () => passed });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  installBrowserSpec(repo);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('Check the browser.'), deps });
  assert.equal(result.error, undefined, result.reply);
  const receipts = store.state.rows.filter(row => row.payload?.tool === 'browser_test');
  assert.deepEqual(receipts.map(row => row.payload.ok), [false, true]);
  assert.equal(receipts[0].payload.browser_test.verification_key, 'browser_test:invalid-request');
});

test('an invalid browser revision blocks publication across turns until a worktree check corrects it', async t => {
  verifiedFixtureIdentity(t);
  let published = false;
  const passed = { ok: true, status: 'succeeded', complete: true, passed: 1, failed: 0, errors: [], warnings: [] };
  const { store, deps, repo, workspaceRoot } = setup([
    editHello,
    { tool: 'browser_test', args: { specs: ['e2e/greeting.spec.ts'], revision: 'draft', reason: 'check the workflow' } },
    { tool: 'reply', args: { blocked_reason: 'The browser request needs correction.' } },
  ], {
    humanTest: async () => passed,
    publish: async () => { published = true; },
    openPullRequest: async () => ({ url: 'https://github.com/o/r/pull/12', number: 12 }),
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  installBrowserSpec(repo);
  const draft = await vibe.processVibeMessage({ store, message: ownerMessage('change the greeting'), deps });
  assert.equal(draft.error, true);
  const receipt = store.state.rows.find(row => row.payload?.tool === 'browser_test');
  assert.equal(receipt.payload.browser_test.verification_key, 'browser_test:invalid-request');
  assert.match(receipt.payload.preview, /Choose browser_test revision/);
  store.verificationHistory = async () => store.state.rows.filter(row => row.kind === 'test');
  const refused = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(refused.error, true);
  assert.match(refused.reply, /malformed browser request/);
  assert.equal(published, false);

  const corrected = scriptedModel([
    { tool: 'browser_test', args: { specs: ['e2e/greeting.spec.ts'], revision: 'worktree', reason: 'correct the request' } },
    { tool: 'reply', args: { message: 'The targeted check passed.' } },
  ]);
  deps.callModel = corrected.callModel;
  const retry = await vibe.processVibeMessage({ store, message: ownerMessage('Rerun the browser check.'), deps });
  assert.equal(retry.error, undefined, retry.reply);
  const shipped = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(shipped.error, undefined, shipped.reply);
  assert.equal(published, true);
});

test('Bob can request the walk as a tool and the handoff reuses it for unchanged files', async () => {
  const walk = fakeHumanTest([walkPassed]);
  const { store, deps } = setup([
    editHello,
    { thought: 'check in a browser', tool: 'human_test', args: { reason: 'confirm greeting renders' } },
    { thought: 'done', tool: 'reply', args: { message: 'Greeting updated and walked.' } },
  ], { humanTest: walk.humanTest });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('friendlier greeting'), deps });
  assert.equal(result.error, undefined);
  assert.equal(walk.calls.length, 1);
  assert.equal(walk.calls[0].reason, 'confirm greeting renders');
  const rows = store.state.rows.filter(entry => entry.payload?.tool === 'human_test');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'test');
  assert.equal(rows[0].payload.automatic, undefined);
});

test('complete failed browser evidence is reused across turns unless a fresh walk is explicitly requested', async t => {
  const walk = fakeHumanTest([
    { ...walkFailed, complete: true },
    { ...walkPassed, complete: true },
  ]);
  const { store, deps, repo, workspaceRoot } = setup([
    editHello,
    { tool: 'human_test', args: { reason: 'initial check' } },
    { tool: 'reply', args: { blocked_reason: 'The walk still fails.' } },
    { tool: 'read_file', args: { path: 'apps/web/src/hello.ts' } },
    { tool: 'reply', args: { blocked_reason: 'The walk still fails after inspecting the source; causality is unknown.' } },
    { tool: 'human_test', args: { reason: 'inspect the same branch' } },
    { tool: 'reply', args: { blocked_reason: 'The walk still fails.' } },
    { tool: 'human_test', args: { reason: 'owner requested a fresh walk', rerun: true } },
    { tool: 'reply', args: { message: 'A fresh browser walk passed.' } },
  ], { humanTest: walk.humanTest });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const first = await vibe.processVibeMessage({ store, message: ownerMessage('change the greeting'), deps });
  assert.equal(first.error, true);
  let previous = store.state.rows.slice();
  store.recentExecution = async () => previous.filter(row => row.kind === 'test');
  const second = await vibe.processVibeMessage({ store, message: ownerMessage('inspect the browser failure'), deps });
  assert.equal(second.error, true);
  assert.equal(walk.calls.length, 1);
  const reused = store.state.rows.filter(row => row.payload?.tool === 'human_test').at(-1);
  assert.equal(reused.payload.reused, true);
  assert.match(reused.payload.preview, /no new walk ran/);
  previous = store.state.rows.slice();
  const third = await vibe.processVibeMessage({ store, message: ownerMessage('rerun the browser walk'), deps });
  assert.equal(third.error, undefined, third.reply);
  assert.equal(walk.calls.length, 2);
  assert.equal(store.state.rows.filter(row => row.payload?.tool === 'human_test').at(-1).payload.reused, false);
});

test('cloud reruns rather than reusing a historical browser report after attachment history', async t => {
  const privateWalk = { ...walkFailed, complete: true, errors: [{ severity: 'error', message: 'private-browser-marker' }] };
  const walk = fakeHumanTest([privateWalk, { ...walkPassed, complete: true }]);
  const { store, deps, repo, workspaceRoot } = setup([
    editHello,
    { tool: 'human_test', args: { reason: 'initial check' } },
    { tool: 'reply', args: { blocked_reason: 'The browser walk failed.' } },
  ], {
    humanTest: walk.humanTest, allowCloud: true,
    fetchHealth: async () => ({ gpu_workstation: { configured: true, healthy: true, models: ['local'], ready_model: 'local' } }),
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('Change the greeting.'), deps });
  const previous = store.state.rows.slice();
  store.recentExecution = async () => previous.filter(row => row.kind === 'test');
  store.hasEarlierAttachments = async () => true;
  const cloudModel = scriptedModel([
    { tool: 'human_test', args: { reason: 'check the browser again' } },
    { tool: 'reply', args: { message: 'The fresh browser walk passed.' } },
  ]);
  deps.callModel = cloudModel.callModel;
  deps.fetchHealth = async () => ({ ollama_cloud: { configured: true, healthy: true, models: ['cloud'], ready_model: 'cloud' } });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('Check the browser again.'), deps });
  assert.equal(result.error, undefined, result.reply);
  assert.equal(walk.calls.length, 2);
  assert.ok(cloudModel.calls.every(call => call.provider === 'ollama_cloud'));
  assert.doesNotMatch(JSON.stringify(cloudModel.calls), /private-browser-marker/);
  assert.equal(store.state.rows.filter(row => row.payload?.tool === 'human_test').at(-1).payload.reused, false);
});

test('cloud reruns browser evidence produced by a private model earlier in the same turn', async t => {
  const privateWalk = { ...walkFailed, complete: true, errors: [{ severity: 'error', message: 'private-turn-browser-marker' }] };
  const walk = fakeHumanTest([privateWalk, { ...walkPassed, complete: true }]);
  const repeated = { tool: 'list_dir', args: { path: 'apps/web/src/' } };
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'human_test', args: { reason: 'private check' } },
    repeated, repeated, repeated, repeated,
    { tool: 'human_test', args: { reason: 'cloud check' } },
    { tool: 'reply', args: { message: 'The fresh browser walk passed.' } },
  ], {
    humanTest: walk.humanTest, allowCloud: true,
    fetchHealth: async () => ({
      gpu_workstation: { configured: true, healthy: true, models: ['local'], ready_model: 'local' },
      ollama_cloud: { configured: true, healthy: true, models: ['cloud'], ready_model: 'cloud' },
    }),
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  store.hasEarlierAttachments = async () => true;
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('Check the browser.'), deps });
  assert.equal(result.error, undefined, result.reply);
  assert.equal(walk.calls.length, 2);
  const cloudCalls = model.calls.filter(call => call.provider === 'ollama_cloud');
  assert.ok(cloudCalls.length);
  assert.doesNotMatch(JSON.stringify(cloudCalls), /private-turn-browser-marker/);
});

test('an incomplete browser report is never cached as a completed walk', async t => {
  const walk = fakeHumanTest([
    { ...walkFailed, complete: false, status: 'timed_out', report_errors: ['report incomplete'] },
    { ...walkPassed, complete: true },
  ]);
  const { store, deps, repo, workspaceRoot } = setup([
    editHello,
    { tool: 'human_test', args: { reason: 'initial check' } },
    { tool: 'human_test', args: { reason: 'retry after incomplete report' } },
    { tool: 'reply', args: { message: 'The browser walk passed.' } },
  ], { humanTest: walk.humanTest });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('change the greeting'), deps });
  assert.equal(result.error, undefined, result.reply);
  assert.equal(walk.calls.length, 2);
  assert.ok(store.state.rows.filter(row => row.payload?.tool === 'human_test').every(row => row.payload.reused === false));
});

test('a complete report with an unexplained worker failure is not reused as test evidence', async t => {
  const walk = fakeHumanTest([
    { ...walkFailed, complete: true, failed: 0, failures: [], errors: [], output_tail: 'browser worker exited unexpectedly' },
    { ...walkPassed, complete: true },
  ]);
  const { store, deps, repo, workspaceRoot } = setup([
    editHello,
    { tool: 'human_test', args: { reason: 'initial check' } },
    { tool: 'human_test', args: { reason: 'retry worker failure' } },
    { tool: 'reply', args: { message: 'A new browser walk passed.' } },
  ], { humanTest: walk.humanTest });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('change the greeting'), deps });
  assert.equal(result.error, undefined, result.reply);
  assert.equal(walk.calls.length, 2);
  const first = store.state.rows.find(row => row.payload?.tool === 'human_test');
  assert.match(first.payload.preview, /browser worker exited unexpectedly/);
  assert.match(first.payload.human_test.output_tail, /browser worker exited unexpectedly/);
});

test('contradictory successful browser evidence is reported as unverified', async t => {
  const walk = fakeHumanTest([{ ...walkPassed, complete: false }]);
  const { store, deps, repo, workspaceRoot } = setup([
    editHello,
    { tool: 'reply', args: { blocked_reason: 'Browser evidence is incomplete.' } },
  ], { humanTest: walk.humanTest });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('change the greeting'), deps });
  assert.equal(result.error, true);
  assert.match(result.reply, /Browser evidence was incomplete/);
  assert.equal(walk.calls.length, 1);
});

test('a pure answer with no tool use does not trigger the browser walk', async () => {
  const walk = fakeHumanTest([walkPassed]);
  const { store, deps } = setup([{ thought: 'answer', tool: 'reply', args: { message: 'The greeting lives in hello.ts.' } }], { humanTest: walk.humanTest });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('where is the greeting?'), deps });
  assert.equal(result.error, undefined);
  assert.equal(walk.calls.length, 0);
});

const VIBE_TIMEOUT_SHAPES = [
  ['client abort', { ok: false, status: 408, error: 'model gateway timed out', timeout: true }],
  ['gateway provider timeout', { ok: false, status: 504, error: 'model provider timed out', code: 'provider_timeout' }],
];

for (const [shape, timedOutResponse] of VIBE_TIMEOUT_SHAPES) {
  test(`a model timeout (${shape}) switches to the next candidate at once and tells the owner why`, async () => {
    const seen = [];
    const { store, deps } = setup([], {
      callModel: async ({ modelRequest }) => {
        seen.push(`${modelRequest.provider}/${modelRequest.model_name}`);
        if (seen.length === 1) return { ...timedOutResponse };
        const call = seen.length === 2
          ? { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"hello"' } }
          : { tool: 'reply', args: { message: 'Changed the greeting.' } };
        return { ok: true, data: { content: JSON.stringify(call) } };
      },
    });
    const result = await vibe.processVibeMessage({ store, message: ownerMessage('improve greeting'), deps });
    assert.equal(result.error, undefined);
    assert.notEqual(seen[1], seen[0], 'the timed-out model is not given a second full turn budget');
    const notice = store.state.rows.find(row => row.payload?.reason === 'timeout');
    assert.ok(notice, 'the owner sees why the model changed');
    assert.equal(`${notice.payload.previous_provider}/${notice.payload.previous_model}`, seen[0]);
    assert.equal(`${notice.payload.provider}/${notice.payload.model}`, seen[1]);
    assert.match(notice.content, /did not answer within \d+ min; switching to/);
  });
}

test('a blocked_reason over a missing test file is refused once so the model creates the test itself', async t => {
  const testCommand = 'npm run test --prefix apps/web -- src/hello.test.ts';
  const { store, deps, repo, workspaceRoot, model } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"hello"' } },
    { tool: 'run', args: { command: testCommand } },
    { tool: 'reply', args: { blocked_reason: 'The test file does not exist. Please create src/hello.test.ts.' } },
    { tool: 'write_file', args: { path: 'apps/web/src/hello.test.ts', content: 'export const covered = true;\n' } },
    { tool: 'run', args: { command: testCommand } },
    { tool: 'reply', args: { message: 'Changed the greeting and added its test.' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(repo.dir, 'apps/web/package.json'), JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"', test: 'node find-test.cjs' } }));
  fs.writeFileSync(path.join(repo.dir, 'apps/web/find-test.cjs'), [
    'const file = process.argv[2];',
    'if (!require("fs").existsSync(file)) { console.error(`No test files found, exiting with code 1\\nfilter: ${file}`); process.exit(1); }',
    'console.log("1 test passed");',
  ].join('\n'));
  git(repo.dir, ['add', '.']);
  git(repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'add test finder fixture']);
  repo.sha = git(repo.dir, ['rev-parse', 'HEAD']);
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('Make the greeting friendlier and cover it with a test.'), deps });
  assert.equal(result.error, undefined, result.reply);
  assert.match(JSON.stringify(model.calls[3].request.messages), /No test files found[\s\S]*write_file/);
  assert.ok(store.state.session.changed_files.includes('apps/web/src/hello.test.ts'));
});

test('an account usage limit skips every model on that provider, not just the one that answered 429', async () => {
  const seen = [];
  const { store, deps } = setup([], {
    fetchHealth: async () => ({
      gpu_workstation: { configured: true, healthy: true, models: ['quota-one', 'quota-two'], installed: ['quota-one', 'quota-two'], ready_model: 'quota-one' },
      ollama: { configured: true, healthy: true, models: ['other-provider'], ready_model: 'other-provider' },
    }),
    callModel: async ({ modelRequest }) => {
      seen.push(`${modelRequest.provider}/${modelRequest.model_name}`);
      if (modelRequest.provider === 'gpu_workstation') {
        return { ok: false, status: 429, error: 'you (squiresdon) have reached your monthly usage limit' };
      }
      const call = seen.filter(entry => entry.startsWith('ollama/')).length === 1
        ? { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"hello"' } }
        : { tool: 'reply', args: { message: 'Changed the greeting.' } };
      return { ok: true, data: { content: JSON.stringify(call) } };
    },
  });
  const result = await vibe.processVibeMessage({ store, message: ownerMessage('improve greeting'), deps });
  assert.equal(result.error, undefined);
  assert.deepEqual(seen.slice(0, 2), ['gpu_workstation/quota-one', 'ollama/other-provider'], 'a sibling model sharing the exhausted account is not tried');
  const notice = store.state.rows.find(row => row.payload?.reason === 'provider_quota_exhausted');
  assert.ok(notice, 'the owner sees that the whole provider account is out of quota');
  assert.equal(notice.payload.previous_provider, 'gpu_workstation');
  assert.equal(`${notice.payload.provider}/${notice.payload.model}`, 'ollama/other-provider');
});

test('Vibe external tiers are opt-in: owner-approved providers append after private compute', () => {
  assert.deepEqual(vibe.vibeExternalProviders({}), []);
  assert.deepEqual(vibe.vibeExternalProviders({ BOB_VIBE_ALLOW_OLLAMA_CLOUD: 'true' }), ['ollama_cloud']);
  assert.deepEqual(vibe.vibeExternalProviders({ BOB_VIBE_EXTERNAL_PROVIDERS: 'anthropic, openai, gemini, nonsense, omniroute, anthropic' }), ['anthropic', 'openai', 'gemini', 'omniroute']);
  assert.deepEqual(vibe.vibeExternalProviders({ BOB_VIBE_EXTERNAL_PROVIDERS: 'anthropic', BOB_VIBE_ALLOW_OLLAMA_CLOUD: '1' }), ['ollama_cloud', 'anthropic']);
  assert.equal(vibe.vibeCloudAllowed({ BOB_VIBE_EXTERNAL_PROVIDERS: 'anthropic' }), true);
  assert.equal(vibe.vibeCloudAllowed({ BOB_VIBE_EXTERNAL_PROVIDERS: 'openai' }), true);
  assert.equal(vibe.vibeCloudAllowed({ OPENAI_API_KEY: 'synthetic', GEMINI_API_KEY: 'synthetic' }), false);
  const routed = vibe.applyVibeRouting({}, { allowCloud: true, externals: ['ollama_cloud', 'anthropic'] });
  assert.deepEqual(routed.chain, ['gpu_workstation', 'ollama', 'ollama_cloud', 'anthropic']);
  assert.equal(routed.routing_reason, 'private_first_owner_approved_external');
  assert.equal(vibe.applyVibeRouting({}, { allowCloud: true }).routing_reason, 'private_first_owner_approved_ollama_cloud');
  assert.deepEqual(vibe.applyVibeRouting({}, { allowCloud: false, externals: ['anthropic'] }).chain, ['gpu_workstation', 'ollama']);
});

// Live-repo truth: a session follows current main and never reuses a finished pull request.
function commitOnMain(repo, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(repo.dir, file)), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, file), content);
  git(repo.dir, ['add', '-A']);
  git(repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', message]);
  repo.sha = git(repo.dir, ['rev-parse', 'HEAD']);
}

function rebaseMergeVibeBranch(repo, baseSha) {
  git(repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'cherry-pick', `${baseSha}..bob/vibe-1a2b3c4d`]);
  repo.sha = git(repo.dir, ['rev-parse', 'HEAD']);
}

test('a turn starts from current main: the pinned base moves forward before Bob works', async t => {
  verifiedFixtureIdentity(t);
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'write_file', args: { path: 'apps/web/src/one.ts', content: 'export const one = 1;\n' } },
    { tool: 'reply', args: { message: 'one' } },
    { tool: 'reply', args: { message: 'looked' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('add one'), deps });
  const firstBase = store.state.session.base_sha;
  commitOnMain(repo, 'apps/web/src/landed.ts', 'export const landed = true;\n', 'other work landed on main');
  await vibe.processVibeMessage({ store, message: ownerMessage('look again'), deps });
  const ws = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
  assert.notEqual(firstBase, repo.sha);
  assert.equal(store.state.session.base_sha, repo.sha);
  assert.ok(fs.existsSync(path.join(ws, 'apps/web/src/landed.ts')), 'the workspace sees work merged to main after the session started');
  assert.ok(fs.existsSync(path.join(ws, 'apps/web/src/one.ts')), 'the session keeps its own unshipped change');
  assert.deepEqual(store.state.session.changed_files, ['apps/web/src/one.ts']);
  assert.ok(store.state.rows.some(row => row.kind === 'status' && /Brought the branch up to date with main/.test(row.content)));
});

test('a sync conflict on a turn warns and keeps working on the earlier base without losing work', async t => {
  verifiedFixtureIdentity(t);
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"mine"' } },
    { tool: 'reply', args: { message: 'mine' } },
    { tool: 'reply', args: { message: 'looked' } },
  ]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('edit'), deps });
  const base = store.state.session.base_sha;
  const head = store.state.session.head_sha;
  commitOnMain(repo, 'apps/web/src/hello.ts', 'export const hello = "theirs";\n', 'conflicting main change');
  await vibe.processVibeMessage({ store, message: ownerMessage('look again'), deps });
  const ws = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
  assert.equal(store.state.session.base_sha, base);
  assert.equal(git(ws, ['rev-parse', 'HEAD']), head);
  assert.equal(git(ws, ['status', '--porcelain']), '', 'no rebase is left half-applied');
  assert.ok(store.state.rows.some(row => row.kind === 'error' && /conflicts with main.*apps\/web\/src\/hello\.ts/s.test(row.content)));
});

test('ship refuses when the existing pull request state cannot be read', async t => {
  verifiedFixtureIdentity(t);
  const published = [];
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'write_file', args: { path: 'apps/web/src/one.ts', content: 'export const one = 1;\n' } },
    { tool: 'reply', args: { message: 'one' } },
  ], {
    humanTest: async () => ({ ok: true, passed: 1 }),
    publish: async args => published.push(args),
    openPullRequest: async () => ({ url: 'https://github.com/o/r/pull/7', number: 7 }),
    readPullRequest: async () => ({ state: 'unknown' }),
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('add one'), deps });
  Object.assign(store.state.session, { pr_url: 'https://github.com/o/r/pull/7', pr_number: 7, status: 'shipped' });
  const refused = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(refused.error, true);
  assert.match(refused.reply, /could not confirm the state of pull request #7/);
  assert.equal(published.length, 0);
});

test('ship pushes to an open pull request after bringing the branch up to date with main', async t => {
  verifiedFixtureIdentity(t);
  const published = [];
  const opened = [];
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'write_file', args: { path: 'apps/web/src/one.ts', content: 'export const one = 1;\n' } },
    { tool: 'reply', args: { message: 'one' } },
  ], {
    humanTest: async () => ({ ok: true, passed: 1 }),
    publish: async args => published.push(args),
    openPullRequest: async args => { opened.push(args); return { url: 'https://github.com/o/r/pull/7', number: 7 }; },
    readPullRequest: async () => ({ state: 'open', headSha: published.at(-1)?.head }),
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('add one'), deps });
  await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  const firstHead = published[0].head;
  commitOnMain(repo, 'apps/web/src/landed.ts', 'export const landed = true;\n', 'other work landed on main');
  const again = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(again.error, undefined, again.reply);
  assert.equal(opened.length, 1, 'an open pull request is reused');
  assert.equal(published.length, 2);
  assert.equal(published[1].replaceOwnHistory, true, 'a rebased branch may replace only tips this workspace produced');
  assert.notEqual(published[1].head, firstHead);
  assert.equal(git(repo.dir, ['rev-parse', `${published[1].head}^`]), repo.sha);
  assert.equal(store.state.session.base_sha, repo.sha);
  assert.match(again.reply, /Pushed the latest changes to pull request/);
});

test('ship never pushes onto a merged pull request: it rebases onto main and opens a new one', async t => {
  verifiedFixtureIdentity(t);
  const published = [];
  const opened = [];
  const prs = {};
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'write_file', args: { path: 'apps/web/src/one.ts', content: 'export const one = 1;\n' } },
    { tool: 'reply', args: { message: 'one' } },
    { tool: 'write_file', args: { path: 'apps/web/src/two.ts', content: 'export const two = 2;\n' } },
    { tool: 'reply', args: { message: 'two' } },
  ], {
    humanTest: async () => ({ ok: true, passed: 1 }),
    publish: async args => published.push(args),
    openPullRequest: async args => { const number = 7 + opened.length; opened.push(args); prs[number] = { state: 'open', headSha: args.head }; return { url: `https://github.com/o/r/pull/${number}`, number }; },
    readPullRequest: async ({ url }) => prs[Number(url.split('/').pop())] || { state: 'unknown' },
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('add one'), deps });
  await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  rebaseMergeVibeBranch(repo, store.state.session.base_sha);
  prs[7] = { state: 'merged', headSha: published[0].head };
  await vibe.processVibeMessage({ store, message: ownerMessage('add two'), deps });
  const shipped = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(shipped.error, undefined, shipped.reply);
  assert.equal(opened.length, 2, 'a merged pull request is never reused');
  assert.match(shipped.reply, /pull request #7 was already merged/i);
  assert.match(shipped.reply, /pull\/8/);
  assert.equal(store.state.session.pr_number, 8);
  assert.deepEqual(store.state.session.changed_files, ['apps/web/src/two.ts'], 'work already on main is not shipped again');
  assert.equal(git(repo.dir, ['rev-parse', `${published[1].head}^`]), repo.sha);
});

test('ship with nothing left after the merged pull request closes the session as complete', async t => {
  verifiedFixtureIdentity(t);
  const published = [];
  const prs = {};
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'write_file', args: { path: 'apps/web/src/one.ts', content: 'export const one = 1;\n' } },
    { tool: 'reply', args: { message: 'one' } },
  ], {
    humanTest: async () => ({ ok: true, passed: 1 }),
    publish: async args => published.push(args),
    openPullRequest: async args => { prs[7] = { state: 'open', headSha: args.head }; return { url: 'https://github.com/o/r/pull/7', number: 7 }; },
    readPullRequest: async ({ url }) => prs[Number(url.split('/').pop())] || { state: 'unknown' },
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('add one'), deps });
  await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  rebaseMergeVibeBranch(repo, store.state.session.base_sha);
  prs[7] = { state: 'merged', headSha: published[0].head };
  const done = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(published.length, 1, 'nothing is pushed');
  assert.match(done.reply, /already on main/);
  assert.equal(store.state.session.status, 'closed');
  assert.ok(store.state.rows.some(row => row.role === 'bob' && /already on main/.test(row.content)), 'the completion reply is posted');
});

test('ship refuses when the branch conflicts with current main and pushes nothing', async t => {
  verifiedFixtureIdentity(t);
  const published = [];
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"mine"' } },
    { tool: 'reply', args: { message: 'mine' } },
  ], {
    humanTest: async () => ({ ok: true, passed: 1 }),
    publish: async args => published.push(args),
    openPullRequest: async () => ({ url: 'https://github.com/o/r/pull/7', number: 7 }),
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('edit'), deps });
  const head = store.state.session.head_sha;
  commitOnMain(repo, 'apps/web/src/hello.ts', 'export const hello = "theirs";\n', 'conflicting main change');
  const refused = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(refused.error, true);
  assert.match(refused.reply, /conflicts with main.*apps\/web\/src\/hello\.ts/s);
  assert.equal(published.length, 0);
  assert.equal(git(vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID), ['rev-parse', 'HEAD']), head);
});

function reconcileStore(sessions) {
  const state = { sessions: sessions.map(session => ({ ...session })), rows: [] };
  return {
    state,
    async shippedSessions() { return state.sessions.filter(session => session.status === 'shipped').map(session => ({ ...session })); },
    async updateSession(id, patch, { onlyIfStatus } = {}) {
      const session = state.sessions.find(entry => entry.id === id);
      if (!session || (onlyIfStatus && session.status !== onlyIfStatus)) return false;
      Object.assign(session, patch);
      return true;
    },
    async post(id, row) { state.rows.push({ session_id: id, ...row }); },
  };
}

test('reconcile closes a shipped session whose pull request merged and reopens stranded or closed work', async t => {
  const { repo, workspaceRoot } = setup([]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004'];
  const heads = {};
  for (const [index, id] of ids.entries()) {
    const ws = vibe.ensureVibeWorkspace({ workspaceRoot, session: { id, base_sha: null }, sourceDirFor: () => repo.dir, resolveHead: () => repo.sha });
    fs.writeFileSync(path.join(ws.workspacePath, `file-${index}.txt`), `${index}\n`);
    git(ws.workspacePath, ['add', '-A']);
    git(ws.workspacePath, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', `work ${index}`]);
    heads[id] = git(ws.workspacePath, ['rev-parse', 'HEAD']);
  }
  const baseSha = repo.sha;
  // Session 1 merged exactly; session 2 merged, then got a later commit that never reached main.
  git(repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'cherry-pick', heads[ids[0]], heads[ids[1]]]);
  repo.sha = git(repo.dir, ['rev-parse', 'HEAD']);
  const prHead2 = heads[ids[1]];
  const ws2 = vibe.vibeWorkspacePath(workspaceRoot, ids[1]);
  fs.writeFileSync(path.join(ws2, 'late.txt'), 'late\n');
  git(ws2, ['add', '-A']);
  git(ws2, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'late work after merge']);
  heads[ids[1]] = git(ws2, ['rev-parse', 'HEAD']);
  const store = reconcileStore(ids.map((id, index) => ({
    id, human_reference: `VB-${index + 1}`, status: 'shipped', base_sha: baseSha, head_sha: heads[id],
    pr_url: `https://github.com/o/r/pull/${index + 1}`, pr_number: index + 1,
  })));
  const states = {
    1: { state: 'merged', headSha: heads[ids[0]] },
    2: { state: 'merged', headSha: prHead2 },
    3: { state: 'closed' },
    4: { state: 'open', headSha: heads[ids[3]] },
  };
  const result = await vibe.reconcileShippedSessions({
    store, workspaceRoot, sourceDirFor: () => repo.dir, resolveHead: () => repo.sha,
    readPullRequest: async ({ url }) => states[Number(url.split('/').pop())],
  });
  const byId = Object.fromEntries(store.state.sessions.map(session => [session.id, session]));
  assert.equal(byId[ids[0]].status, 'closed');
  assert.equal(byId[ids[1]].status, 'open');
  assert.equal(byId[ids[1]].pr_url, null);
  assert.equal(byId[ids[2]].status, 'open');
  assert.equal(byId[ids[2]].pr_url, null);
  assert.equal(byId[ids[3]].status, 'shipped');
  assert.deepEqual(result, { checked: 4, closed: 1, reopened: 2 });
  const posted = id => store.state.rows.filter(row => row.session_id === id).map(row => row.content).join('\n');
  assert.match(posted(ids[0]), /#1 was merged into main.*complete/s);
  assert.match(posted(ids[1]), /#2 was merged.*1 later commit.*not on main/s);
  assert.match(posted(ids[2]), /#3 was closed without merging/);
  assert.equal(posted(ids[3]), '');
});

function squashMergeVibeBranch(repo, workspacePath, files) {
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(repo.dir, file)), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, file), fs.readFileSync(path.join(workspacePath, file)));
  }
  git(repo.dir, ['add', '-A']);
  git(repo.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'Squashed vibe work (#7)']);
  repo.sha = git(repo.dir, ['rev-parse', 'HEAD']);
}

test('after a squash merge, later work replays only the commits made after the merged head', async t => {
  verifiedFixtureIdentity(t);
  const published = [];
  const opened = [];
  const prs = {};
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"hi"', new_text: '"blue"' } },
    { tool: 'reply', args: { message: 'blue' } },
    { tool: 'replace_in_file', args: { path: 'apps/web/src/hello.ts', old_text: '"blue"', new_text: '"green"' } },
    { tool: 'reply', args: { message: 'green' } },
    { tool: 'write_file', args: { path: 'apps/web/src/two.ts', content: 'export const two = 2;\n' } },
    { tool: 'reply', args: { message: 'two' } },
  ], {
    humanTest: async () => ({ ok: true, passed: 1 }),
    publish: async args => published.push(args),
    openPullRequest: async args => { const number = 7 + opened.length; opened.push(args); prs[number] = { state: 'open', headSha: args.head }; return { url: `https://github.com/o/r/pull/${number}`, number }; },
    readPullRequest: async ({ url }) => prs[Number(url.split('/').pop())] || { state: 'unknown' },
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('make it blue'), deps });
  await vibe.processVibeMessage({ store, message: ownerMessage('no, green'), deps });
  await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  const ws = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
  squashMergeVibeBranch(repo, ws, ['apps/web/src/hello.ts']);
  prs[7] = { state: 'merged', headSha: published[0].head };
  await vibe.processVibeMessage({ store, message: ownerMessage('add two'), deps });
  assert.ok(!store.state.rows.some(row => row.kind === 'error' && /conflicts with main/.test(row.content)), 'squashed work is not replayed onto main');
  assert.equal(store.state.session.base_sha, repo.sha);
  const shipped = await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(shipped.error, undefined, shipped.reply);
  assert.equal(opened.length, 2);
  assert.deepEqual(store.state.session.changed_files, ['apps/web/src/two.ts']);
  assert.equal(git(repo.dir, ['rev-parse', `${published[1].head}^`]), repo.sha);
});

test('a failed ship after clearing a finished pull request leaves the session open, not shipped without a PR', async t => {
  verifiedFixtureIdentity(t);
  const { store, deps, repo, workspaceRoot } = setup([
    { tool: 'write_file', args: { path: 'apps/web/src/one.ts', content: 'export const one = 1;\n' } },
    { tool: 'reply', args: { message: 'one' } },
  ], {
    humanTest: async () => ({ ok: true, passed: 1 }),
    publish: async () => { throw new Error('push refused'); },
    openPullRequest: async () => ({ url: 'https://github.com/o/r/pull/8', number: 8 }),
    readPullRequest: async () => ({ state: 'closed', headSha: null }),
  });
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  await vibe.processVibeMessage({ store, message: ownerMessage('add one'), deps });
  Object.assign(store.state.session, { pr_url: 'https://github.com/o/r/pull/7', pr_number: 7, status: 'shipped' });
  await vibe.processVibeMessage({ store, message: ownerMessage('ship', 'ship'), deps });
  assert.equal(store.state.session.pr_url, null);
  assert.equal(store.state.session.status, 'open');
});

test('reconcile counts only commits made after a squash-merged pull request head', async t => {
  const { repo, workspaceRoot } = setup([]);
  t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }); });
  const id = 'eeeeeeee-0000-4000-8000-000000000005';
  const ws = vibe.ensureVibeWorkspace({ workspaceRoot, session: { id, base_sha: null }, sourceDirFor: () => repo.dir, resolveHead: () => repo.sha });
  const commit = (file, content, message) => {
    fs.writeFileSync(path.join(ws.workspacePath, file), content);
    git(ws.workspacePath, ['add', '-A']);
    git(ws.workspacePath, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', message]);
    return git(ws.workspacePath, ['rev-parse', 'HEAD']);
  };
  const baseSha = repo.sha;
  commit('colour.txt', 'blue\n', 'blue');
  const prHead = commit('colour.txt', 'green\n', 'green');
  squashMergeVibeBranch(repo, ws.workspacePath, ['colour.txt']);
  const head = commit('late.txt', 'late\n', 'late work');
  const store = reconcileStore([{ id, human_reference: 'VB-5', status: 'shipped', base_sha: baseSha, head_sha: head, pr_url: 'https://github.com/o/r/pull/7', pr_number: 7 }]);
  await vibe.reconcileShippedSessions({ store, workspaceRoot, sourceDirFor: () => repo.dir, resolveHead: () => repo.sha, readPullRequest: async () => ({ state: 'merged', headSha: prHead }) });
  assert.equal(store.state.sessions[0].status, 'open');
  assert.match(store.state.rows.map(row => row.content).join('\n'), /#7 was merged, but 1 later commit/);
});
