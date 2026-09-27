'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const policy = require('../builder-path-policy');
const gateway = require('../builder-model-gateway');
const { runAgenticEngineer, parseToolCall, RUN_ALLOWLIST, buildProposal, createTools, composeRunNote, classifyNoChange, outlineLines, readingMap, taskPacket, DEFAULT_LIMITS } = require('../builder-agentic-engineer');

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
  // Deterministic best-available: the allowlist is strongest-first and only models the account lists count.
  const account = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.6-sol', 'gpt-6-sol', 'o3'];
  assert.equal(gateway.bestAvailableModel(['gpt-7-nova', 'gpt-6-sol', 'gpt-5.6-sol'], account), 'gpt-6-sol', 'an unreleased first choice is skipped');
  assert.equal(gateway.defaultAuthorModel({ BOB_OPENAI_MODELS: 'gpt-7-nova,gpt-6-sol,gpt-5.6-sol,gpt-5.4' }, account), 'gpt-6-sol');
  assert.equal(gateway.defaultAuthorModel({ BOB_OPENAI_MODELS: 'gpt-6-sol,gpt-5.4', BOB_BUILDER_MODEL: 'gpt-5.4' }, account), 'gpt-5.4', 'a pinned author wins');
  assert.equal(gateway.defaultReviewerModel({ BOB_OPENAI_MODELS: 'gpt-6-sol,gpt-5.6-sol,gpt-5.4' }, account), 'gpt-5.6-sol', 'the reviewer is the strongest available model that is not the author');
  assert.equal(gateway.defaultReviewerModel({ BOB_OPENAI_MODELS: 'gpt-7-nova,gpt-6-sol,gpt-5.6-sol' }, account), 'gpt-5.6-sol');
  assert.ok(gateway.REASONING_EFFORTS.has('xhigh'), 'xhigh is the API maximum for gpt-5.4 … gpt-6 (probed 2026-09-26)');
  assert.ok(!gateway.REASONING_EFFORTS.has('max'));
  assert.equal(gateway.isReasoningModel('gpt-6-sol'), true);
  assert.equal(gateway.isReasoningModel('gpt-4.1'), false);
  const bodyXhigh = gateway.buildProviderBody({ input: { ...base, messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'xhigh' }, config, model: 'gpt-6-sol' });
  assert.equal(bodyXhigh.reasoning_effort, 'xhigh');
  assert.equal(gateway.validateModelRequest({ ...base, messages: [{ role: 'user', content: 'b' }], reasoning_effort: 'max' }, config), 'unsupported reasoning effort');
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

// Provider health as the control plane reports it: laptop GPU off, VPS Ollama up, OpenAI configured.
const LAPTOP_OFF = Object.freeze({
  gpu_workstation: { configured: true, healthy: false, models: ['qwen2.5-coder:7b'], ready_model: null },
  ollama: { configured: true, healthy: true, models: ['llama3.1:8b'], ready_model: 'llama3.1:8b' },
  openai: { configured: true, healthy: true, models: ['gpt-5.4', 'gpt-5.4-mini'] },
});
const LAPTOP_ON = Object.freeze({ ...LAPTOP_OFF, gpu_workstation: { configured: true, healthy: true, models: ['qwen2.5-coder:7b'], ready_model: 'qwen2.5-coder:7b' } });

