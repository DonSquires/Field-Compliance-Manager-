const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { createWorkflowClient } = require('./supabase-workflow-client');
const { createAssessment } = require('./assessment-manifest');
const { collectRepositoryContext } = require('./supabase/functions/_shared/builder-repository-context');
const { collectBuilderLiveContext } = require('./builder-live-context');
const { buildAtlasGraph } = require('./scripts/atlas-graph');
const { createModelGatewayConfig, invokeBuilderModel } = require('./builder-model-gateway');
const { loadBuilderRuntimeSnapshot, advanceBuilderJob, runBuilderUntilPause } = require('./builder-runtime-coordinator');
const { createBranchWorkspace, commitVerifiedPatch, publishWorkspaceBranch, createGiteaPullRequest, workspacePathForBranch, createGitHubPullRequest, ensureSourceCheckout, githubAuthHeader, githubRepoUrl, resolveRemoteHead } = require('./builder-branch-workspace');

const port = Number(process.env.PORT || 8080);
const webhookSecret = process.env.GITEA_WEBHOOK_SECRET || '';
const adminToken = process.env.BOB_ADMIN_TOKEN || '';
const runnerToken = process.env.BOB_RUNNER_TOKEN || '';
const modelGatewayToken = process.env.BOB_MODEL_GATEWAY_TOKEN || '';
const assessmentRoot = process.env.BOB_ASSESSMENT_ROOT || '/app';
const allowedRepositories = new Set((process.env.BOB_ALLOWED_REPOSITORIES || '')
  .split(',')
  .map(repository => repository.trim())
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
const builderWorkspaceRoot = process.env.BOB_BUILDER_WORKSPACE_ROOT || '/data/builder-workspaces';
const giteaBaseUrl = process.env.GITEA_BASE_URL || '';
const giteaToken = process.env.GITEA_TOKEN || '';
const giteaOwner = process.env.GITEA_OWNER || '';
const giteaRepo = process.env.GITEA_REPO || '';
const giteaUsername = process.env.GITEA_USERNAME || '';
// GitHub is the single target build; Gitea stays available as the mirror host.
// Without a GitHub token the Builder publishes to Gitea and the
// bob-builder-bridge GitHub Action carries bob/job-* branches to GitHub as draft PRs.
const githubToken = process.env.GITHUB_TOKEN || '';
const githubOwner = process.env.GITHUB_OWNER || '';
const githubRepo = process.env.GITHUB_REPO || '';
const builderGitHost = process.env.BUILDER_GIT_HOST || (githubToken && githubOwner && githubRepo ? 'github' : 'gitea');
const builderSourceDir = process.env.BOB_BUILDER_SOURCE_DIR || path.join(stateDir, 'builder-source');

function giteaRepoUrl() {
  if (!giteaBaseUrl || !giteaOwner || !giteaRepo) throw new Error('Builder Gitea repository is not configured');
  return `${giteaBaseUrl.replace(/\/+$/, '')}/${giteaOwner}/${giteaRepo}.git`;
}

// Gitea's git-over-HTTP takes the access token as a Basic password (per-invocation header, never stored).
function giteaGitAuthHeader() {
  if (!giteaToken) throw new Error('Builder Gitea token is not configured');
  return `Authorization: Basic ${Buffer.from(`${giteaUsername || giteaOwner}:${giteaToken}`).toString('base64')}`;
}

function builderGitTarget() {
  return builderGitHost === 'github'
    ? { host: 'github', repoUrl: githubRepoUrl(githubOwner, githubRepo), authHeader: githubAuthHeader(githubToken) }
    : { host: 'gitea', repoUrl: giteaRepoUrl(), authHeader: giteaGitAuthHeader() };
}

// Where git work (worktrees, commits, pushes) starts from: a real clone kept at
// the job's pinned SHA. The image copy at assessmentRoot has no .git and is
// only read for assessment.
function builderGitSource(targetSha) {
  const target = builderGitTarget();
  return ensureSourceCheckout({ sourceDir: builderSourceDir, repoUrl: target.repoUrl, authHeader: target.authHeader, sha: targetSha }).sourceDir;
}

function builderRepositoryHead(ref = 'main') {
  const target = builderGitTarget();
  return { host: target.host, ref, sha: resolveRemoteHead({ repoUrl: target.repoUrl, authHeader: target.authHeader, ref }) };
}
const stateFile = path.join(stateDir, 'bob-state.json');
const maxRequestBytes = 1024 * 1024;
const jobs = new Map();
const deliveries = new Set();
const audit = [];
let activeLease = null;

function saveState() {
  fs.mkdirSync(stateDir, { recursive: true });
  const state = {
    jobs: [...jobs.values()],
    deliveries: [...deliveries],
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

function boundedStringArray(value, maximum = 100) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, maximum);
}

async function builderRuntimeContext(body, source = { sourceDir: assessmentRoot, targetSha: null }) {
  const buildMap = source.targetSha ? collectRepositoryContext(source) : null;
  const liveContext = builderSupabase ? await collectBuilderLiveContext(builderSupabase) : null;
  return {
    sourceDir: source.sourceDir,
    // The agentic engineer spawns the job worktree from the pinned shared checkout and reads the canon from the image copy.
    gitSourceDir: source.gitSourceDir || null,
    workspaceRoot: builderWorkspaceRoot,
    repoRoot: assessmentRoot,
    workerImage: builderWorkerImage,
    runnerId: builderRunnerId,
    reviewerModelName: typeof body.reviewerModelName === 'string' ? body.reviewerModelName.slice(0, 200) : null,
    frontendFiles: boundedStringArray(body.frontendFiles, 30),
    backendFiles: boundedStringArray(body.backendFiles, 40),
    constraints: boundedStringArray(body.constraints, 100),
    requestedFromUsers: boundedStringArray(body.requestedFromUsers, 100),
    liveContext,
    repositoryContext: {
      ...(body.repositoryContext && typeof body.repositoryContext === 'object' ? body.repositoryContext : {}),
      build_map: buildMap,
      live_context: liveContext
    },
    designContext: {
      ...(body.designContext && typeof body.designContext === 'object' ? body.designContext : {}),
      build_map: buildMap,
      live_context: liveContext
    }
  };
}

function refreshAtlas() {
  const output = require('node:child_process').execFileSync(process.execPath, ['scripts/atlas-refresh.js', '--apply'], {
    cwd: assessmentRoot,
    encoding: 'utf8',
    env: { ...process.env, ATLAS_REFRESH_OUTPUT_DIR: '/tmp/bob-atlas-refresh' },
    maxBuffer: 1024 * 1024
  });
  return { refreshed_at: new Date().toISOString(), summary: output.trim().slice(-1000) };
}

async function resolveBuilderSourceDir(jobId) {
  const { data: job, error } = await builderSupabase.from('builder_jobs').select('id,workspace_branch,workspace_head_sha,target_sha').eq('id', jobId).single();
  if (error || !job?.target_sha) throw new Error('Builder job source is unavailable');
  if (!job.workspace_branch) {
    // No bound workspace yet: work from the job's own worktree at the pinned commit
    // (the image copy has no .git). The workspace route later binds this same branch.
    const gitSourceDir = builderGitSource(job.target_sha);
    const workspace = createBranchWorkspace({ sourceDir: gitSourceDir, workspaceRoot: builderWorkspaceRoot, jobId: job.id, targetSha: job.target_sha, recoverInterrupted: true });
    return { sourceDir: workspace.workspacePath, gitSourceDir, targetSha: job.target_sha };
  }
  const sourceDir = workspacePathForBranch(builderWorkspaceRoot, job.workspace_branch);
  if (!fs.existsSync(sourceDir)) throw new Error('Builder workspace is unavailable');
  if (job.workspace_head_sha !== job.target_sha) throw new Error('Builder job does not match its workspace head');
  return { sourceDir, gitSourceDir: builderSourceDir, targetSha: job.target_sha };
}

// One Builder run per job at a time; runs continue after the HTTP caller has gone.
const runningBuilderJobs = new Map();

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
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', service: 'bob-control-plane', activeLease: Boolean(activeLease), builderGitHost, builderSourceConfigured: builderGitHost === 'github' ? Boolean(githubToken && githubOwner && githubRepo) : Boolean(giteaBaseUrl && giteaToken && giteaOwner && giteaRepo) });
  if (req.method === 'POST' && url.pathname === '/api/bob/builder/model-run') {
    if (!modelGatewayAuthorized(req)) return json(res, 401, { error: 'model gateway unauthorized' });
    const result = await invokeBuilderModel({ input: body, config: modelGatewayConfig });
    return json(res, result.status, result.body);
  }
  const isAssessmentRoute = url.pathname === '/assessment' || ['/api/bob/assessment', '/api/bob/builder/assessment'].includes(url.pathname);
  if (req.method === 'GET' && isAssessmentRoute) {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const assessment = createAssessment(assessmentRoot);
    const atlas = buildAtlasGraph(assessmentRoot);
    return json(res, 200, { ...assessment, sourceRoot: assessmentRoot, atlas });
  }
  const workerRoute = req.method === 'POST' && /^\/jobs\/[^/]+\/(pickup|artifacts)$/.test(url.pathname);
  if (!authorized(req) && !workerRoute) return json(res, 401, { error: 'unauthorized' });

  if (req.method === 'POST' && url.pathname === '/api/bob/builder/atlas/refresh') {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    try {
      return json(res, 200, refreshAtlas());
    } catch {
      return json(res, 503, { error: 'Atlas refresh failed' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/jobs') {
    if (!body.repository) return json(res, 400, { error: 'repository is required' });
    if (!repositoryAllowed(body.repository)) return json(res, 403, { error: 'repository is not allowed' });
    return json(res, 201, await createJob(body, 'admin'));
  }

  if (req.method === 'POST' && url.pathname === '/api/bob/builder/jobs') {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    if (!body.repository || !repositoryAllowed(body.repository)) return json(res, 403, { error: 'repository is not allowed' });
    if (!body.organizationId || !body.projectId || !body.title || !body.taskDescription || !body.targetSha || !body.requestedAction || !body.targetEnvironment) {
      return json(res, 400, { error: 'organizationId, projectId, title, taskDescription, targetSha, requestedAction, and targetEnvironment are required' });
    }
    if (!['prepare_change', 'prepare_release'].includes(body.requestedAction) || !['development', 'staging', 'production'].includes(body.targetEnvironment)) return json(res, 400, { error: 'unsupported Builder action or target environment' });
    if (body.targetEnvironment === 'production' && (body.requestedAction !== 'prepare_release' || body.codeReviewMode !== 'human')) return json(res, 400, { error: 'production Builder jobs require release preparation and human code review' });
    const { data, error } = await builderSupabase.rpc('builder_create_job_v2', {
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
      _task_run_id: body.taskRunId || null,
      _requested_action: body.requestedAction,
      _target_environment: body.targetEnvironment
    });
    if (error || !data?.id) return json(res, 409, { error: 'Builder job could not be created' });
    return json(res, 201, data);
  }

  const builderMatch = url.pathname.match(/^\/api\/bob\/builder\/jobs\/([^/]+)(?:\/(advance|run|workspace|commit|publish|pull-request))?$/);
  const builderContextMatch = url.pathname.match(/^\/api\/bob\/builder\/jobs\/([^/]+)\/context$/);
  if (req.method === 'GET' && url.pathname === '/api/bob/builder/repository/head') {
    try {
      const ref = String(url.searchParams.get('ref') || 'main');
      return json(res, 200, builderRepositoryHead(ref));
    } catch {
      return json(res, 503, { error: 'Builder repository head is unavailable' });
    }
  }
  if (builderContextMatch && req.method === 'GET') {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    try {
      const source = await resolveBuilderSourceDir(builderContextMatch[1]);
      return json(res, 200, {
        build_map: collectRepositoryContext(source),
        live_context: await collectBuilderLiveContext(builderSupabase)
      });
    } catch {
      return json(res, 404, { error: 'Builder context is unavailable' });
    }
  }
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
        context: await builderRuntimeContext(body, await resolveBuilderSourceDir(builderMatch[1]))
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
    const jobId = builderMatch[1];
    if (runningBuilderJobs.has(jobId)) return json(res, 202, { accepted: true, already_running: true, job_id: jobId, started_at: runningBuilderJobs.get(jobId) });
    let context;
    try {
      context = await builderRuntimeContext(body, await resolveBuilderSourceDir(jobId));
    } catch (error) {
      return json(res, 409, { error: 'Builder runtime could not continue', detail: String(error instanceof Error ? error.message : error).slice(0, 200) });
    }
    const execution = runBuilderUntilPause({ supabase: builderSupabase, gateway: builderGateway, jobId, context, maxActions: body.maxActions })
      .then((outcome) => { record('builder', 'builder.run.paused', jobId, { reason: outcome.reason, detail: outcome.detail ?? null, actions: outcome.history?.length ?? 0 }); return outcome; })
      .catch((error) => { record('builder', 'builder.run.failed', jobId, { error: String(error instanceof Error ? error.message : error).slice(0, 300) }); return { paused: true, reason: 'error' }; })
      .finally(() => runningBuilderJobs.delete(jobId));
    runningBuilderJobs.set(jobId, new Date().toISOString());
    if (body.wait === true) return json(res, 200, await execution);
    // Agentic implementation steps run for many minutes; callers poll the job instead of holding the socket.
    return json(res, 202, { accepted: true, job_id: jobId, started_at: runningBuilderJobs.get(jobId) });
  }
  if (builderMatch && req.method === 'POST' && builderMatch[2] === 'workspace') {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    try {
      const { data: job, error } = await builderSupabase.from('builder_jobs').select('id,target_sha,workspace_branch,workspace_head_sha').eq('id', builderMatch[1]).single();
      if (error || !job?.target_sha) return json(res, 404, { error: 'Builder job is unavailable' });
      if (job.workspace_branch && job.workspace_head_sha) return json(res, 200, { branch: job.workspace_branch, head: job.workspace_head_sha, existing: true });
      const workspace = createBranchWorkspace({ sourceDir: builderGitSource(job.target_sha), workspaceRoot: builderWorkspaceRoot, jobId: job.id, targetSha: job.target_sha });
      const { data: bound, error: bindError } = await builderSupabase.rpc('builder_bind_workspace', { _job_id: job.id, _workspace_branch: workspace.branchName, _workspace_head_sha: workspace.head });
      if (bindError || !bound) return json(res, 409, { error: 'Builder workspace could not be bound' });
      return json(res, 201, { branch: workspace.branchName, head: workspace.head, existing: workspace.existing });
    } catch {
      return json(res, 409, { error: 'Builder workspace could not be created' });
    }
  }
  if (builderMatch && req.method === 'POST' && builderMatch[2] === 'commit') {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    try {
      const artifactId = String(body.artifactId || '');
      const { data: job } = await builderSupabase.from('builder_jobs').select('id,workspace_branch,workspace_head_sha').eq('id', builderMatch[1]).single();
      const { data: artifact } = await builderSupabase.from('builder_artifacts').select('id,status,artifact_type,storage_location,checksum').eq('id', artifactId).eq('job_id', builderMatch[1]).single();
      if (!job?.workspace_branch || !job.workspace_head_sha || !artifact || artifact.status !== 'final' || artifact.artifact_type !== 'code_implementation' || !artifact.storage_location?.startsWith('supabase_storage://builder-artifacts/')) return json(res, 409, { error: 'Verified Builder workspace or patch artifact is unavailable' });
      const { data: object, error: downloadError } = await builderSupabase.storage.from('builder-artifacts').download(artifact.storage_location.slice('supabase_storage://builder-artifacts/'.length));
      const patch = object ? Buffer.from(await object.arrayBuffer()).toString('utf8') : '';
      if (downloadError || !patch || crypto.createHash('sha256').update(patch).digest('hex') !== artifact.checksum) return json(res, 409, { error: 'Verified patch artifact integrity check failed' });
      const workspace = createBranchWorkspace({ sourceDir: builderSourceDir, workspaceRoot: builderWorkspaceRoot, jobId: job.id, targetSha: job.workspace_head_sha, branchName: job.workspace_branch });
      const commit = commitVerifiedPatch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, patch, message: `Bob Builder: ${artifact.id}` });
      const { data: updated, error: recordError } = await builderSupabase.rpc('builder_record_workspace_commit', { _job_id: job.id, _expected_head_sha: job.workspace_head_sha, _commit_sha: commit.commitSha });
      if (recordError || !updated) return json(res, 409, { error: 'Builder workspace commit could not be recorded' });
      return json(res, 201, { branch: commit.branchName, head: commit.commitSha, changedFiles: commit.changedFiles });
    } catch { return json(res, 409, { error: 'Builder workspace commit could not be created' }); }
  }
  if (builderMatch && req.method === 'POST' && builderMatch[2] === 'publish') {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    try {
      const { data: job } = await builderSupabase.from('builder_jobs').select('id,workspace_branch,workspace_head_sha,workspace_published_head_sha').eq('id', builderMatch[1]).single();
      if (!job?.workspace_branch || !job.workspace_head_sha) return json(res, 409, { error: 'Verified Builder workspace is unavailable' });
      if (job.workspace_published_head_sha === job.workspace_head_sha) return json(res, 200, { branch: job.workspace_branch, head: job.workspace_head_sha, existing: true });
      const workspacePath = workspacePathForBranch(builderWorkspaceRoot, job.workspace_branch);
      const target = builderGitTarget();
      const publication = publishWorkspaceBranch({ workspacePath, branchName: job.workspace_branch, expectedHeadSha: job.workspace_head_sha, pushUrl: target.repoUrl, pushAuthHeader: target.authHeader });
      const { data: updated, error } = await builderSupabase.rpc('builder_record_workspace_publication', { _job_id: job.id, _expected_head_sha: publication.head });
      if (error || !updated) return json(res, 409, { error: 'Builder branch publication could not be recorded' });
      return json(res, 201, { branch: publication.branchName, head: publication.head, existing: false });
    } catch { return json(res, 409, { error: 'Builder branch could not be published' }); }
  }
  if (builderMatch && req.method === 'POST' && builderMatch[2] === 'pull-request') {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    try {
      const { data: job } = await builderSupabase.from('builder_jobs').select('id,title,workspace_branch,workspace_head_sha,workspace_published_head_sha,workspace_pull_request_head_sha,workspace_pull_request_url').eq('id', builderMatch[1]).single();
      if (!job?.workspace_branch || !job.workspace_head_sha || job.workspace_published_head_sha !== job.workspace_head_sha) return json(res, 409, { error: 'Published Builder workspace is required' });
      if (job.workspace_pull_request_head_sha === job.workspace_head_sha && job.workspace_pull_request_url) return json(res, 200, { branch: job.workspace_branch, head: job.workspace_head_sha, url: job.workspace_pull_request_url, existing: true });
      const workspacePath = workspacePathForBranch(builderWorkspaceRoot, job.workspace_branch);
      const reviewBody = `## Bob Builder review\n\nVerified Builder workspace branch: \`${job.workspace_branch}\`\n\nPinned commit: \`${job.workspace_head_sha}\`\n\nThis pull request is for human review only. It does not authorize a merge or deployment.`;
      const pullRequest = builderGitHost === 'github'
        ? await createGitHubPullRequest({ workspacePath, branchName: job.workspace_branch, expectedHeadSha: job.workspace_head_sha, title: `Bob Builder: ${job.title}`, body: reviewBody, githubToken, owner: githubOwner, repo: githubRepo })
        : await createGiteaPullRequest({ workspacePath, branchName: job.workspace_branch, expectedHeadSha: job.workspace_head_sha, title: `Bob Builder: ${job.title}`, body: reviewBody, giteaBaseUrl, giteaToken, owner: giteaOwner, repo: giteaRepo });
      const { data: updated, error } = await builderSupabase.rpc('builder_record_workspace_pull_request', { _job_id: job.id, _expected_head_sha: pullRequest.head, _pull_request_url: pullRequest.url });
      if (error || !updated) return json(res, 409, { error: 'Builder pull request could not be recorded' });
      return json(res, 201, { ...pullRequest, existing: false });
    } catch { return json(res, 409, { error: 'Builder pull request could not be created' }); }
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
        const delivery = req.headers['x-gitea-delivery'] || req.headers['x-request-id'];
        if (delivery && deliveries.has(delivery)) return json(res, 202, { accepted: true, duplicate: true });
        const repository = body.repository?.full_name || body.repository?.name;
        if (!repositoryAllowed(repository)) return json(res, 403, { error: 'repository is not allowed' });
        if (delivery) deliveries.add(delivery);
        saveState();
        const job = await createJob({ repository, ref: body.ref, commitSha: body.after }, 'gitea');
        record('gitea', 'webhook.received', job.id, { delivery });
        return json(res, 202, { accepted: true, jobId: job.id });
      }
      await route(req, res, body);
    } catch { json(res, 400, { error: 'invalid request' }); }
  });
});

server.listen(port, '0.0.0.0', () => console.log(`bob-control-plane listening on ${port}`));