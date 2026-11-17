const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { createMainHealthMonitor, summarizeFailure, verifyToolingSandbox } = require('../bob-main-health');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function harness({ sha = SHA_A, result, onRun, onRepair, verifyTooling } = {}) {
  const states = new Map();
  const calls = { checks: 0, repairs: 0, logs: [] };
  const monitor = createMainHealthMonitor({
    getMainSha: async () => sha,
    runChecks: async (input) => { calls.checks += 1; onRun?.(input); return result; },
    verifyTooling,
    openRepair: async (input) => { calls.repairs += 1; onRepair?.(input); return { id: 'job-1' }; },
    readState: async (commit) => states.get(commit) ?? null,
    writeState: async (state) => states.set(state.sha, state),
    now: () => Date.parse('2026-10-12T04:00:00.000Z'),
    log: (entry) => calls.logs.push(entry),
  });
  return { monitor, states, calls };
}

function pinnedToolingSource(root) {
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  execFileSync('git', ['init', '-q', source]);
  for (const file of ['bob-control-plane-server.js', 'bob-main-health.js', 'builder-agentic-engineer.js', 'builder-branch-workspace.js', 'builder-path-policy.js', 'worker-executor.js']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(source, file));
  }
  const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git(['add', '.']);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'matching launcher']);
  return { source, sha: git(['rev-parse', 'HEAD']), git };
}

test('main health runs pinned checks once for each green SHA', async () => {
  const { monitor, calls, states } = harness({ result: { status: 'succeeded', exitCode: 0 } });
  assert.deepEqual(await monitor.tick(), { sha: SHA_A, outcome: 'passed' });
  assert.deepEqual(await monitor.tick(), { sha: SHA_A, outcome: 'passed', job_id: null });
  assert.equal(calls.checks, 1);
  assert.equal(calls.repairs, 0);
  assert.equal(states.get(SHA_A).status, 'passed');
});

test('main health records fixture-emulated tooling distinctly from real nested containers', async () => {
  let toolingInput;
  const { monitor, states, calls } = harness({ result: { status: 'succeeded', exitCode: 0, toolingSourceDir: '/fixture/source', stdout: 'BOB_HEALTH_TOOLING_MODE fixture-emulation (temporary test workspaces only)\n' }, verifyTooling: async input => { toolingInput = input; return { ok: true, mode: 'real-container' }; } });
  assert.equal((await monitor.tick()).outcome, 'passed');
  assert.deepEqual(toolingInput, { sha: SHA_A, sourceDir: '/fixture/source' });
  assert.equal(states.get(SHA_A).tooling_mode, 'fixture-emulation');
  assert.equal(states.get(SHA_A).tooling_sandbox, 'real-container-passed');
  assert.equal(calls.logs[0].tooling_mode, 'fixture-emulation');
});

test('fixture-emulated health cannot pass if real tooling verification fails or is unavailable', async () => {
  for (const verifyTooling of [undefined, async () => ({ ok: false }), async () => { throw new Error('docker unavailable'); }]) {
    const { monitor, calls, states } = harness({ result: { status: 'succeeded', exitCode: 0, stdout: 'BOB_HEALTH_TOOLING_MODE fixture-emulation (temporary test workspaces only)\n' }, verifyTooling });
    assert.equal((await monitor.tick()).outcome, 'retry');
    assert.equal(states.get(SHA_A).status, 'retry');
    assert.equal(calls.repairs, 0);
  }
});

test('a main-health worker cannot pass without tooling provenance', async () => {
  const { monitor, states, calls } = harness({ result: { status: 'succeeded', exitCode: 0, profile: 'main-health', stdout: '' } });
  assert.equal((await monitor.tick()).outcome, 'retry');
  assert.equal(states.get(SHA_A).status, 'retry');
  assert.match(states.get(SHA_A).error, /tooling provenance is unavailable/);
  assert.equal(calls.repairs, 0);
});

test('real tooling verification requires the fixture output and cleans its temporary workspace', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'main-health-tooling-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pinned = pinnedToolingSource(root);
  const workspaces = path.join(root, 'workspaces');
  await assert.rejects(verifyToolingSandbox({ workspaceRoot: workspaces }), /pinned tooling source and SHA are required/);
  const missing = () => ({ run: async () => ({ exit_code: 0 }) });
  await assert.rejects(verifyToolingSandbox({ workspaceRoot: workspaces, sourceDir: pinned.source, expectedSha: pinned.sha, createToolsImpl: missing }), /ENOENT/);
  assert.deepEqual(fs.readdirSync(workspaces), []);
  const passing = ({ workspacePath }) => ({ run: async () => {
    fs.writeFileSync(path.join(workspacePath, 'fixture-output'), 'ok');
    return { exit_code: 0 };
  } });
  assert.deepEqual(await verifyToolingSandbox({ workspaceRoot: workspaces, sourceDir: pinned.source, expectedSha: pinned.sha, createToolsImpl: passing }), { ok: true, mode: 'real-container' });
  assert.deepEqual(fs.readdirSync(workspaces), []);
});

test('real tooling verification refuses a deployed launcher that differs from the pinned source', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'main-health-source-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { source, sha: matchingSha, git } = pinnedToolingSource(root);
  const passing = ({ workspacePath }) => ({ run: async () => {
    fs.writeFileSync(path.join(workspacePath, 'fixture-output'), 'ok');
    return { exit_code: 0 };
  } });
  assert.equal((await verifyToolingSandbox({ workspaceRoot: path.join(root, 'workspaces'), sourceDir: source, expectedSha: matchingSha, createToolsImpl: passing })).ok, true);
  fs.appendFileSync(path.join(source, 'worker-executor.js'), '\nchanged launcher\n');
  git(['add', 'worker-executor.js']);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'different launcher']);
  await assert.rejects(verifyToolingSandbox({ workspaceRoot: path.join(root, 'workspaces'), sourceDir: source, expectedSha: git(['rev-parse', 'HEAD']), createToolsImpl: passing }), /worker-executor\.js does not match pinned main/);
});

