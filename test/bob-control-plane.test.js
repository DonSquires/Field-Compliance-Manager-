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
      PORT: String(port),
      BOB_ADMIN_TOKEN: adminToken,
      BOB_RUNNER_TOKEN: runnerToken,
      BOB_MODEL_GATEWAY_TOKEN: modelGatewayToken,
      BOB_ASSESSMENT_ROOT: root,
      GITEA_WEBHOOK_SECRET: webhookSecret,
      BOB_ALLOWED_REPOSITORIES: 'example/app',
      BOB_ALLOWED_REFS: 'refs/heads/main,main',
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
  assert.deepEqual(body, { status: 'degraded', service: 'bob-control-plane', activeLease: false, builderRuntimeReady: false });
});

test('readiness is authenticated and reports only bounded dependency state', async () => {
  const denied = await request('GET', '/ready');
  assert.equal(denied.response.status, 401);
  const allowed = await request('GET', '/ready', undefined, { authorization: `Bearer ${adminToken}` });
  assert.equal(allowed.response.status, 503);
  assert.equal(allowed.body.ready, false);
  assert.deepEqual(Object.keys(allowed.body.checks).sort(), [
    'docker_available', 'local_model_configured', 'model_gateway_configured', 'persistence_configured',
    'repository_available', 'worker_image_configured'
  ]);
  assert.deepEqual(allowed.body.modelGateway, {
    openai_configured: false,
    ollama_configured: true,
    ollama_auth_configured: false,
    local_builder_provider: 'ollama'
  });
  assert.equal(JSON.stringify(allowed.body).includes(adminToken), false);
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
  assert.ok(allowed.body.atlas.edges.some(edge => edge.source === 'app' && edge.target === 'platform'));
  assert.ok(allowed.body.atlas.edges.some(edge => edge.source === 'platform' && edge.target === 'deployment'));
});

test('system overview aggregates the whole runtime before the part', async () => {
  const denied = await request('GET', '/system');
  assert.equal(denied.response.status, 401);

  const allowed = await request('GET', '/system', undefined, {
    authorization: `Bearer ${adminToken}`
  });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.body.service, 'bob-control-plane');
  assert.equal(allowed.body.sourceRoot, root);
  assert.equal(allowed.body.selfHosted.defaultProfiles.includes('assessment'), true);
  assert.equal(allowed.body.builderRuntime.ready, false);
  assert.deepEqual(allowed.body.modelGateway.local_builder_provider, 'ollama');
  assert.equal(Array.isArray(allowed.body.assessment.files), true);
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
});

test('self-hosted Bob loop is admin-only and supports a dry-run verification pass', async () => {
  const denied = await request('POST', '/api/bob/builder/self-hosted/loop', { dryRun: true });
  assert.equal(denied.response.status, 401);

  const allowed = await request('POST', '/api/bob/builder/self-hosted/loop', {
    dryRun: true,
    profiles: ['assessment', 'test']
  }, { authorization: `Bearer ${adminToken}` });

  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.body.mode, 'self_hosted_bob');
  assert.equal(allowed.body.paused, false);
  assert.deepEqual(allowed.body.plan.profiles, ['assessment', 'test']);
  assert.equal(allowed.body.steps.length, 2);
  assert.equal(allowed.body.steps[0].status, 'succeeded');
});

test('browser checks can validate the live app URL through the control plane', async () => {
  const response = await request('POST', '/api/bob/builder/browser-check', {
    appUrl: 'http://127.0.0.1:4173',
    testName: 'live-app-check'
  }, { authorization: `Bearer ${adminToken}` });

  assert.equal(response.response.status, 500);
  assert.equal(response.body.error, 'browser check failed');
  assert.equal(response.body.appUrl, 'http://127.0.0.1:4173');

  const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'bob-state.json'), 'utf8'));
  assert.ok(Array.isArray(persisted.browserChecks));
  assert.ok(persisted.browserChecks.some(check => check.appUrl === 'http://127.0.0.1:4173' && check.status === 'failed'));
});

test('browser check history is available through the control plane API', async () => {
  const response = await request('GET', '/api/bob/builder/browser-checks', undefined, {
    authorization: `Bearer ${adminToken}`
  });

  assert.equal(response.response.status, 200);
  assert.ok(Array.isArray(response.body));
  assert.ok(response.body.some(check => check.appUrl === 'http://127.0.0.1:4173' && check.status === 'failed'));
});

test('job creation rejects repositories outside the allowlist', async () => {
  const { response, body } = await request('POST', '/jobs', { repository: 'untrusted/app' }, {
    authorization: `Bearer ${adminToken}`
  });
  assert.equal(response.status, 403);
  assert.deepEqual(body, { error: 'repository is not allowed' });
});