test('the author works in-house first and escalates to OpenAI only when the local model is stuck', async () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const job = { id: 'e5ca1a7ee5ca1a7ee5ca1a7ee5ca1a7e', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, title: 'sum subtracts', task_description: 'fix sum' };
  const step = { id: 'step-esc', builder_mode: 'backend_engineer' };
  const seen = [];
  const callModel = async ({ modelRequest }) => {
    seen.push({ provider: modelRequest.provider, model: modelRequest.model_name, effort: modelRequest.request.reasoning_effort ?? null });
    // The laptop answers the first turn, then its window overflows (413) -> escalate; OpenAI finishes the job.
    if (modelRequest.provider === 'gpu_workstation') {
      if (seen.filter(s => s.provider === 'gpu_workstation').length === 1) return { ok: true, status: 200, data: { content: JSON.stringify({ tool: 'read_file', args: { path: 'lib/sum.js' } }), model: 'qwen2.5-coder:7b' } };
      return { ok: false, status: 413, error: 'prompt exceeds the gpu_workstation context window (32768 tokens)' };
    }
    const openaiTurn = seen.filter(s => s.provider === 'openai').length;
    const script = [
      { tool: 'write_file', args: { path: 'lib/sum.js', content: "'use strict';\nmodule.exports = { sum: (a, b) => a + b };\n" } },
      { tool: 'run', args: { command: 'node --test test/sum.test.js' } },
      { tool: 'finish', args: { summary: 'sum() used subtraction; changed to addition; test passes.', tests: ['node --test test/sum.test.js'], rollback_notes: ['revert'] } },
    ];
    return { ok: true, status: 200, data: { content: JSON.stringify(script[Math.min(openaiTurn - 1, script.length - 1)]), model: 'gpt-5.4' } };
  };
  const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job, step, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 10 }, providerHealth: LAPTOP_ON });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(seen.slice(0, 3).map(s => s.provider), ['gpu_workstation', 'gpu_workstation', 'openai']);
  assert.equal(seen[0].model, 'qwen2.5-coder:7b');
  assert.equal(seen[0].effort, null, 'local models get no OpenAI reasoning params');
  assert.equal(seen[2].effort, 'high');
  assert.deepEqual(result.routing.chain, ['gpu_workstation', 'openai']);
  assert.equal(result.routing.provider, 'openai');
  assert.equal(result.routing.escalated, true);
  // Resuming past the failed local provider skips it entirely on the next attempt.
  const seen2 = [];
  const result2 = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job: { ...job, id: 'e5ca1a7ee5ca1a7ee5ca1a7ee5ca1a7f' }, step, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel: async ({ modelRequest }) => { seen2.push(modelRequest.provider); return { ok: true, status: 200, data: { content: JSON.stringify({ tool: 'finish', args: { summary: 'x', no_change_reason: 'nothing to do here really' } }), model: 'gpt-5.4' } }; }, limits: { ...DEFAULT_LIMITS, maxTurns: 3 }, providerHealth: LAPTOP_ON, startAfterProvider: 'gpu_workstation' });
  assert.deepEqual(seen2, ['openai']);
  assert.equal(result2.no_change, true);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

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
  const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job, step, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 12 }, providerHealth: LAPTOP_OFF });
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
  const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job, step, lane: 'frontend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 4 }, providerHealth: LAPTOP_OFF });
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
test('outline indexes the declarations of a big file with line numbers; search can return context lines (live job 118731bd walked a 10k-line file in 42 reads)', () => {
  const source = [
    "import { serve } from 'std/http';",
    'const TOOL_CATALOGUE = {',
    "  laptop_shell: { purpose: 'run' },",
    '};',
    'export async function loadUserMemory(supabase: any, userId: string) {',
    '  if (!userId) return null;',
    '  return supabase.from("bob_self_memory").select();',
    '}',
    'async function dispatchTool(name: string, args: Record<string, unknown>) {',
    '  switch (name) {',
    "    case 'laptop_shell':",
    '      return runLaptop(args);',
    "    case 'builder_create_job':",
    '      return createJob(args);',
    '  }',
    '}',
    'const tools = {',
    '  async write_note({ text }) {',
    '    return text;',
    '  },',
    '};',
    'type Pending = { kind: string };',
    'Deno.serve(async (req) => handle(req));',
    'CREATE OR REPLACE FUNCTION public.builder_cancel_job(_job_id uuid)',
  ].join('\n');
  const { entries, total_lines } = outlineLines(source);
  assert.equal(total_lines, 24);
  const text = entries.join('\n');
  assert.match(text, /^2: const TOOL_CATALOGUE = \{/m);
  assert.match(text, /^5: export async function loadUserMemory/m);
  assert.match(text, /^9: async function dispatchTool/m);
  assert.match(text, /^11: case 'laptop_shell':/m);
  assert.match(text, /^13: case 'builder_create_job':/m);
  assert.match(text, /^18: async write_note\(\{ text \}\) \{/m);
  assert.match(text, /^22: type Pending/m);
  assert.match(text, /^23: Deno\.serve/m);
  assert.match(text, /^24: CREATE OR REPLACE FUNCTION/m);
  assert.doesNotMatch(text, /if \(!userId\)|return supabase|return runLaptop/, 'statements are not declarations');
  assert.deepEqual(outlineLines(source, { pattern: 'laptop' }).entries, ["11: case 'laptop_shell':"]);
  assert.equal(outlineLines(source, { cap: 3 }).entries.length, 3);

  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const { createBranchWorkspace } = require('../builder-branch-workspace');
  const ws = createBranchWorkspace({ sourceDir: repo.source, workspaceRoot, jobId: 'ab1eab1eab1eab1eab1eab1e', targetSha: repo.sha });
  const tools = createTools({ workspacePath: ws.workspacePath, repoRoot: repo.source, lane: 'backend', supabase: null, limits: DEFAULT_LIMITS, log() {} });
  const outline = tools.outline({ path: 'test/sum.test.js' });
  assert.equal(outline.total_lines, 5);
  assert.match(outline.entries.join('\n'), /^1: const test = require/m);
  assert.match(tools.outline({ path: 'lib/sum.js', pattern: '[' }).error, /not a valid regular expression/);
  assert.match(tools.outline({ path: 'lib' }).error, /not a file/);

  const plain = tools.search({ query: 'sum adds', path: 'test' });
  assert.equal(plain.results.length, 1);
  assert.equal(plain.context, undefined);
  const around = tools.search({ query: 'sum adds', path: 'test', context: 2 });
  assert.equal(around.context, 2);
  assert.ok(around.results.length >= 3, JSON.stringify(around));
  assert.ok(around.results.some((line) => /test\/sum\.test\.js-3-/.test(line)), 'surrounding lines come back with the hit');
  assert.equal(tools.search({ query: 'sum adds', path: 'test', context: 99 }).context, 8, 'context is capped');
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test('a no_change after a long read-only walk is classified as budget exhaustion and yields a reading map for the next attempt', async () => {
  const limits = { ...DEFAULT_LIMITS, maxTurns: 60 };
  const walk = (n) => Array.from({ length: n }, (_, i) => ({ tool: i % 4 === 3 ? 'search' : 'read_file', args: i % 4 === 3 ? { query: `q${i}`, path: 'supabase' } : { path: 'supabase/functions/onspace-ai-chat/index.ts', start_line: i * 100, end_line: i * 100 + 99 } }));
  assert.equal(classifyNoChange({ reason: 'Could not complete and verify the coordinated chat changes within this session', turns: 60, transcript: walk(50), limits }), true);
  assert.equal(classifyNoChange({ reason: 'the codebase has no such module', turns: 40, transcript: walk(20), limits }), true, 'late finish after 20 explorations is budget, whatever the wording');
  assert.equal(classifyNoChange({ reason: 'the named script does not exist at this commit', turns: 5, transcript: walk(3), limits }), false, 'a quick honest answer stays an answer');
  assert.equal(classifyNoChange({ reason: 'requires a protected path (deploy/)', turns: 12, transcript: walk(9), limits }), false);
  assert.equal(classifyNoChange({ reason: 'ran out of turns before the first edit', turns: 12, transcript: walk(9), limits }), true, 'the model saying so is enough once it has explored');

  const map = readingMap([...walk(6), { tool: 'outline', args: { path: 'a.ts' } }, { tool: 'run', args: { command: 'git status' } }]);
  assert.deepEqual(map.files_outlined, ['a.ts']);
  assert.equal(map.files_read.length, 1);
  assert.equal(map.files_read[0].path, 'supabase/functions/onspace-ai-chat/index.ts');
  assert.deepEqual(map.files_read[0].ranges.slice(0, 2), ['0-99', '100-199']);
  assert.deepEqual(map.searches, ['q3 in supabase']);

  // End to end: the run reports budget_exhausted + resume_hints, and a seeded packet tells the next run what not to repeat.
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const job = { id: 'b0dgetb0dgetb0dgetb0dgetb0dget00', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, title: 'big seam', task_description: 'd' };
  const script = [
    ...Array.from({ length: 8 }, (_, i) => ({ tool: 'read_file', args: { path: 'lib/sum.js', start_line: 1, end_line: 1 + (i % 2) } })),
    { tool: 'finish', args: { summary: 'Explored but did not edit.', no_change_reason: 'Could not complete within the remaining budget.' } },
  ];
  const seen = [];
  let i = 0;
  const callModel = async ({ modelRequest }) => { seen.push(modelRequest.request.messages.at(-1).content); const t = script[Math.min(i, script.length - 1)]; i++; return { ok: true, data: { content: JSON.stringify(t), model: 'm', usage: {} } }; };
  const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'x', apiToken: 'y' }, job, step: { id: 's' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 12 } });
  assert.equal(result.ok, false);
  assert.equal(result.no_change, true);
  assert.equal(result.budget_exhausted, true);
  assert.equal(result.resume_hints.turns_used, 9);
  assert.equal(result.resume_hints.files_read[0].path, 'lib/sum.js');
  assert.match(result.resume_hints.conclusion, /Explored but did not edit/);
  assert.ok(seen.some((m) => /BUDGET: a third of your turns are used .* nothing is edited yet/.test(m)), 'the one-third nudge fires when nothing is edited');

  const packet = JSON.parse(taskPacket({ job, lane: 'backend', notes: [], previousAttempt: result.resume_hints }));
  assert.equal(packet.previous_attempt_ran_out_of_turns.files_read[0].path, 'lib/sum.js');
  assert.match(packet.previous_attempt_ran_out_of_turns.instruction, /Do not repeat that walk/);
  assert.match(packet.previous_attempt_ran_out_of_turns.instruction, /build to the precedent/);
  assert.match(packet.how_to_start, /Skip read_canon/);
  assert.match(composeRunNote({ job, lane: 'backend', outcome: { ok: false, no_change: true, budget_exhausted: true, error: 'x' }, transcript: [], turns: 9, provider: 'openai', model: 'm' }), /ran out of turns reading, no edits/);

  // Job 79b4c08f: "No changes made" went into summary without no_change_reason, the finish was refused on the last
  // turn and the run ended as a bare 'turn budget exhausted'. Summary-only no-change is a no-change answer.
  const summaryOnly = [
    ...Array.from({ length: 8 }, (_, i) => ({ tool: 'read_file', args: { path: 'lib/sum.js', start_line: 1, end_line: 1 + (i % 2) } })),
    { tool: 'finish', args: { summary: 'No changes made. The RPC accepts a job id only; exposing the tool without a verified claim would be unsafe.', tests: [], rollback_notes: [] } },
  ];
  let j = 0;
  const result2 = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'x', apiToken: 'y' }, job: { ...job, id: 'b0dgetb0dgetb0dgetb0dgetb0dget01' }, step: { id: 's' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel: async () => { const t = summaryOnly[Math.min(j, summaryOnly.length - 1)]; j++; return { ok: true, data: { content: JSON.stringify(t), model: 'm', usage: {} } }; }, limits: { ...DEFAULT_LIMITS, maxTurns: 12 } });
  assert.equal(result2.no_change, true, JSON.stringify(result2.error));
  assert.match(result2.error, /^No changes made/);
  assert.equal(result2.budget_exhausted, true, 'late, after eight reads: budget, with a map for the next run');
  assert.equal(result2.turns, 9, 'accepted on the turn it was given, not refused into the wall');

  // The loop runs dry with nothing edited (no finish at all): same classification, same map.
  let k = 0;
  const result3 = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'x', apiToken: 'y' }, job: { ...job, id: 'b0dgetb0dgetb0dgetb0dgetb0dget02' }, step: { id: 's' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel: async () => { k++; return { ok: true, data: { content: JSON.stringify({ tool: 'read_file', args: { path: 'lib/sum.js', start_line: 1, end_line: 1 + (k % 2) } }), model: 'm', usage: {} } }; }, limits: { ...DEFAULT_LIMITS, maxTurns: 10 } });
  assert.equal(result3.ok, false);
  assert.equal(result3.no_change, false);
  assert.equal(result3.error, 'turn budget exhausted');
  assert.equal(result3.budget_exhausted, true);
  assert.equal(result3.resume_hints.files_read[0].path, 'lib/sum.js');
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test('run chains allowlisted commands with && and stops at the first failure; a disallowed part is refused on its own', async () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const { createBranchWorkspace } = require('../builder-branch-workspace');
  const ws = createBranchWorkspace({ sourceDir: repo.source, workspaceRoot, jobId: 'c4a1c4a1c4a1c4a1c4a1c4a1', targetSha: repo.sha });
  const tools = createTools({ workspacePath: ws.workspacePath, repoRoot: repo.source, lane: 'backend', supabase: null, limits: DEFAULT_LIMITS, log() {} });
  const chained = await tools.run({ command: 'node --check lib/sum.js && git status --short' });
  assert.equal(chained.exit_code, 0, JSON.stringify(chained));
  assert.equal(chained.steps.length, 2);
  assert.equal(chained.stopped_at, undefined);
  const failing = await tools.run({ command: 'node --test test/sum.test.js && node --check lib/sum.js' });
  assert.equal(failing.steps.length, 1, 'the failing test (sum subtracts) stops the chain');
  assert.notEqual(failing.exit_code, 0);
  assert.equal(failing.stopped_at, 'node --test test/sum.test.js');
  const refused = await tools.run({ command: 'node --check lib/sum.js && rm -rf lib' });
  assert.equal(refused.steps.length, 2);
  assert.match(refused.error, /command not allowed/);
  assert.equal(refused.stopped_at, 'rm -rf lib');
  fs.rmSync(repo.root, { recursive: true, force: true });
});

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

