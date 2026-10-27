const assert = require('node:assert/strict');
const test = require('node:test');
const { createProductionHumanTestMonitor, evictableProductionStates, liveDeploymentPreflight, resolveVercelProductionDeployment, classifyRun, worstPreflight } = require('../builder-production-human-test');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function harness({ production = { status: 'ready', sha: SHA_A }, releasedSha = SHA_A, idle = { idle: true }, startRun, maxAttempts } = {}) {
  const states = new Map();
  const runs = new Map();
  const logs = [];
  const starts = [];
  let clock = Date.parse('2026-10-27T00:00:00Z');
  const context = { production, releasedSha, idle, states, runs, logs, starts };
  const monitor = createProductionHumanTestMonitor({
    resolveProduction: async () => context.production,
    readReleasedSha: async () => context.releasedSha,
    readState: async (sha) => states.get(sha) ?? null,
    writeState: async (state) => { states.set(state.sha, state); },
    listStates: async () => [...states.values()],
    startRun: startRun || (async ({ sha }) => {
      const run = { id: `run-${starts.length + 1}`, status: 'running', sha };
      runs.set(run.id, run);
      starts.push(sha);
      return { existing: false, run };
    }),
    getRun: async (id) => runs.get(id) ?? null,
    isIdle: async () => context.idle,
    now: () => clock,
    log: (entry) => logs.push(entry),
    ...(maxAttempts ? { maxAttempts } : {}),
  });
  context.advance = (ms) => { clock += ms; };
  context.finish = (id, fields) => Object.assign(runs.get(id), fields);
  return { monitor, context };
}

