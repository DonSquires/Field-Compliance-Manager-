'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HUMAN_SPEC, humanTestSpecs, humanTestInputFiles, runBrowserSpecs, runVibeHumanTest, summarizeHumanReport, uiChangedFiles } = require('../builder-vibe-human-test');
const { dockerArguments, workerCommand, workerNetwork } = require('../worker-executor');

const attachment = findings => ({ name: 'human-test-report.json', contentType: 'application/json', body: Buffer.from(JSON.stringify({ findings })).toString('base64') });

function report() {
  return {
    errors: [],
    suites: [{
      title: 'dr-bob-human-test.spec.ts',
      suites: [{
        title: 'Dr Bob',
        specs: [
          { title: 'admin walk', file: 'dr-bob-human-test.spec.ts', tests: [{ projectName: 'desktop-chromium', status: 'expected', results: [{ attachments: [attachment([{ severity: 'warning', message: 'UX/layout: crowded header', url: '/admin', step: 'open admin' }])] }] }] },
          { title: 'field portal', file: 'dr-bob-human-test.spec.ts', tests: [{ projectName: 'desktop-chromium', status: 'unexpected', results: [{ errors: [{ message: '\u001b[31mError: expect(page).toHaveScreenshot() failed\u001b[0m' }], attachments: [{ name: 'diff', path: '/artifacts/test-results/x/diff.png' }, attachment([{ severity: 'error', message: 'Console error: boom' }, { severity: 'error', message: 'Console error: boom' }])] }] }] },
          { title: 'live route', file: 'dr-bob-human-test.spec.ts', tests: [{ projectName: 'desktop-chromium', status: 'skipped', results: [{}] }] },
        ],
      }],
    }],
  };
}

test('summarizes Playwright JSON into counts, failures, screenshot evidence and deduplicated findings', () => {
  const summary = summarizeHumanReport(report(), '/host/run');
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.complete, true);
  assert.equal(summary.failures[0].title, 'Dr Bob > field portal');
  assert.equal(summary.failures[0].screenshot_mismatch, true);
  assert.deepEqual(summary.failures[0].evidence, ['/host/run/test-results/x/diff.png']);
  assert.deepEqual(summary.errors.map(item => item.message), ['Console error: boom']);
  assert.deepEqual(summary.warnings.map(item => item.message), ['UX/layout: crowded header']);
});

test('an empty or errored report is never complete', () => {
  assert.equal(summarizeHumanReport({ suites: [] }).complete, false);
  assert.equal(summarizeHumanReport({ ...report(), errors: [{ message: 'webServer timed out' }] }).complete, false);
});

test('only browser-visible web files count as UI changes', () => {
  assert.deepEqual(uiChangedFiles(['apps/web/src/a.tsx', 'apps/web/index.html', 'apps/web/public/x.svg', 'apps/web/e2e/a.spec.ts', 'supabase/schema.sql', 'apps/web/package.json']),
    ['apps/web/src/a.tsx', 'apps/web/index.html', 'apps/web/public/x.svg']);
});

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-human-'));
  const ws = path.join(root, 'vibe-abc');
  fs.mkdirSync(path.join(ws, 'apps/web/e2e'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'apps/web', HUMAN_SPEC), '');
  return ws;
}

test('specs always include Dr Bob\'s walk and only existing, well-formed spec paths', () => {
  const ws = workspace();
  assert.deepEqual(humanTestSpecs(ws, []), [HUMAN_SPEC]);
});

test('browser evidence is invalidated by harness/config changes and runs directly edited specs', t => {
  const ws = workspace();
  t.after(() => fs.rmSync(path.dirname(ws), { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, 'apps/web/e2e/human-test-runner.spec.ts'), '');
  const files = ['apps/web/e2e/human-test-runner.spec.ts', 'apps/web/e2e/fixtures.ts', 'apps/web/vite.config.ts', 'apps/web/src/a.css', 'docs/a.md'];
  assert.deepEqual(humanTestInputFiles(files), files.slice(0, 4));
  assert.deepEqual(humanTestSpecs(ws, files), [HUMAN_SPEC, 'e2e/human-test-runner.spec.ts']);
});

for (const kind of ['skipped', 'findings']) test(`a successful worker exit cannot certify ${kind === 'skipped' ? 'an entirely skipped walk' : 'a report with error findings'}`, async t => {
  const ws = workspace();
  t.after(() => fs.rmSync(path.dirname(ws), { recursive: true, force: true }));
  const execute = async options => {
    const data = { errors: [], suites: [{ specs: [{
      file: 'a.spec.ts', title: 'walk', tests: [{ status: kind === 'skipped' ? 'skipped' : 'expected', results: [{
        attachments: [attachment(kind === 'findings' ? [{ severity: 'error', message: 'broken interaction' }] : [])],
      }] }],
    }] }] };
    fs.writeFileSync(path.join(options.artifactDir, 'results.json'), JSON.stringify(data));
    return { status: 'succeeded' };
  };
  const result = await runVibeHumanTest({ workspacePath: ws, image: 'img', execute });
  assert.equal(result.ok, false);
});

test('runs the vibe-human-qa worker offline and maps its report back to the host', async () => {
  const ws = workspace();
  let request;
  const execute = async options => {
    request = options;
    fs.writeFileSync(path.join(options.artifactDir, 'results.json'), JSON.stringify(report()));
    return { status: 'failed', stdout: '1 failed', stderr: '' };
  };
  const result = await runVibeHumanTest({ workspacePath: ws, changedFiles: ['apps/web/src/a.tsx'], reason: 'check', image: 'img', execute, timeoutMs: 1000 });
  assert.equal(request.profile, 'vibe-human-qa');
  assert.equal(request.sourceDir, ws);
  assert.deepEqual(request.environment, { HUMAN_TEST_LIVE: 'false', E2E_OFFLINE: '1' });
  assert.equal(fs.readFileSync(path.join(request.artifactDir, 'specs.txt'), 'utf8'), `${HUMAN_SPEC}\n`);
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.screenshot_mismatches, ['dr-bob-human-test.spec.ts > Dr Bob > field portal']);
  assert.match(result.output_tail, /1 failed/);
  assert.equal(path.dirname(result.evidence_directory), path.join(path.dirname(ws), '.human-test-runs'));
});

