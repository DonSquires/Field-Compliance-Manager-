const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../scripts/bob-release-lane.sh');
const bashSyntax = (source) => spawnSync('bash', ['-n'], { input: source.replace(/\r\n/g, '\n'), encoding: 'utf8' });

test('release environment values stay literal and existing environment wins', () => {
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  const loader = lane.slice(lane.indexOf('load_env()'), lane.indexOf('load_env "$CP_ENV_FILE"'));
  assert.doesNotMatch(loader, /\$\{!/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-release-env-'));
  const file = path.join(directory, 'fixture.env');
  try {
    fs.writeFileSync(file, 'EXISTING=replacement\nADDED=value=with spaces\n');
    const result = spawnSync('bash', ['-s'], {
      encoding: 'utf8',
      env: { ...process.env, EXISTING: 'kept', ADDED: '', ENV_FIXTURE: file },
      input: `${loader}
load_env "$ENV_FIXTURE"
printf '%s\\n' "$EXISTING" "$ADDED"
`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'kept\nvalue=with spaces\n');
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

// Live 2026-09-27: a stale .git/gc.log (left by a pruned worktree the day before) made the auto-gc
// after every `git fetch` exit non-zero; the lane read that as "mirror unreachable" for 12 hours
// while main had moved. The lane must not run housekeeping inside its fetch, and must log the
// real reason (without the token) when the fetch does fail.
test('release lane prefers authoritative GitHub SSH and keeps a token-safe Gitea fallback', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(bashSyntax(source).status, 0, 'bash -n');
  const fetchLine = source.split('\n').find((line) => /git -C "\$REPO_DIR".*fetch -q "\$REMOTE_URL"/.test(line));
  assert.ok(fetchLine, 'the main fetch is present');
  assert.match(fetchLine, /"\$\{FETCH_CONFIG\[@\]\}"/);
  assert.match(source, /REMOTE_URL="git@github\.com:\$\{GITHUB_OWNER\}\/\$\{GITHUB_REPO\}\.git"/);
  assert.match(source, /GIT_SSH_COMMAND="ssh -i \$GITHUB_SSH_KEY/);
  assert.match(source, /StrictHostKeyChecking=yes/);
  assert.match(source, /FETCH_CONFIG=\(-c gc\.auto=0\)/);
  assert.match(source, /GITEA_BASE_URL is required when GitHub SSH is unavailable/);
  assert.match(source, /http\.extraheader=Authorization: token \$\{GITEA_TOKEN\}/);
  assert.doesNotMatch(source, /log "fetch failed: mirror unreachable"/);
  assert.match(source, /safe_fetch_err="\$\{safe_fetch_err\/\/\$\{GITEA_TOKEN\}\/<token>\}"/);
  // systemd gives root no HOME, so the global safe.directory is invisible; the script must carry its own.
  assert.match(source, /GIT_CONFIG_KEY_0=safe\.directory GIT_CONFIG_VALUE_0="\$REPO_DIR"/);
  assert.match(source, /GIT_CONFIG_KEY_1=safe\.directory GIT_CONFIG_VALUE_1="\$RELEASES_DIR\/\*"/);
});

test('release lane skips applied migrations and exclusively owns its live pointer', () => {
  const lane = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
  const ledgerCheck = lane.indexOf("select version from supabase_migrations.schema_migrations where version = '${version}'");
  const destructiveCheck = lane.indexOf('contains destructive SQL');
  assert.ok(ledgerCheck > 0, 'the ledger is consulted per migration');
  assert.ok(ledgerCheck < destructiveCheck, 'an applied migration is skipped before any content check runs on it');
  assert.match(lane, /already applied, skipped/);
  assert.match(lane, /DEPLOYABLE_CHANGED=.*--diff-filter=ACMRT/);
  assert.match(lane, /FUNCTIONS=.*"\$DEPLOYABLE_CHANGED"/);
  assert.match(lane, /SHARED_CHANGED=.*"\$DEPLOYABLE_CHANGED"/);
  assert.match(lane, /FUNCTIONS=.*sed '\/\^\$\/d' \| sort -u/);
  assert.doesNotMatch(lane, /FUNCTIONS=.*grep -v '\^\$'/);
  assert.match(lane, /migration repair --status applied "\$version" --project-ref "\$SUPABASE_PROJECT_REF"/);
  assert.match(lane, /applied but ledger repair failed/);

  const deploy = fs.readFileSync(path.resolve(__dirname, '../scripts/bob-vps-deploy.sh'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(bashSyntax(deploy).status, 0);
  assert.doesNotMatch(deploy, /> \/var\/lib\/bob\/release-lane\/deployed_sha/);
  assert.match(deploy, /governed release\s*#?\s*lane owns the repository-wide pointer/i);
  assert.match(deploy, /git bundle create .*refs\/remotes\/origin\/main/);
  assert.match(deploy, /git fetch -q .*refs\/remotes\/origin\/main:refs\/bundles/);
  assert.match(deploy, /docker compose -f deploy\/bob-control-plane\/docker-compose\.yml rm -sf bob-control-plane/);
  // A control-plane restart mid-run would discard the author's turns: the lane waits for the next tick.
  assert.match(lane, /require_idle "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/bob-runtime-idle\.js"/);
  assert.match(lane, /deferred \$\{HEAD_SHA:0:8\}: Bob execution is active or unverifiable/);
  // The installed lane is a deliberate copy, so a reviewed lane change must replace it for the next tick.
  assert.match(lane, /scripts\/bob-runtime-idle\\\.js\|deploy\/bob-release-lane/);
  assert.match(lane, /install -m 700 scripts\/bob-release-lane\.sh \/srv\/fcm\/release-lane\/bob-release-lane\.sh/);
  assert.match(lane, /install -m 644 scripts\/bob-runtime-idle\.js \/srv\/fcm\/release-lane\/bob-runtime-idle\.js/);
  assert.match(lane, /systemctl daemon-reload/);
  // The gates the worker image carries rebuild it when they change.
  assert.match(lane, /builder-data-path-gate\\\.js\|builder-ts-delta-gate\\\.js/);
  assert.match(lane, /has '\^deploy\/bob-vps\/nginx\/' && TARGETS\+=\(nginx\)/);
  assert.match(lane, /nginx -t/);
  assert.match(lane, /node scripts\/atlas-refresh\.js --apply --upsert-only/);
  assert.match(lane, /stale generated evidence retained for reconciliation/);
  assert.match(lane, /node scripts\/atlas-exercise-evidence\.mjs --apply/);
  assert.match(lane, /Atlas exercise evidence failed/);
  assert.match(lane, /node scripts\/schema-snapshot-live\.mjs --project-ref "\$SUPABASE_PROJECT_REF" --out "\$live_schema"/);
  assert.match(lane, /live schema snapshot differs from committed supabase\/schema\.sql/);
});

test('automatic and legacy control-plane deployment check idle after image build, including rollback', () => {
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  const action = lane.slice(lane.indexOf('    control-plane)\n      if'), lane.indexOf('    worker-image)'));
  assert.match(action, /build -q bob-control-plane \\\n\s*&& require_idle scripts\/bob-runtime-idle\.js \\\n\s*&& DOCKER_GID=999 docker compose/);
  assert.match(lane.slice(lane.indexOf('rollback()'), lane.indexOf('for target in')), /if ! node scripts\/bob-runtime-idle\.js/);
  const legacy = fs.readFileSync(path.resolve(__dirname, '../deploy/bob-control-plane/deploy.sh'), 'utf8');
  assert.match(legacy, /build bob-control-plane\nnode "\$app_dir\/scripts\/bob-runtime-idle\.js"\ndocker compose/);
  assert.equal(bashSyntax(legacy).status, 0);
});

test('work appearing during image build defers without restart, rollback or advancing the release', () => {
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  const guard = lane.slice(lane.indexOf('require_idle()'), lane.indexOf('if printf', lane.indexOf('require_idle()')));
  const controlPlane = lane.slice(lane.indexOf('    control-plane)\n      if'), lane.indexOf('    fcm-api)\n      if'));
  const result = spawnSync('bash', ['-s'], {
    encoding: 'utf8',
    input: `set -euo pipefail
HEAD_SHA=fixture123456
log() { printf '%s\\n' "$*"; }
node() { return 1; }
docker() { echo build; }
fail_note() { echo failure; }
rollback() { echo rollback; }
${guard}
case control-plane in
${controlPlane}
esac
echo advanced-release
`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /build\ndeferred fixture1/);
  assert.doesNotMatch(result.stdout, /rollback|failure|advanced-release/);
  assert.equal(result.stdout.split('\n').filter(line => line === 'build').length, 1, 'only build, not service up');
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
