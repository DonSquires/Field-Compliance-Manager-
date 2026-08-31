const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { createWorkflowClient } = require('./supabase-workflow-client');
const { createAssessment } = require('./assessment-manifest');
const { buildAtlasGraph } = require('./scripts/atlas-graph');
const { createModelGatewayConfig, modelGatewayReadiness, invokeBuilderModel } = require('./builder-model-gateway');
const { loadBuilderRuntimeSnapshot, advanceBuilderJob, runBuilderUntilPause } = require('./builder-runtime-coordinator');
const { executeWorker } = require('./worker-executor');
const { runSelfHostedBuildLoop } = require('./bob-self-hosted');
const { runVisualCheck } = require('./browser-verifier');

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const webhookSecret = process.env.GITEA_WEBHOOK_SECRET || '';
const adminToken = process.env.BOB_ADMIN_TOKEN || '';
const runnerToken = process.env.BOB_RUNNER_TOKEN || '';
const modelGatewayToken = process.env.BOB_MODEL_GATEWAY_TOKEN || '';
const assessmentRoot = process.env.BOB_ASSESSMENT_ROOT || '/app';
const allowedRepositories = new Set((process.env.BOB_ALLOWED_REPOSITORIES || '')
  .split(',')
  .map(repository => repository.trim())
  .filter(Boolean));
const allowedRefs = new Set((process.env.BOB_ALLOWED_REFS || 'refs/heads/main,main')
  .split(',')
  .map(ref => ref.trim())
  .filter(Boolean));
const stateDir = process.env.BOB_STATE_DIR || '/data';
const workflowClient = createWorkflowClient({
  url: process.env.SUPABASE_URL,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  mode: process.env.BOB_WORKFLOW_MODE || 'local'
});
const modelGatewayConfig = createModelGatewayConfig();
const builderSupabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
  : null;
const builderGateway = {
  gatewayUrl: process.env.BOB_MODEL_GATEWAY_URL || `http://127.0.0.1:${port}`,
  apiToken: modelGatewayToken
};
const builderWorkerImage = process.env.BOB_WORKER_IMAGE || '';
const builderRunnerId = process.env.BOB_BUILDER_RUNNER_ID || 'bob-builder-runtime';
const stateFile = path.join(stateDir, 'bob-state.json');
const maxRequestBytes = 1024 * 1024;
const jobs = new Map();
const deliveries = new Set();
const browserChecks = [];
const audit = [];
let activeLease = null;
let dockerReadinessCache = { checkedAt: 0, available: false };

