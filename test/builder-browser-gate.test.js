'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { builderBrowserSpecs, classifyBrowserRun, createBrowserGate } = require('../builder-browser-gate');
const { runBrowserSpecs } = require('../builder-vibe-human-test');

const PAGE = 'apps/web/src/pages/UserManagementPage.tsx';
const SPEC = 'apps/web/e2e/user-identity.spec.ts';
const PREEXISTING = { file: 'user-identity.spec.ts', title: 'identity preset screenshot', error: 'Error: expect(page).toHaveScreenshot() failed: 1200 pixels (ratio 0.01) are different', screenshot_mismatch: true };
const INTRODUCED = { file: 'user-identity.spec.ts', title: 'administrator recovers from a lazy users chunk failure', error: 'Error: expect(locator).toBeVisible() failed\nLocator: getByRole(\'main\').getByRole(\'alert\')', screenshot_mismatch: false };

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-browser-gate-'));
  const workspacePath = path.join(root, 'bob-job-gate');
  const git = (args, cwd = workspacePath) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.mkdirSync(path.join(workspacePath, 'apps/web/e2e'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'apps/web/src/pages'), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, PAGE), 'export function UserManagementPage() { return null; }\n');
  fs.writeFileSync(path.join(workspacePath, SPEC), "import { test } from './fixtures';\ntest('UserManagement loads', async () => {});\n");
  fs.writeFileSync(path.join(workspacePath, 'apps/web/e2e/dr-bob-human-test.spec.ts'), "test('walk UserManagement', async () => {});\n");
  fs.writeFileSync(path.join(workspacePath, 'apps/web/e2e/unrelated.spec.ts'), "test('other page', async () => {});\n");
  fs.writeFileSync(path.join(workspacePath, 'lib.js'), 'module.exports = 1;\n');
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'fixture']);
  return { root, workspacePath, git };
}

const changedFiles = (workspacePath) => execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: workspacePath, encoding: 'utf8' })
  .split('\n').filter(Boolean).map(line => line.slice(3)).sort();

// Stands in for the offline Playwright worker: the identity screenshot is red at the pin and with the
// patch; the recovery alert test is red only while the page carries the BROKEN marker.
function fakeWorker() {
  const calls = [];
  const runSpecs = async ({ workspacePath: dir, specs }) => {
    const base = path.basename(dir).startsWith('.browser-base-');
    const page = fs.readFileSync(path.join(dir, PAGE), 'utf8');
    calls.push({ base, specs, page, newSpecPresent: fs.existsSync(path.join(dir, 'apps/web/e2e/new-flow.spec.ts')) });
    const failures = [PREEXISTING];
    if (page.includes('BROKEN')) failures.push(INTRODUCED);
    if (fs.existsSync(path.join(dir, 'apps/web/e2e/new-flow.spec.ts'))) {
      failures.push({ file: 'new-flow.spec.ts', title: 'new flow shows the receipt', error: 'Error: locator.click: Test timeout of 30000ms exceeded.' });
    }
    const requested = failures.filter(failure => specs.includes(`e2e/${failure.file}`));
    return { ok: false, status: 'failed', complete: true, passed: 4, failed: requested.length, flaky: 0, failures: requested, report_errors: [], evidence_directory: '/tmp/evidence' };
  };
  return { runSpecs, calls };
}

