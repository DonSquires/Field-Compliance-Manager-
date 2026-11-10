const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createModelRouter,
  rankCandidates,
  resolvePolicy,
  taskClassFor,
  catalogEntry,
} = require('../services/fcm-api/src/bob/modelRouter');
const { buildModelRunRequest, routedCandidates } = require('../supabase/functions/_shared/builder-model-adapter.js');
const { createModelGateway } = require('../services/fcm-api/src/bob/modelGateway');
const { rankVibeCandidates } = require('../builder-vibe-session.js');

const catalog = [
  { provider: 'gpu_workstation', model_name: '*', privacy_class: 'local', cost_tier: 0, base_quality: 0.55, task_quality: { author: 0.5 }, active: true },
  { provider: 'ollama', model_name: '*', privacy_class: 'local', cost_tier: 0, base_quality: 0.3, task_quality: {}, active: true },
  { provider: 'ollama_cloud', model_name: '*', privacy_class: 'external', cost_tier: 1, base_quality: 0.65, task_quality: {}, active: true },
  { provider: 'ollama_cloud', model_name: 'gpt-oss:120b', privacy_class: 'external', cost_tier: 1, base_quality: 0.7, task_quality: { author: 0.72 }, active: true },
  { provider: 'openai', model_name: '*', privacy_class: 'external', cost_tier: 2, base_quality: 0.72, task_quality: {}, active: true },
  { provider: 'anthropic', model_name: '*', privacy_class: 'external', cost_tier: 3, base_quality: 0.85, task_quality: { security: 0.95 }, active: true },
];
const taskClasses = [
  { match_kind: 'workload_kind', match_value: 'backend_implementation', task_class: 'author' },
  { match_kind: 'workload_kind', match_value: 'security_review', task_class: 'security' },
  { match_kind: 'prompt_family', match_value: 'agentic-engineer', task_class: 'author' },
  { match_kind: 'role', match_value: 'verifier', task_class: 'review' },
];
const platform = { id: 'p-all', organization_id: null, surface: '*', task_class: '*', weights: { quality: 0.3, success: 0.4, cost: 0.2, latency: 0.1 }, active: true };

test('task class comes from workload kind, then prompt family, then role', () => {
  assert.equal(taskClassFor(taskClasses, { workloadKind: 'security_review', promptVersion: 'agentic-engineer-v21' }), 'security');
  assert.equal(taskClassFor(taskClasses, { workloadKind: 'unknown', promptVersion: 'agentic-engineer-v21' }), 'author');
  assert.equal(taskClassFor(taskClasses, { role: 'verifier' }), 'review');
  assert.equal(taskClassFor(taskClasses, { promptVersion: 'something-v3' }), 'general');
});

test('the most specific active policy wins and org rows only apply to their org', () => {
  const policies = [
    platform,
    { id: 'p-builder', organization_id: null, surface: 'builder', task_class: '*', active: true },
    { id: 'p-builder-author', organization_id: null, surface: 'builder', task_class: 'author', active: true },
    { id: 'p-org', organization_id: 'org-a', surface: '*', task_class: '*', active: true },
    { id: 'p-off', organization_id: null, surface: 'builder', task_class: 'security', active: false },
  ];
  assert.equal(resolvePolicy(policies, { surface: 'builder', taskClass: 'author' }).id, 'p-builder-author');
  assert.equal(resolvePolicy(policies, { surface: 'builder', taskClass: 'security' }).id, 'p-builder');
  assert.equal(resolvePolicy(policies, { surface: 'vibe', taskClass: 'author' }).id, 'p-all');
  assert.equal(resolvePolicy(policies, { surface: 'builder', taskClass: 'author', organizationId: 'org-a' }).id, 'p-org');
});

test('an uncatalogued provider fails closed on privacy', () => {
  assert.equal(catalogEntry(catalog, 'someone_new', null).privacy_class, 'external');
  assert.equal(catalogEntry(catalog, 'vps_ollama', null).privacy_class, 'local');
  assert.equal(catalogEntry(catalog, 'ollama_cloud', 'gpt-oss:120b').task_quality.author, 0.72);
});

