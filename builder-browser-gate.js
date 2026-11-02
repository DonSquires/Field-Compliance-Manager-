'use strict';

/**
 * Builder's pre-handoff browser gate. The frontend author used to hand the verifier patches whose
 * Playwright specs it had never run: job 34382d60 added a lazy-chunk recovery spec whose alert never
 * appeared, job 7c6c68b6 broke three bob-panel tests, and each was rejected about fifteen minutes later.
 * The author now runs the specs its change targets (the verifier's targeted set, not the smoke set) in
 * the same offline worker Vibe uses, and finish is refused only for failures that the patch introduced:
 * a test that also fails at the pinned commit is reported as pre-existing, never charged to the author.
 * A run that cannot produce a verdict (no worker, no report, timeout, OOM) is recorded as unavailable
 * and never refuses; the independent verifier stays authoritative either way.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { HUMAN_SPEC, SPEC_PATTERN, humanTestInputFiles, humanTestSpecs } = require('./builder-vibe-human-test');
const { baselineInfo } = require('./builder-visual-baseline');
const { INFRASTRUCTURE_PATTERNS } = require('./builder-verification-outcome');

const MAX_BROWSER_REFUSALS = 2;
const MAX_BROWSER_RUNS = 6;
// A targeted run takes about three minutes and its base comparison about as long again.
const MIN_BROWSER_TIME_MS = 8 * 60_000;
const GLOBAL_TIMEOUT = /Timed out waiting [\d.]+m?s for the (?:entire )?test run/i;

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** The specs the verifier targets for these changed files, Dr Bob's walk excluded. */
function builderBrowserSpecs(workspacePath, changedFiles) {
  const webDir = path.join(workspacePath, 'apps/web');
  const fromBaselines = (changedFiles || []).map(baselineInfo).filter(Boolean).map(info => info.spec);
  return [...new Set([...humanTestSpecs(workspacePath, changedFiles), ...fromBaselines])]
    .filter(spec => spec !== HUMAN_SPEC && SPEC_PATTERN.test(spec) && fs.existsSync(path.join(webDir, spec)))
    .sort();
}

/** A worker result -> keyed failures, or the reason it gave no verdict. */
function classifyBrowserRun(result) {
  if (!result || typeof result !== 'object') return { unavailable: 'the browser worker returned nothing' };
  if (result.error) return { unavailable: clip(result.error, 300) };
  const reportErrors = result.report_errors || [];
  if (reportErrors.some(message => /No readable Playwright report/.test(message))) {
    return { unavailable: `browser worker ${result.status || 'failed'} without a Playwright report${result.output_tail ? `: ${clip(result.output_tail, 300)}` : ''}` };
  }
  if (result.status === 'timeout' || reportErrors.some(message => GLOBAL_TIMEOUT.test(message))) return { unavailable: 'the browser run timed out' };
  const failures = (result.failures || []).map(failure => ({
    key: `${failure.file}::${failure.title}`, file: failure.file, title: failure.title,
    error: clip(failure.error, 600), screenshot_mismatch: Boolean(failure.screenshot_mismatch),
  }));
  if (failures.some(failure => INFRASTRUCTURE_PATTERNS.some(pattern => pattern.test(failure.error)))) {
    return { unavailable: 'a browser test failed on runner resources (memory, timeout or docker), not on an assertion' };
  }
  // A spec that cannot load (bad import, syntax error) fails the whole run with no test result.
  for (const message of reportErrors) {
    failures.push({ key: `load::${clip(message.split('\n')[0], 200)}`, file: null, title: 'Playwright could not load the specs', error: clip(message, 600), screenshot_mismatch: false });
  }
  if (result.status !== 'succeeded' && !failures.length) {
    return { unavailable: `browser worker ${result.status || 'failed'} without a failing test${result.output_tail ? `: ${clip(result.output_tail, 300)}` : ''}` };
  }
  return { failures, passed: Number(result.passed) || 0, flaky: Number(result.flaky) || 0, evidence_directory: result.evidence_directory || null };
}

function describeFailure(failure) {
  const name = failure.file ? `${failure.file} > ${failure.title}` : failure.title;
  return `- ${name}${failure.screenshot_mismatch ? ' [screenshot mismatch]' : ''}\n  ${failure.error.replace(/\n/g, '\n  ')}`;
}

