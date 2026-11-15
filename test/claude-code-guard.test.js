const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const hooks = path.join(root, '.claude', 'hooks');
const load = (file) => import(pathToFileURL(path.join(hooks, file)).href);

const owner = { 'user.name': 'DonSquires', 'user.email': 'squires.don@gmail.com' };

async function harness({
  config = owner,
  branch = 'feature/x',
  headAuthor = 'DonSquires <squires.don@gmail.com>',
  commitAuthor = () => 'DonSquires <squires.don@gmail.com>',
  rebaseAuthors = () => ['DonSquires <squires.don@gmail.com>'],
} = {}) {
  const { evaluate } = await load('guard.mjs');
  const { loadPolicy } = await load('lib.mjs');
  const policy = loadPolicy();
  const ctx = {
    projectDir: root,
    gitConfig: (key) => config[key] || '',
    currentBranch: () => branch,
    headAuthor: () => headAuthor,
    commitAuthor,
    commitAuthors: (ref) => [commitAuthor(ref)],
    rebaseAuthors,
  };
  return (tool_name, tool_input) => evaluate({ tool_name, tool_input, cwd: root }, policy, ctx);
}

test('edits to regenerated, owner-managed and secret files are denied', async () => {
  const check = await harness();
  assert.match(check('Edit', { file_path: path.join(root, 'supabase', 'schema.sql') }).deny, /schema-snapshot-live/);
  assert.ok(check('Write', { file_path: path.join(root, '.github', 'workflows', 'ci.yml') }).deny);
  assert.ok(check('Write', { file_path: path.join(root, '.env') }).deny);
  assert.ok(check('Write', { file_path: path.join(root, 'deploy', 'laptop-worker', 'laptop-worker.env') }).deny);
  assert.ok(check('Write', { file_path: '/var/lib/bob/control-plane.env' }).deny, 'secret env files are protected outside the repo too');
  assert.equal(check('Write', { file_path: path.join(root, '.env.example') }), null);
  assert.equal(check('Edit', { file_path: path.join(root, 'supabase', 'migrations', '20990101000000_x.sql') }), null);
  assert.equal(check('Edit', { file_path: path.join(root, 'apps', 'web', 'src', 'vite-env.d.ts') }), null);
});

test('shell writes into protected paths are denied, reads and safe redirects are not', async () => {
  const check = await harness();
  assert.ok(check('Bash', { command: 'echo x > supabase/schema.sql' }).deny);
  assert.ok(check('Bash', { command: 'cat a | tee -a .github/workflows/ci.yml' }).deny);
  assert.ok(check('Bash', { command: "sed -i 's/a/b/' supabase/schema.sql" }).deny);
  assert.ok(check('Bash', { command: 'cp deploy/x.env.example .env' }).deny);
  assert.equal(check('Bash', { command: 'grep -n wf_runs supabase/schema.sql 2>&1 > /dev/null' }), null);
  assert.equal(check('Bash', { command: 'node scripts/check-migration-versions.js > out.txt' }), null);
  assert.ok(check('Bash', { command: `node -e "require('fs').writeFileSync('supabase/schema.sql', 'bad')"` })?.deny, 'inline code that writes a protected path is denied');
  assert.ok(check('Bash', { command: `python -c "open('.github/workflows/ci.yml', 'w').write('bad')"` })?.deny);
  assert.equal(check('Bash', { command: `node -e "console.log('.env.example')"` }), null);
});

test('commits must use the verified release identity', async () => {
  const wrong = await harness({ config: { 'user.name': 'Someone', 'user.email': 'don@squires.local' } });
  assert.match(wrong('Bash', { command: 'git commit -m "x"' }).deny, /git config user.email "squires\.don@gmail\.com"/);
  assert.equal(wrong('Bash', { command: 'git -c user.name=DonSquires -c user.email=squires.don@gmail.com commit -m x' }), null);
  const obsolete = await harness({ config: { 'user.name': 'Don Squires', 'user.email': '256263525+DonSquires@users.noreply.github.com' } });
  assert.ok(obsolete('Bash', { command: 'git commit -m "x"' }).deny);
  const right = await harness();
  assert.equal(right('Bash', { command: 'git add -A && git commit -m "feat: x"' }), null);
  assert.ok(right('Bash', { command: 'git commit --author="Bot <bot@example.com>" -m x' }).deny);
  assert.equal(right('Bash', { command: 'git status && git log -1' }), null);
});

