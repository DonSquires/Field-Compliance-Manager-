'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// The fixtures below use 7B local models to exercise routing; the author size gate has its own test.
process.env.BOB_BUILDER_AUTHOR_MIN_MODEL_B = '0';

const policy = require('../builder-path-policy');
const gateway = require('../builder-model-gateway');
const { runAgenticEngineer, parseToolCall, RUN_ALLOWLIST, buildProposal, createTools, composeRunNote, classifyNoChange, finishAgenticReceipt, heartbeatAgenticReceipt, outlineLines, readingMap, requiredChangedFilesFromTask, resolveStartingFiles, atlasMapForFiles, startAgenticReceipt, taskPacket, validateAcceptanceEvidence, DEFAULT_LIMITS } = require('../builder-agentic-engineer');

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
  assert.equal(config.maxOutputTokens, 8192);
  assert.ok(config.maxPromptChars >= 1_000_000);
  assert.ok(config.openai.models.has('gpt-5.4'));
  const base = { provider: 'openai', builder_mode: 'backend_engineer', prompt_version: 'v', idempotency_key: 'k' };
  assert.equal(gateway.validateModelRequest({ ...base, messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }] }, config), null);
  assert.equal(gateway.validateModelRequest({ ...base, messages: [{ role: 'tool', content: 'x' }] }, config), 'messages must be role/content pairs');
  assert.equal(gateway.validateModelRequest({ ...base, system_prompt: 'a', user_prompt: 'b', reasoning_effort: 'max' }, config), 'unsupported reasoning effort');
  const body = gateway.buildProviderBody({ input: { ...base, messages: [{ role: 'user', content: 'hi' }], output_schema: { type: 'object' } }, config, model: 'gpt-5.4' });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.max_completion_tokens, 8192);
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
  assert.equal(allowed('npm run lint --prefix apps/web'), true);
  assert.equal(allowed('npm run build --prefix apps/web'), true);
  assert.equal(allowed('npm run test --prefix apps/web -- src/components/BobPanel.test.tsx'), true);
  assert.equal(allowed('npm run test --prefix apps/web -- --pool=threads --maxWorkers=1 --reporter=dot'), true);
  assert.equal(allowed('npm run test --prefix apps/web -- src/x.test.tsx; curl bad.example'), false);
  assert.equal(allowed('git diff --stat'), true);
  assert.equal(allowed('rm -rf /'), false);
  assert.equal(allowed('node -e "process.exit(1)"'), false);
  assert.equal(allowed('npm install left-pad'), false);
  assert.equal(allowed('git push origin main'), false);
});

test('agentic author records a durable session and per-turn heartbeat before final provenance', async () => {
  const writes = [];
  const query = {
    select() { return this; },
    single: async () => ({ data: { id: 'run-session' }, error: null }),
    eq: async () => ({ data: null, error: null })
  };
  const supabase = {
    from(table) {
      assert.equal(table, 'builder_model_runs');
      return {
        upsert(value, options) { writes.push({ operation: 'upsert', value, options }); return query; },
        update(value) { writes.push({ operation: 'update', value }); return query; }
      };
    }
  };
  const request = {
    organization_id: 'org-1', job_id: 'job-1', step_id: 'step-1', provider: 'openai', model_name: 'gpt-5.4',
    prompt_version: 'agentic-engineer-v3', idempotency_key: 'author-key', input_artifact_ids: [], request: {}, chain: ['openai']
  };

  const receipt = await startAgenticReceipt(supabase, request, { provider: 'gpu_workstation', model: 'qwen3:8b' });
  await heartbeatAgenticReceipt(supabase, receipt, { provider: 'gpu_workstation', model: 'qwen3:8b', turn: 2, changedFileCount: 1 });
  await finishAgenticReceipt(supabase, receipt, { ok: true, turns: 3, usage: { output_tokens: 40 } });

  assert.equal(receipt, 'run-session');
  assert.equal(writes[0].value.status, 'running');
  assert.equal(writes[0].value.idempotency_key, 'author-key::agentic-session');
  assert.deepEqual(writes[1].value.usage_metadata, { phase: 'authoring', turn: 2, changed_file_count: 1 });
  assert.equal(writes[2].value.status, 'completed');
  assert.deepEqual(writes[2].value.usage_metadata, { output_tokens: 40, phase: 'authored', turns: 3 });
});

