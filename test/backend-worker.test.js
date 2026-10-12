const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { executeBackendPatch, redactLog } = require('../backend-worker');

function fixture(patchLines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-worker-'));
  const sourceDir = path.join(root, 'source');
  const artifactDir = path.join(root, 'artifacts');
  fs.mkdirSync(path.join(sourceDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, 'supabase/functions/_shared'), { recursive: true });
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(path.join(sourceDir, 'scripts/atlas-refresh.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(sourceDir, 'supabase/functions/_shared/example.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(sourceDir, '.env'), 'SECRET=not-copied\n');
  fs.writeFileSync(path.join(artifactDir, 'input.patch'), patchLines.join('\n'));
  return { root, sourceDir, artifactDir, patchPath: path.join(artifactDir, 'input.patch') };
}

test('backend worker applies a bounded patch in disposable storage and emits explicit evidence', () => {
  const setup = fixture([
    'diff --git a/supabase/functions/_shared/example.js b/supabase/functions/_shared/example.js',
    '--- a/supabase/functions/_shared/example.js',
    '+++ b/supabase/functions/_shared/example.js',
    '@@ -1 +1 @@',
    '-module.exports = 1;',
    '+module.exports = 2;',
    ''
  ]);
  try {
    const result = executeBackendPatch({
      sourceDir: setup.sourceDir,
      patchPath: setup.patchPath,
      artifactDir: setup.artifactDir,
      workDir: path.join(setup.root, 'work')
    });
    assert.equal(result.succeeded, true);
    assert.equal(result.migration_execution.performed, false);
    assert.equal(result.verification_scope, 'static_backend_patch');
    assert.deepEqual(fs.readdirSync(setup.artifactDir).sort(), [
      'backend-verification.json', 'changed-files.json', 'input.patch', 'validated.patch'
    ]);
    assert.notEqual(result.changed_files[0].before_sha256, result.changed_files[0].after_sha256);
    assert.equal(fs.existsSync(path.join(setup.root, 'work/.env')), false);
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});

test('backend worker executes the test files a patch touches and fails when they fail', () => {
  const testPatch = (assertion) => [
    'diff --git a/test/example.test.js b/test/example.test.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/test/example.test.js',
    '@@ -0,0 +1,4 @@',
    "+const test = require('node:test');",
    "+const assert = require('node:assert/strict');",
    "+const value = require('../supabase/functions/_shared/example.js');",
    `+test('example', () => assert.equal(value, ${assertion}));`,
    ''
  ];
  const passing = fixture(testPatch('1'));
  try {
    const result = executeBackendPatch({ sourceDir: passing.sourceDir, patchPath: passing.patchPath, artifactDir: passing.artifactDir, workDir: path.join(passing.root, 'work') });
    assert.equal(result.succeeded, true, JSON.stringify(result.checks.map(c => [c.command, c.status])));
    const testRun = result.checks.find(check => check.command.startsWith('node --test'));
    assert.equal(testRun.command, 'node --test test/example.test.js');
    assert.equal(testRun.status, 0);
    assert.match(testRun.stdout, /(# |ℹ )pass 1/);
  } finally {
    fs.rmSync(passing.root, { recursive: true, force: true });
  }
  const failing = fixture(testPatch('999'));
  try {
    const result = executeBackendPatch({ sourceDir: failing.sourceDir, patchPath: failing.patchPath, artifactDir: failing.artifactDir, workDir: path.join(failing.root, 'work') });
    assert.equal(result.succeeded, false);
    const testRun = result.checks.find(check => check.command.startsWith('node --test'));
    assert.equal(testRun.status, 1);
    assert.equal(fs.existsSync(path.join(failing.artifactDir, 'validated.patch')), true, 'the patch applied; the evidence records that its tests failed');
  } finally {
    fs.rmSync(failing.root, { recursive: true, force: true });
  }
});

test('backend worker fails closed on JavaScript syntax errors', () => {
  const setup = fixture([
    'diff --git a/supabase/functions/_shared/example.js b/supabase/functions/_shared/example.js',
    '--- a/supabase/functions/_shared/example.js',
    '+++ b/supabase/functions/_shared/example.js',
    '@@ -1 +1 @@',
    '-module.exports = 1;',
    '+module.exports = ;',
    ''
  ]);
  try {
    const result = executeBackendPatch({
      sourceDir: setup.sourceDir,
      patchPath: setup.patchPath,
      artifactDir: setup.artifactDir,
      workDir: path.join(setup.root, 'work')
    });
    assert.equal(result.succeeded, false);
    assert.equal(result.checks.at(-1).command, 'node --check supabase/functions/_shared/example.js');
    assert.equal(fs.existsSync(path.join(setup.artifactDir, 'backend-verification.json')), true);
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});

test('backend worker rejects destructive SQL before copying source', () => {
  const setup = fixture([
    'diff --git a/supabase/migrations/20260830000000_drop.sql b/supabase/migrations/20260830000000_drop.sql',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/supabase/migrations/20260830000000_drop.sql',
    '@@ -0,0 +1 @@',
    '+DROP TABLE public.organizations;',
    ''
  ]);
  try {
    assert.throws(() => executeBackendPatch({
      sourceDir: setup.sourceDir,
      patchPath: setup.patchPath,
      artifactDir: setup.artifactDir,
      workDir: path.join(setup.root, 'work')
    }), /destructive SQL/);
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});

test('backend worker redacts credentials from evidence', () => {
  assert.equal(
    redactLog('token=abc authorization: Bearer secret.value sk-test_123'),
    'token=[REDACTED] authorization=[REDACTED] [REDACTED]'
  );
});
test('backend worker syntax-gates TypeScript/TSX (mobile screens, edge functions) when a TypeScript install is available', () => {
  const tsDir = path.resolve(__dirname, '../apps/web/node_modules/typescript');
  if (!fs.existsSync(tsDir)) return; // no local TypeScript: the worker image carries its own
  const tsxPatch = (body) => [
    'diff --git a/apps/mobile/src/components/Panel.tsx b/apps/mobile/src/components/Panel.tsx',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/apps/mobile/src/components/Panel.tsx',
    `@@ -0,0 +1,${body.length} @@`,
    ...body.map((line) => `+${line}`),
    ''
  ];
  const previous = process.env.BOB_TYPESCRIPT_DIR;
  process.env.BOB_TYPESCRIPT_DIR = tsDir;
  const good = fixture(tsxPatch(["import React from 'react';", 'export const Panel = ({ error }: { error: string | null }) => <span>{error ?? "ok"}</span>;']));
  const bad = fixture(tsxPatch(["import React from 'react';", 'export const Panel = ({ error }: { error: string | null }) => <span>{error ?? "ok"}</span>', 'const = ;']));
  try {
    const ok = executeBackendPatch({ sourceDir: good.sourceDir, patchPath: good.patchPath, artifactDir: good.artifactDir, workDir: path.join(good.root, 'work') });
    assert.equal(ok.succeeded, true, JSON.stringify(ok.checks.map(c => [c.command.slice(0, 40), c.status, c.stderr.slice(0, 200)])));
    assert.ok(ok.checks.some(c => c.command.startsWith('node -e') && c.status === 0), 'the TS syntax gate ran');
    const failed = executeBackendPatch({ sourceDir: bad.sourceDir, patchPath: bad.patchPath, artifactDir: bad.artifactDir, workDir: path.join(bad.root, 'work') });
    assert.equal(failed.succeeded, false);
    const gate = failed.checks.find(c => c.command.startsWith('node -e'));
    assert.equal(gate.status, 1);
    assert.match(gate.stderr, /apps\/mobile\/src\/components\/Panel\.tsx: /);
  } finally {
    if (previous === undefined) delete process.env.BOB_TYPESCRIPT_DIR; else process.env.BOB_TYPESCRIPT_DIR = previous;
    fs.rmSync(good.root, { recursive: true, force: true });
    fs.rmSync(bad.root, { recursive: true, force: true });
  }
});
