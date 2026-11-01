const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../scripts/bob-release-lane.sh');
const bashSyntax = (source) => spawnSync('bash', ['-n'], { input: source.replace(/\r\n/g, '\n'), encoding: 'utf8' });

test('release CLI uses the locked version and explicitly installs its matching platform binary', t => {
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  const helper = lane.slice(lane.indexOf('supabase_cli()'), lane.indexOf('\nOK=true'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-release-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/supabase': { version: '2.115.0' } } }));
  const result = spawnSync('bash', ['-s'], {
    cwd: directory, encoding: 'utf8', input: `${helper}
npx() { printf '%s\\n' "$@"; }
supabase_cli functions deploy bob-query-atlas --project-ref fixture --use-api
`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    '--yes', '--package=supabase@2.115.0', `--package=@supabase/cli-${process.platform}-${process.arch}@2.115.0`,
    'supabase', 'functions', 'deploy', 'bob-query-atlas', '--project-ref', 'fixture', '--use-api',
  ]);
  assert.doesNotMatch(lane, /npx --yes supabase (?:migration|functions)/);
  assert.match(lane, /supabase_cli migration repair/);
  assert.match(lane, /supabase_cli functions deploy/);
  fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/supabase': { version: 'latest' } } }));
  const refused = spawnSync('bash', ['-s'], {
    cwd: directory, encoding: 'utf8', input: `${helper}
npx() { printf '%s\\n' 'must not install an unpinned CLI'; }
supabase_cli --version
`,
  });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /Supabase CLI version is missing or invalid/);
});

test('the unapplied Atlas gap migration preserves service-only RPC boundaries without invented grants', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20241022120000_grant_unwired_rpcs.sql'), 'utf8')
    .replace(/--[^\n]*/g, '').trim();
  assert.equal(sql, 'SELECT 1;');
});