test('required source scope and admitted partial handoffs fail closed', () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const { createBranchWorkspace } = require('../builder-branch-workspace');
  const ws = createBranchWorkspace({ sourceDir: repo.source, workspaceRoot, jobId: 'accedeaccedeaccedeaccede', targetSha: repo.sha });
  const tools = createTools({ workspacePath: ws.workspacePath, repoRoot: repo.source, lane: 'frontend', supabase: null, limits: DEFAULT_LIMITS, log() {} });
  fs.writeFileSync(path.join(ws.workspacePath, 'apps/web/src/app.tsx'), 'export const a = 2;\n');
  const required = requiredChangedFilesFromTask('Required source scope: apps/web/src/app.tsx, apps/web/src/layout.css, and related tests.', 'frontend');
  assert.deepEqual(required, ['apps/web/src/app.tsx', 'apps/web/src/layout.css']);
  const partial = buildProposal({
    workspacePath: ws.workspacePath,
    lane: 'frontend',
    tools,
    requiredFiles: required,
    args: { summary: 'Implemented the first structural slice but did not complete the required layout.', tests: [], follow_ups: ['Complete layout.css'] }
  });

  test('approved delivery requirements require changed-file acceptance evidence', () => {
    const specification = {
      delivery_requirements: [
        { id: 'DR-1', outcome: 'Responsive workspace', evidence: 'Mobile check', source_scope: ['apps/web/src/layout.css'] },
        { id: 'DR-2', outcome: 'Visible receipts', evidence: 'Human check', source_scope: ['apps/web/src/app.tsx'] }
      ]
    };
    const files = ['apps/web/src/app.tsx', 'apps/web/src/layout.css'];
    assert.match(
      validateAcceptanceEvidence({ args: {}, specification, files }),
      /DR-1 has no completed acceptance evidence/
    );
    assert.match(
      validateAcceptanceEvidence({
        args: {
          acceptance_evidence: [
            { requirement_id: 'DR-1', status: 'completed', evidence: 'Implemented responsive rules' },
            { requirement_id: 'DR-2', status: 'completed', evidence: 'apps/web/src/app.tsx renders receipts' }
          ]
        },
        specification,
        files
      }),
      /DR-1 evidence does not name its changed source_scope file/
    );
    assert.equal(
      validateAcceptanceEvidence({
        args: {
          acceptance_evidence: [
            { requirement_id: 'DR-1', status: 'completed', evidence: 'apps/web/src/layout.css implements responsive rules' },
            { requirement_id: 'DR-2', status: 'completed', evidence: 'app.tsx renders verification receipts' }
          ]
        },
        specification,
        files
      }),
      null
    );
    assert.match(
      validateAcceptanceEvidence({
        args: {
          acceptance_evidence: [
            { requirement_id: 'DR-1', status: 'completed', evidence: 'apps/web/src/layout.css implements responsive rules' },
            { requirement_id: 'DR-2', status: 'completed', evidence: 'apps/web/src/app.tsx renders verification receipts' }
          ]
        },
        specification: {
          delivery_requirements: [
            ...specification.delivery_requirements.slice(0, 1),
            { ...specification.delivery_requirements[1], source_scope: ['apps/web/src/other.tsx'] }
          ]
        },
        files
      }),
      /DR-2 did not change any approved source_scope file/
    );
  });
  assert.match(partial.error, /summary admits the required implementation is incomplete/);
  const missing = buildProposal({
    workspacePath: ws.workspacePath,
    lane: 'frontend',
    tools,
    requiredFiles: required,
    args: { summary: 'Implemented the complete responsive workspace and verified the resulting diff.', tests: [] }
  });
  assert.match(missing.error, /required source scope was not implemented: apps\/web\/src\/layout\.css/);
  fs.writeFileSync(path.join(ws.workspacePath, 'apps/web/src/layout.css'), '.layout { display: grid; }\n');
  const complete = buildProposal({
    workspacePath: ws.workspacePath,
    lane: 'frontend',
    tools,
    requiredFiles: required,
    specification: {
      delivery_requirements: [
        { id: 'DR-1', outcome: 'Responsive workspace', evidence: 'Mobile check', source_scope: ['apps/web/src/layout.css'] },
        { id: 'DR-2', outcome: 'Updated application', evidence: 'Component check', source_scope: ['apps/web/src/app.tsx'] }
      ]
    },
    args: {
      summary: 'Implemented the complete responsive workspace and verified the resulting diff.',
      tests: [],
      acceptance_evidence: [
        { requirement_id: 'DR-1', status: 'completed', evidence: 'apps/web/src/layout.css provides the layout' },
        { requirement_id: 'DR-2', status: 'completed', evidence: 'apps/web/src/app.tsx provides the updated application' }
      ]
    }
  });
  assert.deepEqual(complete.proposal.acceptance_evidence, [
    { requirement_id: 'DR-1', status: 'completed', evidence: 'apps/web/src/layout.css provides the layout' },
    { requirement_id: 'DR-2', status: 'completed', evidence: 'apps/web/src/app.tsx provides the updated application' }
  ]);
  fs.rmSync(repo.root, { recursive: true, force: true });
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
const OPENAI_ONLY = Object.freeze({ openai: { configured: true, healthy: true, models: ['gpt-5.4', 'gpt-5.4-mini'] } });

test('authoring skips local models under the size gate and serves the provider\'s stronger installed model', async () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const job = { id: 'a17e5a17e5a17e5a17e5a17e5a17e5a1', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, title: 'sum subtracts', task_description: 'fix sum' };
  const health = {
    gpu_workstation: { configured: true, healthy: true, models: ['qwen2.5-coder:7b', 'qwen2.5-coder:14b'], installed: ['qwen2.5-coder:7b', 'qwen2.5-coder:14b'], ready_model: 'qwen2.5-coder:7b' },
    ollama: { configured: true, healthy: true, models: ['llama3.1:8b'], installed: ['llama3.1:8b'], ready_model: 'llama3.1:8b' },
    ollama_cloud: { configured: true, healthy: true, models: ['gpt-oss:120b'], installed: ['gpt-oss:120b'], ready_model: 'gpt-oss:120b' },
  };
  const seen = [];
  const script = [
    { tool: 'write_file', args: { path: 'lib/sum.js', content: "'use strict';\nmodule.exports = { sum: (a, b) => a + b };\n" } },
    { tool: 'run', args: { command: 'node --test test/sum.test.js' } },
    { tool: 'finish', args: { summary: 'sum() used subtraction; changed to addition; test passes.', tests: ['node --test test/sum.test.js'], rollback_notes: ['revert'] } },
  ];
  const callModel = async ({ modelRequest }) => {
    seen.push(`${modelRequest.provider}/${modelRequest.model_name}`);
    return { ok: true, status: 200, data: { content: JSON.stringify(script[Math.min(seen.length - 1, script.length - 1)]) } };
  };
  const previousRoute = process.env.BOB_BUILDER_ROUTE_AUTHOR;
  process.env.BOB_BUILDER_ROUTE_AUTHOR = 'gpu_workstation,ollama,ollama_cloud';
  try {
    const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job, step: { id: 's' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 10, minAuthorModelB: 14 }, providerHealth: health });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(seen[0], 'gpu_workstation/qwen2.5-coder:14b', 'the laptop authors with its 14B model, not the 7B ready model');
    assert.ok(!seen.some((entry) => entry.startsWith('ollama/')), 'a provider with only an 8B model is not an author');
  } finally {
    if (previousRoute === undefined) delete process.env.BOB_BUILDER_ROUTE_AUTHOR;
    else process.env.BOB_BUILDER_ROUTE_AUTHOR = previousRoute;
  }
});

