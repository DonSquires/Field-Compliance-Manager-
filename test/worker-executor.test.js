const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { dockerArguments, redact, summarizeHumanTest, workerCommand } = require('../worker-executor');
const { validatePatchText, changedFilesFromPatch, executeFrontendPatch, frontendVerificationCommands, targetedE2eSpecs, E2E_SMOKE_SPECS, redactLog, VERIFICATION_ENV } = require('../frontend-worker');

function writeNpmStub(binDir, source) {
  if (process.platform === 'win32') {
    const scriptPath = path.join(binDir, 'npm.js');
    fs.writeFileSync(scriptPath, source.replace(/^#![^\r\n]*\r?\n/, ''));
    fs.writeFileSync(path.join(binDir, 'npm.cmd'), `@echo off\r\nnode "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`);
    return;
  }
  fs.writeFileSync(path.join(binDir, 'npm'), source, { mode: 0o755 });
}

test('worker profiles use fixed commands', () => {
  assert.deepEqual(workerCommand('assessment'), ['node', '/opt/bob/assessment-manifest.js', '/workspace', '/artifacts/system-assessment.json']);
  assert.deepEqual(workerCommand('test'), ['npm', 'test']);
  assert.deepEqual(workerCommand('build'), ['npm', 'run', 'build']);
  assert.match(workerCommand('human-qa').at(-1), /dr-bob-human-test\.spec\.ts --workers=4/);
  assert.match(workerCommand('human-qa-live').at(-1), /dr-bob-human-test\.spec\.ts --workers=1/);
  assert.match(workerCommand('main-health').at(-1), /npm run lint;.*vite build --outDir=\/tmp\/bob-main-health-dist;.*npm test -- --run;.*npm run test:e2e:ci-smoke/);
  assert.deepEqual(workerCommand('full-page-audit').slice(0, 3), ['sh', '-lc', 'set -eu; npm test; npm run check:css; cp -a /opt/bob/web-node_modules/. /workspace/apps/web/node_modules/; cd /workspace/apps/web; PATH=/workspace/apps/web/node_modules/.bin:$PATH npm run lint; PATH=/workspace/apps/web/node_modules/.bin:$PATH npm test -- --reporter=dot; PATH=/workspace/apps/web/node_modules/.bin:$PATH npm run build; PATH=/workspace/apps/web/node_modules/.bin:$PATH PLAYWRIGHT_OUTPUT_DIR=/artifacts/test-results PLAYWRIGHT_HTML_OUTPUT_DIR=/artifacts/playwright-report playwright test e2e/dr-bob-human-test.spec.ts --workers=1']);
  assert.deepEqual(workerCommand('frontend-verify'), [
    'node', '/opt/bob/frontend-worker.js', '/workspace', '/artifacts/input.patch', '/artifacts'
  ]);
  assert.deepEqual(workerCommand('backend-verify'), [
    'node', '/opt/bob/backend-worker.js', '/workspace', '/artifacts/input.patch', '/artifacts'
  ]);
  assert.deepEqual(workerCommand('security-review'), [
    'node', '/opt/bob/security-worker.js', '/artifacts/validated.patch',
    '/artifacts/changed-files.json', '/artifacts/security-review.json'
  ]);
  assert.throws(() => workerCommand('shell'), /unsupported worker profile/);
});

test('frontend verification uses a bounded Vitest worker pool', () => {
  const testCommand = frontendVerificationCommands().at(-2);
  assert.deepEqual(testCommand, ['run', 'test', '--prefix', 'apps/web', '--', '--pool=threads', '--maxWorkers=1', '--reporter=dot']);
});

test('frontend verification runs Playwright serially after build and unit checks: CI smoke set plus specs targeting the changed files', () => {
  const e2eCommand = frontendVerificationCommands().at(-1);
  assert.deepEqual(e2eCommand, ['run', 'test:e2e', '--prefix', 'apps/web', '--', ...E2E_SMOKE_SPECS, '--project=desktop-chromium', '--workers=1', '--reporter=line', '--ignore-snapshots']);
  // Targeting: a spec whose name or text refers to a changed page/component joins the run (job ecfb4dc4:
  // the full 75-spec suite could not finish inside the lease).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-target-'));
  const webDir = path.join(root, 'apps/web');
  fs.mkdirSync(path.join(webDir, 'e2e'), { recursive: true });
  fs.writeFileSync(path.join(webDir, 'e2e/builder-control-room.spec.ts'), "test('x', () => {});\n");
  fs.writeFileSync(path.join(webDir, 'e2e/reports-hub.spec.ts'), "await page.goto('/builder'); // exercises BuilderControlRoom\n");
  fs.writeFileSync(path.join(webDir, 'e2e/officer-leave.spec.ts'), "test('leave', () => {});\n");
  fs.writeFileSync(path.join(webDir, 'e2e/admin-hub-dispatch.spec.ts'), "BuilderControlRoom\n");
  try {
    const changed = ['apps/web/src/pages/BuilderControlRoomPage.tsx', 'apps/web/src/pages/BuilderControlRoomPage.guard.test.ts'];
    assert.deepEqual(targetedE2eSpecs(changed, webDir), ['e2e/admin-hub-dispatch.spec.ts', 'e2e/builder-control-room.spec.ts', 'e2e/reports-hub.spec.ts']);
    const cmd = frontendVerificationCommands({ changedFiles: changed, webDir }).at(-1);
    assert.deepEqual(cmd.slice(5, 5 + E2E_SMOKE_SPECS.length + 2), [...E2E_SMOKE_SPECS, 'e2e/builder-control-room.spec.ts', 'e2e/reports-hub.spec.ts'], 'a smoke spec is not listed twice');
    assert.deepEqual(targetedE2eSpecs(['apps/web/src/lib/tiny.ts'], webDir), [], 'short stems do not match everything');
    assert.deepEqual(targetedE2eSpecs(['supabase/functions/x/index.ts'], webDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frontend verification supplies deterministic non-secret Supabase test values', () => {
  assert.deepEqual(VERIFICATION_ENV, {
    VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
    VITE_SUPABASE_ANON_KEY: 'playwright-anon-key',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    NODE_OPTIONS: '--max-old-space-size=2048',
    E2E_OFFLINE: '1'
  });
});

test('docker arguments enforce worker isolation', () => {
  const args = dockerArguments({
    image: 'fcm/bob-worker:test',
    sourceDir: '/tmp/source',
    artifactDir: '/tmp/artifacts',
    profile: 'test'
  });
  assert.equal(args.includes('--network=none'), true);
  assert.equal(args.includes('--read-only'), true);
  assert.equal(args.includes('--cap-drop=ALL'), true);
  assert.equal(args.includes('--security-opt=no-new-privileges:true'), true);
  assert.equal(args.includes('--user=1000:1000'), true);
  assert.equal(args.includes('--memory=2g'), true);
  assert.equal(args.includes('--pids-limit=256'), true);
  assert.equal(args.includes('npm'), true);
  assert.equal(args.includes('shell'), false);
  assert.equal(args.includes('/var/run/docker.sock'), false);
});

test('full page audit mounts disposable browser dependencies', () => {
  const args = dockerArguments({
    image: 'fcm/bob-worker:test',
    sourceDir: '/tmp/source',
    artifactDir: '/tmp/artifacts',
    profile: 'full-page-audit'
  });
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--tmpfs=/tmp:rw,noexec,nosuid,size=1024m'));
  assert.ok(args.includes('--tmpfs=/workspace/apps/web/node_modules:rw,exec,nosuid,size=768m,uid=1000,gid=1000,mode=0755'));
  assert.equal(args.some(value => value.includes('docker.sock')), false);
});

test('main health checks run offline in the isolated read-only browser worker', () => {
  const args = dockerArguments({
    image: 'fcm/bob-worker:test',
    sourceDir: '/tmp/source',
    artifactDir: '/tmp/artifacts',
    profile: 'main-health',
    environment: { E2E_OFFLINE: '1' },
  });
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--tmpfs=/workspace/apps/web/node_modules:rw,exec,nosuid,size=768m,uid=1000,gid=1000,mode=0755'));
  assert.equal(args.some((value) => value.includes('/workspace/apps/web/dist')), false);
  assert.ok(args.includes('type=bind,src=/tmp/source,dst=/workspace,readonly'));
  assert.equal(args.some((value) => value.includes('docker.sock')), false);
});

test('human QA forwards only named environment variables without putting values in process arguments', () => {
  const args = dockerArguments({
    image: 'fcm/bob-worker:test',
    sourceDir: '/tmp/source',
    artifactDir: '/tmp/artifacts',
    profile: 'human-qa-live',
    environment: { HUMAN_TEST_LIVE: 'true', HUMAN_TEST_BASE_URL: 'https://example.test', GRANDMASTER_TEST_PASSWORD: 'not-in-argv' }
  });
  assert.deepEqual(args.filter((value, index) => args[index - 1] === '--env'), [
    'HUMAN_TEST_LIVE', 'HUMAN_TEST_BASE_URL', 'GRANDMASTER_TEST_PASSWORD'
  ]);
  assert.equal(args.some(value => value.includes('https://example.test') || value.includes('not-in-argv')), false);
  assert.ok(args.includes('--network=bridge'));
});

test('fixture human QA does not receive live identity variables', () => {
  const args = dockerArguments({
    image: 'fcm/bob-worker:test',
    sourceDir: '/tmp/source',
    artifactDir: '/tmp/artifacts',
    profile: 'human-qa',
    environment: { HUMAN_TEST_LIVE: 'false', E2E_OFFLINE: '1' }
  });
  assert.ok(args.includes('HUMAN_TEST_LIVE'));
  assert.ok(args.includes('E2E_OFFLINE'));
  assert.equal(args.includes('HUMAN_TEST_BASE_URL'), false);
  assert.equal(args.includes('GRANDMASTER_TEST_EMAIL'), false);
  assert.equal(args.includes('GRANDMASTER_TEST_PASSWORD'), false);
  assert.ok(args.includes('--tmpfs=/tmp:rw,noexec,nosuid,size=1024m'));
});

test('human QA summary uses Playwright totals instead of request diagnostics', () => {
  const stdout = [
    '[HUMAN REQUEST SUMMARY] 0 failed requests (0 unique)',
    '  5 failed',
    '  2 skipped',
    '  35 passed (18.1m)'
  ].join('\n');
  assert.deepEqual(summarizeHumanTest({ stdout, stderr: '' }), { passed: 35, failed: 5, skipped: 2 });
});

test('frontend verification executes only in disposable tmpfs while source remains read-only', () => {
  const args = dockerArguments({
    image: 'fcm/bob-worker:test',
    sourceDir: '/tmp/source',
    artifactDir: '/tmp/artifacts',
    profile: 'frontend-verify'
  });
  // node_modules (460 MB) is copied onto this tmpfs, so the web verifier gets a larger one.
  assert.ok(args.includes('--tmpfs=/work:rw,exec,nosuid,size=2048m'));
  assert.ok(args.includes('--tmpfs=/tmp:rw,noexec,nosuid,size=64m'));
  assert.ok(args.includes('type=bind,src=/tmp/source,dst=/workspace,readonly'));
  assert.equal(args.some(value => value.includes('docker.sock')), false);
});

test('backend verification executes only in disposable tmpfs without network or Docker authority', () => {
  const args = dockerArguments({
    image: 'fcm/bob-worker:test',
    sourceDir: '/tmp/source',
    artifactDir: '/tmp/artifacts',
    profile: 'backend-verify'
  });
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--tmpfs=/work:rw,exec,nosuid,size=1024m'));
  assert.ok(args.includes('type=bind,src=/tmp/source,dst=/workspace,readonly'));
  assert.equal(args.some(value => value.includes('docker.sock')), false);
  assert.equal(args.some(value => value.includes('SUPABASE_SERVICE_ROLE_KEY')), false);
});

test('frontend patch validation rejects traversal, binary, and oversized patches', () => {
  assert.throws(() => validatePatchText('diff --git a/../secret b/../secret\n'), /unsafe path/);
  assert.throws(() => validatePatchText('GIT binary patch\n'), /binary patches/);
  assert.throws(() => validatePatchText('x'.repeat(2 * 1024 * 1024 + 1)), /size limit/);
  assert.throws(() => validatePatchText([
    'diff --git a/apps/web/src/context/AuthContext.tsx b/apps/web/src/context/AuthContext.tsx',
    '--- a/apps/web/src/context/AuthContext.tsx',
    '+++ b/apps/web/src/context/AuthContext.tsx'
  ].join('\n')), /protected frontend changes require separate approval/);
});

test('frontend patch manifest extracts normalized changed files', () => {
  const patch = [
    'diff --git a/apps/web/src/App.tsx b/apps/web/src/App.tsx',
    '--- a/apps/web/src/App.tsx',
    '+++ b/apps/web/src/App.tsx',
    'diff --git a/apps/web/src/new.ts b/apps/web/src/new.ts',
    '--- /dev/null',
    '+++ b/apps/web/src/new.ts'
  ].join('\n');
  assert.deepEqual(changedFilesFromPatch(patch), ['apps/web/src/App.tsx', 'apps/web/src/new.ts']);
});

test('frontend worker applies a patch in an ephemeral copy and emits controlled artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-worker-'));
  const sourceDir = path.join(root, 'source');
  const artifactDir = path.join(root, 'artifacts');
  const workDir = path.join(root, 'work');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(path.join(sourceDir, 'apps/web/src'), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, 'scripts'), { recursive: true });
  fs.mkdirSync(artifactDir);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(sourceDir, 'scripts/atlas-refresh.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(sourceDir, 'apps/web/src/example.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(artifactDir, 'input.patch'), [
    'diff --git a/apps/web/src/example.ts b/apps/web/src/example.ts',
    '--- a/apps/web/src/example.ts',
    '+++ b/apps/web/src/example.ts',
    '@@ -1 +1 @@',
    '-export const value = 1;',
    '+export const value = 2;',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(artifactDir, 'untrusted-output.txt'), 'remove me');
  writeNpmStub(binDir, '#!/usr/bin/env node\nprocess.exit(0);\n');
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  try {
    const result = executeFrontendPatch({
      sourceDir,
      patchPath: path.join(artifactDir, 'input.patch'),
      artifactDir,
      workDir
    });
    assert.equal(result.succeeded, true);
    assert.equal(fs.readFileSync(path.join(workDir, 'apps/web/src/example.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const value = 2;\n');
    assert.deepEqual(fs.readdirSync(artifactDir).sort(), [
      'changed-files.json', 'input.patch', 'validated.patch', 'verification.json'
    ]);
    assert.notEqual(result.changed_files[0].before_sha256, result.changed_files[0].after_sha256);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frontend worker preserves relative package binary links in the ephemeral dependency tree', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../frontend-worker.js'), 'utf8');
  assert.match(source, /verbatimSymlinks:\s*true/);
});

test('frontend worker emits verification evidence when a patch cannot apply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-worker-failure-'));
  const sourceDir = path.join(root, 'source');
  const artifactDir = path.join(root, 'artifacts');
  fs.mkdirSync(path.join(sourceDir, 'apps/web/src'), { recursive: true });
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(path.join(sourceDir, 'apps/web/src/example.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(artifactDir, 'input.patch'), [
    'diff --git a/apps/web/src/example.ts b/apps/web/src/example.ts',
    '--- a/apps/web/src/example.ts',
    '+++ b/apps/web/src/example.ts',
    '@@ -1 +1 @@',
    '-export const value = 999;',
    '+export const value = 2;',
    ''
  ].join('\n'));
  try {
    const result = executeFrontendPatch({
      sourceDir,
      patchPath: path.join(artifactDir, 'input.patch'),
      artifactDir,
      workDir: path.join(root, 'work')
    });
    assert.equal(result.succeeded, false);
    assert.equal(fs.existsSync(path.join(artifactDir, 'verification.json')), true);
    assert.equal(fs.existsSync(path.join(artifactDir, 'validated.patch')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frontend verification artifacts redact command output secrets', () => {
  assert.equal(
    redactLog('token=abc123 authorization: Bearer token.value sk-test_123'),
    'token=[REDACTED] authorization=[REDACTED] [REDACTED]'
  );
});

test('worker output redacts common secret formats', () => {
  const output = 'token=abc123 authorization: Bearer token.value sk-test_123';
  assert.equal(redact(output), 'token=[REDACTED] authorization=[REDACTED] [REDACTED]');
});

test('frontend worker re-runs a failing step on the unpatched tree and reports a red baseline as not the patch\'s fault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-worker-baseline-'));
  const sourceDir = path.join(root, 'source');
  const artifactDir = path.join(root, 'artifacts');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(path.join(sourceDir, 'apps/web/src'), { recursive: true });
  fs.mkdirSync(artifactDir);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(sourceDir, 'apps/web/src/example.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(artifactDir, 'input.patch'), [
    'diff --git a/apps/web/src/example.ts b/apps/web/src/example.ts',
    '--- a/apps/web/src/example.ts',
    '+++ b/apps/web/src/example.ts',
    '@@ -1 +1 @@',
    '-export const value = 1;',
    '+export const value = 2;',
    ''
  ].join('\n'));
  // Fake npm: `run test` fails whether or not the patch is applied (main is red); everything else passes.
  writeNpmStub(binDir, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "if (process.argv.includes('test')) { console.log(' FAIL  src/pages/FinanceBureauPage.guard.test.ts > x\\n FAIL  src/pages/NzscvSupplierPage.guard.test.ts [ src/pages/NzscvSupplierPage.guard.test.ts ]'); process.exit(1); }",
    'process.exit(0);',
    ''
  ].join('\n'));
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  try {
    const result = executeFrontendPatch({ sourceDir, patchPath: path.join(artifactDir, 'input.patch'), artifactDir, workDir: path.join(root, 'work') });
    assert.equal(result.succeeded, false);
    assert.equal(result.baseline_failure, true);
    const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir, 'verification.json'), 'utf8'));
    assert.equal(evidence.baseline_failure, true);
    assert.equal(evidence.baseline.checked, true);
    assert.equal(evidence.baseline.also_fails, true);
    assert.deepEqual(evidence.baseline.failing_files, ['src/pages/FinanceBureauPage.guard.test.ts', 'src/pages/NzscvSupplierPage.guard.test.ts']);
    assert.match(evidence.baseline_reason, /^npm run test --prefix apps\/web .* also fails on the pinned commit without this patch .*FinanceBureauPage\.guard\.test\.ts.*; not caused by this change$/);
    // The patch is back in place after the baseline check.
    assert.equal(fs.readFileSync(path.join(root, 'work/apps/web/src/example.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const value = 2;\n');
    const { classifyVerificationFailure } = require('../builder-verification-outcome');
    assert.deepEqual(classifyVerificationFailure(evidence), { infrastructure: false, baseline: true, reason: evidence.baseline_reason });
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
