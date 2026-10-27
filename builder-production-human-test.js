'use strict';

// Bob's own post-deploy Dr Bob verification (owner ruling 2026-10-27): once a production SHA is settled,
// Bob runs the fixture-then-live suite against it himself, with the dedicated test identity, without a
// person requesting or approving the run. One verdict per SHA; infrastructure faults retry a bounded
// number of times; a genuine test failure is recorded once, never re-run in a loop.

const SHA_RE = /^[a-f0-9]{40}$/i;
const INFRASTRUCTURE_EXIT_CODES = new Set([125, 126, 127, 137, 143]);
const TERMINAL = new Set(['passed', 'failed', 'gave_up', 'superseded']);
const UNCONFIRMED_PREFLIGHT = new Set(['unavailable', 'stale', 'unverified']);
const DEFAULT_RETAINED_VERDICTS = 50;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RELEASE_GRACE_MS = 30 * 60 * 1000;

function clip(value, maximum = 300) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, maximum);
}

const IN_PROGRESS_STATES = new Set(['BUILDING', 'INITIALIZING', 'QUEUED']);

function deploymentCommitSha(deployment) {
  return String(deployment?.meta?.githubCommitSha || deployment?.gitSource?.sha || '').toLowerCase();
}

// What a person is served is the deployment the production hostname is aliased to, not merely the
// newest production deployment (a newer one may have failed or been cancelled). While a newer
// production deployment is still building, nothing is settled: the alias is about to move.
async function resolveVercelProductionDeployment({ token, projectId, teamId, targetUrl, apiBase = 'https://api.vercel.com', fetchImpl = globalThis.fetch }) {
  if (!token || !projectId || typeof fetchImpl !== 'function') return { status: 'unconfigured' };
  let hostname;
  try { hostname = new URL(targetUrl).hostname; } catch { return { status: 'unconfigured' }; }
  const headers = { Authorization: `Bearer ${token}` };
  const get = async (url) => {
    try {
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
      return { response, body: response.ok ? await response.json().catch(() => ({})) : null };
    } catch (error) {
      return { error: clip(`Vercel deployment lookup failed: ${error instanceof Error ? error.message : error}`) };
    }
  };
  const listQuery = new URLSearchParams({ projectId, target: 'production', limit: '5' });
  if (teamId) listQuery.set('teamId', teamId);
  const listed = await get(`${apiBase}/v6/deployments?${listQuery}`);
  if (listed.error) return { status: 'unavailable', error: listed.error };
  if (!listed.response.ok) return { status: 'unavailable', error: `Vercel deployment lookup returned HTTP ${listed.response.status}` };
  const newest = Array.isArray(listed.body?.deployments) ? listed.body.deployments[0] : null;
  const newestState = String(newest?.state || newest?.readyState || '').toUpperCase();
  if (IN_PROGRESS_STATES.has(newestState)) {
    const sha = deploymentCommitSha(newest);
    return { status: 'settling', state: newestState, sha: SHA_RE.test(sha) ? sha : null };
  }
  const aliasQuery = new URLSearchParams();
  if (teamId) aliasQuery.set('teamId', teamId);
  const served = await get(`${apiBase}/v13/deployments/${encodeURIComponent(hostname)}?${aliasQuery}`);
  if (served.error) return { status: 'unavailable', error: served.error };
  if (!served.response.ok) return { status: 'unavailable', error: `Vercel alias lookup for ${hostname} returned HTTP ${served.response.status}` };
  const deployment = served.body || {};
  if (deployment.projectId !== projectId) return { status: 'unavailable', error: `${hostname} is not served by the configured Vercel project` };
  const state = String(deployment.readyState || deployment.state || '').toUpperCase();
  const sha = deploymentCommitSha(deployment);
  if (state !== 'READY') return { status: 'settling', state: state || 'UNKNOWN', sha: SHA_RE.test(sha) ? sha : null };
  if (!SHA_RE.test(sha)) return { status: 'unavailable', error: 'Production deployment has no Git commit SHA' };
  return {
    status: 'ready',
    sha,
    ref: typeof deployment.meta?.githubCommitRef === 'string' ? deployment.meta.githubCommitRef : null,
    deployment_id: deployment.uid || deployment.id || null,
    ready_at: Number.isFinite(Number(deployment.ready)) ? new Date(Number(deployment.ready)).toISOString() : null,
  };
}

const PREFLIGHT_SEVERITY = ['unavailable', 'stale', 'unverified', 'matched'];

// The control plane, not repository test code, decides whether production serves the tested SHA.
function liveDeploymentPreflight(resolution, expectedSha) {
  const expected = String(expectedSha || '').toLowerCase();
  if (!SHA_RE.test(expected)) return { result: 'unverified', error: 'Expected deployment SHA is missing' };
  if (resolution?.status === 'ready') {
    return resolution.sha === expected
      ? { result: 'matched', sha: resolution.sha }
      : { result: 'stale', sha: resolution.sha, error: `Production serves ${String(resolution.sha).slice(0, 12)}, not ${expected.slice(0, 12)}` };
  }
  if (resolution?.status === 'settling') {
    return { result: 'stale', sha: resolution.sha ?? null, error: `Production deployment is ${clip(resolution.state || 'settling', 40)}` };
  }
  return { result: 'unavailable', error: clip(resolution?.error || `Production deployment lookup is ${resolution?.status || 'unavailable'}`) };
}

