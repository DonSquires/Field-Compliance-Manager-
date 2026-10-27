'use strict';

// Bob's own post-deploy Dr Bob verification (owner ruling 2026-10-27): once a production SHA is settled,
// Bob runs the fixture-then-live suite against it himself, with the dedicated test identity, without a
// person requesting or approving the run. One verdict per SHA; infrastructure faults retry a bounded
// number of times; a genuine test failure is recorded once, never re-run in a loop.

const SHA_RE = /^[a-f0-9]{40}$/i;
const INFRASTRUCTURE_EXIT_CODES = new Set([125, 126, 127, 137, 143]);
const TERMINAL = new Set(['passed', 'failed', 'gave_up', 'superseded']);
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RELEASE_GRACE_MS = 30 * 60 * 1000;

function clip(value, maximum = 300) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, maximum);
}

// The newest production deployment is what the production alias moves to. Only a READY newest
// deployment is settled: while one builds (or after one failed) the live preflight would see a stale
// SHA and report a deployment mismatch rather than the application's behaviour.
async function resolveVercelProductionDeployment({ token, projectId, teamId, fetchImpl = globalThis.fetch }) {
  if (!token || !projectId || typeof fetchImpl !== 'function') return { status: 'unconfigured' };
  const query = new URLSearchParams({ projectId, target: 'production', limit: '5' });
  if (teamId) query.set('teamId', teamId);
  let response;
  try {
    response = await fetchImpl(`https://api.vercel.com/v6/deployments?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { status: 'unavailable', error: clip(`Vercel deployment lookup failed: ${error instanceof Error ? error.message : error}`) };
  }
  if (!response.ok) return { status: 'unavailable', error: `Vercel deployment lookup returned HTTP ${response.status}` };
  const body = await response.json().catch(() => ({}));
  const newest = Array.isArray(body?.deployments) ? body.deployments[0] : null;
  if (!newest) return { status: 'unavailable', error: 'Vercel returned no production deployment' };
  const state = String(newest.state || newest.readyState || '').toUpperCase();
  const sha = String(newest.meta?.githubCommitSha || newest.gitSource?.sha || '').toLowerCase();
  if (state !== 'READY') return { status: 'settling', state: state || 'UNKNOWN', sha: SHA_RE.test(sha) ? sha : null };
  if (!SHA_RE.test(sha)) return { status: 'unavailable', error: 'Production deployment has no Git commit SHA' };
  return {
    status: 'ready',
    sha,
    ref: typeof newest.meta?.githubCommitRef === 'string' ? newest.meta.githubCommitRef : null,
    deployment_id: newest.uid || newest.id || null,
    ready_at: Number.isFinite(Number(newest.ready)) ? new Date(Number(newest.ready)).toISOString() : null,
  };
}

function classifyRun(run) {
  if (!run) return { outcome: 'infrastructure', error: 'Dr Bob run record is missing' };
  if (run.status === 'succeeded') return { outcome: 'passed' };
  if (run.status === 'interrupted') return { outcome: 'infrastructure', error: clip(run.error || 'run was interrupted') };
  if (run.status === 'timeout') return { outcome: 'infrastructure', error: 'run timed out' };
  const failedPhase = Array.isArray(run.phases) ? run.phases.find((phase) => phase.status !== 'succeeded') : null;
  const exitCode = Number.isInteger(failedPhase?.exit_code) ? failedPhase.exit_code : run.exit_code;
  if (!failedPhase || !Number.isInteger(exitCode) || exitCode === 0 || INFRASTRUCTURE_EXIT_CODES.has(exitCode)) {
    return { outcome: 'infrastructure', error: clip(run.error || `worker infrastructure exited ${exitCode ?? 'without a code'}`) };
  }
  return { outcome: 'failed', failed_phase: failedPhase.mode || null, exit_code: exitCode };
}

function createProductionHumanTestMonitor({
  resolveProduction,
  readReleasedSha = async () => null,
  readState,
  writeState,
  listStates = async () => [],
  startRun,
  getRun,
  isIdle,
  now = Date.now,
  log = () => {},
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  releaseGraceMs = DEFAULT_RELEASE_GRACE_MS,
}) {
  let inFlight = false;
  let lastObservation = null;
  const iso = () => new Date(now()).toISOString();
  const observe = (observation) => { lastObservation = { ...observation, observed_at: iso() }; return observation; };

  // A run whose deployment was replaced mid-walk fails the live preflight as "stale"; that is a
  // superseded verdict, not an application failure, and the newer SHA gets its own run.
  async function settle(state, run, productionSha) {
    const verdict = classifyRun(run);
    const summary = run?.summary || null;
    const superseded = Boolean(productionSha) && productionSha !== state.sha;
    let next;
    if (verdict.outcome === 'passed') next = { ...state, status: 'passed', completed_at: iso(), summary };
    else if (superseded) next = { ...state, status: 'superseded', completed_at: iso(), summary, superseded_by: productionSha, error: verdict.error ?? null };
    else if (verdict.outcome === 'failed') next = { ...state, status: 'failed', completed_at: iso(), summary, failed_phase: verdict.failed_phase, exit_code: verdict.exit_code };
    else next = { ...state, status: state.attempts >= maxAttempts ? 'gave_up' : 'retry', completed_at: iso(), error: verdict.error };
    await writeState(next);
    log({ sha: next.sha, outcome: next.status, run_id: next.run_id, summary, error: next.error ?? null });
    return { sha: next.sha, outcome: next.status, run_id: next.run_id };
  }

  async function settleFinishedRuns(productionSha) {
    let current = null;
    for (const state of await listStates()) {
      if (state?.status !== 'running' || !state.run_id) continue;
      const run = await getRun(state.run_id);
      if (run && (run.status === 'queued' || run.status === 'running')) continue;
      const settled = await settle(state, run, productionSha);
      if (state.sha === productionSha) current = settled;
    }
    return current;
  }

  async function tick() {
    if (inFlight) return { outcome: 'busy' };
    inFlight = true;
    try {
      const production = await resolveProduction();
      const settledCurrent = await settleFinishedRuns(production?.sha || null);
      if (settledCurrent) return observe(settledCurrent);
      if (production?.status !== 'ready') {
        return observe({ outcome: 'waiting_for_deployment', reason: production?.status || 'unknown', state: production?.state, error: production?.error });
      }
      const { sha } = production;
      let state = await readState(sha);
      if (state && TERMINAL.has(state.status)) return observe({ sha, outcome: state.status, run_id: state.run_id ?? null });

      if (state?.status === 'running' && state.run_id) {
        const run = await getRun(state.run_id);
        if (run && (run.status === 'queued' || run.status === 'running')) return observe({ sha, outcome: 'running', run_id: state.run_id });
        return observe(await settle(state, run, sha));
      }

      // Test the whole stack at this SHA: wait for the release lane to finish it (edge functions,
      // migrations, control plane) unless it has been stuck past the grace period.
      const releasedSha = await readReleasedSha();
      const firstSeen = state?.first_seen_at || iso();
      if (!state) {
        state = { sha, status: 'pending', attempts: 0, first_seen_at: firstSeen, deployment_id: production.deployment_id ?? null };
        await writeState(state);
      }
      const releaseBehind = releasedSha !== sha;
      if (releaseBehind && now() - Date.parse(firstSeen) < releaseGraceMs) {
        return observe({ sha, outcome: 'waiting_for_release', released_sha: releasedSha || null });
      }
      const idle = await isIdle();
      if (!idle?.idle) return observe({ sha, outcome: 'waiting_for_idle', reason: idle?.reason || 'runtime busy' });

      const attempts = Number(state.attempts || 0) + 1;
      let started;
      try {
        started = await startRun({ sha });
      } catch (error) {
        const detail = clip(error instanceof Error ? error.message : error);
        if (error?.status === 409) {
          state = { ...state, status: 'pending', waiting_reason: detail };
          await writeState(state);
          return observe({ sha, outcome: 'waiting_for_source', reason: detail });
        }
        state = { ...state, status: attempts >= maxAttempts ? 'gave_up' : 'retry', attempts, error: detail, completed_at: iso() };
        await writeState(state);
        log({ sha, outcome: state.status, error: detail });
        return observe({ sha, outcome: state.status, error: detail });
      }
      if (started?.existing) return observe({ sha, outcome: 'waiting_for_active_run', run_id: started.run?.id ?? null });
      state = {
        ...state,
        status: 'running',
        attempts,
        run_id: started.run.id,
        started_at: iso(),
        released_sha: releasedSha || null,
        release_lane_behind: releaseBehind,
        error: null,
        waiting_reason: null,
      };
      await writeState(state);
      log({ sha, outcome: 'started', run_id: state.run_id, attempts, release_lane_behind: releaseBehind });
      return observe({ sha, outcome: 'started', run_id: state.run_id });
    } catch (error) {
      const detail = clip(error instanceof Error ? error.message : error);
      log({ outcome: 'error', error: detail });
      return observe({ outcome: 'error', error: detail });
    } finally {
      inFlight = false;
    }
  }

  return { tick, lastObservation: () => lastObservation };
}

module.exports = {
  createProductionHumanTestMonitor,
  resolveVercelProductionDeployment,
  classifyRun,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RELEASE_GRACE_MS,
};