test('observed success outranks a reputation prior, but a few runs do not', () => {
  const candidates = [{ provider: 'gpu_workstation', model: 'qwen' }, { provider: 'openai', model: 'gpt-5.4-mini' }];
  const strongGpu = [{ provider: 'gpu_workstation', model_name: 'qwen', task_class: 'author', runs: 200, completed: 190, avg_seconds: 40 }];
  const weakGpu = [{ provider: 'gpu_workstation', model_name: 'qwen', task_class: 'author', runs: 200, completed: 20, avg_seconds: 40 }];
  const base = { candidates, catalog, policies: [platform], taskClasses, surface: 'builder', workloadKind: 'backend_implementation' };
  assert.equal(rankCandidates({ ...base, stats: strongGpu }).ordered[0].provider, 'gpu_workstation');
  assert.equal(rankCandidates({ ...base, stats: weakGpu }).ordered[0].provider, 'openai');
  const oneFailure = [{ provider: 'gpu_workstation', model_name: 'qwen', task_class: 'author', runs: 1, completed: 0 }];
  const ranked = rankCandidates({ ...base, stats: oneFailure }).ordered.find(entry => entry.provider === 'gpu_workstation');
  assert.ok(ranked.success > 0.3, 'one failure is smoothed toward the prior, not written off');
});

