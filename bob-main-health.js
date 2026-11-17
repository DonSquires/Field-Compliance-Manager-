const SHA_RE = /^[a-f0-9]{40}$/i;
const RUNNING_TIMEOUT_MS = 30 * 60 * 1000;
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { failedTestPaths } = require('./supabase/functions/_shared/builder-repository-context');
const TOOLING_RUNTIME_FILES = ['bob-control-plane-server.js', 'bob-main-health.js', 'builder-agentic-engineer.js', 'builder-branch-workspace.js', 'builder-path-policy.js', 'worker-executor.js'];

function rootMountIsReadOnly(mountInfo) {
  const rootMount = String(mountInfo || '').split(/\r?\n/)
    .map(line => line.split(' '))
    .find(fields => fields[4] === '/');
  if (!rootMount) return false;
  const options = new Set((rootMount[5] || '').split(','));
  return options.has('ro') && !options.has('rw');
}

async function verifyToolingSandbox({ workspaceRoot, sourceDir, expectedSha, createToolsImpl } = {}) {
  if (!workspaceRoot) throw new Error('tooling verification workspace root is required');
  if (!sourceDir || !SHA_RE.test(String(expectedSha || ''))) throw new Error('pinned tooling source and SHA are required');
  for (const file of TOOLING_RUNTIME_FILES) {
    const pinned = execFileSync('git', ['show', `${expectedSha}:${file}`], { cwd: sourceDir, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!pinned.equals(fs.readFileSync(path.join(__dirname, file)))) throw new Error(`deployed tooling ${file} does not match pinned main; waiting for managed release`);
  }
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  const workspacePath = fs.mkdtempSync(path.join(workspaceRoot, 'main-health-tooling-'));
  try {
    execFileSync('git', ['init', '-q', workspacePath], { stdio: 'pipe' });
    fs.mkdirSync(path.join(workspacePath, 'test'));
    fs.writeFileSync(path.join(workspacePath, 'test', 'tooling.test.js'), [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      "test('tooling sandbox isolates the host', () => {",
      "  assert.notEqual(process.getuid(), 0);",
      "  assert.equal(fs.existsSync('/var/run/docker.sock'), false);",
      "  assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, undefined);",
      "  assert.equal(process.env.BOB_ADMIN_TOKEN, undefined);",
      "  const rootMount = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').map(line => line.split(' ')).find(fields => fields[4] === '/');",
      "  assert.ok(rootMount, 'root mount must be present in mountinfo');",
      "  const rootOptions = rootMount[5].split(',');",
      "  assert.ok(rootOptions.includes('ro') && !rootOptions.includes('rw'), 'root mount must be read-only');",
      "  assert.throws(() => fs.writeFileSync('/etc/fcm-main-health-probe', 'fixture'), error => ['EROFS', 'EACCES'].includes(error.code));",
      "  assert.throws(() => fs.appendFileSync('/workspace/.git/config', '\\n# fixture'), error => ['EROFS', 'EACCES'].includes(error.code));",
      "  fs.writeFileSync('/workspace/fixture-output', 'ok');",
      '});',
      '',
    ].join('\n'));
    const { createTools, DEFAULT_LIMITS } = require('./builder-agentic-engineer');
    const tools = (createToolsImpl || createTools)({ workspacePath, repoRoot: workspacePath, lane: 'backend', supabase: null, limits: DEFAULT_LIMITS, log() {} });
    const result = await tools.run({ command: 'node --test test/tooling.test.js' });
    if (result?.exit_code !== 0 || result.timed_out || fs.readFileSync(path.join(workspacePath, 'fixture-output'), 'utf8') !== 'ok') {
      throw new Error('real tooling sandbox verification failed');
    }
    return { ok: true, mode: 'real-container' };
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

function failedHealthSteps(output) {
  return [...String(output || '').matchAll(/^BOB_HEALTH_STEP ([a-z0-9-]+) FAIL exit=(\d+)\s*$/gm)]
    .map(([, name, exitCode]) => ({ name, exit_code: Number(exitCode) }));
}

function dockerOnlyTapFailures(output, failureEvidence) {
  const dockerDependentTests = new Set(['test/builder-agentic-engineer.test.js', 'test/builder-vibe-session.test.js']);
  if (!failureEvidence.failed_health_steps.length
    || failureEvidence.failed_health_steps.some(step => step.name !== 'root-tests')) return false;

  const blocks = [];
  let current = null;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (/^\s*not ok \d+\b/.test(line)) {
      if (current) blocks.push(current.join('\n'));
      current = [line];
    } else if (current && (/^\s*ok \d+\b/.test(line) || /^BOB_HEALTH_STEP /.test(line))) {
      blocks.push(current.join('\n'));
      current = null;
    } else if (current) current.push(line);
  }
  if (current) blocks.push(current.join('\n'));
  if (!blocks.length) return false;

  const coveredTests = new Set();
  for (const block of blocks) {
    const paths = failedTestPaths(block);
    if (paths.length !== 1 || !dockerDependentTests.has(paths[0]) || !/spawn docker ENOENT/.test(block)) return false;
    coveredTests.add(paths[0]);
  }
  return failureEvidence.failing_tests.length > 0
    && failureEvidence.failing_tests.every(file => dockerDependentTests.has(file) && coveredTests.has(file));
}

function summarizeFailure(result) {
  const fullOutput = `${String(result?.stdout || '')}\n${String(result?.stderr || '')}`
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
  const failingTests = failedTestPaths(fullOutput);
  const stdout = String(result?.stdout || '').slice(-8000);
  const stderr = String(result?.stderr || '').slice(-4000);
  const output = `${stdout}\n${stderr}`;
  const allLines = fullOutput.split(/\r?\n/);
  const assertions = allLines.filter((line) => /AssertionError|Test Files\s|\bfailed\b/i.test(line)).slice(-20);
  const diagnostics = allLines.filter((line) => /\b(error|enoent|eacces|not found|timed out|timeout|cannot|failed)\b/i.test(line)).slice(-30);
  const failedSteps = failedHealthSteps(fullOutput);
  return {
    profile: result?.profile || 'main-health',
    exit_code: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    failing_tests: failingTests,
    failed_health_steps: failedSteps,
    summary: (failingTests.length ? failingTests : assertions.length ? assertions : diagnostics).join('\n').slice(-3000),
    stdout,
    stderr,
  };
}

function createMainHealthMonitor({ getMainSha, runChecks, verifyTooling, openRepair, readState, writeState, now = Date.now, log = () => {} }) {
  let inFlight = false;

  async function tick() {
    if (inFlight) return { outcome: 'busy' };
    inFlight = true;
    let state = null;
    let failureEvidence = null;
    try {
      const sha = await getMainSha();
      if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new Error('main health received an invalid repository SHA');
      state = await readState(sha);
      if (state?.status === 'passed' || state?.status === 'repair_opened') {
        return { sha, outcome: state.status, job_id: state.job_id ?? null };
      }
      if (state?.status === 'running' && now() - Date.parse(state.started_at) < RUNNING_TIMEOUT_MS) {
        return { sha, outcome: 'running' };
      }

      state = { sha, status: 'running', started_at: new Date(now()).toISOString() };
      await writeState(state);
      const result = await runChecks({ sha });
      const latestSha = await getMainSha();
      if (latestSha !== sha) {
        state = { sha, status: 'superseded', checked_at: new Date(now()).toISOString() };
        await writeState(state);
        return { sha, outcome: 'superseded', latest_sha: latestSha };
      }
      if (result?.status === 'succeeded') {
        const fixtureTooling = /(?:^|\n)BOB_HEALTH_TOOLING_MODE fixture-emulation \(temporary test workspaces only\)(?:\r?\n|$)/.test(`${result.stdout || ''}\n${result.stderr || ''}`);
        if (result.profile === 'main-health' && !fixtureTooling) throw new Error('main-health tooling provenance is unavailable');
        if (fixtureTooling) {
          if (typeof verifyTooling !== 'function') throw new Error('real tooling sandbox verification is unavailable');
          const verified = await verifyTooling({ sha, sourceDir: result.toolingSourceDir });
          if (verified?.ok !== true || verified.mode !== 'real-container') throw new Error('real tooling sandbox verification did not pass');
          if (await getMainSha() !== sha) {
            state = { sha, status: 'superseded', checked_at: new Date(now()).toISOString() };
            await writeState(state);
            return { sha, outcome: 'superseded' };
          }
        }
        state = { sha, status: 'passed', checked_at: new Date(now()).toISOString(), exit_code: 0, ...(fixtureTooling ? { tooling_mode: 'fixture-emulation', tooling_sandbox: 'real-container-passed' } : {}) };
        await writeState(state);
        log({ sha, outcome: 'passed', ...(fixtureTooling ? { tooling_mode: 'fixture-emulation' } : {}) });
        return { sha, outcome: 'passed' };
      }
      const infrastructureExitCodes = new Set([125, 126, 127, 137, 143]);
      if (result?.status !== 'failed' || !Number.isInteger(result.exitCode) || result.exitCode === 0 || infrastructureExitCodes.has(result.exitCode)) {
        const error = infrastructureExitCodes.has(result?.exitCode)
          ? `worker infrastructure exited ${result.exitCode}`
          : String(result?.status || 'worker did not complete');
        state = { sha, status: 'retry', checked_at: new Date(now()).toISOString(), error };
        await writeState(state);
        log({ sha, outcome: 'retry', status: result?.status ?? null, exit_code: result?.exitCode ?? null });
        return { sha, outcome: 'retry' };
      }

      failureEvidence = summarizeFailure(result);
      const fullOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
      const nestedDockerUnavailable = /(?:^|\n)BOB_HEALTH_CAPABILITY nested-docker unavailable(?:\r?\n|$)/.test(fullOutput);
      if (nestedDockerUnavailable && dockerOnlyTapFailures(fullOutput, failureEvidence)) {
        state = { sha, status: 'retry', checked_at: new Date(now()).toISOString(), error: 'main-health cannot verify Docker-dependent Builder tests inside its socket-free worker', failing_tests: failureEvidence.failing_tests };
        await writeState(state);
        log({ sha, outcome: 'retry', reason: 'nested_docker_unavailable', failing_tests: failureEvidence.failing_tests });
        return { sha, outcome: 'retry', reason: 'nested_docker_unavailable' };
      }
      const repair = await openRepair({ sha, failure: failureEvidence });
      if (!repair?.id) throw new Error('main health repair job was not returned');
      state = { sha, status: 'repair_opened', checked_at: new Date(now()).toISOString(), job_id: repair.id, failing_tests: failureEvidence.failing_tests };
      await writeState(state);
      log({ sha, outcome: 'repair_opened', job_id: repair.id, failing_tests: failureEvidence.failing_tests });
      return { sha, outcome: 'repair_opened', job_id: repair.id, failing_tests: failureEvidence.failing_tests };
    } catch (error) {
      const retryState = {
        sha: state?.sha ?? null,
        status: 'retry',
        checked_at: new Date(now()).toISOString(),
        error: String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 300),
        failing_tests: failureEvidence?.failing_tests ?? [],
        failure_summary: failureEvidence?.summary ?? '',
      };
      if (retryState.sha) await writeState(retryState).catch(() => {});
      log({ sha: retryState.sha, outcome: 'error', error: retryState.error, failing_tests: retryState.failing_tests });
      return { sha: retryState.sha, outcome: 'retry', error: retryState.error };
    } finally {
      inFlight = false;
    }
  }

  return { tick };
}

module.exports = { createMainHealthMonitor, summarizeFailure, verifyToolingSandbox, rootMountIsReadOnly, RUNNING_TIMEOUT_MS };