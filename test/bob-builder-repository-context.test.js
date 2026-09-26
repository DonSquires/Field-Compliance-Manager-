const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  MAX_TRACKED_FILES,
  boundTrackedFiles,
  directoryCounts,
  collectRepositoryContext
} = require('../supabase/functions/_shared/builder-repository-context');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-context-'));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `${file}\n`);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, sha };
}

test('a repository past the tracked-file cap still yields a bounded build map instead of failing', () => {
  const files = [];
  for (let i = 0; i < MAX_TRACKED_FILES - 10; i += 1) files.push(`apps/web/src/f${String(i).padStart(5, '0')}.ts`);
  for (let i = 0; i < 40; i += 1) files.push(`supabase/migrations/2026${String(i).padStart(4, '0')}_m.sql`);
  files.push('.env.production', 'package.json');
  const { root, sha } = fixture(files);

  const context = collectRepositoryContext({ sourceDir: root, targetSha: sha });

  assert.equal(context.file_count, files.length - 1, 'true count excludes only the secret file');
  assert.equal(context.tracked_files.length, MAX_TRACKED_FILES);
  assert.equal(context.tracked_files_truncated, true);
  assert.ok(context.tracked_files.every(file => !/\.env/.test(file)), 'secret files never enter the inventory');
  assert.ok(context.tracked_files.filter(file => file.startsWith('apps/web/')).length === MAX_TRACKED_FILES - 10, 'source files are kept in full');
  assert.equal(context.tracked_files.filter(file => file.startsWith('supabase/migrations/')).length, 9, 'migrations are the entries trimmed');
  assert.equal(context.directory_counts.apps, MAX_TRACKED_FILES - 10);
  assert.equal(context.directory_counts.supabase, 40);
  assert.equal(context.directory_counts['.'], 1);
  assert.equal(context.secret_files_excluded, true);
});

test('a repository within the cap is reported in full and unflagged', () => {
  const { root, sha } = fixture(['package.json', 'src/a.js', 'supabase/migrations/1_a.sql']);
  const context = collectRepositoryContext({ sourceDir: root, targetSha: sha });
  assert.equal(context.file_count, 3);
  assert.deepEqual(context.tracked_files, ['package.json', 'src/a.js', 'supabase/migrations/1_a.sql']);
  assert.equal(context.tracked_files_truncated, false);
  assert.deepEqual(context.directory_counts, { '.': 1, src: 1, supabase: 1 });
});

test('boundTrackedFiles is a pure, order-preserving trim that only reorders when it must cut', () => {
  const small = ['b/x.js', 'supabase/migrations/1.sql', 'a/y.js'];
  assert.deepEqual(boundTrackedFiles(small), { tracked_files: small, truncated: false });
  const big = Array.from({ length: MAX_TRACKED_FILES + 1 }, (_, i) => (i % 2 ? `supabase/migrations/${i}.sql` : `src/${i}.js`));
  const bounded = boundTrackedFiles(big);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.tracked_files.length, MAX_TRACKED_FILES);
  assert.ok(bounded.tracked_files.filter(f => f.startsWith('src/')).length === big.filter(f => f.startsWith('src/')).length);
  assert.deepEqual(directoryCounts(['a/1', 'a/2', 'b/1', 'root']), { a: 2, '.': 1, b: 1 });
});