test('security work favours the strongest reviewer under a quality-weighted policy', () => {
  const policies = [platform, { id: 'sec', organization_id: null, surface: 'builder', task_class: 'security', weights: { quality: 0.45, success: 0.35, cost: 0.1, latency: 0.1 }, active: true }];
  const result = rankCandidates({
    candidates: [{ provider: 'gpu_workstation', model: 'qwen' }, { provider: 'openai', model: 'gpt-5.4-mini' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' }],
    catalog, policies, taskClasses, surface: 'builder', workloadKind: 'security_review',
  });
  assert.equal(result.task_class, 'security');
  assert.equal(result.policy.id, 'sec');
  assert.equal(result.ordered[0].provider, 'anthropic');
});

test('restricted data, exclusions, cost ceilings and inactive rows remove candidates with a reason', () => {
  const candidates = [{ provider: 'gpu_workstation', model: 'qwen' }, { provider: 'ollama', model: 'llama' }, { provider: 'ollama_cloud', model: 'gpt-oss:120b' }, { provider: 'anthropic', model: 'x' }];
  const restricted = rankCandidates({ candidates, catalog, policies: [platform], taskClasses, surface: 'builder', restricted: true });
  assert.deepEqual(restricted.ordered.map(entry => entry.provider).sort(), ['gpu_workstation', 'ollama']);
  assert.ok(restricted.excluded.every(entry => entry.reason === 'restricted_data_local_only'));

  const policy = { ...platform, excluded_providers: ['ollama'], max_cost_tier: 2 };
  const limited = rankCandidates({ candidates, catalog: catalog.map(row => row.provider === 'gpu_workstation' ? { ...row, active: false } : row), policies: [policy], taskClasses, surface: 'in_app' });
  assert.deepEqual(limited.ordered.map(entry => entry.provider), ['ollama_cloud']);
  assert.deepEqual(Object.fromEntries(limited.excluded.map(entry => [entry.provider, entry.reason])), { gpu_workstation: 'catalog_inactive', ollama: 'policy_excluded', anthropic: 'policy_cost_ceiling' });

  const localOnly = rankCandidates({ candidates, catalog, policies: [{ ...platform, allow_external: false }], taskClasses, surface: 'vibe' });
  assert.ok(localOnly.ordered.every(entry => entry.privacy_class === 'local'));
  assert.equal(rankCandidates({ candidates, catalog, policies: [{ ...platform, max_candidates: 1 }], taskClasses, surface: 'vibe' }).ordered.length, 1);
});

function fakeSupabase({ rows = {}, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      return { select: async () => (fail ? { data: null, error: { message: 'down' } } : { data: rows[table] || [], error: null }) };
    },
    rpc: async (name, args) => { calls.push(`${name}:${JSON.stringify(args)}`); return { data: rows[name] || [], error: null }; },
  };
}

test('the router loads its tables once per cache window and falls back to null without data', async () => {
  let clock = 0;
  const supabase = fakeSupabase({ rows: { bob_model_catalog: catalog, bob_model_routing_policies: [platform], bob_model_task_classes: taskClasses, bob_model_route_stats: [] } });
  const router = createModelRouter({ supabase, now: () => clock, logger: { warn() {} } });
  const first = await router.rank({ candidates: [{ provider: 'gpu_workstation', model: 'q' }], surface: 'builder' });
  await router.rank({ candidates: [{ provider: 'gpu_workstation', model: 'q' }], surface: 'builder' });
  assert.equal(first.ordered.length, 1);
  assert.equal(supabase.calls.filter(call => call === 'bob_model_catalog').length, 1);
  assert.ok(supabase.calls.includes('bob_model_route_stats:{"p_days":30}'));
  clock = 61_000;
  await router.rank({ candidates: [], surface: 'builder' });
  assert.equal(supabase.calls.filter(call => call === 'bob_model_catalog').length, 2);
  assert.deepEqual((await router.catalogProviders()).sort(), ['anthropic', 'gpu_workstation', 'ollama', 'ollama_cloud', 'openai']);

  assert.equal(await createModelRouter({ supabase: fakeSupabase({ fail: true }), logger: { warn() {} } }).rank({ candidates: [] }), null);
  assert.equal(await createModelRouter({ supabase: null }).rank({ candidates: [] }), null);
});

test('live outcomes observed in-process move a failing model down before the next stats refresh', async () => {
  const supabase = fakeSupabase({ rows: { bob_model_catalog: catalog, bob_model_routing_policies: [platform], bob_model_task_classes: taskClasses } });
  const router = createModelRouter({ supabase, logger: { warn() {} } });
  const request = { candidates: [{ provider: 'gpu_workstation', model: 'q' }, { provider: 'ollama_cloud', model: 'gpt-oss:120b' }], surface: 'builder', workloadKind: 'backend_implementation' };
  const before = await router.rank(request);
  for (let i = 0; i < 20; i += 1) router.observe({ provider: before.ordered[0].provider, model: before.ordered[0].model, taskClass: 'author', ok: false, latencyMs: 1000 });
  const after = await router.rank(request);
  assert.notEqual(after.ordered[0].provider, before.ordered[0].provider);
});

function builderRequest(overrides = {}) {
  return buildModelRunRequest({
    organizationId: 'org-1', jobId: 'job-1', stepId: 'step-1', builderMode: 'backend_engineer',
    workloadKind: 'backend_implementation', promptVersion: 'agentic-engineer-v21',
    systemPrompt: 'system', userPrompt: 'user', ...overrides,
  });
}

const healthy = {
  gpu_workstation: { configured: true, healthy: true, models: ['qwen2.5-coder:7b'], ready_model: 'qwen2.5-coder:7b' },
  ollama: { configured: true, healthy: true, models: ['llama3.1:8b'], ready_model: 'llama3.1:8b' },
  ollama_cloud: { configured: true, healthy: true, models: ['kimi-k2.7-code', 'gpt-oss:120b'], ready_model: 'kimi-k2.7-code' },
  anthropic: { configured: true, healthy: true, models: ['claude-sonnet-5-5'], ready_model: 'claude-sonnet-5-5' },
  openai: { configured: true, healthy: true, models: ['gpt-5.4-mini'], ready_model: 'gpt-5.4-mini' },
};

function fakeRouter(order) {
  const seen = [];
  return {
    seen,
    async catalogProviders() { return ['gpu_workstation', 'ollama', 'ollama_cloud', 'anthropic', 'openai']; },
    async rank(request) {
      seen.push(request);
      const ordered = order(request.candidates).map(candidate => ({ ...candidate, score: 1, success: 0.5, runs: 0, cost_tier: 0 }));
      return { ordered, excluded: [], task_class: 'author', policy: { id: 'p' } };
    },
    observe() {},
  };
}

test('builder candidates are ranked across every healthy installed model when no stage is pinned', async () => {
  const router = fakeRouter(candidates => [...candidates].reverse());
  const request = builderRequest();
  assert.equal(request.routing_pinned, false);
  const { candidates, routing } = await routedCandidates(request, { health: healthy, router });
  assert.equal(routing.mode, 'auto');
  assert.equal(routing.task_class, 'author');
  assert.ok(router.seen[0].candidates.some(entry => entry.provider === 'ollama_cloud' && entry.model === 'gpt-oss:120b'), 'installed sibling models join the pool');
  assert.equal(router.seen[0].workloadKind, 'backend_implementation');
  assert.deepEqual(candidates[0], router.seen[0].candidates.at(-1));

  const after = await routedCandidates(request, { health: healthy, router, startAfter: 'ollama_cloud' });
  assert.ok(!after.candidates.some(entry => entry.provider === 'ollama_cloud'));
});

test('restricted data never reaches an external model even when the router ranks one first', async () => {
  const router = {
    async catalogProviders() { return ['anthropic', 'openai', 'gpu_workstation', 'ollama']; },
    async rank(request) {
      return { ordered: [{ provider: 'anthropic', model: 'x' }, ...request.candidates], excluded: [], task_class: 'author', policy: null };
    },
  };
  const { candidates, routing } = await routedCandidates(builderRequest({ containsRestrictedData: true }), { health: healthy, router });
  assert.equal(routing.mode, 'auto');
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every(entry => ['gpu_workstation', 'ollama'].includes(entry.provider)));
});