function refusalMessage(verdict, refusal, maxRefusals) {
  const preexisting = verdict.preexisting?.length
    ? `\nAlso failing at the pinned commit (pre-existing, not yours; context only): ${verdict.preexisting.map(failure => failure.file ? `${failure.file} > ${failure.title}` : failure.title).join('; ')}.`
    : '';
  return [
    `finish refused: the browser gate ran the Playwright specs your change targets (${verdict.specs.join(', ')}; offline fixtures, desktop Chromium) and these tests fail with your patch but not at the pinned commit, so the independent verifier would reject it:`,
    verdict.failures.map(describeFailure).join('\n'),
    'Fix the cause: read the failing spec and the component it drives, map each failing assertion to what you changed (route, role, label, text, data-testid, loading/error state, timing), fix it, and run browser_test again before finish. Never delete, skip or weaken an existing assertion to make it pass. When a spec you added asserts something the app does not do, correct the spec against the component source and fixtures. An intentional visual change needs its PNG regenerated with generate_visual_baselines.',
    `Browser refusal ${refusal} of ${maxRefusals}; after that the patch goes to the verifier with these failures recorded.${preexisting}`,
  ].join('\n');
}

function receiptOf(verdict) {
  if (!verdict) return null;
  const name = failure => (failure.file ? `${failure.file} > ${failure.title}` : failure.title);
  return {
    status: verdict.status, specs: verdict.specs || [], reason: verdict.reason || undefined,
    passed: verdict.passed, failures: (verdict.failures || []).map(name),
    preexisting_failures: (verdict.preexisting || []).map(name),
    evidence_directory: verdict.evidence_directory || undefined,
  };
}

/**
 * runSpecs({workspacePath, specs, reason}) runs Playwright in the worker; fingerprint() hashes the
 * changed tree; remainingMs() is the author's wall time left.
 */