function worstPreflight(...results) {
  const present = new Set(results.filter((result) => PREFLIGHT_SEVERITY.includes(result)));
  return PREFLIGHT_SEVERITY.find((result) => present.has(result)) ?? null;
}

function classifyRun(run) {
  if (!run) return { outcome: 'infrastructure', error: 'Dr Bob run record is missing' };
  if (run.status === 'succeeded') return { outcome: 'passed' };
  if (run.status === 'interrupted') return { outcome: 'infrastructure', error: clip(run.error || 'run was interrupted') };
  if (run.status === 'timeout') return { outcome: 'infrastructure', error: 'run timed out' };
  const failedPhase = Array.isArray(run.phases) ? run.phases.find((phase) => phase.status !== 'succeeded') : null;
  // The live preflight could not confirm production serves this SHA: the walk is not evidence about it.
  if (failedPhase?.mode === 'live' && UNCONFIRMED_PREFLIGHT.has(failedPhase.deployment_preflight)) {
    return { outcome: 'infrastructure', error: `live deployment preflight was ${failedPhase.deployment_preflight}` };
  }
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

  // Production moved to another SHA while this one was walked: whatever the walk saw, part of it may
  // have been the newer deployment, so the verdict is superseded (never passed or failed) and the
  // newer SHA gets its own run. Only a confirmed READY production SHA can supersede.
  async function settle(state, run, readyProductionSha) {
    const verdict = classifyRun(run);
    const summary = run?.summary || null;
    const superseded = Boolean(readyProductionSha) && readyProductionSha !== state.sha;
    let next;
    if (superseded) next = { ...state, status: 'superseded', completed_at: iso(), summary, superseded_by: readyProductionSha, run_outcome: verdict.outcome, error: verdict.error ?? null };
    else if (verdict.outcome === 'passed') next = { ...state, status: 'passed', completed_at: iso(), summary };
    else if (verdict.outcome === 'failed') next = { ...state, status: 'failed', completed_at: iso(), summary, failed_phase: verdict.failed_phase, exit_code: verdict.exit_code };
    else next = { ...state, status: state.attempts >= maxAttempts ? 'gave_up' : 'retry', completed_at: iso(), error: verdict.error };
    await writeState(next);
    log({ sha: next.sha, outcome: next.status, run_id: next.run_id, summary, error: next.error ?? null });
    return { sha: next.sha, outcome: next.status, run_id: next.run_id };
  }

  async function settleFinishedRuns(readyProductionSha) {
    let current = null;
    for (const state of await listStates()) {
      if (state?.status !== 'running' || !state.run_id) continue;
      const run = await getRun(state.run_id);
      if (run && (run.status === 'queued' || run.status === 'running')) continue;
      const settled = await settle(state, run, readyProductionSha);
      if (readyProductionSha && state.sha === readyProductionSha) current = settled;
    }
    return current;
  }

  async function tick() {
    if (inFlight) return { outcome: 'busy' };
    inFlight = true;
    try {
      const production = await resolveProduction();
      const settledCurrent = await settleFinishedRuns(production?.status === 'ready' ? production.sha : null);
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

      // Persist the attempt before launching, so a crash between launch and recording the run id
      // still counts it and the retry budget stays bounded across control-plane restarts.
      const previous = state;
      if (Number(state.attempts || 0) >= maxAttempts) {
        state = { ...state, status: 'gave_up', completed_at: iso(), error: state.error || 'retry budget exhausted; the last start was interrupted' };
        await writeState(state);
        log({ sha, outcome: state.status, error: state.error });
        return observe({ sha, outcome: state.status, error: state.error });
      }
      const attempts = Number(state.attempts || 0) + 1;
      state = { ...state, status: 'starting', attempts, starting_at: iso() };
      await writeState(state);
      let started;
      try {
        started = await startRun({ sha });
      } catch (error) {
        const detail = clip(error instanceof Error ? error.message : error);
        if (error?.status === 409) {
          state = { ...previous, status: 'pending', waiting_reason: detail };
          await writeState(state);
          return observe({ sha, outcome: 'waiting_for_source', reason: detail });
        }
        state = { ...state, status: attempts >= maxAttempts ? 'gave_up' : 'retry', attempts, error: detail, completed_at: iso() };
        await writeState(state);
        log({ sha, outcome: state.status, error: detail });
        return observe({ sha, outcome: state.status, error: detail });
      }
      if (started?.existing) {
        await writeState(previous);
        return observe({ sha, outcome: 'waiting_for_active_run', run_id: started.run?.id ?? null });
      }
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

// Which verdicts to forget: only terminal ones beyond the newest `keep`. A pending, starting,
// running, or retrying SHA is never evicted, or its run and retry budget would be lost.
function evictableProductionStates(states, keep = DEFAULT_RETAINED_VERDICTS) {
  return [...states]
    .filter((state) => TERMINAL.has(state?.status))
    .sort((left, right) => String(right.first_seen_at).localeCompare(String(left.first_seen_at)))
    .slice(keep);
}

module.exports = {
  createProductionHumanTestMonitor,
  evictableProductionStates,
  resolveVercelProductionDeployment,
  liveDeploymentPreflight,
  worstPreflight,
  classifyRun,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RELEASE_GRACE_MS,
};
