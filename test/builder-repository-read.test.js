'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { fileSha256, listRepositoryTree, readRepositoryFile, safeRepoPath, searchRepository } = require('../builder-repository-read');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-read-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'rotate-keys.mjs'), "// rotates keys\nexport const rotateKeys = () => 'rotated';\n");
  fs.writeFileSync(path.join(root, 'docs', 'README.md'), '# Docs\nrotate keys nightly\n');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=rotate-keys-token\n');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  fs.mkdirSync(path.join(root, 'apps', 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'web', 'dist', 'bundle.js'), 'rotate rotate rotate\n');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const sha = git('rev-parse', 'HEAD').trim();
  // A later commit that is NOT the pinned sha: reads must come from the pinned tree.
  fs.writeFileSync(path.join(root, 'scripts', 'rotate-keys.mjs'), '// changed later\n');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'later');
  return { root, sha };
}

test('safeRepoPath refuses escapes, absolute paths and secret material', () => {
  assert.equal(safeRepoPath('scripts/a.js'), 'scripts/a.js');
  assert.equal(safeRepoPath('./docs/README.md'), 'docs/README.md');
  assert.equal(safeRepoPath('../etc/passwd'), null);
  assert.equal(safeRepoPath('/etc/passwd'), null);
  assert.equal(safeRepoPath('deploy/.env'), null);
  assert.equal(safeRepoPath('deploy/.env.production'), null);
  assert.equal(safeRepoPath('deploy/laptop-worker/laptop-worker.env'), null);
  assert.equal(safeRepoPath('deploy/laptop-worker/laptop-worker.env.example'), null);
  assert.equal(safeRepoPath('src/environment.ts'), 'src/environment.ts');
  assert.equal(safeRepoPath('keys/server.pem'), null);
  assert.equal(safeRepoPath('deploy/bob-laptop/id_ed25519.pub'), null);
  assert.equal(safeRepoPath('a//b'), null);
});

test('search, file and tree answer from the pinned commit and never expose secret paths', () => {
  const { root, sha } = makeRepo();
  const search = searchRepository({ sourceDir: root, sha, query: 'rotate' });
  assert.deepEqual(search.matches.map((m) => m.path).sort(), ['docs/README.md', 'scripts/rotate-keys.mjs', 'scripts/rotate-keys.mjs']);
  assert.ok(search.matches.every((m) => m.path !== '.env'), '.env matched "rotate" but is filtered');
  assert.ok(search.matches.every((m) => !m.path.includes('/dist/')), 'build output is excluded by default');
  assert.deepEqual(listRepositoryTree({ sourceDir: root, sha }).entries, ['apps', 'blob.bin', 'docs', 'scripts']);
  assert.equal(search.capped, false);
  assert.deepEqual(searchRepository({ sourceDir: root, sha, query: 'rotate', pathspec: 'docs' }).matches.map((m) => m.path), ['docs/README.md']);
  assert.deepEqual(searchRepository({ sourceDir: root, sha, query: 'no-such-token-anywhere' }), { matches: [], count: 0, capped: false });
  const capped = searchRepository({ sourceDir: root, sha, query: 'rotate', limit: 1 });
  assert.equal(capped.matches.length, 1);
  assert.equal(capped.count, 3);
  assert.equal(capped.capped, true);
  assert.throws(() => searchRepository({ sourceDir: root, sha, query: '' }), /query is required/);
  assert.throws(() => searchRepository({ sourceDir: root, sha, query: 'x', pathspec: '../x' }), /path must be/);

  const file = readRepositoryFile({ sourceDir: root, sha, path: 'scripts/rotate-keys.mjs' });
  assert.match(file.content, /rotates keys/, 'pinned tree, not the later commit');
  assert.throws(() => readRepositoryFile({ sourceDir: root, sha, path: 'scripts/missing.mjs' }), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => readRepositoryFile({ sourceDir: root, sha, path: '.env' }), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => readRepositoryFile({ sourceDir: root, sha, path: 'blob.bin' }), (e) => e.code === 'FORBIDDEN');

  assert.deepEqual(listRepositoryTree({ sourceDir: root, sha, path: 'scripts' }).entries, ['rotate-keys.mjs']);
  assert.throws(() => listRepositoryTree({ sourceDir: root, sha, path: 'nope' }), (e) => e.code === 'NOT_FOUND');
  // Exact blob hash at the pinned commit (the "has this change landed on main" fingerprint).
  const crypto = require('node:crypto');
  assert.equal(fileSha256({ sourceDir: root, sha, path: 'scripts/rotate-keys.mjs' }), crypto.createHash('sha256').update("// rotates keys\nexport const rotateKeys = () => 'rotated';\n").digest('hex'));
  assert.equal(fileSha256({ sourceDir: root, sha, path: 'scripts/missing.mjs' }), null);
  assert.equal(fileSha256({ sourceDir: root, sha, path: '../etc/passwd' }), null);
  fs.rmSync(root, { recursive: true, force: true });
});
