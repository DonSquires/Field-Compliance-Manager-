const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// Node's fetch gives up waiting for response headers after five minutes; a model run on the VPS CPU
// (and the gateway call that wraps it) can take longer. One dispatcher with the model budget for all.
{
  const { Agent, fetch: undiciFetch, setGlobalDispatcher } = require('undici');
  const budgetMs = Math.min(Number(process.env.BOB_MODEL_TIMEOUT_MS || 600000), 1800000) + 120000;
  setGlobalDispatcher(new Agent({ headersTimeout: budgetMs, bodyTimeout: budgetMs, connectTimeout: 15000 }));
  globalThis.fetch = undiciFetch;
}
const { createClient } = require('@supabase/supabase-js');
const { createWorkflowClient } = require('./supabase-workflow-client');
const { createAssessment } = require('./assessment-manifest');
const { collectRepositoryContext } = require('./supabase/functions/_shared/builder-repository-context');
const { collectBuilderLiveContext } = require('./builder-live-context');
const { buildAtlasGraph } = require('./scripts/atlas-graph');
const { createModelGatewayConfig, defaultReviewerModel, invokeBuilderModel, modelHealth } = require('./builder-model-gateway');
const { loadBuilderRuntimeSnapshot, advanceBuilderJob, runBuilderUntilPause, recoverExpiredWorkerRuns } = require('./builder-runtime-coordinator');
const { fileSha256, listRepositoryTree, readRepositoryFile, searchRepository } = require('./builder-repository-read');
const { autopilotTick, listAutopilotJobs, listPendingApprovals } = require('./builder-autopilot');
const { laptopStatus, runLaptopCommand, laptopConfig, loadLaptopLink, mergeLaptopLink, describeLink } = require('./bob-laptop-shell');
const { createBranchWorkspace, commitVerifiedPatch, publishWorkspaceBranch, createGiteaPullRequest, workspacePathForBranch, createGitHubPullRequest, ensureSourceCheckout, githubAuthHeader, githubRepoUrl, resolveRemoteHead, redactGitError } = require('./builder-branch-workspace');
const { executeWorker } = require('./worker-executor');

// Route failures used to be swallowed into a bare 409; keep a short redacted reason so the
// operator (and Bob's self-heal loop) can act without a shell on the host.
function failureDetail(error) {
  return redactGitError(String(error instanceof Error ? error.message : error)).slice(0, 300);
}

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

// Read-only repository views for Bob's chat tools: pinned to main's head (re-resolved at most
// once a minute) and served from the shared checkout's object database.
const repositoryReadCache = { at: 0, sha: null, sourceDir: null };
function repositoryReadTarget() {
  if (Date.now() - repositoryReadCache.at < 60_000 && repositoryReadCache.sha) return repositoryReadCache;
  const { sha } = builderRepositoryHead('main');
  const sourceDir = builderGitSource(sha);
  Object.assign(repositoryReadCache, { at: Date.now(), sha, sourceDir });
  return repositoryReadCache;
}

// "Has this verified change landed on main?" by content, so a squash or rebase merge counts:
// every file the patch changed must exist on main's head with the patch's after_sha256.
function changeLandedOnMain(manifestRows) {
  const rows = Array.isArray(manifestRows) ? manifestRows.filter((row) => row && typeof row.path === 'string' && /^[a-f0-9]{64}$/i.test(String(row.after_sha256 || ''))) : [];
  if (!rows.length) return false;
  const { sha } = builderRepositoryHead('main');
  const sourceDir = builderGitSource(sha);
  for (const row of rows) {
    if (fileSha256({ sourceDir, sha, path: row.path }) !== row.after_sha256.toLowerCase()) return false;
  }
  return true;
}
const stateFile = path.join(stateDir, 'bob-state.json');
const maxRequestBytes = 1024 * 1024;
const jobs = new Map();
const deliveries = new Set();
const audit = [];
const humanTestRuns = new Map();
let activeLease = null;

function saveState() {
  fs.mkdirSync(stateDir, { recursive: true });
  const state = {
    jobs: [...jobs.values()],
    deliveries: [...deliveries],
    audit,
    humanTestRuns: [...humanTestRuns.values()]
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
    for (const persisted of state.humanTestRuns || []) {
      const run = persisted.status === 'queued' || persisted.status === 'running'
        ? { ...persisted, status: 'interrupted', completed_at: new Date().toISOString(), error: 'Control plane restarted before the human test completed.' }
        : persisted;
      humanTestRuns.set(run.id, run);
    }
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

function safeHumanTestRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    mode: run.mode,
    scope: run.scope,
    status: run.status,
    source_sha: run.source_sha,
    requested_by: run.requested_by,
    created_at: run.created_at,
    started_at: run.started_at,
    completed_at: run.completed_at,
    exit_code: run.exit_code,
    error: run.error,
    summary: run.summary,
    artifacts: run.artifacts || []
  };
}

