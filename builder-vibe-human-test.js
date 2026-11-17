'use strict';

/**
 * Dr Bob's human browser test against a Vibe workspace (fixture mode only). Runs either the
 * full walk plus specs targeting changed web files, or explicitly selected diagnostic specs, in
 * the sandboxed worker image with no network. Live mode needs a deployed SHA and a dedicated
 * test identity, so it stays on the governed /api/bob/human-tests path.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pngEvidence } = require('./builder-visual-baseline');
const { executeWorker } = require('./worker-executor');
const { targetedE2eSpecs } = require('./frontend-worker');

const HUMAN_SPEC = 'e2e/dr-bob-human-test.spec.ts';
const SPEC_PATTERN = /^e2e\/[A-Za-z0-9][A-Za-z0-9._-]*\.spec\.ts$/;
const SCREENSHOT_FAILURE = /toHaveScreenshot|screenshot comparison|snapshot doesn't exist|pixels? \(ratio|different from the expected/i;
const RETAINED_RUNS = 6;
let queue = Promise.resolve();

const stripAnsi = value => String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
const clip = (value, max) => {
  const text = stripAnsi(value).trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const clipTail = (value, max) => {
  const text = stripAnsi(value).trim();
  return text.length > max ? `…${text.slice(-max)}` : text;
};
const streamText = items => (items || []).map(item => item?.text ?? (item?.buffer ? Buffer.from(item.buffer, 'base64').toString('utf8') : '')).join('');

// Playwright's error-context attachment is the page snapshot at the moment of failure.
function readErrorContext(attachments, artifactDir) {
  const item = (attachments || []).find(attachment => attachment.name === 'error-context');
  if (!item) return '';
  try {
    if (item.body) return Buffer.from(item.body, 'base64').toString('utf8');
    if (item.path && artifactDir && item.path.startsWith('/artifacts/')) return fs.readFileSync(path.join(artifactDir, item.path.slice('/artifacts/'.length)), 'utf8');
  } catch { /* evidence that cannot be read is simply absent */ }
  return '';
}

/** Web source changes that a person would see in the browser. */
function uiChangedFiles(files) {
  return (files || []).filter(file => /^apps\/web\/(?:src\/|index\.html$|public\/)/.test(String(file)));
}

function humanTestInputFiles(files) {
  return (files || []).filter(file => uiChangedFiles([file]).length
    || /^apps\/web\/(?:e2e\/|(?:vite|playwright)\.config\.ts$|package(?:-lock)?\.json$)/.test(String(file)));
}

function humanTestSpecs(workspacePath, changedFiles) {
  const webDir = path.join(workspacePath, 'apps/web');
  const changedSpecs = (changedFiles || []).filter(file => /^apps\/web\/e2e\/[^/]+\.spec\.ts$/.test(file))
    .map(file => file.slice('apps/web/'.length));
  const specs = [HUMAN_SPEC, ...changedSpecs, ...targetedE2eSpecs(changedFiles, webDir)];
  return [...new Set(specs)].filter(spec => SPEC_PATTERN.test(spec) && fs.existsSync(path.join(webDir, spec)));
}

function normalizeBrowserSpecPath(spec) {
  if (typeof spec !== 'string') return null;
  const normalized = spec.startsWith('apps/web/') ? spec.slice('apps/web/'.length) : spec;
  return SPEC_PATTERN.test(normalized) ? normalized : null;
}

const isBrowserSpecPath = spec => normalizeBrowserSpecPath(spec) !== null;

function validateBrowserSpecs(workspacePath, specs) {
  if (!Array.isArray(specs) || !specs.length || specs.length > 6) throw new Error('Provide one to six exact Playwright spec paths under e2e/.');
  const webDir = path.join(workspacePath, 'apps/web');
  const normalizedSpecs = specs.map(spec => {
    const normalized = normalizeBrowserSpecPath(spec);
    if (!normalized) throw new Error(`Invalid browser spec path: ${String(spec)}`);
    const file = path.join(webDir, normalized);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`Browser spec is missing or not a regular file: ${normalized}`);
    const relative = path.relative(fs.realpathSync(webDir), fs.realpathSync(file));
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`Browser spec is outside the workspace: ${normalized}`);
    return normalized;
  });
  return [...new Set(normalizedSpecs)];
}

