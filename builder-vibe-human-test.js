'use strict';

/**
 * Dr Bob's human browser test against a Vibe workspace (fixture mode only). Runs the offline
 * dr-bob-human-test walk plus the e2e specs that target the changed web files, desktop project,
 * in the sandboxed worker image with no network. Live mode needs a deployed SHA and a dedicated
 * test identity, so it stays on the governed /api/bob/human-tests path.
 */

const fs = require('node:fs');
const path = require('node:path');
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

async function runOnce({ workspacePath, changedFiles, reason, image, execute, timeoutMs }) {
  if (!image) throw new Error('Human test worker image is not configured (BOB_WORKER_IMAGE)');
  const specs = humanTestSpecs(workspacePath, changedFiles);
  if (!specs.includes(HUMAN_SPEC)) throw new Error(`${HUMAN_SPEC} is missing from the workspace`);
  const root = path.join(path.dirname(workspacePath), '.human-test-runs');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const prefix = `${path.basename(workspacePath)}-`;
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
    specs,
    duration_ms: Date.now() - started,
    ...summary,
    screenshot_mismatches: summary.failures.filter(test => test.screenshot_mismatch).map(test => `${test.file} > ${test.title}`),
    output_tail: ok ? undefined : clip(output.slice(-2500), 2500),
    evidence_directory: artifactDir,
    note: 'Offline fixture walk of the rendered app on this branch (desktop). It is browser evidence for the change, not a live tenant test or merge approval.',
  };
}

/** Serialised: one browser walk at a time keeps the VPS within memory. */
function runVibeHumanTest({ workspacePath, changedFiles = [], reason = '', image = process.env.BOB_WORKER_IMAGE, execute = executeWorker,
  timeoutMs = Math.max(19 * 60_000, Number(process.env.BOB_VIBE_HUMAN_TEST_TIMEOUT_MS || 20 * 60_000)) }) {
  const run = queue.then(() => runOnce({ workspacePath, changedFiles, reason, image, execute, timeoutMs }));
  queue = run.catch(() => {});
  return run;
}

module.exports = { HUMAN_SPEC, humanTestSpecs, humanTestInputFiles, runVibeHumanTest, summarizeHumanReport, uiChangedFiles };