test('pushes to the protected branch are denied; feature-branch pushes are allowed', async () => {
  const onFeature = await harness();
  assert.ok(onFeature('Bash', { command: 'git push origin main' }).deny);
  assert.ok(onFeature('Bash', { command: 'git push origin HEAD:refs/heads/main' }).deny);
  assert.ok(onFeature('Bash', { command: 'git push --force origin +feature/x:main' }).deny);
  assert.ok(onFeature('Bash', { command: 'git push --all origin' }).deny);
  assert.equal(onFeature('Bash', { command: 'git push -u origin HEAD' }), null);
  assert.equal(onFeature('Bash', { command: 'git push origin main --dry-run' }), null);
  const onMain = await harness({ branch: 'main' });
  assert.ok(onMain('Bash', { command: 'git push' }).deny);
});

test('push repo options do not hide protected-branch refspecs', async () => {
  const onFeature = await harness();
  assert.ok(onFeature('Bash', { command: 'git push --repo=origin main' })?.deny);
  assert.ok(onFeature('Bash', { command: 'git push --repo origin main' })?.deny);
});

test('author-preserving git operations reject commits authored by another identity', async () => {
  const foreignAuthor = 'Automation Bot <bot@example.com>';
  const check = await harness({
    headAuthor: foreignAuthor,
    commitAuthor: () => foreignAuthor,
    rebaseAuthors: () => [foreignAuthor],
  });
  assert.ok(check('Bash', { command: 'git cherry-pick abc123' })?.deny);
  assert.ok(check('Bash', { command: 'git rebase origin/main' })?.deny);
  assert.ok(check('Bash', { command: 'git commit --amend -m "amend"' })?.deny);
  assert.ok(check('Bash', { command: 'git rebase --onto new-base origin/main' })?.deny);
});

test('Atlas preflight validates names before interpolating SQL literals', () => {
  const skill = fs.readFileSync(path.join(root, '.claude', 'skills', 'atlas-preflight', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(skill.includes('Before any query, validate the target name against `^[A-Za-z0-9_.:-]{1,200}$`'));
  assert.ok(skill.includes('Reject quotes,\nsemicolons, wildcards, whitespace and SQL syntax'));
});

test('post-edit checks map paths to commands from policy data', async () => {
  const { checksFor } = await load('post-edit-checks.mjs');
  const { loadPolicy } = await load('lib.mjs');
  const policy = loadPolicy();
  assert.deepEqual(checksFor('supabase/migrations/20990101000000_x.sql', policy).map((c) => c.command), ['npm run check:migrations']);
  assert.deepEqual(checksFor('apps/web/src/pages/X.tsx', policy).map((c) => c.command), ['npm run check:css']);
  assert.deepEqual(checksFor('README.md', policy), []);
  for (const check of policy.postEditChecks) {
    const script = check.command.replace(/^npm run /, '');
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts[script], `${check.command} exists`);
  }
});

test('the guard hook speaks the Claude Code hook protocol end to end', () => {
  const run = spawnSync(process.execPath, [path.join(hooks, 'guard.mjs')], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(root, 'supabase', 'schema.sql') }, cwd: root }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(run.status, 0);
  const out = JSON.parse(run.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const allowed = spawnSync(process.execPath, [path.join(hooks, 'guard.mjs')], {
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'README.md') }, cwd: root }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');
});

test('project settings wire both hooks and the context7 server', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /guard\.mjs/);
  assert.match(settings.hooks.PostToolUse[0].hooks[0].command, /post-edit-checks\.mjs/);
  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.deepEqual(settings.enabledMcpjsonServers, Object.keys(mcp.mcpServers));
});

test('Bob gets the preflight and reviewer methods as retrievable platform cards', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261111100000_builder_preflight_review_cards.sql'), 'utf8');
  assert.match(sql, /existing\.organization_id IS NULL AND existing\.key = card\.key AND existing\.is_active/);
  const cards = [...sql.matchAll(/\('discipline', '([a-z_]+)',[\s\S]*?\$\$([\s\S]*?)\$\$,\s*ARRAY\[([^\]]*)\]\)/g)]
    .map(([, key, content, tags]) => ({ key, content, tags: tags.split(',').map((tag) => tag.trim().replace(/'/g, '')) }));
  assert.deepEqual(cards.map((card) => card.key), ['atlas_preflight_report', 'canon_conformance_review', 'ux_states_review']);
  for (const card of cards) {
    assert.ok(card.content.length <= 2500, `${card.key} fits the per-card retrieval cap`);
    for (const surface of ['builder', 'vibe', 'in_app_bob']) assert.ok(card.tags.includes(surface), `${card.key} reaches ${surface}`);
    assert.ok(!card.tags.includes('independent_code_review'), `${card.key} leaves the reviewer's four-card limit untouched`);
  }
});