test('a provider that runs out of turns mid-change hands off to the next provider with a fresh allocation', async () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const job = { id: 'f2e5f2e5f2e5f2e5f2e5f2e5f2e5f2e5', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, title: 'sum subtracts', task_description: 'fix sum' };
  const seen = [];
  const callModel = async ({ modelRequest }) => {
    seen.push({ provider: modelRequest.provider, messages: modelRequest.request.messages });
    if (modelRequest.provider === 'ollama') {
      // The weaker provider edits on its first turn, then keeps re-reading until its allocation ends.
      if (seen.length === 1) return { ok: true, status: 200, data: { content: JSON.stringify({ tool: 'write_file', args: { path: 'lib/sum.js', content: "'use strict';\nmodule.exports = { sum: (a, b) => a + b };\n" } }) } };
      return { ok: true, status: 200, data: { content: JSON.stringify({ tool: 'read_file', args: { path: 'lib/sum.js', start_line: seen.length } }) } };
    }
    const openaiTurn = seen.filter((entry) => entry.provider === 'openai').length;
    const script = [
      { tool: 'run', args: { command: 'node --test test/sum.test.js' } },
      { tool: 'finish', args: { summary: 'sum() used subtraction; changed to addition; test passes.', tests: ['node --test test/sum.test.js'], rollback_notes: ['revert'] } },
    ];
    return { ok: true, status: 200, data: { content: JSON.stringify(script[Math.min(openaiTurn - 1, script.length - 1)]) } };
  };
  const previousRoute = process.env.BOB_BUILDER_ROUTE_AUTHOR;
  process.env.BOB_BUILDER_ROUTE_AUTHOR = 'ollama,openai';
  try {
    const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job, step: { id: 's' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 6, minAuthorModelB: 0 }, providerHealth: LAPTOP_OFF });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(seen.filter((entry) => entry.provider === 'ollama').length, 6, 'the first provider used its full allocation');
    assert.equal(result.routing.provider, 'openai');
    assert.ok(result.turns > 6, 'the escalated provider got turns beyond the original limit');
    const handoff = seen.find((entry) => entry.provider === 'openai').messages.at(-1).content;
    assert.match(handoff, /ran out of turns mid-change/);
  } finally {
    if (previousRoute === undefined) delete process.env.BOB_BUILDER_ROUTE_AUTHOR;
    else process.env.BOB_BUILDER_ROUTE_AUTHOR = previousRoute;
  }
});

