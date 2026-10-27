const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');

// A real control plane against a local repository: proves which commits may receive the live test
// identity, that a run walks a pinned snapshot, that /health counts it, and that verdicts survive restart.
const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-human-source-'));
const stateDir = path.join(work, 'state');
const workspaceRoot = path.join(work, 'workspaces');
const sourceDir = path.join(work, 'source');
const remoteDir = path.join(work, 'remote.git');
const dockerLog = path.join(work, 'docker.jsonl');
const releaseFile = path.join(work, 'release-worker');
const adminToken = crypto.randomBytes(16).toString('hex');
const remoteUrl = 'https://github.com/example/app.git';
const restoredSha = 'c'.repeat(40);
const interruptedRunId = crypto.randomUUID();
let serverProcess;
let baseUrl;
let mainSha;
let olderMainSha;
let branchSha;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commit(repo, message, file, content) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  return port;
}

async function request(method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: ['Bearer', adminToken].join(' ') },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function until(probe, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const dockerRuns = () => (fs.existsSync(dockerLog) ? fs.readFileSync(dockerLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

async function startServer(overrides = {}) {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['bob-control-plane-server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.join(work, 'bin')}${path.delimiter}${process.env.PATH}`,
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      OLLAMA_API_TOKEN: '',
      OLLAMA_API_KEY: '',
      PORT: String(port),
      BOB_ADMIN_TOKEN: adminToken,
      BOB_RUNNER_TOKEN: crypto.randomBytes(16).toString('hex'),
      BOB_MODEL_GATEWAY_TOKEN: crypto.randomBytes(16).toString('hex'),
      BOB_BUILDER_AUTOPILOT: 'false',
      BOB_PRODUCTION_HUMAN_TEST: 'false',
      BOB_WORKER_IMAGE: 'bob-worker:fixture',
      BOB_WORKER_NETWORK: 'none',
      BOB_STATE_DIR: stateDir,
      BOB_BUILDER_SOURCE_DIR: sourceDir,
      BOB_BUILDER_WORKSPACE_ROOT: workspaceRoot,
      BOB_GITHUB_SSH_KEY_FILE: path.join(work, 'missing-key'),
      BOB_GITHUB_KNOWN_HOSTS_FILE: path.join(work, 'missing-known-hosts'),
      GITHUB_TOKEN: 'fixture-github-value',
      GITHUB_OWNER: 'example',
      GITHUB_REPO: 'app',
      HUMAN_TEST_BASE_URL: 'https://www.example.test',
      GRANDMASTER_TEST_EMAIL: 'bob.test@example.invalid',
      GRANDMASTER_TEST_PASSWORD: 'fixture-password',
      VERCEL_TOKEN: 'fixture-vercel-value',
      VERCEL_PROJECT_ID: 'prj_fixture',
      VERCEL_TEAM_ID: '',
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await once(serverProcess, 'spawn');
  await until(async () => {
    try { return (await fetch(`${baseUrl}/health`)).ok; } catch { return false; }
  }, 'the control plane to start');
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const exited = once(serverProcess, 'exit');
  serverProcess.kill('SIGTERM');
  await exited;
}

test.before(async () => {
  const seed = path.join(work, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  olderMainSha = commit(seed, 'web app', 'apps/web/package.json', '{"name":"web"}\n');
  mainSha = commit(seed, 'main follow-up', 'apps/web/README.md', 'main\n');
  git(seed, 'checkout', '-q', '-b', 'bob/unreviewed');
  branchSha = commit(seed, 'unreviewed branch work', 'apps/web/branch.txt', 'branch\n');
  git(work, 'clone', '-q', '--bare', seed, remoteDir);
  git(work, 'clone', '-q', '--no-checkout', remoteDir, sourceDir);
  git(sourceDir, 'fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*');
  git(sourceDir, 'remote', 'set-url', 'origin', remoteUrl);

  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // Only remote-head lookups leave the machine; point them at the local bare repository.
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const mapped = args.includes('ls-remote') ? args.map((arg) => (arg === ${JSON.stringify(remoteUrl)} ? ${JSON.stringify(remoteDir)} : arg)) : args;
const result = spawnSync(${JSON.stringify(realGit)}, mapped, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'run') process.exit(0);
const mount = args[args.indexOf('--mount') + 1];
fs.appendFileSync(${JSON.stringify(dockerLog)}, JSON.stringify({
  source: /src=([^,]+)/.exec(mount)[1],
  live: process.env.HUMAN_TEST_LIVE,
  expected_sha: args.includes('HUMAN_TEST_EXPECTED_SHA') ? process.env.HUMAN_TEST_EXPECTED_SHA : null,
  admin_route: args.includes('HUMAN_TEST_ADMIN_ROUTE') ? process.env.HUMAN_TEST_ADMIN_ROUTE : null,
  forwards_password: args.includes('GRANDMASTER_TEST_PASSWORD'),
}) + '\\n');
const finish = () => {
  if (process.env.HUMAN_TEST_LIVE === 'true') console.log('[HUMAN DEPLOYMENT PREFLIGHT] result=matched\\n  2 passed\\n  9 skipped');
  else console.log('  3 passed');
  process.exit(0);
};
const wait = () => (fs.existsSync(${JSON.stringify(releaseFile)}) ? finish() : setTimeout(wait, 25));
wait();
`, { mode: 0o700 });

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'bob-state.json'), JSON.stringify({
    jobs: [],
    deliveries: [],
    audit: [],
    humanTestRuns: [{ id: interruptedRunId, mode: 'suite', scope: 'full', status: 'running', source_sha: restoredSha, requested_by: 'bob:production-verify', created_at: '2026-10-01T00:00:00.000Z', phases: [], artifacts: [] }],
    mainHealthRuns: [],
    productionHumanTests: [{ sha: restoredSha, status: 'passed', attempts: 1, run_id: interruptedRunId, first_seen_at: '2026-10-01T00:00:00.000Z', completed_at: '2026-10-01T00:20:00.000Z', summary: { passed: 40, failed: 0, skipped: 2 } }],
  }));

  await startServer();
});

test.after(async () => {
  await stopServer();
  fs.rmSync(work, { recursive: true, force: true });
});

test('a restart keeps production verdicts and never resurrects an interrupted run as active', async () => {
  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(health.activeHumanTests, 0);
  assert.equal(health.productionHumanTest.enabled, false);
  assert.equal(health.productionHumanTest.route, '/admin/builder');
  assert.deepEqual(
    { sha: health.productionHumanTest.latest.sha, status: health.productionHumanTest.latest.status, summary: health.productionHumanTest.latest.summary },
    { sha: restoredSha, status: 'passed', summary: { passed: 40, failed: 0, skipped: 2 } },
  );
  const interrupted = await request('GET', `/api/bob/human-tests/${interruptedRunId}`);
  assert.equal(interrupted.body.run.status, 'interrupted');
});

test('live Dr Bob refuses commits that are not merged to main before any snapshot or credential use', async () => {
  for (const mode of ['live', 'suite']) {
    const refused = await request('POST', '/api/bob/human-tests', { mode, expected_sha: branchSha });
    assert.equal(refused.status, 409, mode);
    assert.match(refused.body.error, /only tests commits merged to main/);
  }
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'human-tests')), false);
  assert.deepEqual(dockerRuns(), []);
});

test('a suite walks a pinned snapshot of the merged commit and /health counts it while it runs', async () => {
  const started = await request('POST', '/api/bob/human-tests', { mode: 'suite', expected_sha: olderMainSha, target_route: '/admin/builder' });
  assert.equal(started.status, 202);
  assert.equal(started.body.run.source_sha, olderMainSha);

  const [fixture] = await until(() => { const runs = dockerRuns(); return runs.length === 1 && runs; }, 'the fixture phase to start');
  assert.equal((await (await fetch(`${baseUrl}/health`)).json()).activeHumanTests, 1);
  assert.ok(fixture.source.startsWith(path.join(workspaceRoot, 'human-tests') + path.sep), fixture.source);
  assert.notEqual(fixture.source, sourceDir);
  assert.equal(git(fixture.source, 'rev-parse', 'HEAD'), olderMainSha);
  assert.equal(fixture.live, 'false');
  assert.equal(fixture.forwards_password, false, 'the fixture phase never receives the live identity');
  // A second request while one walks is answered with the active run, not a parallel one.
  const duplicate = await request('POST', '/api/bob/human-tests', { mode: 'fixture' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.existing, true);

  fs.writeFileSync(releaseFile, '');
  const finished = await until(async () => {
    const latest = await request('GET', `/api/bob/human-tests/${started.body.run.id}`);
    return latest.body.run.status !== 'queued' && latest.body.run.status !== 'running' && latest.body.run;
  }, 'the suite to finish');
  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(finished.phases.map((phase) => [phase.mode, phase.status]), [['fixture', 'succeeded'], ['live', 'succeeded']]);
  assert.equal(finished.phases[1].deployment_preflight, 'matched');

  const live = dockerRuns()[1];
  assert.equal(live.source, fixture.source, 'both phases walk the same pinned snapshot');
  assert.equal(live.live, 'true');
  assert.equal(live.expected_sha, olderMainSha);
  assert.equal(live.admin_route, '/admin/builder');
  assert.equal((await (await fetch(`${baseUrl}/health`)).json()).activeHumanTests, 0);
});

test('an enabled production monitor is scheduled at startup and observes without starting a walk', async () => {
  await stopServer();
  const before = dockerRuns().length;
  // A production URL that does not parse fails closed as "unconfigured" before any Vercel request.
  await startServer({ BOB_PRODUCTION_HUMAN_TEST: '', BOB_PRODUCTION_HUMAN_TEST_STARTUP_DELAY_MS: '1000', HUMAN_TEST_BASE_URL: 'not a production url' });
  const initial = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(initial.productionHumanTest.enabled, true);
  const observed = await until(async () => {
    const health = await (await fetch(`${baseUrl}/health`)).json();
    return health.productionHumanTest.observation;
  }, 'the scheduled production monitor tick', 10_000);
  assert.equal(observed.outcome, 'waiting_for_deployment');
  assert.equal(observed.reason, 'unconfigured');
  assert.equal(dockerRuns().length, before, 'an unconfirmed deployment never starts a live walk');
});