test('a main SHA change during real tooling verification cannot record a health pass', async () => {
  let headReads = 0;
  const states = new Map();
  const monitor = createMainHealthMonitor({
    getMainSha: async () => (++headReads < 3 ? SHA_A : SHA_B),
    runChecks: async () => ({ status: 'succeeded', exitCode: 0, stdout: 'BOB_HEALTH_TOOLING_MODE fixture-emulation (temporary test workspaces only)\n' }),
    verifyTooling: async () => ({ ok: true, mode: 'real-container' }),
    openRepair: async () => { throw new Error('must not open repair'); },
    readState: async sha => states.get(sha) ?? null,
    writeState: async state => states.set(state.sha, state),
  });
  assert.deepEqual(await monitor.tick(), { sha: SHA_A, outcome: 'superseded' });
  assert.equal(states.get(SHA_A).status, 'superseded');
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

test('socket-free worker reports Docker-dependent checks as inconclusive without hiding other failures', async () => {
  const dockerFailure = [
    'not ok 1 - nested runner failed',
    "  location: '/workspace/test/builder-agentic-engineer.test.js:161:1'",
    '  error: spawn docker ENOENT',
    'not ok 2 - Vibe runner failed',
    "  location: '/workspace/test/builder-vibe-session.test.js:1060:1'",
    'BOB_HEALTH_CAPABILITY nested-docker unavailable',
  ].join('\n');
  const isolated = harness({ result: { status: 'failed', exitCode: 1, stdout: dockerFailure } });
  assert.deepEqual(await isolated.monitor.tick(), { sha: SHA_A, outcome: 'retry', reason: 'nested_docker_unavailable' });
  assert.equal(isolated.calls.repairs, 0);
  assert.equal(isolated.states.get(SHA_A).status, 'retry');

  const mixed = harness({ result: { status: 'failed', exitCode: 1, stdout: `${dockerFailure}\nnot ok 3 - real regression\n  location: '/workspace/test/other.test.js:5:1'` } });
  assert.equal((await mixed.monitor.tick()).outcome, 'repair_opened');
  assert.equal(mixed.calls.repairs, 1);

  const withoutMarker = harness({ result: { status: 'failed', exitCode: 1, stdout: dockerFailure.replace('BOB_HEALTH_CAPABILITY nested-docker unavailable', '') } });
  assert.equal((await withoutMarker.monitor.tick()).outcome, 'repair_opened');
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

  test('node TAP failures identify root paths alongside web failures without web-prefixing them', () => {
    const { normalizeHealthPath, isHealthTestPath, mainHealthEvidenceConflict } = require('../supabase/functions/_shared/builder-repository-context');
    const stdout = [
      'ok 1 - passing root test',
      'not ok 2 - failing root assertion',
      '  ---',
      "  location: '/workspace/test/root.test.js:22:1'",
      '  ...',
      'not ok 3 - esm failure',
      "  location: 'test/module.test.mjs:1:1'",
      'FAIL src/pages/example.test.ts',
    ].join('\n');
    const failure = summarizeFailure({ status: 'failed', exitCode: 1, stdout });
    assert.deepEqual(failure.failing_tests, ['src/pages/example.test.ts', 'test/root.test.js', 'test/module.test.mjs']);
    assert.equal(normalizeHealthPath('/workspace/test/root.test.js'), 'test/root.test.js');
    assert.equal(normalizeHealthPath('src/pages/example.test.ts'), 'apps/web/src/pages/example.test.ts');
    assert.equal(isHealthTestPath('test/root.test.js'), true);
    assert.equal(isHealthTestPath('test/module.test.mjs'), true);
    assert.equal(isHealthTestPath('../test/root.test.js'), false);
    assert.equal(isHealthTestPath('test/nested/root.test.js'), false);
    assert.equal(mainHealthEvidenceConflict({
      autopilot_source: 'main_monitor', source_main_health_files: failure.failing_tests.map(normalizeHealthPath),
      task_description: stdout,
    }), null);
  });
  assert.deepEqual(failure.failing_tests, ['src/pages/DocumentContextDrafting.guard.test.ts']);
});

test('Vitest failure titles are not classified as file paths', () => {
  const failure = summarizeFailure({
    status: 'failed',
    exitCode: 1,
    stdout: 'FAIL src/pages/DocumentContextDrafting.guard.test.ts > keeps drafting\n× keeps drafting\n',
    stderr: '',
  });

  test('Vitest failed-suite markers identify every failing file without including passing neighbours', () => {
    const failure = summarizeFailure({
      exitCode: 1,
      stdout: [
        '\u001b[32m✓\u001b[39m src/lib/patrolImportLifecycle.guard.test.ts (2 tests) 3ms',
        '\u001b[31m❯\u001b[39m src/lib/dispatchCreationSchema.guard.test.ts (2 tests | 1 failed) 231ms',
        '  × deduplicates client retries',
        '❯ src/pages/Other.guard.test.ts (12 tests | 10 failed | 1 skipped) 40ms',
        '❯ src/pages/Skipped.test.ts (1 test | 1 skipped)',
        '✓ src/pages/Passing.test.ts (1 test | 0 failed)',
        'log: FAIL src/pages/NotAResult.guard.test.ts',
      ].join('\n'),
    });
    assert.deepEqual(failure.failing_tests, [
      'src/lib/dispatchCreationSchema.guard.test.ts',
      'src/pages/Other.guard.test.ts',
    ]);
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