test('an operator can explicitly select GPU-first authoring and it escalates directly to OpenAI', async () => {
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
    const openaiTurn = seen.filter(s => s.provider !== 'gpu_workstation').length;
    const script = [
      { tool: 'write_file', args: { path: 'lib/sum.js', content: "'use strict';\nmodule.exports = { sum: (a, b) => a + b };\n" } },
      { tool: 'run', args: { command: 'node --test test/sum.test.js' } },
      { tool: 'finish', args: { summary: 'sum() used subtraction; changed to addition; test passes.', tests: ['node --test test/sum.test.js'], rollback_notes: ['revert'] } },
    ];
    return { ok: true, status: 200, data: { content: JSON.stringify(script[Math.min(openaiTurn - 1, script.length - 1)]), model: 'gpt-5.4' } };
  };
  const previousAuthorRoute = process.env.BOB_BUILDER_ROUTE_AUTHOR;
  process.env.BOB_BUILDER_ROUTE_AUTHOR = 'gpu_workstation,openai';
  let result;
  try {
    result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job, step, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 10 }, providerHealth: LAPTOP_ON });
  } finally {
    if (previousAuthorRoute === undefined) delete process.env.BOB_BUILDER_ROUTE_AUTHOR;
    else process.env.BOB_BUILDER_ROUTE_AUTHOR = previousAuthorRoute;
  }
  assert.equal(result.ok, true, JSON.stringify(result.error));
  // A window overflow compacts the transcript hard and retries the laptop once; the second overflow
  // escalates directly to the strong provider instead of waiting on the VPS CPU.
  assert.deepEqual(seen.slice(0, 4).map(s => s.provider), ['gpu_workstation', 'gpu_workstation', 'gpu_workstation', 'openai']);
  assert.equal(seen[0].model, 'qwen2.5-coder:7b');
  assert.equal(seen[0].effort, null, 'local models get no OpenAI reasoning params');
  assert.equal(seen[3].effort, 'high');
  assert.deepEqual(result.routing.chain, ['gpu_workstation', 'openai']);
  assert.equal(result.routing.provider, 'openai');
  assert.equal(result.routing.escalated, true);
  // Resuming past the failed local provider skips it entirely on the next attempt.
  const seen2 = [];
  process.env.BOB_BUILDER_ROUTE_AUTHOR = 'gpu_workstation,openai';
  let result2;
  try {
    result2 = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job: { ...job, id: 'e5ca1a7ee5ca1a7ee5ca1a7ee5ca1a7f' }, step, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel: async ({ modelRequest }) => { seen2.push(modelRequest.provider); return { ok: true, status: 200, data: { content: JSON.stringify({ tool: 'finish', args: { summary: 'x', no_change_reason: 'nothing to do here really' } }), model: 'gpt-5.4' } }; }, limits: { ...DEFAULT_LIMITS, maxTurns: 3 }, providerHealth: LAPTOP_ON, startAfterProvider: 'gpu_workstation' });
  } finally {
    if (previousAuthorRoute === undefined) delete process.env.BOB_BUILDER_ROUTE_AUTHOR;
    else process.env.BOB_BUILDER_ROUTE_AUTHOR = previousAuthorRoute;
  }
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
  // Every turn went to the gateway as a strong multi-turn request with the conversation attached.
  // Laptop off: authoring falls to the VPS CPU (owner ruling 2026-10-16: in-house before OpenAI).
  assert.ok(seen.every((request) => Array.isArray(request.request.messages) && request.provider === 'ollama' && request.request.reasoning_effort === undefined), 'OpenAI-only reasoning_effort is not sent to the in-house model');
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

test('a review revision starts from the previous attempt\'s patch applied in the worktree; an unappliable seed falls back to main and says so', async () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const job = { id: '5eed5eed5eed5eed5eed5eed5eed5eed', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, title: 'revise', task_description: 'fix the review findings', description: "Opened by Bob's autopilot from job p after independent review (round 1 of 2) [[seed_patch:v]]" };
  const seed = 'diff --git a/lib/sum.js b/lib/sum.js\n--- a/lib/sum.js\n+++ b/lib/sum.js\n@@ -1,2 +1,2 @@\n \'use strict\';\n-module.exports = { sum: (a, b) => a - b };\n+module.exports = { sum: (a, b) => a + b };\n';
  const packets = [];
  const script = [
    { tool: 'run', args: { command: 'node --test test/sum.test.js' } },
    { tool: 'finish', args: { summary: 'Kept the previous attempt\'s fix; tests pass.', tests: ['node --test test/sum.test.js'], rollback_notes: ['revert'] } },
  ];
  let i = 0;
  const callModel = async ({ modelRequest }) => { packets.push(modelRequest.request.messages[1].content); const t = script[Math.min(i, script.length - 1)]; i++; return { ok: true, data: { content: JSON.stringify(t), model: 'm', usage: {} } }; };
  const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'x', apiToken: 'y' }, job, step: { id: 's' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, seedPatch: { text: seed, from_job: 'p' }, limits: { ...DEFAULT_LIMITS, maxTurns: 6 } });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.proposal.changed_files, ['lib/sum.js'], 'the seed is part of the handed-over diff without the model editing anything');
  const packet = JSON.parse(packets[0]);
  assert.equal(packet.previous_attempt_applied.applied, true);
  assert.deepEqual(packet.previous_attempt_applied.files, ['lib/sum.js']);
  assert.match(packet.previous_attempt_applied.instruction, /ALREADY in your worktree/);
  assert.match(packet.how_to_start, /git_diff to see the previous attempt/);

  const bad = seed.replace("a - b", 'not in the file');
  let k = 0;
  const packets2 = [];
  const result2 = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'x', apiToken: 'y' }, job: { ...job, id: '5eed5eed5eed5eed5eed5eed5eed5ee2' }, step: { id: 's' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel: async ({ modelRequest }) => { packets2.push(modelRequest.request.messages[1].content); const t = [{ tool: 'finish', args: { summary: 'nothing', no_change_reason: 'seed missing' } }][0]; k++; return { ok: true, data: { content: JSON.stringify(t), model: 'm', usage: {} } }; }, seedPatch: { text: bad, from_job: 'p' }, limits: { ...DEFAULT_LIMITS, maxTurns: 4 } });
  assert.equal(result2.no_change, true);
  const packet2 = JSON.parse(packets2[0]);
  assert.equal(packet2.previous_attempt_applied.applied, false);
  assert.match(packet2.previous_attempt_applied.instruction, /start from main/);
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