function listHumanTestArtifacts(rootDir, relativeDir = '', rows = []) {
  if (!fs.existsSync(rootDir) || rows.length >= 100) return rows;
  for (const entry of fs.readdirSync(path.join(rootDir, relativeDir), { withFileTypes: true })) {
    if (rows.length >= 100) break;
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) listHumanTestArtifacts(rootDir, relativePath, rows);
    else {
      const stat = fs.statSync(path.join(rootDir, relativePath));
      rows.push({ path: relativePath.replace(/\\/g, '/'), size_bytes: stat.size });
    }
  }
  return rows;
}

function humanTestSummary(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const matches = [...output.matchAll(/(\d+)\s+(passed|failed|skipped)/g)];
  return {
    passed: Number(matches.find(match => match[2] === 'passed')?.[1] || 0),
    failed: Number(matches.find(match => match[2] === 'failed')?.[1] || 0),
    skipped: Number(matches.find(match => match[2] === 'skipped')?.[1] || 0)
  };
}

async function startHumanTestRun({ mode, scope, requestedBy }) {
  const active = [...humanTestRuns.values()].find(run => run.status === 'queued' || run.status === 'running');
  if (active) return { existing: true, run: safeHumanTestRun(active) };
  if (!builderWorkerImage) throw new BuilderStepError(503, 'Human-test worker image is unavailable');
  const source = repositoryReadTarget();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const artifactDir = path.join(stateDir, 'human-test-runs', id);
  const run = {
    id,
    mode,
    scope,
    status: 'queued',
    source_sha: source.sha,
    requested_by: requestedBy,
    created_at: now,
    started_at: null,
    completed_at: null,
    exit_code: null,
    error: null,
    summary: null,
    artifacts: []
  };
  humanTestRuns.set(id, run);
  saveState();
  setImmediate(async () => {
    run.status = 'running';
    run.started_at = new Date().toISOString();
    saveState();
    try {
      fs.mkdirSync(artifactDir, { recursive: true });
      const result = await executeWorker({
        image: builderWorkerImage,
        sourceDir: source.sourceDir,
        artifactDir,
        profile: mode === 'live' ? 'human-qa-live' : 'human-qa',
        timeoutMs: Math.min(Math.max(Number(process.env.BOB_HUMAN_TEST_TIMEOUT_MS) || 45 * 60_000, 5 * 60_000), 60 * 60_000),
        memory: process.env.BOB_HUMAN_TEST_MEMORY || (mode === 'live' ? '2g' : '8g'),
        cpus: process.env.BOB_HUMAN_TEST_CPUS || (mode === 'live' ? '2' : '4'),
        pidsLimit: Number(process.env.BOB_HUMAN_TEST_PIDS_LIMIT || (mode === 'live' ? 256 : 1024)),
        environment: mode === 'live'
          ? {
              HUMAN_TEST_LIVE: 'true',
              HUMAN_TEST_BASE_URL: process.env.HUMAN_TEST_BASE_URL,
              GRANDMASTER_TEST_EMAIL: process.env.GRANDMASTER_TEST_EMAIL,
              GRANDMASTER_TEST_PASSWORD: process.env.GRANDMASTER_TEST_PASSWORD
            }
          : { HUMAN_TEST_LIVE: 'false', E2E_OFFLINE: '1' }
      });
      run.status = result.status;
      run.exit_code = result.exitCode;
      run.summary = humanTestSummary(result);
      fs.writeFileSync(path.join(artifactDir, 'human-test-output.log'), `${result.stdout || ''}\n${result.stderr || ''}`, { mode: 0o600 });
      fs.writeFileSync(path.join(artifactDir, 'human-test-receipt.json'), JSON.stringify({
        run_id: id,
        mode,
        scope,
        source_sha: source.sha,
        result: { status: result.status, exit_code: result.exitCode, profile: result.profile },
        summary: run.summary
      }, null, 2), { mode: 0o600 });
      run.artifacts = listHumanTestArtifacts(artifactDir);
    } catch (error) {
      run.status = 'failed';
      run.error = failureDetail(error);
    } finally {
      run.completed_at = new Date().toISOString();
      saveState();
      record(requestedBy || 'bob', 'human_test.completed', id, { mode, scope, status: run.status, source_sha: source.sha });
    }
  });
  record(requestedBy || 'bob', 'human_test.started', id, { mode, scope, source_sha: source.sha });
  return { existing: false, run: safeHumanTestRun(run) };
}