test('finish is refused when a change touches tests but no test run passed this session; verified_runs carry first-hand evidence', async () => {
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
  await tools.run({ command: 'node --check lib/sum.js' });
  assert.match(buildProposal({ workspacePath: ws.workspacePath, lane: 'backend', tools, args }).error, /no `node --test …` run passed/);
  const run = await tools.run({ command: 'node --test test/sum.test.js' });
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
  // A lane-validator rejection is a tool result the model can act on, not an exception (live job 1021dbaa
  // crashed the whole run on 'destructive SQL is not allowed' and the step never counted the attempt).
  fs.writeFileSync(path.join(ws.workspacePath, 'lib', 'sum.js'), "'use strict';\n// cleanup: DROP TABLE totals\nmodule.exports = { sum: (a, b) => a + b };\n");
  const refused = buildProposal({ workspacePath: ws.workspacePath, lane: 'backend', tools, args: { summary: 'Fix sum to add instead of subtract; verified with the unit test.', tests: [] } });
  assert.match(refused.error, /finish refused by the backend lane validator: destructive SQL is not allowed/);
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

test('path policy classifies evidential work (owner ruling 2026-09-26: human approval required)', () => {
  const { isEvidentialPath, evidentialPathsIn, evidentialMentions } = require('../builder-path-policy');
  for (const file of ['supabase/functions/generate-parking-notice/index.ts', 'supabase/functions/capture-environmental-evidence/index.ts', 'supabase/functions/bob-perceive-video/index.ts', 'apps/web/src/pages/CCTVReviewPage.tsx', 'apps/web/src/pages/OfficerFieldReportPage.tsx', 'apps/mobile/src/anything.tsx', 'apps/sd-card-bridge-v2/src/import.ts', 'services/fcm-inference/app.py', 'supabase/migrations/20260926012000_cctv_photo_inference.sql', 'test/cctv-observations.test.py']) {
    assert.equal(isEvidentialPath(file), true, `${file} should be evidential`);
  }
  for (const file of ['services/fcm-api/src/bob/verify.js', 'scripts/bob-builder-e2e.mjs', 'test/fcm-api-bob-planner.test.js', 'supabase/functions/onspace-ai-chat/index.ts', 'supabase/functions/_shared/builder-model-adapter.js', 'builder-autopilot.js', 'apps/web/src/pages/RosteringPage.tsx', 'supabase/migrations/20260926150000_builder_model_run_providers.sql', 'docs/ATLAS_BUILD_REPORT.md']) {
    assert.equal(isEvidentialPath(file), false, `${file} should not be evidential`);
  }
  assert.deepEqual(evidentialPathsIn(['services/fcm-api/src/bob/verify.js', 'supabase/functions/generate-notice/index.ts', 'supabase/functions/generate-notice/index.ts']), ['supabase/functions/generate-notice/index.ts']);
  assert.deepEqual(evidentialMentions('Symptom: `supabase/functions/generate-parking-notice/index.ts` prints the wrong plate (see apps/web/src/pages/ParkingOversightPage.tsx). Unrelated: services/fcm-api/src/bob/plan.js.'), ['apps/web/src/pages/ParkingOversightPage.tsx', 'supabase/functions/generate-parking-notice/index.ts']);
  assert.deepEqual(evidentialMentions('Make Bob accept "go for it" in services/fcm-api/src/bob/verify.js'), []);
});

// Lesson from job 1021dbaa (2026-09-26): gpt-6-sol did 28 turns of good reading, then burned
// the remaining 12 on unified-diff hunks that would not apply, three attempts in a row.
test('replace_in_file edits by exact text, refuses ambiguity, hints at whitespace misses, and respects policy', () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const { createBranchWorkspace } = require('../builder-branch-workspace');
  const ws = createBranchWorkspace({ sourceDir: repo.source, workspaceRoot, jobId: 'd00dd00dd00dd00dd00dd00d', targetSha: repo.sha });
  const tools = createTools({ workspacePath: ws.workspacePath, repoRoot: repo.source, lane: 'backend', supabase: null, limits: DEFAULT_LIMITS, log() {} });
  const before = fs.readFileSync(path.join(ws.workspacePath, 'lib/sum.js'), 'utf8');
  assert.match(before, /a - b/);
  const ok = tools.replace_in_file({ path: 'lib/sum.js', old_text: 'a - b', new_text: 'a + b' });
  assert.equal(ok.replaced, 1);
  assert.match(fs.readFileSync(path.join(ws.workspacePath, 'lib/sum.js'), 'utf8'), /a \+ b/);
  assert.deepEqual(tools.__changedFiles(), ['lib/sum.js']);
  assert.match(tools.replace_in_file({ path: 'lib/sum.js', old_text: 'not here at all', new_text: 'x' }).error, /old_text not found/);
  assert.match(tools.replace_in_file({ path: 'lib/sum.js', old_text: 'a  +  b', new_text: 'x' }).error, /different whitespace/);
  fs.writeFileSync(path.join(ws.workspacePath, 'lib/sum.js'), 'const x = 1;\nconst x = 1;\n');
  assert.match(tools.replace_in_file({ path: 'lib/sum.js', old_text: 'const x = 1;', new_text: 'const y = 2;' }).error, /occurs 2 times/);
  assert.equal(tools.replace_in_file({ path: 'lib/sum.js', old_text: 'const x = 1;', new_text: 'const y = 2;', all: true }).replaced, 2);
  assert.match(tools.replace_in_file({ path: 'package.json', old_text: '{', new_text: '[' }).error, /refused/);
  assert.match(tools.replace_in_file({ path: 'lib/missing.js', old_text: 'a', new_text: 'b' }).error, /not found: lib\/missing\.js/);
});

test('the engineer paces its budget and gets one grace turn to finish when edits exist at the limit', async () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const job = { id: 'feedfacefeedfacefeedfacefeedface', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, title: 't', task_description: 'd' };
  const seen = [];
  const turns = [
    { tool: 'read_file', args: { path: 'lib/sum.js' } },
    { tool: 'replace_in_file', args: { path: 'lib/sum.js', old_text: 'a - b', new_text: 'a + b' } },
    { tool: 'run', args: { command: 'node --test test/sum.test.js' } },
    { tool: 'read_file', args: { path: 'lib/sum.js' } }, // dawdling: the budget runs out here
    { tool: 'finish', args: { summary: 'sum() used subtraction; changed to addition. Verified with node --test.', tests: ['node --test test/sum.test.js'], rollback_notes: ['Revert.'] } },
  ];
  let i = 0;
  const callModel = async ({ modelRequest }) => {
    seen.push(modelRequest.request.messages.at(-1).content);
    const t = turns[Math.min(i, turns.length - 1)]; i++;
    return { ok: true, data: { content: JSON.stringify(t), model: 'm', usage: {} } };
  };
  const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'x', apiToken: 'y' }, job, step: { id: 's' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 4 } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.turns, 4, 'the loop itself stopped at the budget');
  assert.match(result.proposal.summary, /changed to addition/);
  assert.ok(seen.some((m) => /BUDGET: .*left/.test(m)), 'a budget note was injected before the end');
  assert.ok(seen.at(-1).includes('FINAL TURN'), 'the grace turn asked for finish only');
});

