const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const port = 18080 + Math.floor(Math.random() * 1000);
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-control-plane-'));
const adminToken = 'test-admin-token';
const runnerToken = 'test-runner-token';
const modelGatewayToken = 'test-model-gateway-token';
const webhookSecret = 'test-webhook-secret';
const baseUrl = `http://127.0.0.1:${port}`;
let serverProcess;
let serverStartupFailure = null;

test('model-run disconnect cancels upstream work without writing to a closed response', async () => {
  const { EventEmitter } = require('node:events');
  const source = fs.readFileSync(path.join(root, 'bob-control-plane-server.js'), 'utf8');
  const start = source.indexOf("  if (req.method === 'POST' && url.pathname === '/api/bob/builder/model-run')");
  const end = source.indexOf("  // Bob's terminal", start);
  const route = vm.runInNewContext(`(async function(req,res){${source.slice(start, end)}})`, {
    AbortController, url: { pathname: '/api/bob/builder/model-run' }, body: {}, modelGatewayConfig: {},
    modelGatewayAuthorized: () => true,
    invokeBuilderModel: async ({ signal }) => {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { status: 499, body: { code: 'request_cancelled' } };
    },
    json: () => { throw new Error('must not write to disconnected caller'); },
  });
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  const pending = route({ method: 'POST' }, res);
  assert.equal(res.listenerCount('close'), 1);
  res.destroyed = true;
  res.emit('close');
  await pending;
  assert.equal(res.listenerCount('close'), 0);
});

test('single-step acceptance does not wait for preflight or models and shares the run lock', async () => {
  const source = fs.readFileSync(path.join(root, 'bob-control-plane-server.js'), 'utf8');
  const functionSource = source.slice(source.indexOf('async function runBuilderJobBounded('), source.indexOf('// Bob autopilot:'));
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const active = new Map();
  const events = [];
  let steps = 0;
  let runs = 0;
  const context = vm.createContext({
    clearStaleBuilderRun: () => false, runningBuilderJobs: active, boundedPreflight: promise => promise,
    resolveBuilderSourceDir: () => pending, builderRuntimeContext: async () => ({}),
    builderSupabase: {}, builderGateway: {}, record: (...args) => events.push(args),
    advanceBuilderJob: async () => { steps++; return { advanced: true }; },
    runBuilderUntilPause: async () => { runs++; return { reason: 'waiting_for_human', history: [] }; },
  });
  const start = vm.runInContext(`${functionSource}\nrunBuilderJobBounded`, context);
  const first = await start('job', {}, { singleStep: true });
  assert.equal(active.has('job'), true);
  assert.equal(steps, 0);
  const duplicate = await start('job');
  assert.equal(duplicate.already_running, true);
  assert.equal(duplicate.started_at, first.started_at);
  release({});
  assert.equal((await first.execution).advanced, true);
  assert.equal(steps, 1);
  assert.equal(runs, 0);
  assert.equal(active.size, 0);
  await (await start('job')).execution;
  assert.equal(runs, 1);
  assert.equal(events.length, 2);
  assert.match(source, /singleStep: builderMatch\[2\] === 'advance'/);
});

test('background single-step failure is recorded and releases the shared lock', async () => {
  const source = fs.readFileSync(path.join(root, 'bob-control-plane-server.js'), 'utf8');
  const functionSource = source.slice(source.indexOf('async function runBuilderJobBounded('), source.indexOf('// Bob autopilot:'));
  const active = new Map();
  const events = [];
  const start = vm.runInNewContext(`${functionSource}\nrunBuilderJobBounded`, {
    clearStaleBuilderRun: () => false, runningBuilderJobs: active, boundedPreflight: promise => promise,
    resolveBuilderSourceDir: async () => ({}), builderRuntimeContext: async () => { throw new Error('preflight failed'); },
    builderSupabase: {}, builderGateway: {}, record: (...args) => events.push(args),
  });
  const result = await (await start('job', {}, { singleStep: true })).execution;
  assert.equal(result.reason, 'error');
  assert.equal(active.size, 0);
  assert.equal(events[0][1], 'builder.run.failed');
  assert.match(events[0][3].error, /preflight failed/);
});