test('an env-pinned stage, a missing router or unavailable data keeps the static chain', async () => {
  const pinned = { ...builderRequest(), routing_pinned: true };
  const router = fakeRouter(candidates => [...candidates].reverse());
  assert.equal((await routedCandidates(pinned, { health: healthy, router })).routing.reason, 'env_pinned');
  assert.equal(router.seen.length, 0);
  assert.equal((await routedCandidates(builderRequest(), { health: healthy, router: null })).routing.reason, 'no_router');
  const empty = { async catalogProviders() { return []; }, async rank() { return null; } };
  const fallback = await routedCandidates(builderRequest(), { health: healthy, router: empty });
  assert.equal(fallback.routing.reason, 'routing_data_unavailable');
  assert.equal(fallback.candidates[0].provider, 'gpu_workstation');
  const broken = { async catalogProviders() { throw new Error('boom'); }, async rank() { return null; } };
  assert.match((await routedCandidates(builderRequest(), { health: healthy, router: broken })).routing.reason, /^router_error: boom/);
});

test('vibe ranking only reorders candidates the owner already permitted', async () => {
  const permitted = [{ provider: 'gpu_workstation', model: 'qwen' }, { provider: 'ollama_cloud', model: 'gpt-oss:120b' }];
  const router = { async rank() { return { ordered: [{ provider: 'anthropic', model: 'x' }, { provider: 'ollama_cloud', model: 'gpt-oss:120b' }, { provider: 'gpu_workstation', model: 'qwen' }], excluded: [], task_class: 'author', policy: null }; } };
  const result = await rankVibeCandidates({ prompt_version: 'vibe-v22' }, permitted, { router });
  assert.deepEqual(result.candidates, [{ provider: 'ollama_cloud', model: 'gpt-oss:120b' }, { provider: 'gpu_workstation', model: 'qwen' }]);
  assert.equal(result.routing.mode, 'auto');
  assert.deepEqual((await rankVibeCandidates({}, permitted, { router: null })).candidates, permitted);
});

test('in-app Bob ranks every configured provider per role unless the role chain is pinned', async () => {
  const env = {
    OPENAI_API_KEY: 'test-key', ANTHROPIC_API_KEY: 'test-key', GPU_WORKSTATION_URL: 'http://gpu', GPU_WORKSTATION_MODEL: 'qwen',
    BOB_ROUTE_VERIFIER: 'openai',
  };
  const seen = [];
  const router = {
    async rank(request) {
      seen.push(request);
      return { ordered: request.candidates.filter(entry => entry.provider === 'anthropic').concat(request.candidates.filter(entry => entry.provider !== 'anthropic')), excluded: [], task_class: 'planning', policy: null };
    },
    observe() {},
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }) };
  };
  const gateway = createModelGateway({ env, fetchImpl, router, logger: { warn() {} } });
  const planned = await gateway.chatJson('planner', [{ role: 'user', content: 'hi' }]);
  assert.equal(planned.provider, 'anthropic');
  assert.equal(seen[0].surface, 'in_app');
  assert.equal(seen[0].role, 'planner');
  assert.deepEqual(gateway.chainAfter('planner', 'anthropic'), ['gpu_workstation', 'openai']);

  const verified = await gateway.chatJson('verifier', [{ role: 'user', content: 'hi' }]);
  assert.equal(verified.provider, 'openai', 'a pinned role keeps its env chain');
  assert.equal(seen.length, 1);
  const status = await gateway.status();
  assert.equal(status.auto_routing.enabled, true);
  assert.deepEqual(status.auto_routing.pinned_roles, ['verifier']);
});

test('the routing migration keeps the tables service-only and seeds every surface', () => {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const file = fs.readdirSync(dir).find(name => name.endsWith('_bob_model_auto_routing.sql'));
  assert.ok(file, 'migration present');
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  for (const table of ['bob_model_catalog', 'bob_model_task_classes', 'bob_model_routing_policies']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(sql, new RegExp(`create policy ${table}_service_role on public\\.${table}\\s+to service_role`));
  }
  assert.match(sql, /revoke all on public\.bob_model_catalog, public\.bob_model_task_classes, public\.bob_model_routing_policies from public, anon, authenticated/);
  assert.match(sql, /revoke all on function public\.bob_model_route_stats\(integer\) from public, anon, authenticated/);
  assert.match(sql, /security definer\s+set search_path = public/);
  for (const surface of ["'\\*', '\\*'", "'builder', 'author'", "'in_app', '\\*'"]) assert.match(sql, new RegExp(`\\(null, ${surface}`));
});