async function builderRuntimeContext(body, source = { sourceDir: assessmentRoot, targetSha: null }) {
  const buildMap = source.targetSha ? collectRepositoryContext(source) : null;
  const liveContext = builderSupabase ? await collectBuilderLiveContext(builderSupabase) : null;
  const providers = await modelHealth(modelGatewayConfig).catch(() => ({}));
  return {
    sourceDir: source.sourceDir,
    // The agentic engineer spawns the job worktree from the pinned shared checkout and reads the canon from the image copy.
    gitSourceDir: source.gitSourceDir || null,
    workspaceRoot: builderWorkspaceRoot,
    repoRoot: assessmentRoot,
    workerImage: builderWorkerImage,
    runnerId: builderRunnerId,
    reviewerModelName: typeof body.reviewerModelName === 'string' && body.reviewerModelName.trim() ? body.reviewerModelName.slice(0, 200) : defaultReviewerModel(process.env, providers.openai?.installed ?? null),
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
const staleBuilderRunMs = Math.max(5 * 60_000, Number(process.env.BOB_BUILDER_STALE_RUN_MS) || 45 * 60_000);

function clearStaleBuilderRun(jobId, now = Date.now()) {
  const startedAt = runningBuilderJobs.get(jobId);
  if (!startedAt) return false;
  const age = now - Date.parse(startedAt);
  if (!Number.isFinite(age) || age < staleBuilderRunMs) return false;
  runningBuilderJobs.delete(jobId);
  record('builder', 'builder.run.stale_lease_cleared', jobId, { age_ms: age, stale_after_ms: staleBuilderRunMs });
  return true;
}

// Expected-state failures on the publication steps (a 4xx with a plain reason, no stack).
class BuilderStepError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function bindBuilderWorkspace(jobId) {
  const { data: job, error } = await builderSupabase.from('builder_jobs').select('id,target_sha,workspace_branch,workspace_head_sha').eq('id', jobId).single();
  if (error || !job?.target_sha) throw new BuilderStepError(404, 'Builder job is unavailable');
  if (job.workspace_branch && job.workspace_head_sha) return { branch: job.workspace_branch, head: job.workspace_head_sha, existing: true };
  const workspace = createBranchWorkspace({ sourceDir: builderGitSource(job.target_sha), workspaceRoot: builderWorkspaceRoot, jobId: job.id, targetSha: job.target_sha, recoverInterrupted: true });
  const { data: bound, error: bindError } = await builderSupabase.rpc('builder_bind_workspace', { _job_id: job.id, _workspace_branch: workspace.branchName, _workspace_head_sha: workspace.head });
  if (bindError || !bound) throw new BuilderStepError(409, 'Builder workspace could not be bound');
  return { branch: workspace.branchName, head: workspace.head, existing: false };
}

async function commitBuilderPatch(jobId, artifactId) {
  const { data: job } = await builderSupabase.from('builder_jobs').select('id,title,target_sha,workspace_branch,workspace_head_sha').eq('id', jobId).single();
  const { data: artifact } = await builderSupabase.from('builder_artifacts').select('id,status,artifact_type,storage_location,checksum').eq('id', artifactId).eq('job_id', jobId).single();
  if (!job?.workspace_branch || !job.workspace_head_sha || !artifact || artifact.status !== 'final' || artifact.artifact_type !== 'code_implementation' || !artifact.storage_location?.startsWith('supabase_storage://builder-artifacts/')) throw new BuilderStepError(409, 'Verified Builder workspace or patch artifact is unavailable');
  const { data: object, error: downloadError } = await builderSupabase.storage.from('builder-artifacts').download(artifact.storage_location.slice('supabase_storage://builder-artifacts/'.length));
  const patch = object ? Buffer.from(await object.arrayBuffer()).toString('utf8') : '';
  if (downloadError || !patch || crypto.createHash('sha256').update(patch).digest('hex') !== artifact.checksum) throw new BuilderStepError(409, 'Verified patch artifact integrity check failed');
  // The recorded head is the truth; a tree left dirty (or one commit ahead but unrecorded) by an
  // interrupted commit step is restored to it and the verified patch is applied again.
  const workspace = createBranchWorkspace({ sourceDir: builderSourceDir, workspaceRoot: builderWorkspaceRoot, jobId: job.id, targetSha: job.workspace_head_sha, branchName: job.workspace_branch, recoverInterrupted: true });
  // The subject is what GitHub shows as the PR title when the bridge cannot read the Gitea PR (PR #20 read "Bob Builder: <artifact id>").
  const commit = commitVerifiedPatch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, patch, message: `Bob Builder: ${String(job.title || 'verified change').trim()}`, body: `Builder job ${job.id}\nVerified patch artifact ${artifact.id}\nPinned to ${job.target_sha}` });
  const { data: updated, error: recordError } = await builderSupabase.rpc('builder_record_workspace_commit', { _job_id: job.id, _expected_head_sha: job.workspace_head_sha, _commit_sha: commit.commitSha });
  if (recordError || !updated) throw new BuilderStepError(409, 'Builder workspace commit could not be recorded');
  return { branch: commit.branchName, head: commit.commitSha, changedFiles: commit.changedFiles };
}

async function publishBuilderBranch(jobId) {
  const { data: job } = await builderSupabase.from('builder_jobs').select('id,workspace_branch,workspace_head_sha,workspace_published_head_sha').eq('id', jobId).single();
  if (!job?.workspace_branch || !job.workspace_head_sha) throw new BuilderStepError(409, 'Verified Builder workspace is unavailable');
  if (job.workspace_published_head_sha === job.workspace_head_sha) return { branch: job.workspace_branch, head: job.workspace_head_sha, existing: true };
  const workspacePath = workspacePathForBranch(builderWorkspaceRoot, job.workspace_branch);
  const target = builderGitTarget();
  const publication = publishWorkspaceBranch({ workspacePath, branchName: job.workspace_branch, expectedHeadSha: job.workspace_head_sha, pushUrl: target.repoUrl, pushAuthHeader: target.authHeader });
  const { data: updated, error } = await builderSupabase.rpc('builder_record_workspace_publication', { _job_id: job.id, _expected_head_sha: publication.head });
  if (error || !updated) throw new BuilderStepError(409, 'Builder branch publication could not be recorded');
  return { branch: publication.branchName, head: publication.head, existing: false };
}