async function request(method, route, body, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

test('officer privacy route requires server authority and never echoes invalid source content', async () => {
  const source = { fields: { site_brief: { private: 'SYNTHETIC-PRIVATE-SENTINEL' } } };
  const denied = await request('POST', '/api/bob/officer/privacy', source);
  assert.equal(denied.response.status, 401);
  const result = await request('POST', '/api/bob/officer/privacy', source, { authorization: `Bearer ${adminToken}` });
  assert.equal(result.response.status, 503);
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
  assert.match(result.body.error, /remains withheld/);
  assert.doesNotMatch(JSON.stringify(result.body), /SYNTHETIC-PRIVATE-SENTINEL/);
});

test.before(async () => {
  const bin = path.join(stateDir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'container' && args[1] === 'ls') console.log('a'.repeat(64));
else if (args[0] === 'container' && args[1] === 'inspect') console.log(JSON.stringify({id:'a'.repeat(64),name:'/fixture-api',status:'running',compose_config_files:'/srv/fixture/compose.yml'}));
else process.exit(2);
`, { mode: 0o700 });
  serverProcess = spawn(process.execPath, ['bob-control-plane-server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      // Hermetic: the developer's live Supabase env must not leak into the unit server
      // (it made /health read the live laptop registry once the laptop had registered).
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      OLLAMA_API_TOKEN: '',
      OLLAMA_API_KEY: '',
      PORT: String(port),
      BOB_ADMIN_TOKEN: adminToken,
      BOB_RUNNER_TOKEN: runnerToken,
      BOB_MODEL_GATEWAY_TOKEN: modelGatewayToken,
      BUILDER_GIT_HOST: 'gitea',
      GITHUB_TOKEN: '',
      BOB_GITHUB_ACCESS_TOKEN: '',
      GITHUB_API_TOKEN: '',
      GITHUB_OWNER: '',
      GITHUB_REPO: '',
      BOB_GITHUB_SSH_KEY_FILE: path.join(stateDir, 'missing-github-key'),
      BOB_GITHUB_KNOWN_HOSTS_FILE: path.join(stateDir, 'missing-known-hosts'),
      BOB_ASSESSMENT_ROOT: root,
      GITEA_WEBHOOK_SECRET: webhookSecret,
      BOB_ALLOWED_REPOSITORIES: 'example/app',
      BOB_STATE_DIR: stateDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.once('exit', (code, signal) => {
    serverStartupFailure = `process exited (${signal || code})`;
  });
  await once(serverProcess, 'spawn');
  let lastHealthError = 'no health response';
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (serverStartupFailure) break;
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastHealthError = `health returned HTTP ${response.status}`;
    } catch (error) {
      lastHealthError = error.message;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(
    `Bob control plane did not start after 15 seconds: ${serverStartupFailure || lastHealthError}`
  );
});

test.after(() => {
  serverProcess.kill('SIGTERM');
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('health is public and reports the control plane', async () => {
  const { response, body } = await request('GET', '/health');
  assert.equal(response.status, 200);
  // Health names the git host Bob's Builder lane publishes to; secrets never appear, only whether the host is configured.
  // Autopilot reads false here: the test server has no Supabase, model gateway, or worker image.
  const { modelProviders, laptopShell, storage, ...rest } = body;
  // Host disk truth is live (statfs of the state dir) and carries only sizes and a status, never paths.
  assert.ok(['ok', 'warn', 'critical', 'unknown'].includes(storage.status));
  assert.ok(Object.keys(storage).every((key) => ['total_gb', 'available_gb', 'used_pct', 'status', 'last_hygiene'].includes(key)));
  assert.deepEqual(rest, { status: 'ok', service: 'bob-control-plane', activeLease: false, builderGitHost: 'github', builderSourceConfigured: false, builderApiConfigured: false, builderSshConfigured: false, autopilot: false, autopilotIntervalMs: 60_000, mainHealth: { enabled: false, sourceHost: 'github', latest: null }, runningBuilderJobs: 0, activeHumanTests: 0, productionHumanTest: { enabled: false, route: '/admin/builder', latest: null, observation: null } });
  // Bob's laptop terminal is off unless the owner-side env enables it; health never carries the user or key path.
  assert.deepEqual(laptopShell, { enabled: false, configured: false, host: null, ssh_allowed: null });
  // Provider health names Bob's own compute first and never carries secrets or URLs.
  assert.deepEqual(Object.keys(modelProviders).sort(), ['gpu_workstation', 'ollama', 'ollama_cloud', 'openai']);
  assert.deepEqual(Object.keys(modelProviders.openai).sort(), ['configured', 'healthy', 'ready_model']);
  assert.equal(modelProviders.gpu_workstation.configured, false, 'no GPU link in the test environment');
  assert.equal(modelProviders.ollama_cloud.configured, false, 'no Ollama Cloud key in the test environment');
  assert.ok(!JSON.stringify(modelProviders.ollama_cloud).includes('ollama.com'), 'public health never carries the cloud URL');
});

test('control-plane source has a bounded stale Builder lease recovery path', () => {
  const source = fs.readFileSync(path.join(root, 'bob-control-plane-server.js'), 'utf8');
  assert.match(source, /BOB_BUILDER_STALE_RUN_MS/);
  assert.match(source, /agenticWallBudgetMs \+ agenticTurnTimeoutMs \+ builderBrowserAllowanceMs \+ 5 \* 60_000/);
  // The browser gate's wall extension and patched + base runs are inside the lease, never past it.
  assert.match(source, /builderBrowserAllowanceMs = builderBrowserTest\s*\?\s*15 \* 60_000 \+ 2 \* /);
  assert.match(source, /browserTest: builderBrowserTest,/);
  assert.match(source, /BOB_BUILDER_PREFLIGHT_TIMEOUT_MS/);
  assert.match(source, /builder\.run\.stale_lease_cleared/);
  assert.match(source, /clearStaleBuilderRun\(jobId\)/);
  assert.match(source, /runningBuilderJobs\.set\(jobId, startedAt\)[\s\S]*boundedPreflight\(resolveBuilderSourceDir\(jobId\)/);
  assert.match(source, /boundedPreflight\(builderRuntimeContext\(body, source\), 'Builder runtime context'\)/);
});

test('main-health verification runs independently of owner Builder jobs', () => {
  const source = fs.readFileSync(path.join(root, 'bob-control-plane-server.js'), 'utf8');
  assert.match(source, /let mainHealthInFlight = null/);
  assert.match(source, /function startMainHealthCheck\(\)/);
  assert.match(source, /if \(!mainHealthEnabled \|\| mainHealthInFlight\) return mainHealthInFlight/);
  assert.match(source, /startMainHealthCheck\(\);\s*await startRoutineRepairs\(\)/);
  assert.doesNotMatch(source, /await mainHealthMonitor\.tick\(\)/);
  assert.match(source, /createDetachedWorkspace\(\{[\s\S]*workspaceRoot: path\.join\(builderWorkspaceRoot, 'main-health'\),[\s\S]*targetSha: sha/);
});

test('control plane retires stale Builder jobs without touching active execution or workspaces', () => {
  const source = fs.readFileSync(path.join(root, 'bob-control-plane-server.js'), 'utf8');
  assert.match(source, /async function reconcileStaleBuilderJobs\(\)/);
  assert.match(source, /jobHygieneDecision\(job,/);
  assert.match(source, /builder_retire_stale_job/);
  assert.match(source, /builder_cancel_terminal_approvals/);
  assert.match(source, /await reconcileInvalidSelfHealDeployments\(\);\s*await reconcileStaleBuilderJobs\(\)/);
});

test('startup recovers model steps interrupted by a control-plane restart before autopilot planning', () => {
  const source = fs.readFileSync(path.join(root, 'bob-control-plane-server.js'), 'utf8');
  assert.match(source, /const controlPlaneStartedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(source, /function recoverInterruptedModelSteps\(\)/);
  assert.match(source, /\.eq\('status', 'running'\)\s*\.lt\('started_at', controlPlaneStartedAt\)/);
  assert.match(source, /builder_abort_model_step/);
  assert.match(source, /await startInterruptedModelRecovery\(\);\s*startMainHealthCheck\(\)/);
});

test('UX design receives pinned canonical tokens and Builder route/access evidence', () => {
  const source = fs.readFileSync(path.join(root, 'bob-control-plane-server.js'), 'utf8');
  assert.match(source, /function collectPinnedDesignContext\(source\)/);
  assert.match(source, /docs\/canon\/PRODUCT_DESIGN\.md/);
  assert.match(source, /apps\/web\/src\/styles\/tokens\.css/);
  assert.match(source, /existing_routes: \['AdminShell page id "builder"'\]/);
  assert.match(source, /platform-only AdminShell page/);
  assert.match(source, /\.\.\.collectPinnedDesignContext\(source\)/);
});

test('assessment is authenticated and read-only', async () => {
  const denied = await request('GET', '/assessment');
  assert.equal(denied.response.status, 401);

  const allowed = await request('GET', '/assessment', undefined, {
    authorization: `Bearer ${adminToken}`
  });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.body.sourceRoot, root);
  assert.equal(allowed.body.secretFilesExcluded, true);
  assert.ok(Array.isArray(allowed.body.files));
  assert.equal(allowed.body.atlas.ok, true);
  assert.deepEqual(allowed.body.atlas.domains.sort(), ['app', 'deployment', 'governance', 'platform']);
  assert.equal(allowed.body.atlas.edges.length, 0);
  assert.equal(allowed.body.atlas.concreteEdges.length, 0);
  assert.ok(allowed.body.atlas.nodes.length > 0);
});

test('assessment aliases retain the same authentication and read-only contract', async () => {
  for (const route of ['/api/bob/assessment', '/api/bob/builder/assessment']) {
    const denied = await request('GET', route);
    assert.equal(denied.response.status, 401);
    const allowed = await request('GET', route, undefined, { authorization: `Bearer ${adminToken}` });
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.body.sourceRoot, root);
    assert.equal(allowed.body.secretFilesExcluded, true);
  }
});

test('Docker diagnostic aliases require admin authority rather than worker or model authority', async () => {
  for (const route of ['/docker/services', '/api/bob/docker/services', '/api/bob/builder/docker/services']) {
    for (const token of ['', runnerToken, modelGatewayToken]) {
      const result = await request('GET', route, undefined, { authorization: `Bearer ${token}` });
      assert.equal(result.response.status, 401);
    }
    const allowed = await request('GET', route, undefined, { authorization: `Bearer ${adminToken}` });
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.body.services[0].name, '/fixture-api');
    assert.equal(allowed.body.total, 1);
    assert.equal(allowed.body.evidence.environment, 'host_docker_daemon');
    assert.equal(allowed.body.evidence.read_only, true);
  }
});

test('request bodies are bounded and malformed requests do not expose internal errors', async () => {
  const oversized = await fetch(`${baseUrl}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ repository: 'example/app', padding: 'x'.repeat(1024 * 1024) })
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'request body too large' });

  const malformed = await fetch(`${baseUrl}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: '{'
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid request' });
});

test('job routes require the admin bearer token', async () => {
  const { response, body } = await request('POST', '/jobs', { repository: 'example/app' });
  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: 'unauthorized' });
});

test('builder model route requires its dedicated bearer token', async () => {
  const input = {
    provider: 'invalid',
    builder_mode: 'product_analyst',
    prompt_version: 'product-v1',
    idempotency_key: 'job::step::hash',
    system_prompt: 'System',
    user_prompt: 'User'
  };
  const denied = await request('POST', '/api/bob/builder/model-run', input, {
    authorization: `Bearer ${adminToken}`
  });
  assert.equal(denied.response.status, 401);

  const allowed = await request('POST', '/api/bob/builder/model-run', input, {
    authorization: `Bearer ${modelGatewayToken}`
  });
  assert.equal(allowed.response.status, 400);
  assert.deepEqual(allowed.body, { error: 'unsupported model provider' });
});

test('Builder runtime routes require the admin token and fixed server configuration', async () => {
  const denied = await request('POST', '/api/bob/builder/jobs', {});
  assert.equal(denied.response.status, 401);
  const deniedAdvance = await request('POST', '/api/bob/builder/jobs/job-1/advance', {});
  assert.equal(deniedAdvance.response.status, 401);
  const deniedRun = await request('POST', '/api/bob/builder/jobs/job-1/run', {});
  assert.equal(deniedRun.response.status, 401);
  const deniedContext = await request('GET', '/api/bob/builder/jobs/job-1/context');
  assert.equal(deniedContext.response.status, 401);
  const deniedRefresh = await request('POST', '/api/bob/builder/atlas/refresh', {});
  assert.equal(deniedRefresh.response.status, 401);
  const deniedHumanTest = await request('POST', '/api/bob/human-tests', {});
  assert.equal(deniedHumanTest.response.status, 401);
});

test('human-test routes require a configured worker and return durable status receipts', async () => {
  const headers = { authorization: ['Bearer', adminToken].join(' ') };
  const missing = await request('GET', '/api/bob/human-tests/latest', undefined, {
    ...headers
  });
  assert.equal(missing.response.status, 404);
  assert.deepEqual(missing.body, { error: 'No human-test run exists' });

  const unavailable = await request('POST', '/api/bob/human-tests', { mode: 'fixture' }, {
    ...headers
  });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.body.error, 'Human-test worker image is unavailable');

  const liveWithoutIdentity = await request('POST', '/api/bob/human-tests', { mode: 'live' }, {
    ...headers
  });
  assert.equal(liveWithoutIdentity.response.status, 409);
  assert.equal(liveWithoutIdentity.body.error, 'Dedicated live human-test identity and target URL are not configured');
});

test('job creation rejects repositories outside the allowlist', async () => {
  const { response, body } = await request('POST', '/jobs', { repository: 'untrusted/app' }, {
    authorization: `Bearer ${adminToken}`
  });
  assert.equal(response.status, 403);
  assert.deepEqual(body, { error: 'repository is not allowed' });
});

test('authorized jobs can be inspected and cancelled', async () => {
  const headers = { authorization: `Bearer ${adminToken}` };
  const created = await request('POST', '/jobs', {
    repository: 'example/app',
    ref: 'main',
    commitSha: 'abc123',
    jobType: 'verify'
  }, headers);
  assert.equal(created.response.status, 201);
  assert.equal(created.body.status, 'queued');
  assert.equal(created.body.repository, 'example/app');

  const inspected = await request('GET', `/jobs/${created.body.id}`, undefined, headers);
  assert.equal(inspected.response.status, 200);
  assert.equal(inspected.body.audit.some(event => event.type === 'job.created'), true);

  const cancelled = await request('POST', `/jobs/${created.body.id}/cancel`, {}, headers);
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
});

test('worker can pick up a queued job and return an artifact', async () => {
  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  const runnerHeaders = { authorization: `Bearer ${runnerToken}` };
  const created = await request('POST', '/jobs', { repository: 'example/app' }, adminHeaders);
  assert.equal(created.response.status, 201);

  const pickedUp = await request('POST', `/jobs/${created.body.id}/pickup`, { runnerId: 'runner-1' }, runnerHeaders);
  assert.equal(pickedUp.response.status, 200);
  assert.equal(pickedUp.body.status, 'picked_up');
  assert.equal(pickedUp.body.runnerId, 'runner-1');
  assert.ok(pickedUp.body.leaseToken);

  const second = await request('POST', '/jobs', { repository: 'example/app' }, adminHeaders);
  const blocked = await request('POST', `/jobs/${second.body.id}/pickup`, { runnerId: 'runner-2' }, runnerHeaders);
  assert.equal(blocked.response.status, 409);
  assert.deepEqual(blocked.body, { error: 'another job is already leased' });

  const rejectedArtifact = await request('POST', `/jobs/${created.body.id}/artifacts`, {
    runId: pickedUp.body.id,
    leaseToken: 'wrong-lease',
    kind: 'report',
    objectPath: 'forged.json'
  }, runnerHeaders);
  assert.equal(rejectedArtifact.response.status, 409);

  const artifact = await request('POST', `/jobs/${created.body.id}/artifacts`, {
    kind: 'report',
    runId: pickedUp.body.id,
    leaseToken: pickedUp.body.leaseToken,
    objectPath: `${created.body.id}/analysis.json`,
    sizeBytes: 42
  }, runnerHeaders);
  assert.equal(artifact.response.status, 201);
  assert.equal(artifact.body.kind, 'report');

  const inspected = await request('GET', `/jobs/${created.body.id}`, undefined, adminHeaders);
  assert.equal(inspected.body.artifacts.length, 1);
});

test('worker routes reject the admin token', async () => {
  const created = await request('POST', '/jobs', { repository: 'example/app' }, {
    authorization: `Bearer ${adminToken}`
  });
  const response = await request('POST', `/jobs/${created.body.id}/pickup`, { runnerId: 'runner-1' }, {
    authorization: `Bearer ${adminToken}`
  });
  assert.equal(response.response.status, 401);
  assert.deepEqual(response.body, { error: 'runner unauthorized' });
});

test('Gitea webhooks require a valid signature and deduplicate deliveries', async () => {
  const payload = JSON.stringify({
    ref: 'refs/heads/main',
    after: 'def456',
    repository: { full_name: 'example/app' }
  });
  const signature = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');
  const headers = {
    'content-type': 'application/json',
    'x-gitea-signature': signature,
    'x-gitea-delivery': 'delivery-1'
  };

  const accepted = await fetch(`${baseUrl}/webhooks/gitea`, { method: 'POST', headers, body: payload });
  const acceptedBody = await accepted.json();
  assert.equal(accepted.status, 202);
  assert.equal(acceptedBody.accepted, true);
  assert.ok(acceptedBody.jobId);

  const duplicate = await fetch(`${baseUrl}/webhooks/gitea`, { method: 'POST', headers, body: payload });
  assert.equal(duplicate.status, 202);
  assert.deepEqual(await duplicate.json(), { accepted: true, duplicate: true });
});

test('Gitea webhooks reject repositories outside the allowlist', async () => {
  const payload = JSON.stringify({
    ref: 'refs/heads/main',
    after: 'untrusted-commit',
    repository: { full_name: 'untrusted/app' }
  });
  const signature = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');
  const response = await fetch(`${baseUrl}/webhooks/gitea`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gitea-signature': signature,
      'x-gitea-delivery': 'untrusted-delivery'
    },
    body: payload
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'repository is not allowed' });
});

test('laptop shell routes are admin-only and report "not available" until the owner-side link is configured', async () => {
  const anon = await request('GET', '/api/bob/laptop/status');
  assert.equal(anon.response.status, 401);
  const status = await request('GET', '/api/bob/laptop/status', undefined, { authorization: `Bearer ${adminToken}` });
  assert.equal(status.response.status, 200);
  assert.equal(status.body.reachable, false);
  assert.equal(status.body.configured, false);
  assert.ok(status.body.missing.includes('BOB_LAPTOP_SHELL_ENABLED'));
  const run = await request('POST', '/api/bob/laptop/run', { command: 'Get-Date' }, { authorization: `Bearer ${adminToken}` });
  assert.equal(run.response.status, 503);
  assert.match(run.body.error, /laptop shell is not available/);
  // The refusal is recorded (command head + hash only), so the owner can see what Bob attempted.
  const audit = await request('GET', '/api/bob/audit', undefined, { authorization: `Bearer ${adminToken}` });
  if (audit.response.status === 200) {
    const events = Array.isArray(audit.body) ? audit.body : audit.body.events || [];
    const entry = events.find((e) => e.type === 'laptop.shell.run');
    assert.ok(entry, 'laptop.shell.run audit event');
    assert.equal(entry.metadata.command_head, 'Get-Date');
    assert.equal(entry.metadata.status, 503);
  }
});

test('the control plane gives long in-house model runs their full budget: no 5-minute socket or fetch cut-off', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '../bob-control-plane-server.js'), 'utf8');
  // Node's http server (requestTimeout) and fetch (undici headersTimeout) both default to 300 s; job 2fba8ca0's
  // author call was cut at 5:03 and reported as "ollama provider is unreachable".
  assert.match(source, /server\.requestTimeout = Math\.min\(Number\(process\.env\.BOB_MODEL_TIMEOUT_MS \|\| 600000\), 1800000\) \+ 120000;/);
  assert.match(source, /setGlobalDispatcher\(new Agent\(\{ headersTimeout: budgetMs, bodyTimeout: budgetMs/);
  assert.match(source, /globalThis\.fetch = undiciFetch;/);
  const gateway = fs.readFileSync(path.resolve(__dirname, '../builder-model-gateway.js'), 'utf8');
  assert.match(gateway, /HEALTH_PROBE_TIMEOUT_MS = Math\.max\(2_000, Number\(process\.env\.BOB_MODEL_PROBE_TIMEOUT_MS \|\| 10_000\)\)/);
  assert.equal(require('../package.json').dependencies.undici !== undefined, true);
});
