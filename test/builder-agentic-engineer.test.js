'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const policy = require('../builder-path-policy');
const gateway = require('../builder-model-gateway');
const { runAgenticEngineer, parseToolCall, RUN_ALLOWLIST, buildProposal, createTools, DEFAULT_LIMITS } = require('../builder-agentic-engineer');

test('path policy: protected paths are refused on every lane, lanes split at apps/web', () => {
  for (const file of ['.github/workflows/ci.yml', 'deploy/bob-vps/compose.yml', 'Dockerfile', 'services/fcm-api/Dockerfile', 'docker-compose.full.yml', 'package.json', 'apps/web/package-lock.json', '.env', 'apps/web/.env.production', 'supabase/schema.sql', 'apps/web/src/context/AuthContext.tsx', 'supabase/functions/_shared/auth.ts', 'certs/site.pem', '../etc/passwd', 'a/../../b']) {
    assert.equal(policy.isProtectedPath(file), true, `${file} should be protected`);
    assert.equal(policy.laneAllows('backend', file), false, `${file} must not be editable`);
    assert.equal(policy.laneAllows('frontend', file), false, `${file} must not be editable`);
  }
  assert.equal(policy.laneAllows('backend', 'services/fcm-api/src/bob/plan.js'), true);
  assert.equal(policy.laneAllows('backend', 'supabase/functions/onspace-ai-chat/index.ts'), true);
  assert.equal(policy.laneAllows('backend', 'supabase/migrations/20260926120000_add_thing.sql'), true);
  assert.equal(policy.laneAllows('backend', 'apps/web/src/components/BobPanel.tsx'), false);
  assert.equal(policy.laneAllows('frontend', 'apps/web/src/components/BobPanel.tsx'), true);
  assert.equal(policy.laneAllows('frontend', 'services/fcm-api/server.js'), false);
  assert.match(policy.protectedReason('package.json'), /dependency/);
  assert.match(policy.protectedReason('.github/workflows/x.yml'), /CI workflow/);
});

test('builder model gateway: max effort defaults, multi-turn messages, and allowlist', () => {
  const config = gateway.createModelGatewayConfig({ OPENAI_API_KEY: 'k' });
  assert.equal(config.reasoningEffort, 'high');
  assert.equal(config.maxOutputTokens, 32000);
  assert.ok(config.maxPromptChars >= 1_000_000);
  assert.ok(config.openai.models.has('gpt-5.4'));
  const base = { provider: 'openai', builder_mode: 'backend_engineer', prompt_version: 'v', idempotency_key: 'k' };
  assert.equal(gateway.validateModelRequest({ ...base, messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }] }, config), null);
  assert.equal(gateway.validateModelRequest({ ...base, messages: [{ role: 'tool', content: 'x' }] }, config), 'messages must be role/content pairs');
  assert.equal(gateway.validateModelRequest({ ...base, system_prompt: 'a', user_prompt: 'b', reasoning_effort: 'max' }, config), 'unsupported reasoning effort');
  const body = gateway.buildProviderBody({ input: { ...base, messages: [{ role: 'user', content: 'hi' }], output_schema: { type: 'object' } }, config, model: 'gpt-5.4' });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.max_completion_tokens, 32000);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const classic = gateway.buildProviderBody({ input: { ...base, system_prompt: 'a', user_prompt: 'b' }, config, model: 'gpt-4o-mini' });
  assert.equal(classic.max_tokens, 16000);
  assert.equal(classic.reasoning_effort, undefined);
  // The independent reviewer defaults to a model that differs from the author's (job 3a4a2d06 stalled on a missing reviewer).
  assert.equal(gateway.defaultReviewerModel({ BOB_BUILDER_MODEL: 'gpt-5.4', BOB_OPENAI_MODELS: 'gpt-5.4,gpt-5.4-mini,gpt-4o-mini' }), 'gpt-5.4-mini');
  assert.equal(gateway.defaultReviewerModel({ BOB_BUILDER_MODEL: 'gpt-5.4', BOB_BUILDER_REVIEWER_MODEL: 'gpt-4o-mini' }), 'gpt-4o-mini');
  assert.equal(gateway.defaultReviewerModel({ BOB_BUILDER_MODEL: 'gpt-5.4', BOB_BUILDER_REVIEWER_MODEL: 'gpt-5.4', BOB_OPENAI_MODELS: 'gpt-5.4' }), null, 'the author may never review itself');
});