function createBrowserGate({ workspacePath, runSpecs, fingerprint, changedFiles, remainingMs = () => Infinity, log = () => {},
  maxRefusals = MAX_BROWSER_REFUSALS, maxRuns = MAX_BROWSER_RUNS, minTimeMs = MIN_BROWSER_TIME_MS }) {
  const verdicts = new Map();
  const baseRuns = new Map();
  let runsUsed = 0;
  let refusals = 0;
  let last = null;

  const runOn = async (dir, specs, reason) => {
    try { return classifyBrowserRun(await runSpecs({ workspacePath: dir, specs, reason })); }
    catch (error) { return { unavailable: clip(error && error.message, 300) }; }
  };
  const isTracked = spec => {
    try { execFileSync('git', ['cat-file', '-e', `HEAD:apps/web/${spec}`], { cwd: workspacePath, stdio: 'ignore' }); return true; }
    catch { return false; }
  };

  // The pinned commit in a throwaway detached worktree (the author never commits, so HEAD is the pin).
  const baseFailures = async (specs) => {
    const key = specs.join('\n');
    if (baseRuns.has(key)) return baseRuns.get(key);
    const dir = path.join(path.dirname(workspacePath), `.browser-base-${path.basename(workspacePath)}-${crypto.randomBytes(4).toString('hex')}`);
    let verdict;
    try {
      execFileSync('git', ['worktree', 'add', '--detach', '--quiet', dir, 'HEAD'], { cwd: workspacePath, stdio: 'ignore' });
      verdict = await runOn(dir, specs, 'Base run of the targeted specs at the pinned commit');
    } catch (error) {
      verdict = { unavailable: `base worktree could not be prepared: ${clip(error && error.message, 200)}` };
    } finally {
      try { execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: workspacePath, stdio: 'ignore' }); }
      catch {
        fs.rmSync(dir, { recursive: true, force: true });
        try { execFileSync('git', ['worktree', 'prune'], { cwd: workspacePath, stdio: 'ignore' }); } catch { /* best effort */ }
      }
    }
    baseRuns.set(key, verdict);
    return verdict;
  };

  const check = async (files, reason) => {
    if (!humanTestInputFiles(files).length) return { status: 'not_applicable', reason: 'no browser-visible change' };
    const specs = builderBrowserSpecs(workspacePath, files);
    if (!specs.length) return { status: 'not_applicable', reason: 'no Playwright spec targets the changed files' };
    const current = fingerprint();
    const cacheKey = current && `${current}::${specs.join(',')}`;
    if (cacheKey && verdicts.has(cacheKey)) return verdicts.get(cacheKey);
    if (runsUsed >= maxRuns) return { status: 'unavailable', specs, reason: `browser run allowance (${maxRuns}) used in this run` };
    if (remainingMs() < minTimeMs) return { status: 'unavailable', specs, reason: 'not enough of the time budget left for a browser run' };
    runsUsed += 1;
    const started = Date.now();
    const patched = await runOn(workspacePath, specs, reason);
    let verdict;
    if (patched.unavailable) {
      verdict = { status: 'unavailable', specs, reason: patched.unavailable };
    } else if (!patched.failures.length) {
      verdict = { status: 'passed', specs, passed: patched.passed, evidence_directory: patched.evidence_directory };
    } else {
      // Only specs that already exist at the pin can fail there; a new spec's failures are the patch's.
      const baseSpecs = [...new Set(patched.failures.filter(failure => failure.file).map(failure => `e2e/${path.basename(failure.file)}`))]
        .filter(spec => specs.includes(spec) && isTracked(spec)).sort();
      const base = baseSpecs.length ? await baseFailures(baseSpecs) : { failures: [] };
      const baseKeys = new Set((base.failures || []).map(failure => failure.key));
      const atBase = failure => failure.file && baseSpecs.includes(`e2e/${path.basename(failure.file)}`);
      if (base.unavailable) {
        // Without a base verdict only failures in specs absent at the pin are certainly the patch's.
        const certain = patched.failures.filter(failure => failure.file && !atBase(failure));
        verdict = certain.length
          ? { status: 'failed', specs, failures: certain, preexisting: [], unresolved: patched.failures.filter(failure => !certain.includes(failure)), reason: `base run unavailable: ${base.unavailable}`, passed: patched.passed, evidence_directory: patched.evidence_directory }
          : { status: 'unavailable', specs, reason: `base run unavailable: ${base.unavailable}`, failures: [], unresolved: patched.failures, passed: patched.passed, evidence_directory: patched.evidence_directory };
      } else {
        const introduced = patched.failures.filter(failure => !baseKeys.has(failure.key));
        const preexisting = patched.failures.filter(failure => baseKeys.has(failure.key));
        verdict = { status: introduced.length ? 'failed' : 'passed_with_preexisting', specs, failures: introduced, preexisting, passed: patched.passed, evidence_directory: patched.evidence_directory };
      }
    }
    verdict.duration_ms = Date.now() - started;
    log({ browser_gate: receiptOf(verdict), duration_ms: verdict.duration_ms });
    if (cacheKey && verdict.status !== 'unavailable') verdicts.set(cacheKey, verdict);
    last = verdict;
    return verdict;
  };

  return {
    /** The browser_test tool: run now and report; never counts as a refusal. */
    async test({ reason } = {}) {
      const verdict = await check(changedFiles(), clip(reason || 'Author check of the targeted Playwright specs', 500));
      const name = failure => (failure.file ? `${failure.file} > ${failure.title}` : failure.title);
      const result = {
        status: verdict.status, specs: verdict.specs || [], reason: verdict.reason,
        passed: verdict.passed,
        failures: (verdict.failures || []).map(failure => ({ test: name(failure), error: failure.error, screenshot_mismatch: failure.screenshot_mismatch || undefined })),
        preexisting_failures: (verdict.preexisting || []).map(name),
        unresolved_failures: (verdict.unresolved || []).map(name),
      };
      if (verdict.status === 'failed') result.next = 'These fail with your patch and not at the pinned commit: fix the cause (never weaken the assertion) and run browser_test again.';
      if (verdict.status === 'unavailable') result.note = 'No browser verdict; the independent verifier still runs these specs.';
      return result;
    },
    /** The finish gate: refuses only patch-introduced failures, at most maxRefusals times. */
    async gate(files) {
      const verdict = await check(files, 'Pre-handoff browser gate');
      if (verdict.status !== 'failed') return { receipt: receiptOf(verdict) };
      if (refusals >= maxRefusals) return { receipt: { ...receiptOf(verdict), handed_off_after_refusals: refusals } };
      refusals += 1;
      return { error: refusalMessage(verdict, refusals, maxRefusals), receipt: receiptOf(verdict) };
    },
    last: () => receiptOf(last),
  };
}

module.exports = { MAX_BROWSER_REFUSALS, MAX_BROWSER_RUNS, MIN_BROWSER_TIME_MS, builderBrowserSpecs, classifyBrowserRun, createBrowserGate };