test('worker launcher changes redeploy the control plane as well as the worker image', () => {
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  const classification = lane.slice(lane.indexOf('has()'), lane.indexOf('WEB_ONLY_NOTE='));
  const result = spawnSync('bash', ['-s'], {
    encoding: 'utf8',
    input: `set -euo pipefail
CHANGED=worker-executor.js
${classification}
printf '%s\\n' "\${TARGETS[@]}"
`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['control-plane', 'worker-image']);
});

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

test('release lane refuses a main branch head with an unverified author', (t) => {
  const source = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
  const guardStart = source.indexOf('VERIFIED_GITHUB_NAME=');
  const guardEnd = source.indexOf('\n# 2. What is live?', guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart, 'the branch-head identity guard is present');
  const guard = source.slice(guardStart, guardEnd);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-release-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'fixture.txt'), 'verified\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  const commit = (name, email, message) => {
    execFileSync('git', ['-C', repo, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', message], {
      env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
    });
    return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  };
  const verifiedHead = commit('Don Squires', '256263525+DonSquires@users.noreply.github.com', 'verified');
  const unverifiedHead = commit('Don Squires', 'squires.don@gmail.com', 'unverified');
  const bashRepo = process.platform === 'win32'
    ? repo.replace(/^([A-Za-z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/')
    : repo;
  const runGuard = (head) => spawnSync('bash', ['-s'], {
    encoding: 'utf8',
    input: `REPO_DIR='${bashRepo}'\nHEAD_SHA='${head}'\nlog() { printf '%s\\n' "$*" >&2; }\n${guard}`,
  });
  const accepted = runGuard(verifiedHead);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const refused = runGuard(unverifiedHead);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /main branch-head author is not the verified GitHub identity/);
  assert.ok(source.indexOf('if ! verify_main_author') < source.indexOf('# 2. What is live?'));
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
  assert.match(action, /build -q bob-control-plane; then\n[^\n]*image build failed[^\n]*\n\s*else\n\s*require_idle scripts\/bob-runtime-idle\.js\n\s*if DOCKER_GID=999 docker compose [^\n]* up -d/);
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
  for (const prefix of ['', '/api/bob', '/api/bob/builder']) {
    for (const suffix of ['/assessment', '/docker/services']) relayed.add(`${prefix}${suffix}`);
  }
  for (const p of relayed) assert.ok(allow.some((re) => re.test(p)), `${p} is not allowed by deploy/bob-vps/nginx/bob.fcmanager.co.nz (it would be an HTTP 404 in Bob's chat)`);
  for (const p of ['/assessment/extra', '/docker/exec', '/api/bob/builder/docker/logs']) {
    assert.ok(!allow.some(re => re.test(p)), `${p} must not be admitted by the diagnostic allowlist`);
  }
});

test('nginx backups are kept outside sites-enabled so nginx never loads a duplicate site', () => {
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  const start = lane.indexOf('    nginx)');
  const nginxBlock = lane.slice(start, lane.indexOf('  esac', start));
  assert.doesNotMatch(nginxBlock, /install[^\n]*-b\b/);
  assert.doesNotMatch(nginxBlock, /\.lane-previous/);
  assert.match(nginxBlock, /nginx_backup="\$STATE_DIR\/nginx-previous"/);
});

test('release lane heals out-of-band nginx drift every tick and keeps the drifted copy', (t) => {
  const { execFileSync } = require('node:child_process');
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  const fn = lane.slice(lane.indexOf('NGINX_SHA_FILE='), lane.indexOf('\nheal_nginx_drift\n'));
  assert.ok(lane.indexOf('\nheal_nginx_drift\n') < lane.indexOf('if [[ "$HEAD_SHA" == "$DEPLOYED_SHA" ]]; then exit 0; fi'), 'drift heal must run before the no-new-release exit');
  assert.match(lane, /nginx sites installed at \$SHA8"\); printf '%s\\n' "\$HEAD_SHA" > "\$NGINX_SHA_FILE"/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-nginx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const sites = path.join(root, 'sites');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  for (const dir of [repo, sites, bin, state, path.join(repo, 'deploy/bob-vps/nginx')]) fs.mkdirSync(dir, { recursive: true });
  const site = path.join(repo, 'deploy/bob-vps/nginx/bob.example');
  const g = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  g('init', '-q');
  fs.writeFileSync(site, 'managed v1\n'); g('add', '.'); g('commit', '-qm', 'v1');
  const deployed = g('rev-parse', 'HEAD');
  fs.writeFileSync(site, 'managed v2\n'); g('commit', '-qam', 'v2');
  const installed = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const run = (nginxExit) => {
    fs.writeFileSync(path.join(bin, 'nginx'), `#!/bin/sh\nexit ${nginxExit}\n`, { mode: 0o755 });
    return execFileSync('bash', ['-c', `set -euo pipefail\nlog() { echo "$*"; }\n${fn}\nheal_nginx_drift`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MODE: 'live', REPO_DIR: repo, DEPLOYED_SHA: deployed, STATE_DIR: state, BOB_RELEASE_NGINX_SITES_DIR: sites },
    });
  };
  const live = path.join(sites, 'bob.example');
  const drift = path.join(state, 'nginx-drift');

  // Without nginx_sha the deployed release is the reference.
  fs.writeFileSync(live, 'managed v1\n');
  assert.equal(run(0), '');

  // A release installed v2 and then failed later: v2 is the reference, never reverted to deployed v1.
  fs.writeFileSync(path.join(state, 'nginx_sha'), `${installed}\n`);
  fs.writeFileSync(live, 'managed v2\n');
  assert.equal(run(0), '');

  fs.writeFileSync(live, 'hand edit\n');
  assert.match(run(0), /nginx drift healed/);
  assert.equal(fs.readFileSync(live, 'utf8'), 'managed v2\n');
  const kept = fs.readdirSync(drift);
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(drift, kept[0]), 'utf8'), 'hand edit\n');

  fs.writeFileSync(live, 'hand edit\n');
  assert.match(run(1), /failed nginx -t/);
  assert.equal(fs.readFileSync(live, 'utf8'), 'hand edit\n');

  // A deleted site is drift; a failed nginx -t restores the absence.
  fs.rmSync(live);
  assert.match(run(1), /failed nginx -t/);
  assert.equal(fs.existsSync(live), false);
  assert.match(run(0), /nginx drift healed/);
  assert.equal(fs.readFileSync(live, 'utf8'), 'managed v2\n');

  // A dangling link is drift; a failed nginx -t puts the same link back.
  fs.rmSync(live);
  fs.symlinkSync(path.join(root, 'missing-target'), live);
  assert.match(run(1), /failed nginx -t/);
  assert.equal(fs.readlinkSync(live), path.join(root, 'missing-target'));
  assert.match(run(0), /nginx drift healed/);
  assert.equal(fs.lstatSync(live).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(live, 'utf8'), 'managed v2\n');
  assert.deepEqual(fs.readdirSync(drift).filter((f) => /\.(restore|absent)$/.test(f)), []);
});