function defaultPullRequestBody(job) {
  return `## Bob Builder review\n\nVerified Builder workspace branch: \`${job.workspace_branch}\`\n\nPinned commit: \`${job.workspace_head_sha}\`\n\nThis pull request is for human review only. It does not authorize a merge or deployment.`;
}

async function openBuilderPullRequest(jobId, bodyFor = null) {
  const { data: job } = await builderSupabase.from('builder_jobs').select('id,title,workspace_branch,workspace_head_sha,workspace_published_head_sha,workspace_pull_request_head_sha,workspace_pull_request_url').eq('id', jobId).single();
  if (!job?.workspace_branch || !job.workspace_head_sha || job.workspace_published_head_sha !== job.workspace_head_sha) throw new BuilderStepError(409, 'Published Builder workspace is required');
  if (job.workspace_pull_request_head_sha === job.workspace_head_sha && job.workspace_pull_request_url) return { branchName: job.workspace_branch, head: job.workspace_head_sha, url: job.workspace_pull_request_url, existing: true };
  const workspacePath = workspacePathForBranch(builderWorkspaceRoot, job.workspace_branch);
  const reviewBody = typeof bodyFor === 'function' ? bodyFor(job.workspace_branch, job.workspace_head_sha) : defaultPullRequestBody(job);
  const pullRequest = builderGitHost === 'github'
    ? await createGitHubPullRequest({ workspacePath, branchName: job.workspace_branch, expectedHeadSha: job.workspace_head_sha, title: `Bob Builder: ${job.title}`, body: reviewBody, githubToken, owner: githubOwner, repo: githubRepo })
    : await createGiteaPullRequest({ workspacePath, branchName: job.workspace_branch, expectedHeadSha: job.workspace_head_sha, title: `Bob Builder: ${job.title}`, body: reviewBody, giteaBaseUrl, giteaToken, owner: giteaOwner, repo: giteaRepo });
  const { data: updated, error } = await builderSupabase.rpc('builder_record_workspace_pull_request', { _job_id: job.id, _expected_head_sha: pullRequest.head, _pull_request_url: pullRequest.url });
  if (error || !updated) throw new BuilderStepError(409, 'Builder pull request could not be recorded');
  return { ...pullRequest, existing: false };
}

async function runBuilderJobBounded(jobId, body = {}) {
  clearStaleBuilderRun(jobId);
  if (runningBuilderJobs.has(jobId)) return { skipped: true, already_running: true, started_at: runningBuilderJobs.get(jobId) };
  const context = await builderRuntimeContext(body, await resolveBuilderSourceDir(jobId));
  const execution = runBuilderUntilPause({ supabase: builderSupabase, gateway: builderGateway, jobId, context, maxActions: body.maxActions })
    .then((outcome) => { record('builder', 'builder.run.paused', jobId, { reason: outcome.reason, detail: outcome.detail ?? null, actions: outcome.history?.length ?? 0 }); return outcome; })
    .catch((error) => { record('builder', 'builder.run.failed', jobId, { error: String(error instanceof Error ? error.message : error).slice(0, 300) }); return { paused: true, reason: 'error', detail: String(error instanceof Error ? error.message : error).slice(0, 300) }; })
    .finally(() => runningBuilderJobs.delete(jobId));
  runningBuilderJobs.set(jobId, new Date().toISOString());
  return { execution };
}

// Bob autopilot: every tick, move the jobs the owner asked for in chat one step closer to a
// reviewed pull request. Human-only paths (merge, deploy, protected files) are untouched.
const autopilotEnabled = process.env.BOB_BUILDER_AUTOPILOT !== 'false';
const routineRepairEnabled = process.env.BOB_ROUTINE_SELF_HEAL !== 'false';
const autopilotIntervalMs = Math.max(15_000, Number(process.env.BOB_BUILDER_AUTOPILOT_INTERVAL_MS) || 60_000);
let autopilotBusy = false;

async function routineBuilderProject() {
  let query = builderSupabase
    .from('builder_projects')
    .select('id,organization_id,gitea_owner,gitea_repo')
    .eq('status', 'active');
  if (giteaOwner) query = query.eq('gitea_owner', giteaOwner);
  if (giteaRepo) query = query.eq('gitea_repo', giteaRepo);
  const { data, error } = await query.limit(2);
  if (error || !Array.isArray(data) || data.length !== 1) {
    throw new Error('routine self-heal requires exactly one active Builder project for this repository');
  }
  return data[0];
}