function compareSnapshotFailures({ base, draft, baseSha, evidenceRoot }) {
  if (!baseSha || base?.revision !== 'base' || draft?.revision !== 'worktree'
    || base.base_sha !== baseSha || draft.base_sha !== baseSha || base.source_fingerprint !== baseSha
    || base.complete !== true || draft.complete !== true || base.status !== 'failed' || draft.status !== 'failed'
    || (base.report_errors || []).length || (draft.report_errors || []).length
    || !Array.isArray(base.specs) || !Array.isArray(draft.specs) || !Array.isArray(base.failures) || !Array.isArray(draft.failures)
    || !draft.specs.every(spec => base.specs.includes(spec)) || !evidenceRoot) return [];
  const hashes = (failure, result) => {
    const files = Array.isArray(failure.evidence) ? failure.evidence : [];
    const read = suffix => {
      const matches = files.filter(file => typeof file === 'string' && path.basename(file).endsWith(suffix));
      if (matches.length !== 1 || !path.isAbsolute(matches[0]) || !path.isAbsolute(result.evidence_directory || '')) return null;
      const runRelative = path.relative(evidenceRoot, result.evidence_directory);
      const fileRelative = path.relative(result.evidence_directory, matches[0]);
      if (!runRelative || runRelative.startsWith(`..${path.sep}`) || runRelative === '..' || path.isAbsolute(runRelative)
        || !fileRelative || fileRelative.startsWith(`..${path.sep}`) || fileRelative === '..' || path.isAbsolute(fileRelative)) return null;
      const relative = path.relative(evidenceRoot, matches[0]).split(path.sep).join('/');
      if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return null;
      try { return pngEvidence(evidenceRoot, relative).sha256; } catch { return null; }
    };
    return { actual: read('-actual.png'), diff: read('-diff.png') };
  };
  const matched = [];
  for (const failure of draft.failures) {
    if (!failure.screenshot_mismatch || typeof failure.file !== 'string' || typeof failure.title !== 'string' || typeof failure.project !== 'string') continue;
    if (!draft.specs.some(spec => path.posix.basename(spec) === failure.file)) continue;
    const candidates = base.failures.filter(item => item.screenshot_mismatch && item.file === failure.file && item.title === failure.title && item.project === failure.project);
    if (candidates.length !== 1) continue;
    const before = hashes(candidates[0], base);
    const after = hashes(failure, draft);
    if (before.actual && before.diff && before.actual === after.actual && before.diff === after.diff) {
      matched.push({ file: failure.file, title: failure.title, project: failure.project, actual_sha256: after.actual, diff_sha256: after.diff });
    }
  }
  return matched.slice(0, 20);
}

function decodeAttachment(attachment) {
  try {
    if (attachment.body) return JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'));
  } catch { /* unreadable attachment is reported as missing findings */ }
  return null;
}

