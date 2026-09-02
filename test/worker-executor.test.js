const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { dockerArguments, redact, workerCommand } = require('../worker-executor');
const { validatePatchText, changedFilesFromPatch, executeFrontendPatch, frontendVerificationCommands, redactLog } = require('../frontend-worker');

test('worker profiles use fixed commands', () => {
  assert.deepEqual(workerCommand('assessment'), ['node', '/opt/bob/assessment-manifest.js', '/workspace', '/artifacts/system-assessment.json']);
  assert.deepEqual(workerCommand('test'), ['npm', 'test']);
  assert.deepEqual(workerCommand('build'), ['npm', 'run', 'build']);
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

test('frontend verification runs Playwright serially after build and unit checks', () => {
  const e2eCommand = frontendVerificationCommands().at(-1);
  assert.deepEqual(e2eCommand, ['run', 'test:e2e', '--prefix', 'apps/web', '--', '--workers=1', '--reporter=line']);
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
  assert.equal(args.includes('npm'), true);
  assert.equal(args.includes('shell'), false);
  assert.equal(args.includes('/var/run/docker.sock'), false);
});

test('frontend verification executes only in disposable tmpfs while source remains read-only', () => {
  const args = dockerArguments({
    image: 'fcm/bob-worker:test',
    sourceDir: '/tmp/source',
    artifactDir: '/tmp/artifacts',
    profile: 'frontend-verify'
  });
  assert.ok(args.includes('--tmpfs=/work:rw,exec,nosuid,size=1024m'));
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
  fs.writeFileSync(path.join(artifactDir, 'untrusted-output.txt'), 'remove me');
  fs.writeFileSync(path.join(binDir, 'npm'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    const result = executeFrontendPatch({
      sourceDir,
      patchPath: path.join(artifactDir, 'input.patch'),
      artifactDir,
      workDir
    });
    assert.equal(result.succeeded, true);
    assert.equal(fs.readFileSync(path.join(workDir, 'apps/web/src/example.ts'), 'utf8'), 'export const value = 2;\n');
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
