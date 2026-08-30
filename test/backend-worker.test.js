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
  fs.mkdirSync(path.join(sourceDir, 'supabase/functions/_shared'), { recursive: true });
  fs.mkdirSync(artifactDir);
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