test('tool-call parsing tolerates fences and prose; run allowlist is narrow', () => {
  assert.deepEqual(parseToolCall('```json\n{"tool":"read_file","args":{"path":"a.js"}}\n```'), { tool: 'read_file', args: { path: 'a.js' } });
  assert.deepEqual(parseToolCall('Sure: {"thought":"x","tool":"finish","args":{"summary":"s"}} done'), { thought: 'x', tool: 'finish', args: { summary: 's' } });
  assert.equal(parseToolCall('nope'), null);
  const allowed = (cmd) => RUN_ALLOWLIST.some((pattern) => pattern.test(cmd));
  assert.equal(allowed('node --test test/fcm-api-bob-planner.test.js'), true);
  assert.equal(allowed('node --check services/fcm-api/server.js'), true);
  assert.equal(allowed('git diff --stat'), true);
  assert.equal(allowed('rm -rf /'), false);
  assert.equal(allowed('node -e "process.exit(1)"'), false);
  assert.equal(allowed('npm install left-pad'), false);
  assert.equal(allowed('git push origin main'), false);
});

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-agent-repo-'));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const git = (args, cwd = source) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(source, 'lib'));
  fs.mkdirSync(path.join(source, 'test'));
  fs.mkdirSync(path.join(source, 'apps', 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'lib', 'sum.js'), "'use strict';\nmodule.exports = { sum: (a, b) => a - b };\n");
  fs.writeFileSync(path.join(source, 'test', 'sum.test.js'), "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { sum } = require('../lib/sum');\ntest('sum adds', () => assert.equal(sum(2, 3), 5));\n");
  fs.writeFileSync(path.join(source, 'apps', 'web', 'src', 'app.tsx'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(source, 'AGENTS.md'), '# Agents\nRead the canon.\n');
  git(['add', '-A']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'fixture']);
  return { root, source, sha: git(['rev-parse', 'HEAD']), git };
}

function fakeModel(turns) {
  let index = 0;
  const seen = [];
  const callModel = async ({ modelRequest }) => {
    seen.push(modelRequest);
    const turn = turns[Math.min(index, turns.length - 1)];
    index++;
    const content = typeof turn === 'function' ? turn(modelRequest) : turn;
    return { ok: true, status: 200, data: { content: JSON.stringify(content), model: 'gpt-5.4', usage: { total_tokens: 10 } } };
  };
  return { callModel, seen };
}

