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
});
