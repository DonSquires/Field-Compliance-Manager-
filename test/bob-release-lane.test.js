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
});
