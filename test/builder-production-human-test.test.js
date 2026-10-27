const assert = require('node:assert/strict');
const test = require('node:test');
const { createProductionHumanTestMonitor, resolveVercelProductionDeployment, classifyRun } = require('../builder-production-human-test');

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

test('the Vercel resolver only treats a READY newest production deployment as settled', async () => {
  const calls = [];
  const fetchImpl = (body, status = 200) => async (url, options) => {
    calls.push({ url, options });
    return { ok: status === 200, status, json: async () => body };
  };
  assert.deepEqual(await resolveVercelProductionDeployment({ token: '', projectId: 'p' }), { status: 'unconfigured' });

  const ready = await resolveVercelProductionDeployment({
    token: 'secret-token', projectId: 'prj', teamId: 'team',
    fetchImpl: fetchImpl({ deployments: [{ uid: 'dpl_1', state: 'READY', ready: 1_800_000_000_000, meta: { githubCommitSha: SHA_A.toUpperCase(), githubCommitRef: 'main' } }] }),
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.sha, SHA_A);
  assert.equal(ready.deployment_id, 'dpl_1');
  assert.match(calls[0].url, /projectId=prj/);
  assert.match(calls[0].url, /target=production/);
  assert.match(calls[0].url, /teamId=team/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');

  const building = await resolveVercelProductionDeployment({
    token: 't', projectId: 'p',
    fetchImpl: fetchImpl({ deployments: [{ readyState: 'BUILDING', meta: { githubCommitSha: SHA_B } }, { state: 'READY', meta: { githubCommitSha: SHA_A } }] }),
  });
  assert.deepEqual(building, { status: 'settling', state: 'BUILDING', sha: SHA_B });

  assert.equal((await resolveVercelProductionDeployment({ token: 't', projectId: 'p', fetchImpl: fetchImpl({}, 403) })).status, 'unavailable');
  assert.equal((await resolveVercelProductionDeployment({ token: 't', projectId: 'p', fetchImpl: fetchImpl({ deployments: [{ state: 'READY', meta: {} }] }) })).status, 'unavailable');
  const network = await resolveVercelProductionDeployment({ token: 'secret-token', projectId: 'p', fetchImpl: async () => { throw new Error('socket closed'); } });
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
  ]) assert.equal(classifyRun(run).outcome, 'infrastructure', JSON.stringify(run));
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