test('compactMessages fits even oversized recent tool results under the active local prompt budget', () => {
  const { compactMessages } = require('../builder-agentic-engineer');
  const messages = [
    { role: 'system', content: 'system'.repeat(100) },
    { role: 'user', content: 'task'.repeat(1000) },
    { role: 'assistant', content: JSON.stringify({ thought: 'read source', tool: 'read_file', args: { path: 'src/large.ts' } }) },
    { role: 'user', content: JSON.stringify({ tool_result: { path: 'src/large.ts', content: 'A'.repeat(30000) } }) },
    { role: 'assistant', content: JSON.stringify({ thought: 'inspect usage', tool: 'search', args: { query: 'largeSource' } }) },
    { role: 'user', content: JSON.stringify({ tool_result: { matches: ['B'.repeat(30000)] } }) }
  ];
  const out = compactMessages(messages, { keepRecent: 1, maxChars: 12000 });
  assert.ok(out.reduce((total, message) => total + message.content.length, 0) <= 12000);
  assert.equal(out[0], messages[0]);
  assert.equal(out[1], messages[1]);
  assert.equal(out.at(-2), messages.at(-2), 'the latest model action is preserved');
  assert.match(out.at(-1).content, /compacted/);
  assert.match(out.at(-1).content, /src\/large\.ts|BBBB/);
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
  assert.match(tools.replace_in_file({ path: 'lib/sum.js', old_text: 'not here at all', new_text: 'x' }).error, /old_text not found[\s\S]*use search[\s\S]*read_file/);
  assert.match(tools.replace_in_file({ path: 'lib/sum.js', old_text: 'a  +  b', new_text: 'x' }).error, /different whitespace/);
  fs.writeFileSync(path.join(ws.workspacePath, 'lib/sum.js'), 'const x = 1;\nconst x = 1;\n');
  assert.match(tools.replace_in_file({ path: 'lib/sum.js', old_text: 'const x = 1;', new_text: 'const y = 2;' }).error, /occurs 2 times/);
  assert.equal(tools.replace_in_file({ path: 'lib/sum.js', old_text: 'const x = 1;', new_text: 'const y = 2;', all: true }).replaced, 2);
  assert.match(tools.replace_in_file({ path: 'package.json', old_text: '{', new_text: '[' }).error, /refused/);
  assert.match(tools.replace_in_file({ path: 'lib/missing.js', old_text: 'a', new_text: 'b' }).error, /not found: lib\/missing\.js/);
});