test('a dropped gateway connection mid-run is retried on the same turn; three in a row end the run (live job 1021dbaa lost 41 turns to one)', async () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const job = { id: 'd0c0d0c0d0c0d0c0d0c0d0c0d0c0d0c0', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, title: 'sum subtracts', task_description: 'fix sum' };
  const step = { id: 'step-hiccup', builder_mode: 'backend_engineer' };
  const seen = [];
  const script = [
    { tool: 'write_file', args: { path: 'lib/sum.js', content: "'use strict';\nmodule.exports = { sum: (a, b) => a + b };\n" } },
    'drop', 'drop',
    { tool: 'run', args: { command: 'node --test test/sum.test.js' } },
    { tool: 'finish', args: { summary: 'sum() used subtraction; changed to addition; test passes.', tests: ['node --test test/sum.test.js'], rollback_notes: ['revert'] } },
  ];
  const callModel = async ({ modelRequest }) => {
    seen.push(modelRequest.idempotency_key);
    const next = script[Math.min(seen.length - 1, script.length - 1)];
    if (next === 'drop') return { ok: false, status: 502, error: 'model gateway unavailable (ECONNRESET)' };
    return { ok: true, status: 200, data: { content: JSON.stringify(next), model: 'gpt-5.4' } };
  };
  const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job, step, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 10 }, providerHealth: LAPTOP_OFF });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(seen.length, 5, 'two dropped calls, then the run carries on');
  assert.equal(seen[1], seen[2], 'a retried turn keeps the same turn number/idempotency key');
  assert.equal(seen[2], seen[3]);

  const seen2 = [];
  const result2 = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job: { ...job, id: 'd0c0d0c0d0c0d0c0d0c0d0c0d0c0d0c1' }, step, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel: async () => { seen2.push(1); return { ok: false, status: 502, error: 'model gateway unavailable' }; }, limits: { ...DEFAULT_LIMITS, maxTurns: 10 }, providerHealth: LAPTOP_OFF });
  assert.equal(result2.ok, false);
  assert.match(result2.error, /model unavailable/);
  assert.equal(seen2.length, 3, 'three consecutive failures on the last provider end the run, not thirty');
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test('every run leaves a factual note in bob_self_memory (builder_note) and the next run reads it', async () => {
  const note = composeRunNote({
    job: { id: 'abcdef1234567890', title: 'Fix sum' }, lane: 'backend', turns: 7, provider: 'openai', model: 'gpt-x',
    outcome: { ok: true, proposal: { changed_files: ['lib/sum.js', 'test/sum.test.js'] } },
    transcript: [
      { tool: 'apply_patch', args: {} }, { result: { error: 'patch does not apply' } },
      { tool: 'apply_patch', args: {} }, { result: { error: 'patch does not apply' } },
      { tool: 'replace_in_file', args: {} }, { result: { ok: true } },
      { finish_refused: 'finish refused: this change touches tests but no `node --test …` run passed' },
      { tool: 'run', args: {} }, { result: { ok: true } },
    ],
    lessons: ['apply_patch hunks drift after edits; use replace_in_file', '', 'x'.repeat(500)],
  });
  assert.match(note, /^\[job abcdef12 backend\] "Fix sum" -> proposal handed over\. 7 turns on openai\/gpt-x\./);
  assert.match(note, /Friction: apply_patch failed x2\./);
  assert.match(note, /Finish refused once: finish refused: this change touches tests/);
  assert.match(note, /Files: lib\/sum\.js, test\/sum\.test\.js\./);
  assert.match(note, /Lessons: apply_patch hunks drift after edits; use replace_in_file \| x{300}$/);
  assert.match(composeRunNote({ job: { id: 'a', title: 't' }, lane: 'backend', turns: 2, provider: 'openai', model: 'm', outcome: { ok: false, no_change: true, error: 'file does not exist' }, transcript: [], lessons: [] }), /-> no change: file does not exist\. 2 turns/);

  // Live shape: a chainable supabase stub; the run reads notes first and writes one at the end.
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const inserted = [];
  const rows = [{ memory_text: 'earlier lesson: tests live under test/', created_at: '2026-09-26T00:00:00Z' }];
  const table = { select() { return this; }, eq() { return this; }, order() { return this; }, async limit() { return { data: rows, error: null }; }, async insert(row) { inserted.push(row); return { error: null }; } };
  const other = { upsert() { return this; }, select() { return this; }, async single() { return { data: null, error: { message: 'stub' } }; } };
  const supabase = { from(name) { return name === 'bob_self_memory' ? table : other; }, rpc: async () => ({ data: null, error: null }) };
  let packet = null;
  const callModel = async ({ modelRequest }) => {
    packet = packet || modelRequest.request.messages[1].content;
    return { ok: true, status: 200, data: { content: JSON.stringify({ tool: 'finish', args: { summary: 'nothing to do here', no_change_reason: 'the named file does not exist in this repository', lessons: ['check the file exists before planning'] } }), model: 'gpt-5.4' } };
  };
  const result = await runAgenticEngineer({ supabase, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job: { id: 'n0te0000n0te0000n0te0000n0te0000', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, title: 'ghost file', task_description: 'fix scripts/ghost.mjs' }, step: { id: 'step-note', builder_mode: 'backend_engineer' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 5 }, providerHealth: LAPTOP_OFF });
  assert.equal(result.no_change, true);
  assert.match(packet, /earlier lesson: tests live under test\//, 'recent notes are in the task packet');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].memory_kind, 'builder_note');
  assert.match(inserted[0].memory_text, /\[job n0te0000 backend\] "ghost file" -> no change: the named file does not exist/);
  assert.match(inserted[0].memory_text, /Lessons: check the file exists before planning/);
  fs.rmSync(repo.root, { recursive: true, force: true });
});