test('agentic engineer explores, fixes the bug, runs the tests, and hands over a validated patch', async () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const job = { id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, title: 'sum subtracts', task_description: 'lib/sum.js subtracts instead of adding; test/sum.test.js fails.' };
  const step = { id: 'step-1', builder_mode: 'backend_engineer' };
  const { callModel, seen } = fakeModel([
    { thought: 'read the canon first', tool: 'read_canon', args: {} },
    { thought: 'find the function', tool: 'search', args: { query: 'sum', path: 'lib' } },
    { thought: 'read it', tool: 'read_file', args: { path: 'lib/sum.js' } },
    { thought: 'run the failing test', tool: 'run', args: { command: 'node --test test/sum.test.js' } },
    { thought: 'try a protected path (should be refused)', tool: 'write_file', args: { path: 'package.json', content: '{}' } },
    { thought: 'fix it', tool: 'write_file', args: { path: 'lib/sum.js', content: "'use strict';\nmodule.exports = { sum: (a, b) => a + b };\n" } },
    { thought: 'verify', tool: 'run', args: { command: 'node --test test/sum.test.js' } },
    { thought: 'done', tool: 'finish', args: { summary: 'sum() used subtraction; changed to addition. Verified with node --test test/sum.test.js (1 pass).', tests: ['node --test test/sum.test.js'], rollback_notes: ['revert the PR'] } },
  ]);
  const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job, step, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 12 } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.turns, 8);
  assert.deepEqual(result.proposal.changed_files, ['lib/sum.js']);
  assert.match(result.proposal.patch, /-module\.exports = \{ sum: \(a, b\) => a - b \};/);
  assert.match(result.proposal.patch, /\+module\.exports = \{ sum: \(a, b\) => a \+ b \};/);
  assert.ok(result.proposal.patch.endsWith('\n'), 'patch keeps its terminating newline (git apply rejects an unterminated last line as corrupt)');
  // The handed-over patch must be applicable, byte for byte, to a clean checkout of the pinned commit.
  const patchFile = path.join(repo.root, 'proposal.patch');
  fs.writeFileSync(patchFile, result.proposal.patch);
  assert.equal(repo.git(['apply', '--check', '--whitespace=error-all', patchFile]), '');
  assert.equal(result.proposal.lane, 'backend');
  // Every turn went to the gateway as a multi-turn request at high effort with the conversation attached.
  assert.ok(seen.every((request) => Array.isArray(request.request.messages) && request.request.reasoning_effort === 'high'));
  const firstTest = JSON.parse(seen[4].request.messages.at(-1).content).tool_result;
  assert.equal(firstTest.exit_code, 1, 'the failing test ran inside the worktree');
  const refused = JSON.parse(seen[5].request.messages.at(-1).content).tool_result;
  assert.match(refused.error, /dependency change \(protected path\)/);
  const secondTest = JSON.parse(seen[7].request.messages.at(-1).content).tool_result;
  assert.equal(secondTest.exit_code, 0, 'the test passed after the fix');
  // The worktree is left clean at the pinned commit for the handoff.
  const workspacePath = path.join(workspaceRoot, 'bob-job-a1b2c3d4e5f60718293a');
  assert.equal(repo.git(['status', '--porcelain'], workspacePath), '');
  assert.equal(repo.git(['rev-parse', 'HEAD'], workspacePath), repo.sha);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test('agentic engineer refuses to finish with out-of-lane edits and stops on budget without a proposal', async () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const job = { id: 'ffffffffffffffffffffffffffffffff', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, title: 't', task_description: 'd' };
  const step = { id: 'step-2', builder_mode: 'frontend_engineer' };
  const { callModel, seen } = fakeModel([
    { tool: 'write_file', args: { path: 'lib/sum.js', content: 'x' } },
    { tool: 'finish', args: { summary: 'changed a backend file from the frontend lane, which must be refused' } },
    { tool: 'git_diff', args: {} },
  ]);
  const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job, step, lane: 'frontend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 4 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /turn budget exhausted/);
  const writeResult = JSON.parse(seen[1].request.messages.at(-1).content).tool_result;
  assert.match(writeResult.error, /outside the frontend lane/);
  const finishResult = JSON.parse(seen[2].request.messages.at(-1).content).tool_result;
  assert.match(finishResult.error, /no changes in the worktree/);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

// Lessons from the first live run (job 5ba292f4, 2026-09-26): the model searched two
// pathspecs at once and got "Command failed"; a no-match grep was reported as an error;
// and three fenced / miscounted diffs were rejected outright, forcing full-file rewrites.
test('search honours several pathspecs and treats no matches as a result; apply_patch tolerates fences and miscounted hunks', () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const { createBranchWorkspace } = require('../builder-branch-workspace');
  const ws = createBranchWorkspace({ sourceDir: repo.source, workspaceRoot, jobId: 'cafebabecafebabecafebabe', targetSha: repo.sha });
  const tools = createTools({ workspacePath: ws.workspacePath, repoRoot: repo.source, lane: 'backend', supabase: null, limits: DEFAULT_LIMITS, log() {} });

  const multi = tools.search({ query: 'sum', path: 'lib test' });
  assert.deepEqual(multi.paths, ['lib', 'test']);
  assert.equal(multi.matches, 3, JSON.stringify(multi)); // 1 in lib/sum.js + 2 in test/sum.test.js
  const none = tools.search({ query: 'definitely-not-present', path: 'lib' });
  assert.equal(none.error, undefined);
  assert.equal(none.matches, 0);
  const regex = tools.search({ query: 'sum|assert', path: ['test'], regex: true });
  assert.ok(regex.matches >= 2);

  // Fenced diff with a wrong hunk length (says 3 lines, has 2) still applies via --recount.
  const fenced = [
    '```diff',
    'diff --git a/lib/sum.js b/lib/sum.js',
    '--- a/lib/sum.js',
    '+++ b/lib/sum.js',
    '@@ -1,3 +1,3 @@',
    " 'use strict';",
    '-module.exports = { sum: (a, b) => a - b };',
    '+module.exports = { sum: (a, b) => a + b };',
    '```',
  ].join('\n');
  const applied = tools.apply_patch({ diff: fenced });
  assert.equal(applied.applied, true, JSON.stringify(applied));
  assert.deepEqual(applied.changed_files, ['lib/sum.js']);
  assert.match(fs.readFileSync(path.join(ws.workspacePath, 'lib', 'sum.js'), 'utf8'), /a \+ b/);

  // A hunk whose context does not exist anywhere is still refused with actionable guidance.
  const bogus = 'diff --git a/lib/sum.js b/lib/sum.js\n--- a/lib/sum.js\n+++ b/lib/sum.js\n@@ -1,2 +1,2 @@\n-this line is not in the file\n+replacement\n';
  const refused = tools.apply_patch({ diff: bogus });
  assert.match(refused.error, /patch did not apply/);
  assert.match(refused.error, /write_file/);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test('compactMessages keeps recent turns verbatim and collapses older bulky results and write payloads', () => {
  const { compactMessages } = require('../builder-agentic-engineer');
  const big = 'x'.repeat(5000);
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: JSON.stringify({ thought: 't', tool: 'read_file', args: { path: 'a.js' } }) },
    { role: 'user', content: JSON.stringify({ tool_result: { content: big } }) },
    { role: 'assistant', content: JSON.stringify({ thought: 'write', tool: 'write_file', args: { path: 'a.js', content: big } }) },
    { role: 'user', content: JSON.stringify({ tool_result: { ok: true } }) },
    { role: 'assistant', content: JSON.stringify({ thought: 'recent', tool: 'read_file', args: { path: 'b.js' } }) },
    { role: 'user', content: JSON.stringify({ tool_result: { content: big } }) },
  ];
  const out = compactMessages(messages, { keepRecent: 1 });
  assert.equal(out.length, messages.length);
  assert.equal(out[0], messages[0]);
  assert.equal(out[1], messages[1]);
  assert.ok(out[3].content.length < 1000 && /compacted \d+ chars/.test(out[3].content), 'old bulky tool result is stubbed');
  const write = JSON.parse(out[4].content);
  assert.equal(write.tool, 'write_file');
  assert.equal(write.args.path, 'a.js');
  assert.equal(write.args.bytes, 5000);
  assert.match(write.args.content, /compacted/);
  assert.equal(out[5], messages[5], 'small messages are untouched');
  assert.equal(out[6], messages[6]);
  assert.equal(out[7], messages[7], 'the most recent result stays verbatim');
  assert.equal(messages[3].content.length > 5000, true, 'the in-memory transcript is not mutated');
});