test('oversized file reads preserve real head and tail with an exact omitted range', () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const { createBranchWorkspace } = require('../builder-branch-workspace');
  const ws = createBranchWorkspace({ sourceDir: repo.source, workspaceRoot, jobId: 'feedfacefeedfacefeedfacefeedface', targetSha: repo.sha });
  const largePath = path.join(ws.workspacePath, 'lib', 'large.js');
  fs.writeFileSync(largePath, Array.from({ length: 240 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n'));
  const tools = createTools({
    workspacePath: ws.workspacePath,
    repoRoot: repo.source,
    lane: 'backend',
    supabase: null,
    limits: { ...DEFAULT_LIMITS, readCapChars: 1200 },
    log() {},
  });

  const result = tools.read_file({ path: 'lib/large.js' });
  assert.match(result.content, /^1: const line1 = 1;/);
  assert.match(result.content, /240: const line240 = 240;$/);
  assert.match(result.content, /\[OMITTED: lib\/large\.js lines \d+-\d+\./);
  assert.ok(result.omitted_range.start_line < result.omitted_range.end_line);
  fs.rmSync(repo.root, { recursive: true, force: true });
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
  const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'x', apiToken: 'y' }, job, step: { id: 's' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 4 }, providerHealth: OPENAI_ONLY });
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
  assert.equal(seen2.length, 6, 'with the GPU offline: three VPS CPU failures escalate to OpenAI, and three more there end the run');
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
  let lastModelRun = null;
  const modelRuns = {
    upsert(row) { lastModelRun = row; return this; },
    update() { return this; },
    select() { return this; },
    async single() {
      return lastModelRun?.idempotency_key?.endsWith('::agentic-session')
        ? { data: { id: 'session-note' }, error: null }
        : { data: null, error: { message: 'stub' } };
    },
    async eq() { return { data: null, error: null }; }
  };
  const other = { upsert() { return this; }, select() { return this; }, async single() { return { data: null, error: { message: 'stub' } }; } };
  const supabase = { from(name) { return name === 'bob_self_memory' ? table : name === 'builder_model_runs' ? modelRuns : other; }, rpc: async () => ({ data: null, error: null }) };
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

test('the opening packet is fitted to a local model window: the build map keeps what the task names and the whole packet stays under budget', () => {
  const { buildOpeningPacket, systemPrompt, DEFAULT_LIMITS } = require('../builder-agentic-engineer');
  const tracked = Array.from({ length: 2000 }, (_, i) => `apps/web/src/pages/Page${i}.tsx`).concat(['apps/web/src/components/BobPanel.tsx']);
  const rawRepositoryContext = {
    repository: 'r', ref: 'main', commit_sha: 'a'.repeat(40), architecture_summary: 'x'.repeat(12000), relevant_files: [], known_capabilities: [],
    build_map: { target_sha: 'a'.repeat(40), file_count: 2001, tracked_files: tracked, directory_counts: {}, packages: [], compose: [], supabase_edge_functions: [],
      schema: { available: true, tables: Array.from({ length: 1000 }, (_, i) => `table_${i}`).concat(['bob_conversations']), views: [], functions: [] }, recent_commits: [] }
  };
  const job = { id: 'j', title: 'Tappable options in BobPanel', task_description: 'Render metadata.options in apps/web/src/components/BobPanel.tsx; history is in bob_conversations.', target_sha: 'a'.repeat(40) };
  const liveContext = { big: 'y'.repeat(50_000) };
  const opening = buildOpeningPacket({ job, lane: 'frontend', specification: { product_brief: { problem: 'p' } }, uxPlan: null, rawRepositoryContext, liveContext, notes: [], previousFailure: null, hints: null, previousAttempt: null, seeded: null });
  assert.ok(opening.packet.length <= 28_000, `packet ${opening.packet.length} chars`);
  assert.equal(opening.repositoryContext.build_map.tracked_files[0], 'apps/web/src/components/BobPanel.tsx');
  assert.equal(opening.repositoryContext.build_map.schema.tables[0], 'bob_conversations');
  assert.ok(opening.liveContext.truncated_live_context, 'oversized live context is trimmed');
  // Reserve the real local output budget and tokenizer headroom instead of assuming
  // the entire context window is available for the opening prompt.
  const total = systemPrompt({ lane: 'frontend', limits: DEFAULT_LIMITS }).length + opening.packet.length;
  const promptBudgetChars = (24576 - 8192 - 512) * 3;
  assert.ok(total <= promptBudgetChars * 0.8, `system+packet ${total} chars`);
});

test('a rerun child works in its bound parent worktree even when the shared clone has moved on (live job f6df4b84)', async () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const { createBranchWorkspace } = require('../builder-branch-workspace');
  const parent = createBranchWorkspace({ sourceDir: repo.source, workspaceRoot, jobId: 'a7c916f5b98047f7ac47aaaa', targetSha: repo.sha });
  // Another job pinned the shared clone elsewhere.
  fs.writeFileSync(path.join(repo.source, 'later.txt'), 'later\n');
  repo.git(['add', '-A']);
  repo.git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'later']);
  const job = { id: 'f6df4b8403f14ad2adfb7d7fd9d32704', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, workspace_branch: parent.branchName, title: 't', task_description: 't' };
  const { callModel } = fakeModel([{ tool: 'finish', args: { summary: 'nothing', no_change_reason: 'nothing to change in this fixture' } }]);
  const result = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'http://gw', apiToken: 't' }, job, step: { id: 's' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel, limits: { ...DEFAULT_LIMITS, maxTurns: 3 }, providerHealth: LAPTOP_OFF });
  assert.doesNotMatch(String(result.error || ''), /does not match the target SHA/);
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'bob-job-f6df4b8403f14ad2adfb')), false, 'no second worktree named after the child');
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test('a model looping on one refused call escalates, or stops early with a reading map (live job 0c388688)', async () => {
  const repo = makeRepo();
  const workspaceRoot = path.join(repo.root, 'workspaces');
  const job = { id: '5tuck5tuck5tuck5tuck5tuck5tuck00', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, title: 'loop', task_description: 'd' };
  const loop = { tool: 'search', args: { query: 'saveGeofenceValue', path: 'lib' } };
  const gpuOnly = { gpu_workstation: LAPTOP_ON.gpu_workstation, ollama: { configured: false, healthy: false, models: [] }, openai: { configured: false, healthy: false, models: [] } };
  let calls = 0;
  const stopped = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'x', apiToken: 'y' }, job, step: { id: 's' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel: async () => { calls++; return { ok: true, data: { content: JSON.stringify(loop), model: 'm', usage: {} } }; }, limits: { ...DEFAULT_LIMITS, maxTurns: 60 }, providerHealth: gpuOnly });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.turns, 6, 'two real calls, then four refusals in a row');
  assert.equal(calls, 6);
  assert.equal(stopped.budget_exhausted, true, 'the coordinator treats it like a budget failure and escalates from the map');
  assert.match(stopped.error, /stuck: 4 identical search calls refused in a row/);
  assert.deepEqual(stopped.resume_hints.searches, ['saveGeofenceValue in lib']);

  const providers = [];
  const finish = { tool: 'finish', args: { summary: 'nothing to change', no_change_reason: 'the search shows nothing to change' } };
  const escalated = await runAgenticEngineer({ supabase: null, gateway: { gatewayUrl: 'x', apiToken: 'y' }, job: { ...job, id: '5tuck5tuck5tuck5tuck5tuck5tuck01' }, step: { id: 's' }, lane: 'backend', sourceDir: repo.source, workspaceRoot, repoRoot: repo.source, callModel: async ({ modelRequest }) => { providers.push(modelRequest.provider); return { ok: true, data: { content: JSON.stringify(modelRequest.provider === 'openai' ? finish : loop), model: 'm', usage: {} } }; }, limits: { ...DEFAULT_LIMITS, maxTurns: 60 }, providerHealth: { ...LAPTOP_ON, ollama: { configured: false, healthy: false, models: [] } } });
  assert.equal(escalated.routing.provider, 'openai');
  assert.equal(escalated.routing.escalated, true);
  assert.equal(providers.filter((p) => p !== 'openai').length, 6);
  assert.equal(escalated.turns, 7);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test('distinct unedited exploration hands off early enough for the next allowed model to edit and test', async () => {
  const repo = makeRepo();
  const providers = [];
  const paid = [
    { tool: 'read_file', args: { path: 'lib/sum.js' } },
    { tool: 'write_file', args: { path: 'lib/sum.js', content: "'use strict';\nmodule.exports = { sum: (a, b) => a + b };\n" } },
    { tool: 'run', args: { command: 'node --test test/sum.test.js' } },
    { tool: 'finish', args: { summary: 'Fixed addition and verified it.', tests: ['node --test test/sum.test.js'], rollback_notes: ['Revert the PR.'] } },
  ];
  let paidTurn = 0;
  try {
    const result = await runAgenticEngineer({
      supabase: null, gateway: {}, lane: 'backend', sourceDir: repo.source,
      workspaceRoot: path.join(repo.root, 'workspaces'), repoRoot: repo.source,
      job: { id: 'progress1234567890', organization_id: '00000000-0000-0000-0000-000000000001', target_sha: repo.sha, title: 'Fix addition', task_description: 'Fix lib/sum.js and verify test/sum.test.js.' },
      step: { id: 's' }, providerHealth: LAPTOP_OFF,
      limits: { ...DEFAULT_LIMITS, maxTurns: 40 },
      callModel: async ({ modelRequest }) => {
        providers.push(modelRequest.provider);
        const call = modelRequest.provider === 'openai' ? paid[paidTurn++]
          : { tool: 'search', args: { query: `distinct-investigation-${providers.length}`, path: 'lib' } };
        return { ok: true, data: { content: JSON.stringify(call), model: 'fixture', usage: {} } };
      },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(providers.filter(provider => provider === 'ollama').length, 13);
    assert.equal(paidTurn, 4, 'the next model can read, edit, test and finish within the original total budget');
    assert.deepEqual(result.proposal.changed_files, ['lib/sum.js']);
    assert.equal(result.proposal.verified_runs[0].exit_code, 0);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

function mapRepo() {
  const repo = makeRepo();
  const pages = path.join(repo.source, 'apps', 'web', 'src', 'pages');
  fs.mkdirSync(pages, { recursive: true });
  fs.writeFileSync(path.join(pages, 'OrganizationSetupPage.tsx'), 'export function OrganizationSetupPage() { return "council jurisdiction boundary map"; }\n');
  fs.writeFileSync(path.join(pages, 'RosterPage.tsx'), 'export const RosterPage = () => "roster";\n');
  repo.git(['add', '-A']);
  repo.git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'pages']);
  return repo;
}

function fakeAtlas(rowsFor, { hang = false } = {}) {
  const calls = [];
  return {
    calls,
    from() {
      const query = { filters: {} };
      const chain = {
        select() { return chain; },
        eq(column, value) { query.filters[column] = value; return chain; },
        in(column, values) { query.filters[column] = values; return chain; },
        ilike(column, value) { query.filters[column] = value; return chain; },
        limit() { calls.push(query.filters); return hang ? new Promise(() => {}) : Promise.resolve({ data: rowsFor(query.filters), error: null }); },
      };
      return chain;
    },
  };
}

test('starting map: invented scope paths are reported, real files are discovered from the task words', () => {
  const { source } = mapRepo();
  const job = { title: 'Org settings persistent map', task_description: 'The council boundary map must persist on the jurisdiction preview.' };
  const specification = { delivery_requirements: [{ id: 'r1', source_scope: ['apps/web/src/pages/ExamplePage.tsx'] }] };
  const map = resolveStartingFiles({ workspacePath: source, lane: 'frontend', hints: [], specification, job });
  assert.deepEqual(map.confirmed, []);
  assert.deepEqual(map.named_but_missing, ['apps/web/src/pages/ExamplePage.tsx']);
  assert.equal(map.discovered[0].file, 'apps/web/src/pages/OrganizationSetupPage.tsx');
  assert.ok(!map.discovered.some((entry) => entry.file === 'apps/web/src/pages/RosterPage.tsx'));
});

test('starting map: Atlas flow edges map found files to data and suggest files that touch task entities', async () => {
  const { source } = mapRepo();
  const startingFiles = { confirmed: ['apps/web/src/app.tsx'], discovered: [], named_but_missing: [], search_terms: ['jurisdiction'] };
  const supabase = fakeAtlas((filters) => filters.source_file
    ? [{ source_file: 'apps/web/src/app.tsx', source_type: 'component', source_name: 'App', target_type: 'table', target_name: 'organizations', edge_kind: 'reads' }]
    : [
      { source_file: 'apps/web/src/pages/OrganizationSetupPage.tsx', source_type: 'component', source_name: 'OrganizationSetupPage', target_type: 'edge_function', target_name: 'bob-jurisdiction-preview', edge_kind: 'invokes' },
      { source_file: 'apps/web/src/pages/Missing.tsx', source_type: 'component', source_name: 'Gone', target_type: 'rpc', target_name: 'jurisdiction_x', edge_kind: 'calls' },
      { source_file: 'supabase/functions/x/index.ts', source_type: 'edge_function', source_name: 'x', target_type: 'table', target_name: 'jurisdiction', edge_kind: 'writes' },
    ]);
  const atlas = await atlasMapForFiles({ supabase, workspacePath: source, lane: 'frontend', startingFiles });
  assert.equal(atlas.available, true);
  assert.deepEqual(atlas.suggested_files, ['apps/web/src/pages/OrganizationSetupPage.tsx']);
  assert.deepEqual(atlas.flow_edges_by_file['apps/web/src/app.tsx'], ['App reads table:organizations']);
  assert.ok(supabase.calls.every((filters) => Array.isArray(filters.edge_kind) && !filters.edge_kind.includes('references')));
});

test('starting map: an unavailable Atlas degrades to a stated reason instead of stalling the run', async () => {
  const { source } = mapRepo();
  process.env.BOB_BUILDER_ATLAS_TIMEOUT_MS = '50';
  const startingFiles = { confirmed: ['apps/web/src/app.tsx'], discovered: [], named_but_missing: [], search_terms: [] };
  const timed = await atlasMapForFiles({ supabase: fakeAtlas(() => [], { hang: true }), workspacePath: source, lane: 'frontend', startingFiles });
  assert.equal(timed.available, false);
  assert.match(timed.reason, /did not answer|Atlas/);
  assert.deepEqual(await atlasMapForFiles({ supabase: null, workspacePath: source, lane: 'frontend', startingFiles }), { available: false, reason: 'no Atlas client in this run' });
});

test('finish gate: a scope of only invented paths needs evidence naming the real changed file', () => {
  const specification = { delivery_requirements: [{ id: 'r1', source_scope: ['apps/web/src/pages/ExamplePage.tsx'] }] };
  const files = ['apps/web/src/pages/OrganizationSetupPage.tsx'];
  const trackedAtPin = new Set();
  const vague = validateAcceptanceEvidence({ args: { acceptance_evidence: [{ requirement_id: 'r1', status: 'completed', evidence: 'map persists' }] }, specification, files, trackedAtPin });
  assert.match(vague, /named no real source file/);
  assert.equal(validateAcceptanceEvidence({ args: { acceptance_evidence: [{ requirement_id: 'r1', status: 'completed', evidence: 'OrganizationSetupPage.tsx keeps one map instance' }] }, specification, files, trackedAtPin }), null);
  const realScope = { delivery_requirements: [{ id: 'r1', source_scope: ['apps/web/src/pages/RosterPage.tsx'] }] };
  assert.match(validateAcceptanceEvidence({ args: { acceptance_evidence: [{ requirement_id: 'r1', status: 'completed', evidence: 'OrganizationSetupPage.tsx' }] }, specification: realScope, files, trackedAtPin: new Set(['apps/web/src/pages/RosterPage.tsx']) }), /did not change any approved source_scope/);
});
