const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../scripts/bob-release-lane.sh');

// Live 2026-09-27: a stale .git/gc.log (left by a pruned worktree the day before) made the auto-gc
// after every `git fetch` exit non-zero; the lane read that as "mirror unreachable" for 12 hours
// while main had moved. The lane must not run housekeeping inside its fetch, and must log the
// real reason (without the token) when the fetch does fail.
test('release lane fetches with gc off and logs the real, token-free fetch error', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.equal(spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' }).status, 0, 'bash -n');
  const fetchLine = source.split('\n').find((line) => /fetch -q "\$REMOTE_URL"/.test(line));
  assert.ok(fetchLine, 'the main fetch is present');
  assert.match(fetchLine, /-c gc\.auto=0/);
  assert.doesNotMatch(source, /log "fetch failed: mirror unreachable"/);
  assert.match(source, /fetch failed: \$\(printf '%s' "\$fetch_err" \| sed -e "s\/\$\{GITEA_TOKEN\}\/<token>\/g"/);
  // systemd gives root no HOME, so the global safe.directory is invisible; the script must carry its own.
  assert.match(source, /GIT_CONFIG_KEY_0=safe\.directory GIT_CONFIG_VALUE_0="\$REPO_DIR"/);
  assert.match(source, /GIT_CONFIG_KEY_1=safe\.directory GIT_CONFIG_VALUE_1="\$RELEASES_DIR\/\*"/);
});

test('release lane skips migrations already in the live ledger, and a hand deploy moves its live pointer', () => {
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  const ledgerCheck = lane.indexOf("select version from supabase_migrations.schema_migrations where version = '${version}'");
  const destructiveCheck = lane.indexOf('contains destructive SQL');
  assert.ok(ledgerCheck > 0, 'the ledger is consulted per migration');
  assert.ok(ledgerCheck < destructiveCheck, 'an applied migration is skipped before any content check runs on it');
  assert.match(lane, /already applied, skipped/);

  const deploy = fs.readFileSync(path.resolve(__dirname, '../scripts/bob-vps-deploy.sh'), 'utf8');
  assert.equal(spawnSync('bash', ['-n', path.resolve(__dirname, '../scripts/bob-vps-deploy.sh')], { encoding: 'utf8' }).status, 0);
  assert.match(deploy, /> \/var\/lib\/bob\/release-lane\/deployed_sha/);
  // A control-plane restart mid-run would discard the author's turns: the lane waits for the next tick.
  assert.match(lane, /builder_model_runs\?select=id&status=in\.\(running,queued\)/);
  assert.match(lane, /deferred \$\{HEAD_SHA:0:8\}: a Bob model run is in flight/);
  // The gates the worker image carries rebuild it when they change.
  assert.match(lane, /builder-data-path-gate\\\.js\|builder-ts-delta-gate\\\.js/);
  assert.match(lane, /has '\^deploy\/bob-vps\/nginx\/' && TARGETS\+=\(nginx\)/);
  assert.match(lane, /nginx -t/);
});

test('every control-plane path the edge functions relay is allowed through the public nginx site', () => {
  const site = fs.readFileSync(path.resolve(__dirname, '../deploy/bob-vps/nginx/bob.fcmanager.co.nz'), 'utf8');
  const allow = [...site.matchAll(/location ~ (\^[^\s{]+) \{/g)].map((m) => new RegExp(m[1]));
  assert.ok(allow.length >= 2, 'allowlist locations present');
  const fnDir = path.resolve(__dirname, '../supabase/functions');
  const relayed = new Set();
  for (const name of fs.readdirSync(fnDir)) {
    const file = path.join(fnDir, name, 'index.ts');
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/relay\((?:'|`)(\/api\/bob\/[^'`?]+)/g)) {
      // Template parts become a representative concrete path.
      relayed.add(m[1].replace(/\$\{encodeURIComponent\(jobId\)\}/g, '0f1e2d3c-0000-4000-8000-000000000000').replace(/\$\{action\}/g, 'advance'));
    }
  }
  assert.ok(relayed.has('/api/bob/laptop/run'), 'laptop run relay found');
  for (const p of relayed) assert.ok(allow.some((re) => re.test(p)), `${p} is not allowed by deploy/bob-vps/nginx/bob.fcmanager.co.nz (it would be an HTTP 404 in Bob's chat)`);
});