test('CCTV watcher and inference changes redeploy the cctv-vision target', () => {
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  const classification = lane.slice(lane.indexOf('has()'), lane.indexOf('WEB_ONLY_NOTE='));
  for (const changed of ['services/vision/vision_job_watcher.js', 'services/fcm-inference/app.py']) {
    const result = spawnSync('bash', ['-s'], {
      encoding: 'utf8',
      input: `set -euo pipefail
CHANGED=${changed}
${classification}
printf '%s\\n' "\${TARGETS[@]}"
`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), ['cctv-vision'], changed);
  }
});

const cctvHarness = (options = {}) => {
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  const helpers = lane.slice(lane.indexOf('CCTV_DRAIN_SECONDS='), lane.indexOf('# Healthy = the inference container'));
  const action = lane.slice(lane.indexOf('    cctv-vision)\n      if'), lane.indexOf('    worker-image)'));
  assert.ok(helpers.includes('drain_cctv()') && action.includes('drain_cctv'), 'cctv-vision claim gate not found');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-cctv-'));
  fs.writeFileSync(path.join(dir, 'queue'), `${(options.queue || ['[]']).join('\n')}\n`);
  return spawnSync('bash', ['-s'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, BOB_RELEASE_CCTV_DRAIN_SECONDS: String(options.drainSeconds ?? 900) },
    input: `set -euo pipefail
HEAD_SHA=fixture123456; SHA8=fixture1; OK=true; RESULTS=()
SUPABASE_URL=https://example.invalid; SUPABASE_SERVICE_ROLE_KEY=fixture
QUEUE=${JSON.stringify(path.join(dir, 'queue'))}
log() { printf '%s\\n' "$*" >&2; }
sleep() { :; }
curl() {
  local url
  for url in "$@"; do :; done
  case "$*" in
    *rpc/pause_cctv_inference_claims*) echo pause >&2; ${options.pauseFails ? 'return 22' : 'echo "\\"2026-11-01T10:00:00Z\\""'} ;;
    *rpc/resume_cctv_inference_claims*) echo resume >&2; echo true ;;
    *inference_jobs*) echo queue >&2; local next; next="$(head -n1 "$QUEUE")"; sed -i 1d "$QUEUE"
      [[ "$next" == unreadable ]] && return 7; printf '%s' "\${next:-[]}" ;;
  esac
}
docker() {
  case "$*" in
    *" build "*) echo build >&2; ${options.buildFails ? 'return 1' : 'return 0'} ;;
    *" up "*) echo up >&2; ${options.upFails ? 'return 1' : 'return 0'} ;;
  esac
}
cctv_vision_healthy() { echo health >&2; ${options.unhealthy ? 'return 1' : 'return 0'}; }
fail_note() { echo "note: $1" >&2; }
rollback() { echo "rollback $1" >&2; }
${helpers}
case cctv-vision in
${action}
esac
echo advanced-release
`,
  });
};
const events = (result) => result.stderr.trim().split('\n');

test('cctv-vision pauses claims, drains, replaces, validates and only then resumes claims', () => {
  const idle = cctvHarness();
  assert.equal(idle.status, 0, idle.stderr);
  assert.equal(idle.stdout, 'advanced-release\n');
  assert.deepEqual(events(idle), ['build', 'pause', 'queue', 'up', 'health', 'resume', 'CCTV inference claims resumed']);

  const draining = cctvHarness({ queue: ['[{"id":"a"}]', '[{"id":"a"}]', '[]'] });
  assert.equal(draining.status, 0, draining.stderr);
  assert.deepEqual(events(draining), ['build', 'pause', 'queue', 'queue', 'queue', 'up', 'health', 'resume', 'CCTV inference claims resumed']);
});

test('cctv-vision defers with claims resumed when work does not drain, the queue is unreadable or the pause fails', () => {
  for (const [options, reason] of [
    [{ queue: ['[{"id":"a"}]'], drainSeconds: 0 }, /a CCTV inference job is still processing after 0s/],
    [{ queue: ['unreadable'] }, /the CCTV inference queue is unreadable/],
    [{ queue: ['{"message":"JWT expired"}'] }, /the CCTV inference queue is unreadable/],
    [{ pauseFails: true }, /CCTV inference claims could not be paused/],
  ]) {
    const result = cctvHarness(options);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, reason);
    assert.doesNotMatch(result.stderr, /^(up|health|rollback .*)$/m, 'nothing is replaced or rolled back');
    assert.doesNotMatch(result.stdout, /advanced-release/);
    assert.equal(events(result).at(-2), 'resume', 'the exit trap resumes claims');
  }
});