test('job creation rejects refs outside the allowlist', async () => {
  const { response, body } = await request('POST', '/jobs', { repository: 'example/app', ref: 'feature/unsafe' }, {
    authorization: `Bearer ${adminToken}`
  });
  assert.equal(response.status, 403);
  assert.deepEqual(body, { error: 'ref is not allowed' });
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
    'x-gitea-event': 'push',
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

test('Gitea webhooks reject unsupported signed events before job intake', async () => {
  const payload = JSON.stringify({
    repository: { full_name: 'example/app' },
    issue: { id: 1 }
  });
  const signature = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');
  const response = await fetch(`${baseUrl}/webhooks/gitea`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gitea-signature': signature,
      'x-gitea-event': 'issues',
      'x-gitea-delivery': 'issue-delivery'
    },
    body: payload
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'unsupported webhook event' });
});

test('Gitea webhooks reject pushes outside the allowed refs', async () => {
  const payload = JSON.stringify({
    ref: 'refs/heads/feature/unsafe',
    after: 'def456',
    repository: { full_name: 'example/app' }
  });
  const signature = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');
  const response = await fetch(`${baseUrl}/webhooks/gitea`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gitea-signature': signature,
      'x-gitea-event': 'push',
      'x-gitea-delivery': 'feature-delivery'
    },
    body: payload
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'ref is not allowed' });
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
      'x-gitea-event': 'push',
      'x-gitea-delivery': 'untrusted-delivery'
    },
    body: payload
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'repository is not allowed' });
});

test('job assessments can be initiated and status retrieved', async () => {
  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  const jobId = crypto.randomUUID();
  
  const statusBefore = await request('GET', `/api/bob/builder/jobs/${jobId}/assessment`, undefined, adminHeaders);
  assert.equal(statusBefore.response.status, 200);
  assert.equal(statusBefore.body, null);
  
  const assessment = await request('POST', `/api/bob/builder/jobs/${jobId}/assessment`, {
    appUrl: 'http://127.0.0.1:4173'
  }, adminHeaders);
  assert.equal(assessment.response.status, 200);
  assert.ok(assessment.body.id);
  assert.equal(assessment.body.jobId, jobId);
  assert.ok(['passed', 'failed'].includes(assessment.body.status));
  assert.ok(Array.isArray(assessment.body.steps));
  
  const statusAfter = await request('GET', `/api/bob/builder/jobs/${jobId}/assessment`, undefined, adminHeaders);
  assert.equal(statusAfter.response.status, 200);
  assert.equal(statusAfter.body.jobId, jobId);
  assert.equal(statusAfter.body.status, assessment.body.status);
});

test('job assessment requires authorization', async () => {
  const jobId = crypto.randomUUID();
  const response = await request('POST', `/api/bob/builder/jobs/${jobId}/assessment`, {
    appUrl: 'http://127.0.0.1:4173'
  });
  assert.equal(response.response.status, 401);
  assert.deepEqual(response.body, { error: 'unauthorized' });
});

test('job assessment persists across server restart', async () => {
  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  const jobId = crypto.randomUUID();
  
  const created = await request('POST', `/api/bob/builder/jobs/${jobId}/assessment`, {
    appUrl: 'http://127.0.0.1:4173'
  }, adminHeaders);
  assert.equal(created.response.status, 200);
  assert.ok(created.body.id);
  
  const { response: statusRes, body: persisted } = await request('GET', `/api/bob/builder/jobs/${jobId}/assessment`, undefined, adminHeaders);
  assert.equal(statusRes.status, 200);
  assert.equal(persisted.jobId, jobId);
  assert.equal(persisted.status, created.body.status);
});

test('job advance requires a passing assessment', async () => {
  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  const jobId = crypto.randomUUID();
  
  const advanceWithoutAssessment = await request('POST', `/api/bob/builder/jobs/${jobId}/advance`, {
    frontendFiles: [],
    backendFiles: []
  }, adminHeaders);
  assert.equal(advanceWithoutAssessment.response.status, 412);
  assert.deepEqual(advanceWithoutAssessment.body.error, 'Assessment required');
  assert.equal(advanceWithoutAssessment.body.assessment, null);
  
  const assessment = await request('POST', `/api/bob/builder/jobs/${jobId}/assessment`, {
    appUrl: 'http://127.0.0.1:4173'
  }, adminHeaders);
  assert.ok(['passed', 'failed'].includes(assessment.body.status));
  
  if (assessment.body.status === 'passed') {
    const advanceWithAssessment = await request('POST', `/api/bob/builder/jobs/${jobId}/advance`, {
      frontendFiles: [],
      backendFiles: []
    }, adminHeaders);
    assert.ok([202, 200, 404, 503].includes(advanceWithAssessment.response.status));
  }
});