function routineRepairBrief(packet) {
  const envelope = packet.envelope && typeof packet.envelope === 'object' ? packet.envelope : {};
  const before = envelope.before && typeof envelope.before === 'object' ? envelope.before : {};
  const during = envelope.during && typeof envelope.during === 'object' ? envelope.during : {};
  const expected = envelope.expected && typeof envelope.expected === 'object' ? envelope.expected : {};
  const error = during.error && typeof during.error === 'object' ? during.error : {};
  const failed = during.failed_request && typeof during.failed_request === 'object' ? during.failed_request : {};
  return [
    `Goal: repair the routine monitored defect recorded in friction packet ${packet.id}.`,
    `Before: page ${String(before.page || 'unknown').slice(0, 500)}; module ${String(before.module || 'unknown').slice(0, 120)}; user intended ${String(expected.user_intent || 'continue the workflow').slice(0, 1000)}.`,
    `During: ${String(error.kind || 'runtime_error').slice(0, 80)} — ${String(error.message || 'unhandled application error').slice(0, 500)}${failed.status ? `; request ${String(failed.fn || failed.route || 'unknown').slice(0, 200)} returned ${Number(failed.status)}` : ''}.`,
    `After: ${String(expected.expected_outcome || 'the workflow remains usable and exposes an explicit recoverable state').slice(0, 1000)}.`,
    'Required investigation: read canon, query Atlas capability/direct edges/blast radius, cross-check supabase/schema.sql, and identify the smallest root-cause fix.',
    'Required verification: targeted tests, independent review, before/during/after data-path evidence, Atlas refresh, schema/data-path check, and human-glass acceptance for any web change.',
    'Routine boundary: make the smallest corrective patch only. Do not redesign, add a feature/module/workflow, change architecture, add or alter migrations/schema/RLS/auth, change dependencies/environment/secrets, or touch legal, safety, identity, enforcement, finance, payroll, or evidential truth. If any such work is necessary, stop and escalate for Grandmaster review.',
    `Triage basis: ${JSON.stringify(packet.basis || {}).slice(0, 1800)}.`,
  ].join('\n');
}

async function startRoutineRepairs() {
  if (!routineRepairEnabled) return [];
  const project = await routineBuilderProject();
  const { sha } = builderRepositoryHead('main');
  const { data: packets, error: claimError } = await builderSupabase.rpc('builder_claim_routine_repairs', { _limit: 3 });
  if (claimError) throw new Error(`routine repair queue could not be claimed: ${claimError.message}`);
  if (!Array.isArray(packets) || !packets.length) return [];
  const outcomes = [];
  for (const packet of packets) {
    let createdJobId = null;
    let boundSuccessfully = false;
    try {
      const page = String(packet.envelope?.before?.page || 'application error').replace(/\s+/g, ' ').slice(0, 120);
      const { data: created, error } = await builderSupabase.rpc('builder_create_job_v2', {
        _organization_id: project.organization_id,
        _project_id: project.id,
        _title: `Routine repair: ${page}`.slice(0, 200),
        _task_description: routineRepairBrief(packet).slice(0, 12000),
        _target_sha: sha,
        _branch_name: 'main',
        _description: `Opened automatically from monitored friction packet ${packet.id}.`,
        _frontend_required: true,
        _backend_required: Boolean(packet.envelope?.during?.failed_request),
        _code_review_mode: 'independent_ai',
        _task_run_id: null,
        _requested_action: 'prepare_change',
        _target_environment: 'development',
      });
      if (error || !created?.id) throw new Error(error?.message || 'Builder job was not returned');
      createdJobId = created.id;
      const { data: boundJob, error: bindError } = await builderSupabase.rpc('builder_bind_routine_repair', {
        _job_id: created.id,
        _packet_id: packet.id,
      });
      if (bindError || !boundJob?.id) throw new Error(bindError?.message || 'routine repair could not be bound');
      boundSuccessfully = true;
      record('autopilot', 'builder.routine_repair.started', boundJob.id, { packet_id: packet.id, page });
      outcomes.push({ packet: packet.id, job: boundJob.id, outcome: 'started' });
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 300);
      if (createdJobId && !boundSuccessfully) {
        await builderSupabase.from('builder_jobs').update({
          status: 'cancelled',
          last_error: 'Routine repair intake failed before policy binding.',
          updated_at: new Date().toISOString(),
        }).eq('id', createdJobId).is('source_friction_packet_id', null);
      }
      await builderSupabase.from('bob_friction_packets').update({
        automation_status: packet.automation_attempt_count >= 5 ? 'failed' : 'queued',
        automation_error_redacted: detail,
        automation_updated_at: new Date().toISOString(),
      }).eq('id', packet.id).eq('automation_status', 'claimed');
      record('autopilot', 'builder.routine_repair.failed', packet.id, { error: detail });
      outcomes.push({ packet: packet.id, outcome: 'failed', error: detail });
    }
  }
  return outcomes;
}