test('a failed or unhealthy cctv-vision replacement rolls back while claims are still paused', () => {
  for (const [options, note] of [[{ upFails: true }, 'note: cctv-vision replacement failed'], [{ unhealthy: true }, 'note: cctv-vision unhealthy after replacement']]) {
    const result = cctvHarness(options);
    assert.equal(result.status, 0, result.stderr);
    const seen = events(result);
    assert.ok(seen.includes(note), result.stderr);
    assert.ok(seen.indexOf('rollback cctv-vision') > seen.indexOf('up'), result.stderr);
    assert.ok(seen.indexOf('rollback cctv-vision') < seen.indexOf('resume'), 'rollback happens under the claim pause');
  }
  const buildFailed = cctvHarness({ buildFails: true });
  assert.deepEqual(events(buildFailed), ['build', 'note: cctv-vision image build failed; the running services were not touched']);
});

const rollbackHarness = (target, options = {}) => {
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  const rollback = lane.slice(lane.indexOf('rollback_build()'), lane.indexOf('for target in'));
  const previous = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-previous-'));
  return spawnSync('bash', ['-s'], {
    encoding: 'utf8',
    input: `set -euo pipefail
PREVIOUS_RELEASE=${JSON.stringify(previous)}; DEPLOYED_SHA=previous123456
docker() { case "$*" in *" build "*) echo build >&2; ${options.buildFails ? 'return 1' : 'return 0'} ;; *" up "*) echo up >&2 ;; esac; }
node() { echo idle-probe >&2; ${options.busy ? 'return 1' : 'return 0'}; }
fail_note() { echo "note: $1" >&2; }
${rollback}
rollback ${target}
`,
  });
};

test('rollback rebuilds the previous release, then rechecks Bob activity immediately before recreation', () => {
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  assert.equal(bashSyntax(lane).status, 0);
  for (const target of ['control-plane', 'fcm-api']) {
    const busy = rollbackHarness(target, { busy: true });
    assert.equal(busy.status, 0, busy.stderr);
    assert.deepEqual(events(busy).slice(0, 2), ['build', 'idle-probe']);
    assert.match(busy.stderr, new RegExp(`note: ${target} rollback deferred: Bob execution became active`));
    assert.doesNotMatch(busy.stderr, /^up$|rolled back/m);
    const idle = rollbackHarness(target);
    assert.deepEqual(events(idle), ['build', 'idle-probe', 'up', `note: ${target} rolled back to previous`]);
    const unbuilt = rollbackHarness(target, { buildFails: true });
    assert.deepEqual(events(unbuilt), ['build', `note: ${target} rollback to previous failed: the previous release did not build; the failed release is still running`]);
  }
  const cctv = rollbackHarness('cctv-vision', { busy: true });
  assert.deepEqual(events(cctv), ['build', 'up', 'note: cctv-vision rolled back to previous'], 'CCTV rollback is guarded by the claim pause, not the Bob probe');
});

test('a failed control-plane or fcm-api recreate is rolled back instead of left half-replaced', () => {
  const lane = fs.readFileSync(SCRIPT, 'utf8');
  for (const [target, next] of [['control-plane', '    fcm-api)\n      if'], ['fcm-api', '    cctv-vision)\n      if']]) {
    const action = lane.slice(lane.indexOf(`    ${target})\n      if`), lane.indexOf(next));
    const result = spawnSync('bash', ['-s'], {
      encoding: 'utf8',
      input: `set -euo pipefail
HEAD_SHA=fixture123456; SHA8=fixture1; OK=true; RESULTS=(); STATE_DIR=/tmp
docker() { case "$*" in *" build "*) echo build >&2 ;; *" up "*) echo up >&2; return 1 ;; esac; }
require_idle() { echo idle >&2; }
fail_note() { echo "note: $1" >&2; }
rollback() { echo "rollback $1" >&2; }
case ${target} in
${action}
esac
echo "ok=$OK"
`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(events(result), ['build', 'idle', 'up', `note: ${target} replacement failed`, `rollback ${target}`]);
    assert.equal(result.stdout, 'ok=false\n');
  }
});