/** Playwright JSON report -> counts, failing tests (screenshot mismatches flagged) and Dr Bob's findings. */
function summarizeHumanReport(report, artifactDir = null) {
  const tests = [];
  const findings = [];
  // Root suites are files (spec.file already names them); nested suites are describe() blocks.
  const visit = (suite, ancestors, root = false) => {
    const parents = root ? ancestors : [...ancestors, suite.title || ''];
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const result = test.results?.at(-1) || {};
        const errors = result.errors?.length ? result.errors : result.error ? [result.error] : [];
        const error = errors.map(item => item.message || item.value || '').join('\n');
        const entry = {
          file: spec.file, title: [...parents, spec.title].filter(Boolean).join(' > '), project: test.projectName,
          status: test.status === 'unexpected' ? 'failed' : test.status === 'skipped' ? 'skipped' : test.status === 'flaky' ? 'flaky' : 'passed',
        };
        if (entry.status === 'failed') {
          entry.error = clip(error, 600);
          entry.screenshot_mismatch = SCREENSHOT_FAILURE.test(stripAnsi(error));
          if (Number.isFinite(result.duration)) entry.duration_ms = result.duration;
          const output = clipTail(`${streamText(result.stdout)}${streamText(result.stderr)}`, 1500);
          if (output) entry.output = output;
          const errorContext = clip(readErrorContext(result.attachments, artifactDir), 1500);
          if (errorContext) entry.error_context = errorContext;
          const evidence = (result.attachments || []).filter(item => item.path && /\.png$/i.test(item.path)).map(item => item.path);
          if (evidence.length) entry.evidence = evidence.slice(0, 3).map(file => artifactDir && file.startsWith('/artifacts/') ? path.join(artifactDir, file.slice('/artifacts/'.length)) : file);
        }
        tests.push(entry);
        for (const attachment of result.attachments || []) {
          if (attachment.name !== 'human-test-report.json') continue;
          const body = decodeAttachment(attachment);
          for (const finding of body?.findings || []) {
            findings.push({ severity: finding.severity, message: clip(finding.message, 300), url: clip(finding.url, 200), step: clip(finding.step, 160), test: entry.title });
          }
        }
      }
    }
    for (const child of suite.suites || []) visit(child, parents);
  };
  for (const suite of report?.suites || []) visit(suite, [], true);
  const count = status => tests.filter(test => test.status === status).length;
  const unique = new Map();
  for (const finding of findings) {
    const key = `${finding.severity}::${finding.message}`;
    if (!unique.has(key)) unique.set(key, finding);
  }
  const deduped = [...unique.values()];
  const reportErrors = (report?.errors || []).map(error => clip(error.message || error.value || '', 600)).filter(Boolean);
  return {
    passed: count('passed'), failed: count('failed'), skipped: count('skipped'), flaky: count('flaky'),
    complete: tests.length > 0 && !reportErrors.length,
    failures: tests.filter(test => test.status === 'failed').slice(0, 12),
    errors: deduped.filter(finding => finding.severity === 'error').slice(0, 15),
    warnings: deduped.filter(finding => finding.severity !== 'error').slice(0, 15),
    report_errors: reportErrors.slice(0, 5),
  };
}

function pruneRuns(root, prefix) {
  try {
    const runs = fs.readdirSync(root).filter(name => name.startsWith(prefix))
      .map(name => ({ name, time: fs.statSync(path.join(root, name)).mtimeMs }))
      .sort((left, right) => right.time - left.time);
    for (const run of runs.slice(RETAINED_RUNS)) fs.rmSync(path.join(root, run.name), { recursive: true, force: true });
  } catch { /* retention is best-effort */ }
}