async function autopilotOnce() {
  if (autopilotBusy || !builderSupabase || !modelGatewayToken || !builderWorkerImage) return [];
  autopilotBusy = true;
  try {
    await startRoutineRepairs();
    const jobs = await listAutopilotJobs(builderSupabase);
    if (!jobs.length) return [];
    return await autopilotTick({
      supabase: builderSupabase,
      jobs,
      log: (entry) => record('autopilot', 'builder.autopilot', entry.job, entry),
      actions: {
        listPending: (jobId) => listPendingApprovals(builderSupabase, jobId),
        approve: async (approvalId, comment) => {
          const { error } = await builderSupabase.rpc('builder_autopilot_decide_approval_guarded', { _approval_id: approvalId, _comment: comment });
          if (error) throw new Error(`gate could not be cleared: ${error.message}`);
        },
        run: async (jobId) => {
          const started = await runBuilderJobBounded(jobId, { maxActions: 8 });
          return started.skipped ? started : await started.execution;
        },
        publish: async ({ job, validatedPatchId, bodyFor }) => {
          await bindBuilderWorkspace(job.id);
          const { data: fresh } = await builderSupabase.from('builder_jobs').select('workspace_head_sha,workspace_branch,target_sha').eq('id', job.id).single();
          if (fresh?.workspace_head_sha === fresh?.target_sha) await commitBuilderPatch(job.id, validatedPatchId);
          await publishBuilderBranch(job.id);
          const pullRequest = await openBuilderPullRequest(job.id, bodyFor);
          return { pullRequestUrl: pullRequest.url };
        },
        record: async (jobId, state, report) => {
          const { error } = await builderSupabase.rpc('builder_autopilot_record', { _job_id: jobId, _state: state, _report: report });
          if (error) throw new Error(`autopilot outcome could not be recorded: ${error.message}`);
          const { data: routineJob, error: routineJobError } = await builderSupabase
            .from('builder_jobs')
            .select('autopilot_source,source_friction_packet_id')
            .eq('id', jobId)
            .maybeSingle();
          if (routineJobError) throw new Error(`routine repair provenance could not be read: ${routineJobError.message}`);
          if (routineJob?.autopilot_source === 'routine_monitor' && routineJob.source_friction_packet_id) {
            const automationStatus = state === 'published'
              ? 'published'
              : state === 'done'
                ? 'completed'
              : state === 'awaiting_human'
                ? 'awaiting_grandmaster'
                : state === 'blocked'
                  ? 'failed'
                  : 'builder_started';
            const { error: packetStatusError } = await builderSupabase.from('bob_friction_packets').update({
              automation_status: automationStatus,
              automation_updated_at: new Date().toISOString(),
            }).eq('id', routineJob.source_friction_packet_id);
            if (packetStatusError) throw new Error(`routine repair status could not be recorded: ${packetStatusError.message}`);
          }
        },
        // Self-heal (owner ruling 2026-09-27): a job blocked by a red main opens a repair job bound to the
        // same requester, and is re-opened on current main once the repair has landed.
        createJob: async (input) => {
          const { sha } = builderRepositoryHead('main');
          const { data: created, error } = await builderSupabase.rpc('builder_create_job_v2', {
            _organization_id: input.organizationId,
            _project_id: input.projectId,
            _title: String(input.title).slice(0, 200),
            _task_description: String(input.taskDescription).slice(0, 12000),
            _target_sha: sha,
            _branch_name: 'main',
            _description: input.description ? String(input.description).slice(0, 500) : input.parentJobId ? `Opened by Bob's autopilot from job ${input.parentJobId}.` : null,
            _frontend_required: input.frontendRequired === true,
            _backend_required: input.backendRequired === true,
            _code_review_mode: input.codeReviewMode || 'independent_ai',
            _task_run_id: null,
            _requested_action: 'prepare_change',
            _target_environment: 'development',
          });
          if (error || !created?.id) throw new Error(`autopilot could not open a job: ${error?.message || 'no job returned'}`);
          const { data: bound, error: bindError } = await builderSupabase.rpc('builder_autopilot_bind', { _job_id: created.id, _requested_by: input.requestedBy, _conversation_id: input.conversationId ?? null });
          if (bindError) throw new Error(`autopilot could not bind the new job: ${bindError.message}`);
          record('autopilot', 'builder.autopilot.job_opened', created.id, { parent: input.parentJobId ?? null, title: String(input.title).slice(0, 120) });
          return bound || created;
        },
        loadJob: async (jobId) => {
          const { data } = await builderSupabase.from('builder_jobs').select('id, title, status, last_error, workspace_pull_request_url, autopilot_state, autopilot_report').eq('id', jobId).maybeSingle();
          return data || null;
        },
        changeLanded: (manifestRows) => changeLandedOnMain(manifestRows),
        mainHead: async () => builderRepositoryHead('main').sha,
      },
    });
  } catch (error) {
    record('autopilot', 'builder.autopilot.failed', 'tick', { error: String(error instanceof Error ? error.message : error).slice(0, 300) });
    return [];
  } finally {
    autopilotBusy = false;
  }
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
    const providers = await modelHealth(modelGatewayConfig).catch(() => ({}));
    const laptopLink = await loadLaptopLink(builderSupabase).catch(() => null);
    const laptop = laptopConfig(mergeLaptopLink(process.env, laptopLink));
    return json(res, 200, { status: 'ok', service: 'bob-control-plane', activeLease: Boolean(activeLease), builderGitHost, builderSourceConfigured: builderGitHost === 'github' ? Boolean(githubToken && githubOwner && githubRepo) : Boolean(giteaBaseUrl && giteaToken && giteaOwner && giteaRepo), autopilot: autopilotEnabled && Boolean(builderSupabase && modelGatewayToken && builderWorkerImage), autopilotIntervalMs, runningBuilderJobs: runningBuilderJobs.size, modelProviders: Object.fromEntries(Object.entries(providers).map(([name, p]) => [name, { configured: p.configured, healthy: p.healthy, ready_model: p.ready_model }])), laptopShell: { enabled: laptop.enabled, configured: laptop.configured, host: laptop.host || null, ssh_allowed: laptopLink ? laptopLink.ssh_allowed === true : null } });
  }
  if (req.method === 'GET' && url.pathname === '/api/bob/builder/model-health') {
    if (!modelGatewayAuthorized(req) && !authorized(req)) return json(res, 401, { error: 'model gateway unauthorized' });
    return json(res, 200, await modelHealth(modelGatewayConfig));
  }
  if (req.method === 'POST' && url.pathname === '/api/bob/builder/model-run') {
    if (!modelGatewayAuthorized(req)) return json(res, 401, { error: 'model gateway unauthorized' });
    const result = await invokeBuilderModel({ input: body, config: modelGatewayConfig });
    return json(res, result.status, result.body);
  }
  // Bob's terminal on the owner's laptop (Tailscale-only Windows OpenSSH; owner toggles it). The
  // laptop registers itself (bob_laptop_link) when the owner runs laptop-tailscale.ps1; env pins win.
  if (req.method === 'GET' && url.pathname === '/api/bob/laptop/status') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const link = await loadLaptopLink(builderSupabase);
    const status = await laptopStatus({ env: mergeLaptopLink(process.env, link) });
    return json(res, 200, { ...status, link: describeLink(link) });
  }
  if (req.method === 'POST' && url.pathname === '/api/bob/laptop/run') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const command = typeof body?.command === 'string' ? body.command : '';
    const requestedBy = typeof body?.requested_by === 'string' ? body.requested_by.slice(0, 120) : null;
    const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id.slice(0, 64) : null;
    const purpose = typeof body?.purpose === 'string' ? body.purpose.slice(0, 300) : null;
    const link = await loadLaptopLink(builderSupabase);
    const env = mergeLaptopLink(process.env, link);
    const result = link && link.ssh_allowed === false && !process.env.BOB_LAPTOP_SSH_USER
      ? { ok: false, status: 503, error: `the owner's Bob switch on the laptop is off (laptop-tailscale.ps1 -Allow turns it on; last reported ${link.reported_at ?? 'unknown'})`, exit_code: null, command_sha256: crypto.createHash('sha256').update(command).digest('hex') }
      : await runLaptopCommand({ command, timeoutMs: Number(body?.timeout_ms) || undefined, env });
    // The audit keeps the command's head and hash, never its output (it may be the owner's private files).
    record(requestedBy || 'bob', 'laptop.shell.run', result.command_sha256 || null, {
      command_head: command.slice(0, 200), purpose, conversation_id: conversationId, host: laptopConfig(env).host || null,
      status: result.status, exit_code: result.exit_code ?? null, ok: result.ok === true, timed_out: result.timed_out === true,
      stdout_bytes: result.stdout ? Buffer.byteLength(result.stdout) : 0, duration_ms: result.duration_ms ?? null, error: result.error ?? null,
    });
    return json(res, result.status, result);
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

  if (req.method === 'POST' && url.pathname === '/api/bob/human-tests') {
    const mode = body?.mode === 'live' ? 'live' : 'fixture';
    const scope = 'full';
    const requestedBy = typeof body?.requested_by === 'string' ? body.requested_by.slice(0, 120) : 'bob';
    if (mode === 'live' && (!process.env.HUMAN_TEST_BASE_URL || !process.env.GRANDMASTER_TEST_EMAIL || !process.env.GRANDMASTER_TEST_PASSWORD)) {
      return json(res, 409, { error: 'Dedicated live human-test identity and target URL are not configured' });
    }
    try {
      const started = await startHumanTestRun({ mode, scope, requestedBy });
      return json(res, started.existing ? 200 : 202, started);
    } catch (error) {
      return json(res, error.status || 503, { error: failureDetail(error) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/bob/human-tests/latest') {
    const latest = [...humanTestRuns.values()].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0];
    return latest ? json(res, 200, { run: safeHumanTestRun(latest) }) : json(res, 404, { error: 'No human-test run exists' });
  }

  const humanTestMatch = url.pathname.match(/^\/api\/bob\/human-tests\/([0-9a-f-]+)$/i);
  if (req.method === 'GET' && humanTestMatch) {
    const run = humanTestRuns.get(humanTestMatch[1]);
    return run ? json(res, 200, { run: safeHumanTestRun(run) }) : json(res, 404, { error: 'Human-test run was not found' });
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
  const repositoryReadMatch = url.pathname.match(/^\/api\/bob\/builder\/repository\/(search|file|tree)$/);
  if (repositoryReadMatch && req.method === 'GET') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    let target;
    try { target = repositoryReadTarget(); } catch { return json(res, 503, { error: 'Builder repository is unavailable' }); }
    const base = { ref: 'main', sha: target.sha };
    try {
      if (repositoryReadMatch[1] === 'search') {
        const result = searchRepository({ sourceDir: target.sourceDir, sha: target.sha, query: url.searchParams.get('q'), pathspec: url.searchParams.get('path'), limit: url.searchParams.get('limit'), regex: url.searchParams.get('regex') === '1' });
        return json(res, 200, { ...base, ...result });
      }
      if (repositoryReadMatch[1] === 'file') return json(res, 200, { ...base, ...readRepositoryFile({ sourceDir: target.sourceDir, sha: target.sha, path: url.searchParams.get('path') }) });
      return json(res, 200, { ...base, ...listRepositoryTree({ sourceDir: target.sourceDir, sha: target.sha, path: url.searchParams.get('path') || '' }) });
    } catch (error) {
      const status = error?.code === 'NOT_FOUND' ? 404 : error?.code === 'FORBIDDEN' ? 403 : 400;
      return json(res, status, { ...base, error: String(error?.message || 'repository read failed').slice(0, 200) });
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
    let started;
    try {
      started = await runBuilderJobBounded(jobId, body);
    } catch (error) {
      return json(res, 409, { error: 'Builder runtime could not continue', detail: String(error instanceof Error ? error.message : error).slice(0, 200) });
    }
    if (started.skipped) return json(res, 202, { accepted: true, already_running: true, job_id: jobId, started_at: started.started_at });
    if (body.wait === true) return json(res, 200, await started.execution);
    // Agentic implementation steps run for many minutes; callers poll the job instead of holding the socket.
    return json(res, 202, { accepted: true, job_id: jobId, started_at: runningBuilderJobs.get(jobId) });
  }
  if (builderMatch && req.method === 'POST' && builderMatch[2] === 'workspace') {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    try {
      const workspace = await bindBuilderWorkspace(builderMatch[1]);
      return json(res, workspace.existing ? 200 : 201, workspace);
    } catch (error) {
      if (error instanceof BuilderStepError) return json(res, error.status, { error: error.message });
      return json(res, 409, { error: 'Builder workspace could not be created', detail: failureDetail(error) });
    }
  }
  if (builderMatch && req.method === 'POST' && builderMatch[2] === 'commit') {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    try {
      const commit = await commitBuilderPatch(builderMatch[1], String(body.artifactId || ''));
      return json(res, 201, commit);
    } catch (error) {
      if (error instanceof BuilderStepError) return json(res, error.status, { error: error.message });
      return json(res, 409, { error: 'Builder workspace commit could not be created', detail: failureDetail(error) });
    }
  }
  if (builderMatch && req.method === 'POST' && builderMatch[2] === 'publish') {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    try {
      const publication = await publishBuilderBranch(builderMatch[1]);
      return json(res, publication.existing ? 200 : 201, publication);
    } catch (error) {
      if (error instanceof BuilderStepError) return json(res, error.status, { error: error.message });
      return json(res, 409, { error: 'Builder branch could not be published', detail: failureDetail(error) });
    }
  }
  if (builderMatch && req.method === 'POST' && builderMatch[2] === 'pull-request') {
    if (!builderSupabase) return json(res, 503, { error: 'Builder persistence is unavailable' });
    try {
      const pullRequest = await openBuilderPullRequest(builderMatch[1]);
      return json(res, pullRequest.existing ? 200 : 201, pullRequest);
    } catch (error) {
      if (error instanceof BuilderStepError) return json(res, error.status, { error: error.message });
      return json(res, 409, { error: 'Builder pull request could not be created', detail: failureDetail(error) });
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

// A model run on the VPS CPU can legitimately take longer than Node's 5-minute default request timeout;
// at 5:03 the socket closed mid-generation, the gateway marked Ollama unhealthy and every retry was told
// "unreachable" (job 2fba8ca0, 2026-09-27). Give requests the model budget plus a margin.
server.requestTimeout = Math.min(Number(process.env.BOB_MODEL_TIMEOUT_MS || 600000), 1800000) + 120000;
server.keepAliveTimeout = 65000;
server.listen(port, '0.0.0.0', () => console.log(`bob-control-plane listening on ${port}`));
if (autopilotEnabled && builderSupabase) {
  // This process is the only verifier runner: anything still 'running' at startup was orphaned by
  // the restart and would otherwise hold its job until the lease ran out (job 72edc782: 33 minutes).
  recoverExpiredWorkerRuns(builderSupabase, console, { includeActive: true, reason: 'control plane restarted before the verifier reported' })
    .then((count) => { if (count) record('autopilot', 'builder.autopilot.recovered_on_restart', 'startup', { runs: count }); })
    .catch(() => {});
  const autopilotTimer = setInterval(() => { autopilotOnce().catch(() => {}); }, autopilotIntervalMs);
  autopilotTimer.unref?.();
  setTimeout(() => { autopilotOnce().catch(() => {}); }, 5_000).unref?.();
}