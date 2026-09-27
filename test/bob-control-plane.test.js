const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const port = 18080 + Math.floor(Math.random() * 1000);
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-control-plane-'));
const adminToken = 'test-admin-token';
const runnerToken = 'test-runner-token';
const modelGatewayToken = 'test-model-gateway-token';
const webhookSecret = 'test-webhook-secret';
const baseUrl = `http://127.0.0.1:${port}`;
let serverProcess;

async function request(method, route, body, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

test.before(async () => {
  serverProcess = spawn(process.execPath, ['bob-control-plane-server.js'], {
    cwd: root,
    env: {
      ...process.env,
      // Hermetic: the developer's live Supabase env must not leak into the unit server
      // (it made /health read the live laptop registry once the laptop had registered).
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      PORT: String(port),
      BOB_ADMIN_TOKEN: adminToken,
      BOB_RUNNER_TOKEN: runnerToken,
      BOB_MODEL_GATEWAY_TOKEN: modelGatewayToken,
      BOB_ASSESSMENT_ROOT: root,
      GITEA_WEBHOOK_SECRET: webhookSecret,
      BOB_ALLOWED_REPOSITORIES: 'example/app',
      BOB_STATE_DIR: stateDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await once(serverProcess, 'spawn');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Bob control plane did not start');
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
  const { modelProviders, laptopShell, ...rest } = body;
  assert.deepEqual(rest, { status: 'ok', service: 'bob-control-plane', activeLease: false, builderGitHost: 'gitea', builderSourceConfigured: false, autopilot: false, autopilotIntervalMs: 60_000, runningBuilderJobs: 0 });
  // Bob's laptop terminal is off unless the owner-side env enables it; health never carries the user or key path.
  assert.deepEqual(laptopShell, { enabled: false, configured: false, host: null, ssh_allowed: null });
  // Provider health names Bob's own compute first and never carries secrets or URLs.
  assert.deepEqual(Object.keys(modelProviders).sort(), ['gpu_workstation', 'ollama', 'openai']);
  assert.deepEqual(Object.keys(modelProviders.openai).sort(), ['configured', 'healthy', 'ready_model']);
  assert.equal(modelProviders.gpu_workstation.configured, false, 'no GPU link in the test environment');
});

test('control-plane source has a bounded stale Builder lease recovery path', () => {
  const source = fs.readFileSync(path.join(root, 'bob-control-plane-server.js'), 'utf8');
  assert.match(source, /BOB_BUILDER_STALE_RUN_MS/);
  assert.match(source, /builder\.run\.stale_lease_cleared/);
  assert.match(source, /clearStaleBuilderRun\(jobId\)/);
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