test('the Vercel resolver settles on the deployment the production alias serves', async () => {
  const calls = [];
  const routed = (routes) => async (url, options) => {
    calls.push({ url, options });
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    const [status, body] = key ? routes[key] : [404, {}];
    return { ok: status === 200, status, json: async () => body };
  };
  const LIST = 'https://api.vercel.com/v6/deployments';
  const ALIAS = 'https://api.vercel.com/v13/deployments/www.example.test';
  const base = { token: 'secret-token', projectId: 'prj', targetUrl: 'https://www.example.test' };
  assert.deepEqual(await resolveVercelProductionDeployment({ token: '', projectId: 'p', targetUrl: base.targetUrl }), { status: 'unconfigured' });
  assert.deepEqual(await resolveVercelProductionDeployment({ token: 't', projectId: 'p' }), { status: 'unconfigured' });

  const ready = await resolveVercelProductionDeployment({
    ...base, teamId: 'team',
    fetchImpl: routed({
      [LIST]: [200, { deployments: [{ state: 'READY', meta: { githubCommitSha: SHA_A } }] }],
      [ALIAS]: [200, { projectId: 'prj', uid: 'dpl_1', readyState: 'READY', ready: 1_800_000_000_000, meta: { githubCommitSha: SHA_A.toUpperCase(), githubCommitRef: 'main' } }],
    }),
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.sha, SHA_A);
  assert.equal(ready.deployment_id, 'dpl_1');
  assert.match(calls[0].url, /projectId=prj/);
  assert.match(calls[0].url, /target=production/);
  assert.match(calls[0].url, /teamId=team/);
  assert.match(calls[1].url, /^https:\/\/api\.vercel\.com\/v13\/deployments\/www\.example\.test\?teamId=team$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');

  // A failed newest deployment never moved the alias: production still serves the older READY one.
  const afterFailure = await resolveVercelProductionDeployment({
    ...base,
    fetchImpl: routed({
      [LIST]: [200, { deployments: [{ state: 'ERROR', meta: { githubCommitSha: SHA_B } }, { state: 'READY', meta: { githubCommitSha: SHA_A } }] }],
      [ALIAS]: [200, { projectId: 'prj', readyState: 'READY', meta: { githubCommitSha: SHA_A } }],
    }),
  });
  assert.equal(afterFailure.status, 'ready');
  assert.equal(afterFailure.sha, SHA_A);

  const building = await resolveVercelProductionDeployment({
    ...base,
    fetchImpl: routed({ [LIST]: [200, { deployments: [{ readyState: 'BUILDING', meta: { githubCommitSha: SHA_B } }, { state: 'READY', meta: { githubCommitSha: SHA_A } }] }] }),
  });
  assert.deepEqual(building, { status: 'settling', state: 'BUILDING', sha: SHA_B });

  const ok = [200, { deployments: [] }];
  for (const routes of [
    { [LIST]: [403, {}] },
    { [LIST]: ok, [ALIAS]: [404, {}] },
    { [LIST]: ok, [ALIAS]: [200, { projectId: 'someone-else', readyState: 'READY', meta: { githubCommitSha: SHA_A } }] },
    { [LIST]: ok, [ALIAS]: [200, { projectId: 'prj', readyState: 'READY', meta: {} }] },
  ]) assert.equal((await resolveVercelProductionDeployment({ ...base, fetchImpl: routed(routes) })).status, 'unavailable', JSON.stringify(routes));
  const network = await resolveVercelProductionDeployment({ ...base, fetchImpl: async () => { throw new Error('socket closed'); } });
  assert.equal(network.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(network), /secret-token/);
});

test('run classification separates application failures from infrastructure faults', () => {
  assert.deepEqual(classifyRun({ status: 'succeeded' }), { outcome: 'passed' });
  assert.deepEqual(classifyRun({ status: 'failed', phases: [{ mode: 'fixture', status: 'succeeded', exit_code: 0 }, { mode: 'live', status: 'failed', exit_code: 1 }] }),
    { outcome: 'failed', failed_phase: 'live', exit_code: 1 });
  for (const run of [
    null,
    { status: 'interrupted', error: 'Control plane restarted before the human test completed.' },
    { status: 'timeout', phases: [{ status: 'timeout', exit_code: null }] },
    { status: 'failed', phases: [{ mode: 'fixture', status: 'failed', exit_code: 137 }] },
    { status: 'failed', phases: [], error: 'docker unavailable' },
    { status: 'failed', phases: [{ mode: 'fixture', status: 'succeeded', exit_code: 0 }, { mode: 'live', status: 'failed', exit_code: 1, deployment_preflight: 'unavailable' }] },
    { status: 'failed', phases: [{ mode: 'fixture', status: 'succeeded', exit_code: 0 }, { mode: 'live', status: 'failed', exit_code: 1, deployment_preflight: 'stale' }] },
  ]) assert.equal(classifyRun(run).outcome, 'infrastructure', JSON.stringify(run));
  assert.equal(classifyRun({ status: 'failed', phases: [{ mode: 'live', status: 'failed', exit_code: 1, deployment_preflight: 'matched' }] }).outcome, 'failed');
});

test('Bob starts one production suite per settled SHA without anyone requesting it', async () => {
  const { monitor, context } = harness();
  const started = await monitor.tick();
  assert.equal(started.outcome, 'started');
  assert.deepEqual(context.starts, [SHA_A]);
  assert.equal((await monitor.tick()).outcome, 'running');

  context.finish('run-1', { status: 'succeeded', summary: { passed: 40, failed: 0, skipped: 2 } });
  const passed = await monitor.tick();
  assert.equal(passed.outcome, 'passed');
  assert.deepEqual(context.states.get(SHA_A).summary, { passed: 40, failed: 0, skipped: 2 });
  assert.equal((await monitor.tick()).outcome, 'passed');
  assert.deepEqual(context.starts, [SHA_A], 'a passed SHA is never re-run');
  assert.equal(monitor.lastObservation().outcome, 'passed');
});

test('a genuine test failure is recorded once and never re-run in a loop', async () => {
  const { monitor, context } = harness();
  await monitor.tick();
  context.finish('run-1', { status: 'failed', phases: [{ mode: 'fixture', status: 'succeeded', exit_code: 0 }, { mode: 'live', status: 'failed', exit_code: 1 }] });
  assert.equal((await monitor.tick()).outcome, 'failed');
  assert.equal((await monitor.tick()).outcome, 'failed');
  assert.deepEqual(context.starts, [SHA_A]);
  assert.equal(context.states.get(SHA_A).failed_phase, 'live');
});

test('infrastructure faults retry a bounded number of times, then give up', async () => {
  const { monitor, context } = harness({ maxAttempts: 2 });
  await monitor.tick();
  context.finish('run-1', { status: 'interrupted', error: 'Control plane restarted before the human test completed.' });
  assert.equal((await monitor.tick()).outcome, 'retry');
  assert.equal((await monitor.tick()).outcome, 'started');
  context.finish('run-2', { status: 'failed', phases: [{ mode: 'fixture', status: 'failed', exit_code: 125 }] });
  assert.equal((await monitor.tick()).outcome, 'gave_up');
  assert.equal((await monitor.tick()).outcome, 'gave_up');
  assert.deepEqual(context.starts, [SHA_A, SHA_A]);
});

test('start errors: a missing source commit waits without spending an attempt; other errors count', async () => {
  let mode = 'missing';
  const { monitor, context } = harness({
    maxAttempts: 2,
    startRun: async () => {
      const error = new Error(mode === 'missing' ? 'commit is not yet in Bob\'s source repository' : 'worker image unavailable');
      if (mode === 'missing') error.status = 409;
      throw error;
    },
  });
  assert.equal((await monitor.tick()).outcome, 'waiting_for_source');
  assert.equal((await monitor.tick()).outcome, 'waiting_for_source');
  assert.equal(context.states.get(SHA_A).attempts, 0);
  mode = 'broken';
  assert.equal((await monitor.tick()).outcome, 'retry');
  assert.equal((await monitor.tick()).outcome, 'gave_up');
});

test('waits for the release lane within the grace period, then tests and records that the lane is behind', async () => {
  const { monitor, context } = harness({ releasedSha: SHA_B });
  assert.equal((await monitor.tick()).outcome, 'waiting_for_release');
  context.advance(10 * 60_000);
  assert.equal((await monitor.tick()).outcome, 'waiting_for_release');
  context.advance(25 * 60_000);
  assert.equal((await monitor.tick()).outcome, 'started');
  assert.equal(context.states.get(SHA_A).release_lane_behind, true);
});

test('defers while the runtime is busy or production is still building', async () => {
  const { monitor, context } = harness({ idle: { idle: false, reason: 'a Builder job is executing' } });
  assert.deepEqual(await monitor.tick(), { sha: SHA_A, outcome: 'waiting_for_idle', reason: 'a Builder job is executing' });
  context.idle = { idle: true };
  context.production = { status: 'settling', state: 'BUILDING', sha: SHA_B };
  assert.equal((await monitor.tick()).outcome, 'waiting_for_deployment');
  assert.deepEqual(context.starts, []);
});

test('a run whose deployment was replaced mid-walk is superseded, not an application failure', async () => {
  const { monitor, context } = harness();
  await monitor.tick();
  context.production = { status: 'ready', sha: SHA_B };
  context.releasedSha = SHA_B;
  context.finish('run-1', { status: 'failed', phases: [{ mode: 'live', status: 'failed', exit_code: 1 }] });
  const next = await monitor.tick();
  assert.equal(context.states.get(SHA_A).status, 'superseded');
  assert.equal(context.states.get(SHA_A).superseded_by, SHA_B);
  assert.equal(next.outcome, 'started');
  assert.deepEqual(context.starts, [SHA_A, SHA_B]);
});

test('an existing active run started elsewhere is waited for, not duplicated', async () => {
  const { monitor, context } = harness({ startRun: async () => ({ existing: true, run: { id: 'owner-run' } }) });
  assert.deepEqual(await monitor.tick(), { sha: SHA_A, outcome: 'waiting_for_active_run', run_id: 'owner-run' });
  assert.equal(context.states.get(SHA_A).status, 'pending');
});

test('a run that passes after production moved is superseded, never recorded as passed', async () => {
  const { monitor, context } = harness();
  await monitor.tick();
  context.production = { status: 'ready', sha: SHA_B };
  context.releasedSha = SHA_B;
  context.finish('run-1', { status: 'succeeded', summary: { passed: 40, failed: 0, skipped: 0 } });
  await monitor.tick();
  assert.equal(context.states.get(SHA_A).status, 'superseded');
  assert.equal(context.states.get(SHA_A).run_outcome, 'passed');
});

test('a production deployment that is still settling never supersedes a finished run', async () => {
  const { monitor, context } = harness();
  await monitor.tick();
  context.production = { status: 'settling', state: 'BUILDING', sha: SHA_B };
  context.finish('run-1', { status: 'failed', phases: [{ mode: 'live', status: 'failed', exit_code: 1, deployment_preflight: 'matched' }] });
  assert.equal((await monitor.tick()).outcome, 'waiting_for_deployment');
  assert.equal(context.states.get(SHA_A).status, 'failed');
});

test('the attempt is persisted before launch and a restart never exceeds the retry budget', async () => {
  let seenDuringStart = null;
  const { monitor, context } = harness({
    maxAttempts: 2,
    startRun: async ({ sha }) => {
      seenDuringStart = { ...context.states.get(sha) };
      return { existing: false, run: { id: 'run-1', status: 'running' } };
    },
  });
  await monitor.tick();
  assert.equal(seenDuringStart.status, 'starting');
  assert.equal(seenDuringStart.attempts, 1);

  // The control plane died after launching the final attempt but before recording its run id.
  const restarted = harness({ maxAttempts: 2 });
  restarted.context.states.set(SHA_A, { sha: SHA_A, status: 'starting', attempts: 2, first_seen_at: '2026-10-27T00:00:00.000Z' });
  assert.equal((await restarted.monitor.tick()).outcome, 'gave_up');
  assert.deepEqual(restarted.context.starts, []);
});

test('retention forgets only old terminal verdicts, never an active SHA', () => {
  const states = [];
  for (let index = 0; index < 60; index += 1) {
    states.push({ sha: index.toString(16).padStart(40, '0'), status: index % 5 === 0 ? 'running' : 'passed', first_seen_at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString() });
  }
  const evicted = evictableProductionStates(states, 40);
  assert.equal(evicted.length, 8);
  assert.ok(evicted.every((state) => state.status === 'passed'));
  assert.ok(evicted.every((state) => state.first_seen_at < '2026-10-01T00:10:00.000Z'));
  assert.deepEqual(evictableProductionStates([{ sha: SHA_A, status: 'retry' }, { sha: SHA_B, status: 'starting' }], 0), []);
});

test('control-plane live preflight requires the exact settled production SHA and keeps the worst verdict', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(liveDeploymentPreflight({ status: 'ready', sha }, sha.toUpperCase()), { result: 'matched', sha });
  assert.equal(liveDeploymentPreflight({ status: 'ready', sha: 'b'.repeat(40) }, sha).result, 'stale');
  assert.equal(liveDeploymentPreflight({ status: 'settling', state: 'BUILDING', sha }, sha).result, 'stale');
  assert.equal(liveDeploymentPreflight({ status: 'unavailable', error: 'HTTP 503' }, sha).result, 'unavailable');
  assert.equal(liveDeploymentPreflight({ status: 'unconfigured' }, sha).result, 'unavailable');
  assert.equal(liveDeploymentPreflight({ status: 'ready', sha }, 'short').result, 'unverified');
  assert.equal(worstPreflight('matched', 'stale', 'matched'), 'stale');
  assert.equal(worstPreflight('matched', null, 'unavailable'), 'unavailable');
  assert.equal(worstPreflight('matched', 'invented'), 'matched');
});
