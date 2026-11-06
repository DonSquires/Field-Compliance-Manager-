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
  const state = { session: { ...session }, rows, completed: {} };
  return {
    state,
    async session() { return { ...state.session }; },
    async updateSession(_id, patch) { Object.assign(state.session, patch); },
    async post(_id, row) { rows.push({ seq: rows.length + 100, ...row }); },
    async complete(id, status) { state.completed[id] = status; },
    async history() { return []; },
    async recentExecution() { return []; },
    async verificationHistory(sessionId, beforeSeq) { return this.recentExecution(sessionId, beforeSeq); },
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
  process.env.BOB_BUILDER_GIT_NAME = 'Don Squires';
  process.env.BOB_BUILDER_GIT_EMAIL = '256263525+DonSquires@users.noreply.github.com';
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
  const definitions = vibe.vibeNativeTools({ read_file() {}, search() {}, replace_in_file() {}, __policyCheck() {} });
  const replacement = definitions.find(tool => tool.function.name === 'replace_in_file').function;
  assert.deepEqual(replacement.parameters.required, ['path', 'old_text', 'new_text']);
  assert.equal(replacement.parameters.properties.new_text.type, 'string');
  const read = definitions.find(tool => tool.function.name === 'read_file').function;
  assert.deepEqual(read.parameters.required, ['path']);
  assert.equal(read.parameters.properties.start_line.type, 'integer');
  assert.match(definitions.find(tool => tool.function.name === 'search').function.description, /not semantic questions/);
  assert.ok(definitions.every(tool => !tool.function.name.startsWith('__')));
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
    store, message: ownerMessage('improve greeting'), deps, limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 0 },
  });
  assert.equal(result.error, true);
  assert.match(result.reply, /Changes are not verified/);
  assert.match(result.reply, /ran out of steps/);
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
    store: stuck.store, message: ownerMessage('improve greeting'), deps: stuck.deps, limits: { ...vibe.VIBE_LIMITS, maxTurns: 1, repairTurns: 2 },
  });
  assert.equal(unverified.error, true);
  assert.match(unverified.reply, /Changes are not verified/);
  assert.equal(stuck.store.state.rows.filter(row => row.payload?.reason === 'verification_repair_extension').length, 1);
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
  assert.deepEqual(model.calls[0].chain, ['gpu_workstation', 'ollama']);
  assert.equal(model.calls[0].routing_reason, 'private_repository_local_only');
  assert.ok(model.calls[0].request.output_schema.properties.tool.enum.includes('replace_in_file'));
  assert.ok(!model.calls[0].request.output_schema.properties.tool.enum.includes('__policyCheck'));
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
    store, message: ownerMessage(compact ? `Continue ${'a'.repeat(37700)}` : 'Continue.'), deps,
  });
  assert.ok(cloudModel.calls.length);
  assert.doesNotMatch(JSON.stringify(cloudModel.calls), /private-(?:branch|commit|session-title|check|output)-marker/);
  if (compact) assert.ok(store.state.rows.some(row => row.payload?.reason === 'context_compacted'));
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

test('failed commands cannot reset the repetition limit', async () => {
  const run = { thought: 'install tooling', tool: 'run', args: { command: 'npm install vitest --save-dev' } };
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
  const current = `Continue ${'a'.repeat(37700)}`;
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

test('protected paths are refused and never committed', async () => {
  const { store, deps, workspaceRoot } = setup([
    { thought: 'bump', tool: 'write_file', args: { path: 'package.json', content: '{"name":"evil"}\n' } },
    { thought: 'tell', tool: 'reply', args: { message: 'Tried.' } },
  ]);
  await vibe.processVibeMessage({ store, message: ownerMessage('change the package name'), deps });
  const ws = vibe.vibeWorkspacePath(workspaceRoot, SESSION_ID);
  assert.equal(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'), '{"name":"x"}\n');
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
  process.env.BOB_BUILDER_GIT_EMAIL = '256263525+DonSquires@users.noreply.github.com';
  process.env.BOB_BUILDER_GIT_NAME = 'Don Squires';
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
    assert.equal(git(ws, ['log', '-1', '--format=%ae']), '256263525+DonSquires@users.noreply.github.com');
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
  await manager.ensureWebDependencies(workspacePath);
  const install = calls.find(call => call.cmd === 'npm');
  assert.ok(install, 'npm ci was called');
  assert.ok(install.args.includes('--include=dev'));
  assert.equal(install.options.env.NODE_ENV, 'development');
  assert.equal(install.options.env.NPM_CONFIG_PRODUCTION, 'false');
  assert.equal(install.options.env.npm_config_production, 'false');
  assert.equal(fs.existsSync(path.join(web, 'node_modules', 'vite', 'package.json')), true);
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
    { tool: 'browser_test', args: { specs: ['e2e/greeting.spec.ts'], revision: 'base', reason: 'reproduce on base' } },
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