async function runOnce({ workspacePath, changedFiles, reason, image, execute, timeoutMs, requestedSpecs, artifactLabel, authorSpecs }) {
  if (!image) throw new Error('Human test worker image is not configured (BOB_WORKER_IMAGE)');
  const targeted = requestedSpecs !== undefined || Boolean(authorSpecs);
  const specs = authorSpecs
    ? [...new Set(authorSpecs.map(normalizeBrowserSpecPath).filter(Boolean))].filter(spec => fs.existsSync(path.join(workspacePath, 'apps/web', spec)))
    : targeted ? validateBrowserSpecs(workspacePath, requestedSpecs) : humanTestSpecs(workspacePath, changedFiles);
  if (!targeted && !specs.includes(HUMAN_SPEC)) throw new Error(`${HUMAN_SPEC} is missing from the workspace`);
  if (!specs.length) throw new Error('No Playwright spec to run in this workspace');
  const root = path.join(path.dirname(workspacePath), '.human-test-runs');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const prefix = `${path.basename(artifactLabel || workspacePath)}-`;
  pruneRuns(root, prefix);
  const artifactDir = fs.mkdtempSync(path.join(root, prefix));
  fs.writeFileSync(path.join(artifactDir, 'specs.txt'), `${specs.join('\n')}\n`, { mode: 0o644 });
  fs.writeFileSync(path.join(artifactDir, 'request.json'), JSON.stringify({ specs, changed_files: changedFiles, reason: clip(reason, 500), mode: 'fixture' }), { mode: 0o600 });
  const started = Date.now();
  const result = await execute({
    image, sourceDir: workspacePath, artifactDir, profile: 'vibe-human-qa',
    environment: { HUMAN_TEST_LIVE: 'false', E2E_OFFLINE: '1' },
    timeoutMs, memory: '4g', cpus: '2', pidsLimit: 1024,
  });
  const reportPath = path.join(artifactDir, 'results.json');
  let summary;
  try {
    summary = summarizeHumanReport(JSON.parse(fs.readFileSync(reportPath, 'utf8')), artifactDir);
  } catch {
    summary = { passed: 0, failed: 0, skipped: 0, flaky: 0, complete: false, failures: [], errors: [], warnings: [], report_errors: ['No readable Playwright report was produced.'] };
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const ok = result.status === 'succeeded' && summary.complete && summary.passed > 0 && summary.failed === 0 && summary.errors.length === 0;
  return {
    ok,
    status: result.status,
    mode: 'fixture',
    scope: targeted ? 'targeted' : 'human_walk',
    specs,
    duration_ms: Date.now() - started,
    ...summary,
    screenshot_mismatches: summary.failures.filter(test => test.screenshot_mismatch).map(test => `${test.file} > ${test.title}`),
    output_tail: ok ? undefined : clip(output.slice(-2500), 2500),
    evidence_directory: artifactDir,
    note: authorSpecs
      ? 'Offline fixture run of the named Playwright specs on this tree (desktop). It is browser evidence for the author, not the independent verification or a merge approval.'
      : targeted
        ? 'Offline targeted fixture browser check (desktop). This does not replace the full human walk or publication verification.'
      : 'Offline fixture walk of the rendered app on this branch (desktop). It is browser evidence for the change, not a live tenant test or merge approval.',
  };
}

/** Serialised: one browser walk at a time keeps the VPS within memory. */
function runVibeHumanTest({ workspacePath, changedFiles = [], reason = '', specs, artifactLabel, image = process.env.BOB_WORKER_IMAGE, execute = executeWorker,
  timeoutMs = Math.max(19 * 60_000, Number(process.env.BOB_VIBE_HUMAN_TEST_TIMEOUT_MS || 20 * 60_000)) }) {
  const run = queue.then(() => runOnce({ workspacePath, changedFiles, reason, image, execute, timeoutMs, requestedSpecs: specs, artifactLabel }));
  queue = run.catch(() => {});
  return run;
}

/** Builder's author runs exactly the named specs (no Dr Bob walk) in the same offline worker and queue. */
function runBrowserSpecs({ workspacePath, specs, reason = '', image = process.env.BOB_WORKER_IMAGE, execute = executeWorker,
  timeoutMs = Math.max(5 * 60_000, Number(process.env.BOB_BUILDER_BROWSER_TEST_TIMEOUT_MS || 15 * 60_000)) }) {
  if (!Array.isArray(specs) || !specs.length) return Promise.reject(new Error('specs are required'));
  const run = queue.then(() => runOnce({ workspacePath, changedFiles: [], reason, image, execute, timeoutMs, authorSpecs: specs }));
  queue = run.catch(() => {});
  return run;
}

module.exports = { HUMAN_SPEC, SPEC_PATTERN, humanTestSpecs, humanTestInputFiles, isBrowserSpecPath, normalizeBrowserSpecPath, validateBrowserSpecs, compareSnapshotFailures, runBrowserSpecs, runVibeHumanTest, summarizeHumanReport, uiChangedFiles };
