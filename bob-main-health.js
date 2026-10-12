const SHA_RE = /^[a-f0-9]{40}$/i;
const RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

function summarizeFailure(result) {
  const fullOutput = `${String(result?.stdout || '')}\n${String(result?.stderr || '')}`;
  const failingTests = [...new Set([
    ...[...fullOutput.matchAll(/(?:FAIL|✖|✘|×)\s+([^\s:>]+)/g)].map((match) => match[1]),
    ...[...fullOutput.matchAll(/^\s*\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?([^\r\n]+?\.(?:spec|test)\.tsx?)(?::|\s|$)/gm)].map((match) => match[1]),
  ])].slice(0, 20);
  const stdout = String(result?.stdout || '').slice(-8000);
  const stderr = String(result?.stderr || '').slice(-4000);
  const output = `${stdout}\n${stderr}`;
  const assertions = output.split(/\r?\n/).filter((line) => /AssertionError|Test Files\s|\bfailed\b/i.test(line)).slice(-20);
  return {
    profile: result?.profile || 'main-health',
    exit_code: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    failing_tests: failingTests,
    summary: (failingTests.length ? failingTests : assertions).join('\n').slice(-3000),
    stdout,
    stderr,
  };
}

function createMainHealthMonitor({ getMainSha, runChecks, openRepair, readState, writeState, now = Date.now, log = () => {} }) {
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
        state = { sha, status: 'passed', checked_at: new Date(now()).toISOString(), exit_code: 0 };
        await writeState(state);
        log({ sha, outcome: 'passed' });
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

module.exports = { createMainHealthMonitor, summarizeFailure, RUNNING_TIMEOUT_MS };