const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createMainHealthMonitor, summarizeFailure } = require('../bob-main-health');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function harness({ sha = SHA_A, result, onRun, onRepair } = {}) {
  const states = new Map();
  const calls = { checks: 0, repairs: 0, logs: [] };
  const monitor = createMainHealthMonitor({
    getMainSha: async () => sha,
    runChecks: async (input) => { calls.checks += 1; onRun?.(input); return result; },
    openRepair: async (input) => { calls.repairs += 1; onRepair?.(input); return { id: 'job-1' }; },
    readState: async (commit) => states.get(commit) ?? null,
    writeState: async (state) => states.set(state.sha, state),
    now: () => Date.parse('2026-10-12T04:00:00.000Z'),
    log: (entry) => calls.logs.push(entry),
  });
  return { monitor, states, calls };
}

test('main health runs pinned checks once for each green SHA', async () => {
  const { monitor, calls, states } = harness({ result: { status: 'succeeded', exitCode: 0 } });
  assert.deepEqual(await monitor.tick(), { sha: SHA_A, outcome: 'passed' });
  assert.deepEqual(await monitor.tick(), { sha: SHA_A, outcome: 'passed', job_id: null });
  assert.equal(calls.checks, 1);
  assert.equal(calls.repairs, 0);
  assert.equal(states.get(SHA_A).status, 'passed');
});

test('red pinned main opens one repair job with bounded failure evidence', async () => {
  const result = { status: 'failed', exitCode: 1, profile: 'main-health', stdout: 'FAIL src/a.guard.test.ts\nAssertionError: stale guard\n'.repeat(1000), stderr: 'safe output' };
  let repairInput;
  const { monitor, calls, states } = harness({ result, onRepair: (input) => { repairInput = input; } });
  assert.deepEqual(await monitor.tick(), { sha: SHA_A, outcome: 'repair_opened', job_id: 'job-1', failing_tests: ['src/a.guard.test.ts'] });
  assert.deepEqual(await monitor.tick(), { sha: SHA_A, outcome: 'repair_opened', job_id: 'job-1' });
  assert.equal(calls.checks, 1);
  assert.equal(calls.repairs, 1);
  assert.equal(repairInput.sha, SHA_A);
  assert.equal(repairInput.failure.stdout.length <= 8000, true);
  assert.equal(repairInput.failure.stderr.length <= 4000, true);
  assert.equal(states.get(SHA_A).status, 'repair_opened');
});

test('a check for a SHA that moved during execution is discarded without opening repair', async () => {
  let currentSha = SHA_A;
  const states = new Map();
  const monitor = createMainHealthMonitor({
    getMainSha: async () => { const result = currentSha; currentSha = SHA_B; return result; },
    runChecks: async () => ({ status: 'failed', exitCode: 1, stdout: 'FAIL stale.test.ts' }),
    openRepair: async () => { throw new Error('must not open repair for stale main'); },
    readState: async (sha) => states.get(sha) ?? null,
    writeState: async (state) => states.set(state.sha, state),
  });
  assert.deepEqual(await monitor.tick(), { sha: SHA_A, outcome: 'superseded', latest_sha: SHA_B });
  assert.equal(states.get(SHA_A).status, 'superseded');
});

test('timeouts and worker launch failures retry without classifying main as broken', async () => {
  for (const result of [{ status: 'timeout', exitCode: null }, { status: 'failed', exitCode: 125 }]) {
    const { monitor, calls, states } = harness({ result });
    assert.deepEqual(await monitor.tick(), { sha: SHA_A, outcome: 'retry' });
    assert.equal(calls.repairs, 0);
    assert.equal(states.get(SHA_A).status, 'retry');
  }
});

test('a rejected repair intake persists only bounded parsed test paths for diagnosis', async () => {
  const states = new Map();
  const monitor = createMainHealthMonitor({
    getMainSha: async () => SHA_A,
    runChecks: async () => ({ status: 'failed', exitCode: 1, stdout: 'FAIL src/pages/example.guard.test.ts\n' + 'large diff '.repeat(2000) }),
    openRepair: async () => { throw new Error('repair intake rejected'); },
    readState: async (sha) => states.get(sha) ?? null,
    writeState: async (state) => states.set(state.sha, state),
  });
  const outcome = await monitor.tick();
  assert.equal(outcome.outcome, 'retry');
  assert.deepEqual(states.get(SHA_A).failing_tests, ['src/pages/example.guard.test.ts']);
  assert.equal(states.get(SHA_A).failure_summary.length <= 3000, true);
});

test('failure summaries identify test paths and never exceed the evidence budget', () => {
  const failure = summarizeFailure({ status: 'failed', exitCode: 1, stdout: 'FAIL src/a.test.ts\n'.repeat(1000), stderr: 'AssertionError\n'.repeat(1000) });
  assert.deepEqual(failure.failing_tests, ['src/a.test.ts']);
  assert.equal(failure.stdout.length <= 8000, true);
  assert.equal(failure.stderr.length <= 4000, true);
});

test('failure path detection runs before evidence truncation drops the Vitest header', () => {
  const failure = summarizeFailure({
    status: 'failed',
    exitCode: 1,
    stdout: ' FAIL src/pages/DocumentContextDrafting.guard.test.ts > long failure\n' + 'diff detail\n'.repeat(5000),
    stderr: '',
  });
  assert.deepEqual(failure.failing_tests, ['src/pages/DocumentContextDrafting.guard.test.ts']);
  assert.equal(failure.stdout.length <= 8000, true);
});

test('failure path detection strips ANSI color codes from Vitest output', () => {
  const failure = summarizeFailure({
    status: 'failed',
    exitCode: 1,
    stdout: '\u001b[31mFAIL\u001b[39m  \u001b[22m\u001b[49msrc/pages/DocumentContextDrafting.guard.test.ts\u001b[22m',
    stderr: '',
  });
  assert.deepEqual(failure.failing_tests, ['src/pages/DocumentContextDrafting.guard.test.ts']);
});

test('worker errors are retained in a bounded summary when no test path is reported', () => {
  const failure = summarizeFailure({ status: 'failed', exitCode: 1, stdout: 'npm run build\nError: browser binary not found\n', stderr: '' });
  assert.match(failure.summary, /browser binary not found/);
});

test('main-health Builder RPC binds bot provenance without inventing a human requester', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261012045502_bob_main_health_repairs.sql'), 'utf8');
  assert.match(migration, /builder_open_main_health_repair/);
  assert.match(migration, /auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /source_main_health_sha/);
  assert.match(migration, /source_main_health_files/);
  assert.match(migration, /'main_monitor'/);
  assert.match(migration, /main-health repair is limited to web source guard tests/i);
  assert.doesNotMatch(migration, /SET autopilot_requested_by\s*=/);
});