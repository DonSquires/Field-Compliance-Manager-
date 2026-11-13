const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const load = () => import('../scripts/bob-catalog-refresh-pr.mjs');

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(repo, 'supabase'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src/types'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'supabase/schema.sql'), 'create table a ();\n');
  fs.writeFileSync(path.join(repo, 'src/types/database.ts'), 'export type Database = {}\n');
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(root, 'init', '-q', '--bare', remote);
  return { root, repo, remote, base: git(repo, 'rev-parse', 'HEAD'), git };
}

function fakeApi({ types = 'export type Database = { public: {} }\n', prFiles = ['supabase/schema.sql', 'src/types/database.ts'], mergeOk = true } = {}) {
  const calls = [];
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if (url.includes('/types/typescript')) return json(200, { types });
    if (url.includes('/pulls?state=open')) return json(200, []);
    if (url.endsWith('/pulls') && init.method === 'POST') return json(201, { number: 7 });
    if (url.endsWith('/pulls/7/files')) return json(200, prFiles.map(filename => ({ filename })));
    if (url.endsWith('/pulls/7/merge')) return json(mergeOk ? 200 : 405, mergeOk ? { merged: true, sha: 'm'.repeat(40) } : { message: 'no' });
    return json(404, {});
  };
  return { calls, fetchImpl };
}

const env = remote => ({ SUPABASE_ACCESS_TOKEN: 'x', BOB_GITHUB_ACCESS_TOKEN: 'y', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', BOB_CATALOG_REMOTE: remote });

test('only the two generated catalog files are ever allowed', async () => {
  const { onlyCatalogFiles } = await load();
  assert.equal(onlyCatalogFiles(['supabase/schema.sql']), true);
  assert.equal(onlyCatalogFiles(['supabase/schema.sql', 'src/types/database.ts']), true);
  assert.equal(onlyCatalogFiles([]), false);
  assert.equal(onlyCatalogFiles(['supabase/schema.sql', 'apps/web/src/App.tsx']), false);
});

test('a changed live catalog is committed with the verified identity, pushed, opened and merged', async () => {
  const { refreshCatalog } = await load();
  const fx = fixtureRepo();
  const schema = path.join(fx.root, 'live.sql');
  fs.writeFileSync(schema, 'create table a ();\ncreate table b ();\n');
  const api = fakeApi();
  const result = await refreshCatalog({ repo: fx.repo, base: fx.base, schema, env: env(fx.remote), fetchImpl: api.fetchImpl, log: () => {} });
  assert.equal(result.outcome, 'merged');
  assert.equal(result.number, 7);
  assert.deepEqual(result.files.sort(), ['src/types/database.ts', 'supabase/schema.sql']);
  const branch = `bob/catalog-${fx.base.slice(0, 8)}`;
  const identity = Array(2).fill('Don Squires <256263525+DonSquires@users.noreply.github.com>');
  assert.deepEqual(fx.git(fx.root, `--git-dir=${fx.remote}`, 'log', '-1', '--format=%an <%ae>%n%cn <%ce>', branch).split('\n'), identity);
  assert.match(fx.git(fx.root, `--git-dir=${fx.remote}`, 'show', `${branch}:supabase/schema.sql`), /create table b/);
  const merge = api.calls.find(call => call.url.endsWith('/merge'));
  assert.equal(merge.body.sha, fx.git(fx.root, `--git-dir=${fx.remote}`, 'rev-parse', branch));
  assert.equal(merge.body.merge_method, 'rebase');
  assert.equal(fx.git(fx.repo, 'worktree', 'list').split('\n').length, 1);
});

test('catalog refresh refuses a mismatched configured Git identity before contacting services', async () => {
  const { refreshCatalog } = await load();
  const api = fakeApi();
  for (const mismatch of [
    { GIT_AUTHOR_EMAIL: 'squires.don@gmail.com' },
    { GIT_COMMITTER_NAME: 'GitHub' },
  ]) {
    await assert.rejects(refreshCatalog({
      repo: 'unused',
      base: 'a'.repeat(40),
      schema: 'unused',
      env: { ...env('unused'), ...mismatch },
      fetchImpl: api.fetchImpl,
      log: () => {},
    }), /configured Git identity is not the verified GitHub identity/);
  }
  assert.equal(api.calls.length, 0);
});

test('an unchanged catalog opens nothing', async () => {
  const { refreshCatalog } = await load();
  const fx = fixtureRepo();
  const schema = path.join(fx.root, 'live.sql');
  fs.copyFileSync(path.join(fx.repo, 'supabase/schema.sql'), schema);
  const api = fakeApi({ types: 'export type Database = {}\n' });
  const result = await refreshCatalog({ repo: fx.repo, base: fx.base, schema, env: env(fx.remote), fetchImpl: api.fetchImpl, log: () => {} });
  assert.equal(result.outcome, 'unchanged');
  assert.equal(api.calls.some(call => call.url.includes('api.github.com')), false);
});

test('a pull request that is not catalog-only is left for a person', async () => {
  const { refreshCatalog } = await load();
  const fx = fixtureRepo();
  const schema = path.join(fx.root, 'live.sql');
  fs.writeFileSync(schema, 'create table c ();\n');
  const api = fakeApi({ prFiles: ['supabase/schema.sql', 'apps/web/src/App.tsx'] });
  await assert.rejects(refreshCatalog({ repo: fx.repo, base: fx.base, schema, env: env(fx.remote), fetchImpl: api.fetchImpl, log: () => {} }), /not catalog-only/);
  assert.equal(api.calls.some(call => call.url.endsWith('/merge')), false);
});

test('the release lane hands a changed live catalog to the refresh helper and does not move the pointer', () => {
  const lane = fs.readFileSync(path.resolve(__dirname, '../scripts/bob-release-lane.sh'), 'utf8');
  const start = lane.indexOf('live schema snapshot refreshed and matches');
  const block = lane.slice(start, lane.indexOf('# 6. Record', start));
  assert.match(block, /node scripts\/bob-catalog-refresh-pr\.mjs --repo "\$REPO_DIR" --base "\$HEAD_SHA" --schema "\$live_schema"/);
  assert.match(block, /BOB_CATALOG_REMOTE="\$\{REMOTE_URL:-\}"/);
  assert.match(block, /OK=false/);
});