test('targeted Playwright specs accept repo-root paths and use the same offline worker', async t => {
  const ws = workspace();
  t.after(() => fs.rmSync(path.dirname(ws), { recursive: true, force: true }));
  const spec = 'e2e/greeting.spec.ts';
  fs.writeFileSync(path.join(ws, 'apps/web', spec), '');
  let request;
  const execute = async options => {
    request = options;
    fs.writeFileSync(path.join(options.artifactDir, 'results.json'), JSON.stringify({
      errors: [], suites: [{ specs: [{ file: 'greeting.spec.ts', title: 'greeting', tests: [{ status: 'expected', results: [{}] }] }] }],
    }));
    return { status: 'succeeded' };
  };
  const result = await runVibeHumanTest({ workspacePath: ws, specs: [`apps/web/${spec}`], reason: 'targeted check', image: 'img', execute });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.scope, 'targeted');
  assert.deepEqual(result.specs, [spec]);
  assert.equal(request.profile, 'vibe-human-qa');
  assert.deepEqual(request.environment, { HUMAN_TEST_LIVE: 'false', E2E_OFFLINE: '1' });
  assert.equal(fs.readFileSync(path.join(request.artifactDir, 'specs.txt'), 'utf8'), `${spec}\n`);
  assert.match(result.note, /does not replace the full human walk/);
});

test('Builder targeted Playwright specs accept repo-root paths and normalize them for the worker', async t => {
  const ws = workspace();
  t.after(() => fs.rmSync(path.dirname(ws), { recursive: true, force: true }));
  const spec = 'e2e/greeting.spec.ts';
  fs.writeFileSync(path.join(ws, 'apps/web', spec), '');
  let request;
  const execute = async options => {
    request = options;
    fs.writeFileSync(path.join(options.artifactDir, 'results.json'), JSON.stringify({
      errors: [], suites: [{ specs: [{ file: 'greeting.spec.ts', title: 'greeting', tests: [{ status: 'expected', results: [{}] }] }] }],
    }));
    return { status: 'succeeded' };
  };
  const result = await runBrowserSpecs({ workspacePath: ws, specs: [`apps/web/${spec}`], reason: 'Builder targeted check', image: 'img', execute });
  assert.equal(result.ok, true);
  assert.deepEqual(result.specs, [spec]);
  assert.equal(fs.readFileSync(path.join(request.artifactDir, 'specs.txt'), 'utf8'), `${spec}\n`);
});

test('targeted browser paths must be existing, regular, bounded spec files', async t => {
  const ws = workspace();
  t.after(() => fs.rmSync(path.dirname(ws), { recursive: true, force: true }));
  const options = { workspacePath: ws, image: 'img', execute: async () => { throw new Error('must not execute'); } };
  await assert.rejects(runVibeHumanTest({ ...options, specs: ['e2e/../secret.spec.ts'] }), /Invalid browser spec/);
  await assert.rejects(runVibeHumanTest({ ...options, specs: ['e2e/missing.spec.ts'] }), /missing or not a regular file/);
  await assert.rejects(runVibeHumanTest({ ...options, specs: Array(7).fill(HUMAN_SPEC) }), /one to six/);
  fs.symlinkSync(path.join(ws, 'apps/web', HUMAN_SPEC), path.join(ws, 'apps/web/e2e/linked.spec.ts'));
  await assert.rejects(runVibeHumanTest({ ...options, specs: ['e2e/linked.spec.ts'] }), /not a regular file/);
});

test('a missing report or worker image fails closed', async () => {
  const ws = workspace();
  const result = await runVibeHumanTest({ workspacePath: ws, image: 'img', execute: async () => ({ status: 'succeeded', stdout: '', stderr: '' }), timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.match(result.report_errors[0], /No readable Playwright report/);
  await assert.rejects(runVibeHumanTest({ workspacePath: ws, image: '', execute: async () => ({}) }), /BOB_WORKER_IMAGE/);
});

test('vibe-human-qa worker is offline, uses tmpfs dependencies and only runs validated spec paths', () => {
  assert.equal(workerNetwork('vibe-human-qa', { BOB_WORKER_NETWORK: 'bob-workers' }), 'none');
  const command = workerCommand('vibe-human-qa').at(-1);
  assert.match(command, /grep -E '\^e2e\/\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\*\\\.spec\\\.ts\$' \/artifacts\/specs\.txt/);
  assert.match(command, /--project=desktop-chromium --workers=2 --global-timeout=1080000 --reporter=line,json/);
  assert.match(command, /PLAYWRIGHT_JSON_OUTPUT_NAME=\/artifacts\/results\.json/);
  const args = dockerArguments({ image: 'img', sourceDir: '/tmp/source', artifactDir: '/tmp/artifacts', profile: 'vibe-human-qa', environment: { HUMAN_TEST_LIVE: 'false', E2E_OFFLINE: '1', GRANDMASTER_TEST_PASSWORD: 'x' } });
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('type=bind,src=/tmp/source,dst=/workspace,readonly'));
  assert.equal(args.includes('GRANDMASTER_TEST_PASSWORD'), false);
});