test('the Builder browser specs are the verifier\'s targeted set without Dr Bob\'s walk', () => {
  const ws = makeWorkspace();
  try {
    assert.deepEqual(builderBrowserSpecs(ws.workspacePath, [PAGE]), ['e2e/user-identity.spec.ts'], 'a spec naming the changed page is targeted; the human walk is not');
    assert.deepEqual(builderBrowserSpecs(ws.workspacePath, ['apps/web/e2e/unrelated.spec.ts']), ['e2e/unrelated.spec.ts'], 'a changed spec always runs');
    assert.deepEqual(builderBrowserSpecs(ws.workspacePath, ['apps/web/e2e/unrelated.spec.ts-snapshots/home-desktop-chromium-linux.png']), ['e2e/unrelated.spec.ts'], 'a changed PNG baseline runs its spec');
    assert.deepEqual(builderBrowserSpecs(ws.workspacePath, ['lib.js']), []);
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test('the browser gate refuses a failure the patch introduced, names the pre-existing one, and passes once it is fixed (job 34382d60)', async () => {
  const ws = makeWorkspace();
  const worker = fakeWorker();
  const logged = [];
  const gate = createBrowserGate({ workspacePath: ws.workspacePath, runSpecs: worker.runSpecs, fingerprint: () => fs.readFileSync(path.join(ws.workspacePath, PAGE), 'utf8'),
    changedFiles: () => changedFiles(ws.workspacePath), log: entry => logged.push(entry) });
  try {
    fs.writeFileSync(path.join(ws.workspacePath, PAGE), 'export function UserManagementPage() { return null; } // BROKEN\n');
    const refused = await gate.gate([PAGE]);
    assert.match(refused.error, /^finish refused: the browser gate ran the Playwright specs your change targets \(e2e\/user-identity\.spec\.ts/);
    assert.match(refused.error, /administrator recovers from a lazy users chunk failure/);
    assert.match(refused.error, /getByRole\('main'\)\.getByRole\('alert'\)/);
    assert.match(refused.error, /Never delete, skip or weaken an existing assertion/);
    assert.match(refused.error, /pre-existing, not yours[^\n]*identity preset screenshot/);
    assert.match(refused.error, /Browser refusal 1 of 2/);
    assert.equal(refused.receipt.status, 'failed');
    assert.deepEqual(refused.receipt.preexisting_failures, ['user-identity.spec.ts > identity preset screenshot']);

    const base = worker.calls.filter(call => call.base);
    assert.equal(base.length, 1, 'the pinned commit ran once to separate pre-existing failures');
    assert.doesNotMatch(base[0].page, /BROKEN/, 'the base run sees the pinned commit, not the patch');
    assert.deepEqual(fs.readdirSync(ws.root).filter(name => name.startsWith('.browser-base-')), [], 'the base worktree is removed');
    assert.doesNotMatch(ws.git(['worktree', 'list']), /browser-base/);

    const toolView = await gate.test({ reason: 'same tree again' });
    assert.equal(toolView.status, 'failed');
    assert.equal(worker.calls.length, 2, 'a verdict on the same tree is reused, not re-run');

    fs.writeFileSync(path.join(ws.workspacePath, PAGE), 'export function UserManagementPage() { return <main role="alert" />; }\n');
    const passed = await gate.gate([PAGE]);
    assert.equal(passed.error, undefined);
    assert.equal(passed.receipt.status, 'passed_with_preexisting');
    assert.equal(worker.calls.filter(call => call.base).length, 1, 'the base verdict for the same specs is reused');
    assert.ok(logged.some(entry => entry.browser_gate?.status === 'failed'));
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test('a failing spec the patch adds is the patch\'s without a base run; the refusal cap hands off with the failure recorded', async () => {
  const ws = makeWorkspace();
  const worker = fakeWorker();
  let tree = 0;
  const gate = createBrowserGate({ workspacePath: ws.workspacePath, runSpecs: worker.runSpecs, fingerprint: () => `tree-${tree}`, changedFiles: () => changedFiles(ws.workspacePath) });
  try {
    fs.writeFileSync(path.join(ws.workspacePath, 'apps/web/e2e/new-flow.spec.ts'), "test('new flow shows the receipt', async () => {});\n");
    const files = ['apps/web/e2e/new-flow.spec.ts'];
    const first = await gate.gate(files);
    assert.match(first.error, /new-flow\.spec\.ts > new flow shows the receipt/);
    assert.equal(worker.calls.filter(call => call.base).length, 0, 'a spec absent at the pin cannot fail there');
    tree += 1;
    assert.match((await gate.gate(files)).error, /Browser refusal 2 of 2/);
    tree += 1;
    const handedOff = await gate.gate(files);
    assert.equal(handedOff.error, undefined, 'after the cap the verifier decides');
    assert.equal(handedOff.receipt.status, 'failed');
    assert.equal(handedOff.receipt.handed_off_after_refusals, 2);
    assert.deepEqual(handedOff.receipt.failures, ['new-flow.spec.ts > new flow shows the receipt']);
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test('a browser run without a verdict is recorded as unavailable and never refuses finish', async () => {
  const ws = makeWorkspace();
  try {
    fs.writeFileSync(path.join(ws.workspacePath, PAGE), 'export function UserManagementPage() { return null; } // BROKEN\n');
    const outcomes = [
      async () => { throw new Error('Human test worker image is not configured (BOB_WORKER_IMAGE)'); },
      async () => ({ ok: false, status: 'failed', complete: false, passed: 0, failures: [], report_errors: ['No readable Playwright report was produced.'], output_tail: 'docker: Error response from daemon' }),
      async () => ({ ok: false, status: 'timeout', complete: false, passed: 0, failures: [], report_errors: [] }),
      async () => ({ ok: false, status: 'failed', complete: true, passed: 1, failures: [{ file: 'user-identity.spec.ts', title: 'x', error: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' }], report_errors: [] }),
    ];
    for (const runSpecs of outcomes) {
      const gate = createBrowserGate({ workspacePath: ws.workspacePath, runSpecs, fingerprint: () => 'tree', changedFiles: () => [PAGE] });
      const verdict = await gate.gate([PAGE]);
      assert.equal(verdict.error, undefined);
      assert.equal(verdict.receipt.status, 'unavailable');
      assert.ok(verdict.receipt.reason);
    }
    let ran = false;
    const late = createBrowserGate({ workspacePath: ws.workspacePath, runSpecs: async () => { ran = true; return {}; }, fingerprint: () => 'tree', changedFiles: () => [PAGE], remainingMs: () => 60_000 });
    assert.match((await late.gate([PAGE])).receipt.reason, /not enough of the time budget/);
    assert.equal(ran, false);
    const backendOnly = createBrowserGate({ workspacePath: ws.workspacePath, runSpecs: async () => { ran = true; return {}; }, fingerprint: () => 'tree', changedFiles: () => ['lib.js'] });
    assert.equal((await backendOnly.gate(['lib.js'])).receipt.status, 'not_applicable');
    assert.equal(ran, false);
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test('a spec that cannot load is the author\'s failure; a clean run passes', () => {
  const loadError = classifyBrowserRun({ status: 'failed', complete: false, passed: 0, failures: [], report_errors: ["Error: Cannot find module './missing-fixture'"] });
  assert.equal(loadError.unavailable, undefined);
  assert.equal(loadError.failures.length, 1);
  assert.match(loadError.failures[0].key, /^load::Error: Cannot find module/);
  assert.match(classifyBrowserRun({ status: 'failed', complete: false, failures: [], report_errors: ['Timed out waiting 1080s for the entire test run'] }).unavailable, /timed out/);
  assert.deepEqual(classifyBrowserRun({ status: 'succeeded', complete: true, passed: 3, failures: [], report_errors: [] }).failures, []);
});

test('runBrowserSpecs runs exactly the named specs in the offline worker without Dr Bob\'s walk', async () => {
  const ws = makeWorkspace();
  try {
    let request = null;
    const result = await runBrowserSpecs({ workspacePath: ws.workspacePath, specs: ['e2e/user-identity.spec.ts', 'e2e/../../etc.spec.ts', 'e2e/absent.spec.ts'], reason: 'author check', image: 'worker:test',
      execute: async (options) => {
        request = options;
        fs.writeFileSync(path.join(options.artifactDir, 'results.json'), JSON.stringify({ suites: [{ file: 'user-identity.spec.ts', specs: [{ title: 'loads', file: 'user-identity.spec.ts', tests: [{ projectName: 'desktop-chromium', status: 'expected', results: [{}] }] }] }] }));
        return { status: 'succeeded', stdout: '', stderr: '' };
      } });
    assert.equal(request.profile, 'vibe-human-qa');
    assert.deepEqual(request.environment, { HUMAN_TEST_LIVE: 'false', E2E_OFFLINE: '1' });
    assert.equal(fs.readFileSync(path.join(request.artifactDir, 'specs.txt'), 'utf8'), 'e2e/user-identity.spec.ts\n', 'only existing, well-formed specs; no human walk added');
    assert.equal(result.ok, true);
    assert.equal(result.passed, 1);
    await assert.rejects(runBrowserSpecs({ workspacePath: ws.workspacePath, specs: [], image: 'worker:test' }), /specs are required/);
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});