function detectDockerAccess(spawn = spawnSync) {
  const result = spawn('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  return result.status === 0 && Boolean(String(result.stdout || '').trim());
}

function cachedDockerAccess(now = Date.now(), detect = detectDockerAccess) {
  if (now - dockerReadinessCache.checkedAt >= 15000) {
    dockerReadinessCache = { checkedAt: now, available: detect() };
  }
  return dockerReadinessCache.available;
}

function builderRuntimeReadiness({ dockerAccess = detectDockerAccess() } = {}) {
  const modelReadiness = modelGatewayReadiness(modelGatewayConfig);
  const checks = {
    persistence_configured: Boolean(builderSupabase),
    model_gateway_configured: Boolean(modelGatewayToken && modelReadiness.ollama_configured),
    local_model_configured: modelReadiness.ollama_configured,
    worker_image_configured: Boolean(builderWorkerImage),
    repository_available: fs.existsSync(path.join(assessmentRoot, '.git')),
    docker_available: Boolean(dockerAccess)
  };
  return { ready: Object.values(checks).every(Boolean), checks, modelGateway: modelReadiness };
}

function saveState() {
  fs.mkdirSync(stateDir, { recursive: true });
  const state = {
    jobs: [...jobs.values()],
    deliveries: [...deliveries],
    browserChecks: [...browserChecks],
    audit
  };
  const temporary = `${stateFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, stateFile);
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const job of state.jobs || []) jobs.set(job.id, job);
    for (const delivery of state.deliveries || []) deliveries.add(delivery);
    for (const check of state.browserChecks || []) browserChecks.push(check);
    audit.push(...(state.audit || []));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

loadState();

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1024 * 1024) reject(new Error('payload too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!adminToken) return false;
  return req.headers.authorization === `Bearer ${adminToken}`;
}

function runnerAuthorized(req) {
  return Boolean(runnerToken) && req.headers.authorization === `Bearer ${runnerToken}`;
}

function modelGatewayAuthorized(req) {
  return Boolean(modelGatewayToken) && req.headers.authorization === `Bearer ${modelGatewayToken}`;
}

function repositoryAllowed(repository) {
  return Boolean(repository) && allowedRepositories.has(repository);
}

function refAllowed(ref = 'main') {
  if (!ref || typeof ref !== 'string') return false;
  return allowedRefs.has(ref) || allowedRefs.has(ref.replace(/^refs\/heads\//, ''));
}

function giteaEvent(req) {
  return String(req.headers['x-gitea-event'] || '').toLowerCase();
}

function boundedStringArray(value, maximum = 100) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, maximum);
}

function builderRuntimeContext(body) {
  return {
    sourceDir: assessmentRoot,
    workerImage: builderWorkerImage,
    runnerId: builderRunnerId,
    reviewerModelName: typeof body.reviewerModelName === 'string' ? body.reviewerModelName.slice(0, 200) : null,
    frontendFiles: boundedStringArray(body.frontendFiles, 30),
    backendFiles: boundedStringArray(body.backendFiles, 40),
    constraints: boundedStringArray(body.constraints, 100),
    requestedFromUsers: boundedStringArray(body.requestedFromUsers, 100),
    repositoryContext: body.repositoryContext && typeof body.repositoryContext === 'object' ? body.repositoryContext : {},
    designContext: body.designContext && typeof body.designContext === 'object' ? body.designContext : {}
  };
}

function webhookValid(req, rawBody) {
  if (!webhookSecret) return false;
  const supplied = req.headers['x-gitea-signature'] || req.headers['x-hub-signature-256'] || '';
  const digest = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const expected = supplied.replace(/^sha256=/, '');
  return expected.length === digest.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digest));
}

function record(actor, type, subject, metadata = {}) {
  const event = { id: crypto.randomUUID(), occurredAt: new Date().toISOString(), actor, type, subject, metadata };
  audit.push(event);
  saveState();
  return event;
}

async function createJob(input, actor) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const remoteJob = await workflowClient.createJob({
    title: `${input.jobType || 'build'}: ${input.repository}`,
    payload: {
      actor,
      repository: input.repository,
      ref: input.ref || 'main',
      commitSha: input.commitSha || null,
      jobType: input.jobType || 'build'
    }
  });
  const job = {
    id: remoteJob?.id || id,
    status: 'queued',
    jobType: input.jobType || 'build',
    repository: input.repository,
    ref: input.ref || 'main',
    commitSha: input.commitSha || null,
    requestedBy: actor,
    createdAt: remoteJob?.created_at || now,
    updatedAt: remoteJob?.updated_at || now,
    approval: null,
    verificationStatus: 'pending'
  };
  jobs.set(job.id, job);
  record(actor, 'job.created', job.id, { repository: job.repository, ref: job.ref });
  return { ...job, workflow: remoteJob ? 'supabase' : 'local' };
}

async function route(req, res, body) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    const runtime = builderRuntimeReadiness({ dockerAccess: cachedDockerAccess() });
    return json(res, 200, { status: runtime.ready ? 'ok' : 'degraded', service: 'bob-control-plane', activeLease: Boolean(activeLease), builderRuntimeReady: runtime.ready });
  }
  if (req.method === 'GET' && url.pathname === '/ready') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const runtime = builderRuntimeReadiness();
    return json(res, runtime.ready ? 200 : 503, runtime);
  }
  if (req.method === 'POST' && url.pathname === '/api/bob/builder/model-run') {
    if (!modelGatewayAuthorized(req)) return json(res, 401, { error: 'model gateway unauthorized' });
    const result = await invokeBuilderModel({ input: body, config: modelGatewayConfig });
    return json(res, result.status, result.body);
  }
  if (req.method === 'POST' && url.pathname === '/api/bob/builder/self-hosted/loop') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const profiles = Array.isArray(body.profiles) ? body.profiles.filter(profile => typeof profile === 'string' && profile.trim()) : ['assessment', 'test'];
    const dryRun = body.dryRun === true;
    const selectedProfiles = profiles.length ? profiles : ['assessment', 'test'];
    const appUrl = body.appUrl || process.env.BOB_APP_URL || process.env.VITE_APP_URL || null;
    const runner = dryRun
      ? async ({ profile, sourceDir, artifactDir, image, env }) => ({
          status: 'succeeded',
          exitCode: 0,
          profile,
          stdout: `dry-run:${profile}${env && env.BOB_APP_URL ? `:${env.BOB_APP_URL}` : ''}`,
          stderr: '',
          sourceDir,
          artifactDir,
          image,
          env
        })
      : async options => {
          try {
            const workerOptions = {
              ...options,
              env: options.env || (options.profile === 'playwright-visual-check' && appUrl ? { BOB_APP_URL: appUrl } : {})
            };
            return await executeWorker(workerOptions);
          } catch (error) {
            return {
              status: 'failed',
              exitCode: 1,
              profile: options.profile,
              stdout: '',
              stderr: String(error && error.message ? error.message : error),
              sourceDir: options.sourceDir,
              artifactDir: options.artifactDir,
              image: options.image,
              env: options.env
            };
          }
        };
    const result = await runSelfHostedBuildLoop({
      rootDir: assessmentRoot,
      artifactDir: path.join(assessmentRoot, 'bob-artifacts'),
      profiles: selectedProfiles,
      workerImage: builderWorkerImage || body.workerImage || 'fcm/bob-worker:local',
      execute: runner,
      assessmentFactory: createAssessment,
      appUrl
    });
    return json(res, 200, result);
  }
  if (req.method === 'GET' && url.pathname === '/api/bob/builder/browser-checks') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, [...browserChecks].slice(-20).reverse());
  }
  if (req.method === 'POST' && url.pathname === '/api/bob/builder/browser-check') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const appUrl = body.appUrl || body.url || process.env.BOB_APP_URL || process.env.VITE_APP_URL;
    if (!appUrl || typeof appUrl !== 'string') {
      return json(res, 400, { error: 'appUrl is required' });
    }
    const checkRecord = {
      id: crypto.randomUUID(),
      appUrl,
      checkedAt: new Date().toISOString(),
      status: 'pending',
      testName: typeof body.testName === 'string' && body.testName.trim() ? body.testName.trim() : 'bob-hosted-browser-check'
    };
    browserChecks.push(checkRecord);
    saveState();
    try {
      const result = await runVisualCheck({
        appUrl,
        sourceDir: assessmentRoot,
        artifactDir: path.join(assessmentRoot, 'bob-artifacts'),
        testName: checkRecord.testName
      });
      const completed = {
        ...checkRecord,
        status: result.result.status || 'passed',
        manifestPath: result.manifestPath,
        screenshotPath: result.screenshotPath,
        title: result.result.title,
        checks: result.result.checks || [],
        browserErrors: result.result.browserErrors || []
      };
      const index = browserChecks.findIndex(entry => entry.id === checkRecord.id);
      if (index >= 0) browserChecks[index] = completed;
      saveState();
      return json(res, 200, {
        mode: 'browser_check',
        appUrl,
        manifestPath: result.manifestPath,
        screenshotPath: result.screenshotPath,
        result: result.result
      });
    } catch (error) {
      const failed = {
        ...checkRecord,
        status: 'failed',
        error: String(error && error.message ? error.message : error),
        checkedAt: new Date().toISOString()
      };
      const index = browserChecks.findIndex(entry => entry.id === checkRecord.id);
      if (index >= 0) browserChecks[index] = failed;
      saveState();
      return json(res, 500, {
        error: 'browser check failed',
        details: String(error && error.message ? error.message : error),
        appUrl
      });
    }
  }
  if (req.method === 'GET' && url.pathname === '/assessment') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const assessment = createAssessment(assessmentRoot);
    const atlas = buildAtlasGraph(assessmentRoot);
    return json(res, 200, { ...assessment, sourceRoot: assessmentRoot, atlas });
  }
  if (req.method === 'GET' && url.pathname === '/system') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const assessment = createAssessment(assessmentRoot);
    const atlas = buildAtlasGraph(assessmentRoot);
    const runtime = builderRuntimeReadiness({ dockerAccess: cachedDockerAccess() });
    const selfHosted = {
      mode: 'self_hosted_bob',
      readOnly: true,
      defaultProfiles: ['assessment', 'test', 'build', 'lint', 'security-review', 'playwright-visual-check'],
      summary: 'Self-hosted Bob performs evidence-based repository assessment, app validation, and browser-level visual checks before any approval.'
    };
    return json(res, 200, {
      service: 'bob-control-plane',
      sourceRoot: assessmentRoot,
      assessment,
      atlas,
      builderRuntime: runtime,
      modelGateway: modelGatewayReadiness(modelGatewayConfig),
      selfHosted,
      activeLease: Boolean(activeLease)
    });
  }
  const workerRoute = req.method === 'POST' && /^\/jobs\/[^/]+\/(pickup|artifacts)$/.test(url.pathname);
  if (!authorized(req) && !workerRoute) return json(res, 401, { error: 'unauthorized' });

  if (req.method === 'POST' && url.pathname === '/jobs') {
    if (!body.repository) return json(res, 400, { error: 'repository is required' });
    if (!repositoryAllowed(body.repository)) return json(res, 403, { error: 'repository is not allowed' });
    if (!refAllowed(body.ref || 'main')) return json(res, 403, { error: 'ref is not allowed' });
    return json(res, 201, await createJob(body, 'admin'));
  }

  if (req.method === 'POST' && url.pathname === '/api/bob/builder/jobs') {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    if (!body.repository || !repositoryAllowed(body.repository)) return json(res, 403, { error: 'repository is not allowed' });
    if (!body.organizationId || !body.projectId || !body.title || !body.taskDescription || !body.targetSha) {
      return json(res, 400, { error: 'organizationId, projectId, title, taskDescription, and targetSha are required' });
    }
    const { data, error } = await builderSupabase.rpc('builder_create_job', {
      _organization_id: body.organizationId,
      _project_id: body.projectId,
      _title: body.title,
      _task_description: body.taskDescription,
      _target_sha: body.targetSha,
      _branch_name: body.branchName || 'main',
      _description: body.description || null,
      _frontend_required: body.frontendRequired !== false,
      _backend_required: body.backendRequired === true,
      _code_review_mode: body.codeReviewMode || 'none',
      _task_run_id: body.taskRunId || null
    });
    if (error || !data?.id) return json(res, 409, { error: 'Builder job could not be created' });
    return json(res, 201, data);
  }

  const builderMatch = url.pathname.match(/^\/api\/bob\/builder\/jobs\/([^/]+)(?:\/(advance|run))?$/);
  if (builderMatch && req.method === 'GET' && !builderMatch[2]) {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    try {
      return json(res, 200, await loadBuilderRuntimeSnapshot(builderSupabase, builderMatch[1]));
    } catch {
      return json(res, 404, { error: 'Builder job not found' });
    }
  }
  if (builderMatch && req.method === 'POST' && builderMatch[2] === 'advance') {
    if (!builderSupabase || !modelGatewayToken || !builderWorkerImage) {
      return json(res, 503, { error: 'Builder runtime is unavailable' });
    }
    try {
      const outcome = await advanceBuilderJob({
        supabase: builderSupabase,
        gateway: builderGateway,
        jobId: builderMatch[1],
        context: builderRuntimeContext(body)
      });
      return json(res, outcome.advanced ? 202 : 200, outcome);
    } catch {
      return json(res, 409, { error: 'Builder job could not advance' });
    }
  }
  if (builderMatch && req.method === 'POST' && builderMatch[2] === 'run') {
    if (!builderSupabase || !modelGatewayToken || !builderWorkerImage) {
      return json(res, 503, { error: 'Builder runtime is unavailable' });
    }
    try {
      const outcome = await runBuilderUntilPause({
        supabase: builderSupabase,
        gateway: builderGateway,
        jobId: builderMatch[1],
        context: builderRuntimeContext(body),
        maxActions: body.maxActions
      });
      return json(res, 200, outcome);
    } catch {
      return json(res, 409, { error: 'Builder runtime could not continue' });
    }
  }

  const match = url.pathname.match(/^\/jobs\/([^/]+)(?:\/(approve|cancel))?$/);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job) return json(res, 404, { error: 'job not found' });
    if (req.method === 'GET' && !match[2]) return json(res, 200, { ...job, audit: audit.filter(event => event.subject === job.id) });
    if (req.method === 'POST' && match[2] === 'cancel') {
      if (['deployed', 'cancelled'].includes(job.status)) return json(res, 409, { error: 'job cannot be cancelled' });
      job.status = 'cancelled'; job.updatedAt = new Date().toISOString();
      if (activeLease?.jobId === job.id) activeLease = null;
      record('admin', 'job.cancelled', job.id); return json(res, 200, job);
    }
    if (req.method === 'POST' && match[2] === 'approve') {
      if (job.status !== 'approval_required') return json(res, 409, { error: 'job is not awaiting approval' });
      job.approval = { approver: 'admin', commitSha: body.commitSha || job.commitSha, target: body.deploymentTarget || null, at: new Date().toISOString() };
      job.status = 'approved'; job.updatedAt = new Date().toISOString(); record('admin', 'job.approved', job.id, job.approval); return json(res, 200, job);
    }
  }

  const pickupMatch = url.pathname.match(/^\/jobs\/([^/]+)\/pickup$/);
  if (req.method === 'POST' && pickupMatch) {
    if (!runnerAuthorized(req)) return json(res, 401, { error: 'runner unauthorized' });
    const job = jobs.get(pickupMatch[1]);
    if (!job) return json(res, 404, { error: 'job not found' });
    if (!body.runnerId || typeof body.runnerId !== 'string') return json(res, 400, { error: 'runnerId is required' });
    if (activeLease && activeLease.jobId !== job.id) return json(res, 409, { error: 'another job is already leased' });
    const run = await workflowClient.pickupRun({ job_id: job.id, runner_id: body.runnerId });
    if (run) {
      activeLease = { jobId: job.id, runId: run.id, runnerId: body.runnerId, token: crypto.randomBytes(32).toString('hex') };
      job.run = { ...run, runnerId: body.runnerId };
      return json(res, 200, { ...run, leaseToken: activeLease.token });
    }
    if (job.status !== 'queued') return json(res, 409, { error: 'job is not queued' });
    job.status = 'running';
    job.runnerId = body.runnerId;
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    job.run = { id: crypto.randomUUID(), status: 'picked_up', runnerId: body.runnerId, pickedUpAt: job.startedAt };
    activeLease = { jobId: job.id, runId: job.run.id, runnerId: body.runnerId, token: crypto.randomBytes(32).toString('hex') };
    record('runner', 'job.picked_up', job.id, { runnerId: body.runnerId });
    return json(res, 200, { ...job.run, leaseToken: activeLease.token });
  }

  const artifactMatch = url.pathname.match(/^\/jobs\/([^/]+)\/artifacts$/);
  if (req.method === 'POST' && artifactMatch) {
    if (!runnerAuthorized(req)) return json(res, 401, { error: 'runner unauthorized' });
    const job = jobs.get(artifactMatch[1]);
    if (!job) return json(res, 404, { error: 'job not found' });
    if (!body.kind || !body.objectPath) return json(res, 400, { error: 'kind and objectPath are required' });
    if (!activeLease || activeLease.jobId !== job.id || activeLease.runId !== job.run?.id || body.leaseToken !== activeLease.token) {
      return json(res, 409, { error: 'artifact is not attached to the active worker lease' });
    }
    if (body.runId !== job.run.id) return json(res, 409, { error: 'artifact run does not match the active worker run' });
    const artifact = await workflowClient.returnArtifact({
      job_id: job.id,
      run_id: body.runId || job.run?.id || null,
      kind: body.kind,
      bucket_id: body.bucketId || 'wf-artifacts',
      object_path: body.objectPath,
      sha256: body.sha256 || null,
      size_bytes: body.sizeBytes ?? null,
      lease_token: body.leaseToken
    });
    if (artifact) {
      activeLease = null;
      return json(res, 201, artifact);
    }
    const localArtifact = { id: crypto.randomUUID(), jobId: job.id, kind: body.kind, objectPath: body.objectPath, runId: body.runId || job.run?.id || null, sha256: body.sha256 || null, sizeBytes: body.sizeBytes ?? null };
    job.artifacts = [...(job.artifacts || []), localArtifact];
    job.updatedAt = new Date().toISOString();
    record('runner', 'artifact.returned', job.id, { artifactId: localArtifact.id, kind: localArtifact.kind });
    activeLease = null;
    return json(res, 201, localArtifact);
  }

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  let raw = '';
  let tooLarge = false;
  req.on('data', chunk => {
    if (tooLarge) return;
    raw += chunk;
    if (Buffer.byteLength(raw) > maxRequestBytes) {
      tooLarge = true;
      raw = '';
    }
  });
  req.on('end', async () => {
    if (tooLarge) return json(res, 413, { error: 'request body too large' });
    try {
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === 'POST' && req.url === '/webhooks/gitea') {
        if (!webhookValid(req, raw)) return json(res, 401, { error: 'invalid webhook signature' });
        const event = giteaEvent(req);
        if (event !== 'push') return json(res, 400, { error: 'unsupported webhook event' });
        const delivery = req.headers['x-gitea-delivery'] || req.headers['x-request-id'];
        if (delivery && deliveries.has(delivery)) return json(res, 202, { accepted: true, duplicate: true });
        const repository = body.repository?.full_name || body.repository?.name;
        if (!repositoryAllowed(repository)) return json(res, 403, { error: 'repository is not allowed' });
        if (!refAllowed(body.ref)) return json(res, 403, { error: 'ref is not allowed' });
        if (delivery) deliveries.add(delivery);
        saveState();
        const job = await createJob({ repository, ref: body.ref, commitSha: body.after }, 'gitea');
        record('gitea', 'webhook.received', job.id, { delivery, event });
        return json(res, 202, { accepted: true, jobId: job.id });
      }
      await route(req, res, body);
    } catch { json(res, 400, { error: 'invalid request' }); }
  });
});

server.listen(port, host, () => console.log(`bob-control-plane listening on ${host}:${port}`));

module.exports = { builderRuntimeReadiness, cachedDockerAccess, detectDockerAccess };