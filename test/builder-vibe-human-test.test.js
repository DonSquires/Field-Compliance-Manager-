'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HUMAN_SPEC, humanTestSpecs, runVibeHumanTest, summarizeHumanReport, uiChangedFiles } = require('../builder-vibe-human-test');
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
  assert.match(command, /--project=desktop-chromium --workers=2 --reporter=line,json/);
  assert.match(command, /PLAYWRIGHT_JSON_OUTPUT_NAME=\/artifacts\/results\.json/);
  const args = dockerArguments({ image: 'img', sourceDir: '/tmp/source', artifactDir: '/tmp/artifacts', profile: 'vibe-human-qa', environment: { HUMAN_TEST_LIVE: 'false', E2E_OFFLINE: '1', GRANDMASTER_TEST_PASSWORD: 'x' } });
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('type=bind,src=/tmp/source,dst=/workspace,readonly'));
  assert.equal(args.includes('GRANDMASTER_TEST_PASSWORD'), false);
});