test('finish is refused when a change touches tests but no test run passed this session; verified_runs carry first-hand evidence', () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const { createBranchWorkspace } = require('../builder-branch-workspace');
  const ws = createBranchWorkspace({ sourceDir: repo.source, workspaceRoot, jobId: 'abad1deaabad1deaabad1dea', targetSha: repo.sha });
  const tools = createTools({ workspacePath: ws.workspacePath, repoRoot: repo.source, lane: 'backend', supabase: null, limits: DEFAULT_LIMITS, log() {} });
  fs.writeFileSync(path.join(ws.workspacePath, 'lib', 'sum.js'), "'use strict';\nmodule.exports = { sum: (a, b) => a + b };\n");
  fs.writeFileSync(path.join(ws.workspacePath, 'test', 'sum.test.js'), "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { sum } = require('../lib/sum');\ntest('sum adds', () => assert.equal(sum(2, 3), 5));\ntest('sum adds zero', () => assert.equal(sum(2, 0), 2));\n");
  const args = { summary: 'Fix sum and extend its test; verified locally.', tests: 'node --check lib/sum.js\nnode --test test/sum.test.js', rollback_notes: ['revert'] };
  const refused = buildProposal({ workspacePath: ws.workspacePath, lane: 'backend', tools, args });
  assert.match(refused.error, /touches tests but no `node --test …` run passed/);
  // Claims in args.tests do not count; only an actual passing run does.
  tools.run({ command: 'node --check lib/sum.js' });
  assert.match(buildProposal({ workspacePath: ws.workspacePath, lane: 'backend', tools, args }).error, /no `node --test …` run passed/);
  const run = tools.run({ command: 'node --test test/sum.test.js' });
  assert.equal(run.exit_code, 0);
  const ok = buildProposal({ workspacePath: ws.workspacePath, lane: 'backend', tools, args });
  assert.ok(ok.proposal, JSON.stringify(ok));
  assert.deepEqual(ok.proposal.tests, ['node --check lib/sum.js', 'node --test test/sum.test.js'], 'a newline-joined tests string is normalised to a list');
  assert.deepEqual(ok.proposal.verified_runs.map(r => [r.command, r.exit_code]), [['node --check lib/sum.js', 0], ['node --test test/sum.test.js', 0]]);
  // An honest reason is the only other way through.
  const tools2 = createTools({ workspacePath: ws.workspacePath, repoRoot: repo.source, lane: 'backend', supabase: null, limits: DEFAULT_LIMITS, log() {} });
  const explained = buildProposal({ workspacePath: ws.workspacePath, lane: 'backend', tools: tools2, args: { ...args, tests: [], tests_not_run_reason: 'the suite needs a live database that is not available in this worktree' } });
  assert.equal(explained.proposal.tests_not_run_reason, 'the suite needs a live database that is not available in this worktree');
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test('buildProposal keeps a trailing blank context line (live job 3a4a2d06 lost it and the worker saw a corrupt patch)', () => {
  const repo = makeRepo();
  // A change followed by <blank>, line, <blank>: the hunk's last context line is a lone space.
  fs.writeFileSync(path.join(repo.source, 'lib', 'spaced.js'), "const a = 1;\n\nconst b = 2;\n\n");
  repo.git(['add', '-A']);
  repo.git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'spaced']);
  const sha = repo.git(['rev-parse', 'HEAD']);
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const { createBranchWorkspace } = require('../builder-branch-workspace');
  const ws = createBranchWorkspace({ sourceDir: repo.source, workspaceRoot, jobId: 'feedfacefeedfacefeedface', targetSha: sha });
  const tools = createTools({ workspacePath: ws.workspacePath, repoRoot: repo.source, lane: 'backend', supabase: null, limits: DEFAULT_LIMITS, log() {} });
  fs.writeFileSync(path.join(ws.workspacePath, 'lib', 'spaced.js'), "const a = 10;\n\nconst b = 2;\n\n");
  const built = buildProposal({ workspacePath: ws.workspacePath, lane: 'backend', tools, args: { summary: 'Bump a from 1 to 10; verified by reading the diff.', tests: [] } });
  assert.ok(built.proposal, JSON.stringify(built));
  assert.ok(built.proposal.patch.endsWith('\n \n'), `trailing blank context line must survive: ${JSON.stringify(built.proposal.patch.slice(-20))}`);
  const patchFile = path.join(repo.root, 'spaced.patch');
  fs.writeFileSync(patchFile, built.proposal.patch);
  assert.equal(repo.git(['apply', '--check', '--whitespace=error-all', patchFile]), '');
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test('buildProposal enforces additive-only migrations and the lane validator', () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const { createBranchWorkspace } = require('../builder-branch-workspace');
  const ws = createBranchWorkspace({ sourceDir: repo.source, workspaceRoot, jobId: 'deadbeefdeadbeefdeadbeef', targetSha: repo.sha });
  const tools = createTools({ workspacePath: ws.workspacePath, repoRoot: repo.source, lane: 'backend', supabase: null, limits: DEFAULT_LIMITS, log() {} });
  fs.writeFileSync(path.join(ws.workspacePath, 'lib', 'sum.js'), "'use strict';\nmodule.exports = { sum: (a, b) => a + b };\n");
  const short = buildProposal({ workspacePath: ws.workspacePath, lane: 'backend', tools, args: { summary: 'too short' } });
  assert.match(short.error, /summary must explain/);
  const ok = buildProposal({ workspacePath: ws.workspacePath, lane: 'backend', tools, args: { summary: 'Fix sum to add instead of subtract; verified with the unit test.', tests: ['node --test test/sum.test.js'] } });
  assert.deepEqual(ok.proposal.changed_files, ['lib/sum.js']);
  assert.deepEqual(ok.proposal.database_migrations, []);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test('worker mounts are translated to host paths when the control plane runs in a container', () => {
  const { dockerArguments, hostPath } = require('../worker-executor');
  const env = { BOB_STATE_DIR: '/data', BOB_HOST_DATA_DIR: '/var/lib/bob' };
  assert.equal(hostPath('/data/builder-workspaces/bob-job-x', env), '/var/lib/bob/builder-workspaces/bob-job-x');
  assert.equal(hostPath('/data', env), '/var/lib/bob');
  assert.throws(() => hostPath('/tmp/outside', env), /must live under \/data/);
  assert.equal(hostPath('/tmp/anything', {}), '/tmp/anything');
  const args = dockerArguments({ image: 'fcm/bob-worker:current', sourceDir: '/data/builder-workspaces/bob-job-x', artifactDir: '/data/tmp/bob-backend-worker-1', profile: 'backend-verify', env });
  assert.ok(args.includes('type=bind,src=/var/lib/bob/builder-workspaces/bob-job-x,dst=/workspace,readonly'));
  assert.ok(args.includes('type=bind,src=/var/lib/bob/tmp/bob-backend-worker-1,dst=/artifacts'));
  assert.ok(args.includes('--network=none') && args.includes('--cap-drop=ALL'));
});
