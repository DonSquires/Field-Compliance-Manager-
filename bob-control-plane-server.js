const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');
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
const { createVibeWorker, vibeWorkspacePath } = require('./builder-vibe-session');
const { createFirewall } = require('./bob-firewall');
const { createVibePreviewManager } = require('./builder-vibe-preview');
const { createBranchWorkspace, createDetachedWorkspace, retireTerminalWorkspace, commitVerifiedPatch, publishWorkspaceBranch, createGiteaPullRequest, workspacePathForBranch, createGitHubPullRequest, mergeGitHubPullRequest, ensureSourceCheckout, githubAuthHeader, githubRepoUrl, githubSshRepoUrl, resolveRemoteHead, redactGitError } = require('./builder-branch-workspace');
const { executeWorker, summarizeHumanTest } = require('./worker-executor');
const { createMainHealthMonitor } = require('./bob-main-health');
const { TERMINAL_STATUSES: BUILDER_TERMINAL_STATUSES, jobHygieneDecision } = require('./builder-job-hygiene');

// Route failures used to be swallowed into a bare 409; keep a short redacted reason so the
// operator (and Bob's self-heal loop) can act without a shell on the host.
function failureDetail(error) {
  return redactGitError(String(error instanceof Error ? error.message : error)).slice(0, 300);
}

const controlPlaneStartedAt = new Date().toISOString();
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
const firewall = createFirewall({ stateDir, image: builderWorkerImage });
// Re-apply Bob's saved firewall rules (iptables does not survive a reboot on its own).
if (builderWorkerImage && process.env.BOB_FIREWALL_RECONCILE !== 'off') {
  firewall.reconcile().then(result => console.log(`bob firewall reconciled: ${result.applied} rule(s)`), error => console.error(`bob firewall reconcile failed: ${error.message}`));
}
const builderRunnerId = process.env.BOB_BUILDER_RUNNER_ID || 'bob-builder-runtime';
const builderWorkspaceRoot = process.env.BOB_BUILDER_WORKSPACE_ROOT || '/data/builder-workspaces';
const giteaBaseUrl = process.env.GITEA_BASE_URL || '';
const giteaToken = process.env.GITEA_TOKEN || '';
const giteaOwner = process.env.GITEA_OWNER || '';
const giteaRepo = process.env.GITEA_REPO || '';
const giteaUsername = process.env.GITEA_USERNAME || '';
// GitHub is the only source host. SSH deploy-key auth is for Git transport;
// PR/review APIs require a separate durable token in the VPS environment.
const githubToken = process.env.BOB_GITHUB_ACCESS_TOKEN || process.env.GITHUB_API_TOKEN || '';
const githubOwner = process.env.GITHUB_OWNER || 'DonSquires';
const githubRepo = process.env.GITHUB_REPO || 'Field-Compliance-Manager-';
const builderGitHost = 'github';
const githubSshKeyFile = path.resolve(process.env.BOB_GITHUB_SSH_KEY_FILE || '/data/github/bob-fcm-main');
const githubKnownHostsFile = path.resolve(process.env.BOB_GITHUB_KNOWN_HOSTS_FILE || '/data/github/known_hosts');
const githubSshConfigured = fs.existsSync(githubSshKeyFile) && fs.existsSync(githubKnownHostsFile)
  && /^[A-Za-z0-9_./-]+$/.test(githubSshKeyFile)
  && /^[A-Za-z0-9_./-]+$/.test(githubKnownHostsFile);
const githubSshCommand = githubSshConfigured
  ? `ssh -i ${githubSshKeyFile} -o IdentitiesOnly=yes -o UserKnownHostsFile=${githubKnownHostsFile} -o StrictHostKeyChecking=yes -o BatchMode=yes`
  : null;
const builderApiConfigured = Boolean(githubToken && githubOwner && githubRepo);
const builderSourceConfigured = Boolean((githubSshConfigured || builderApiConfigured) && githubOwner && githubRepo);
let builderSourceDir = process.env.BOB_BUILDER_SOURCE_DIR || path.join(stateDir, 'builder-source');

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
  return {
    host: 'github',
    repoUrl: githubSshConfigured ? githubSshRepoUrl(githubOwner, githubRepo) : githubRepoUrl(githubOwner, githubRepo),
    authHeader: githubSshConfigured || !githubToken ? null : githubAuthHeader(githubToken),
    sshCommand: githubSshCommand,
  };
}

function selectBuilderSourceDir(repoUrl) {
  if (!fs.existsSync(path.join(builderSourceDir, '.git'))) return builderSourceDir;
  let currentRemote = '';
  try { currentRemote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: builderSourceDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  if (currentRemote === repoUrl) return builderSourceDir;

  const githubSourceDir = process.env.BOB_GITHUB_BUILDER_SOURCE_DIR
    || path.join(path.dirname(builderSourceDir), `${path.basename(builderSourceDir)}-github`);
  if (fs.existsSync(path.join(githubSourceDir, '.git'))) {
    let githubRemote = '';
    try { githubRemote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: githubSourceDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    if (githubRemote !== repoUrl) throw new Error('GitHub Builder source path points at an unexpected repository');
  }
  builderSourceDir = githubSourceDir;
  return builderSourceDir;
}

// Where git work (worktrees, commits, pushes) starts from: a real clone kept at
// the job's pinned SHA. The image copy at assessmentRoot has no .git and is
// only read for assessment.
function builderGitSource(targetSha) {
  const target = builderGitTarget();
  const sourceDir = selectBuilderSourceDir(target.repoUrl);
  return ensureSourceCheckout({ sourceDir, repoUrl: target.repoUrl, authHeader: target.authHeader, sshCommand: target.sshCommand, sha: targetSha }).sourceDir;
}

function builderRepositoryHead(ref = 'main') {
  const target = builderGitTarget();
  return { host: target.host, ref, sha: resolveRemoteHead({ repoUrl: target.repoUrl, authHeader: target.authHeader, sshCommand: target.sshCommand, ref }) };
}

async function verifyGitHubProductionRelease(mergeSha) {
  if (!/^[a-f0-9]{40}$/i.test(String(mergeSha || ''))) {
    return { status: 'failed', error: 'Verified merge SHA is missing' };
  }
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'bob-builder-release-verifier',
  };
  const repoPath = `/repos/${encodeURIComponent(githubOwner)}/${encodeURIComponent(githubRepo)}`;
  const deploymentsResponse = await fetch(`https://api.github.com${repoPath}/deployments?sha=${mergeSha}&environment=Production&per_page=10`, { headers });
  if (!deploymentsResponse.ok) {
    return { status: 'pending', error: `GitHub deployment lookup returned HTTP ${deploymentsResponse.status}` };
  }
  const deployments = await deploymentsResponse.json();
  if (!Array.isArray(deployments) || !deployments.length) return { status: 'pending' };
  for (const deployment of deployments) {
    const statusesResponse = await fetch(`https://api.github.com${repoPath}/deployments/${deployment.id}/statuses?per_page=20`, { headers });
    if (!statusesResponse.ok) continue;
    const statuses = await statusesResponse.json();
    const latest = Array.isArray(statuses) ? statuses[0] : null;
    if (latest?.state === 'success') {
      const liveUrl = String(process.env.HUMAN_TEST_BASE_URL || latest.target_url || '').trim();
      if (!/^https:\/\//.test(liveUrl)) return { status: 'failed', error: 'Production deployment succeeded without an approved live URL' };
      try {
        const liveResponse = await fetch(liveUrl, { method: 'HEAD', redirect: 'follow' });
        if (!liveResponse.ok) return { status: 'pending', error: `Live URL returned HTTP ${liveResponse.status}` };
      } catch (error) {
        return { status: 'pending', error: `Live URL verification failed: ${failureDetail(error)}` };
      }
      return {
        status: 'success',
        source_sha: mergeSha,
        deployment_id: deployment.id,
        deployment_status_id: latest.id ?? null,
        target_url: liveUrl,
        provider_url: latest.target_url ?? null,
        verified_at: new Date().toISOString(),
        live_verified: true,
      };
    }
    if (latest && ['failure', 'error', 'inactive'].includes(latest.state)) {
      return { status: 'failed', error: latest.description || `Production deployment ended as ${latest.state}` };
    }
  }
  return { status: 'pending' };
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
const { hostStorageStatus } = require('./bob-host-storage');
const maxRequestBytes = 1024 * 1024;
const jobs = new Map();
const deliveries = new Set();
const audit = [];
const humanTestRuns = new Map();
const mainHealthRuns = new Map();
let activeLease = null;

function saveState() {
  fs.mkdirSync(stateDir, { recursive: true });
  const state = {
    jobs: [...jobs.values()],
    deliveries: [...deliveries],
    audit,
    humanTestRuns: [...humanTestRuns.values()],
    mainHealthRuns: [...mainHealthRuns.values()]
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
    for (const persisted of state.mainHealthRuns || []) {
      mainHealthRuns.set(persisted.sha, persisted.status === 'running'
        ? { ...persisted, status: 'retry', error: 'Control plane restarted during main-health verification.' }
        : persisted);
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
    target_route: run.target_route || null,
    requested_by: run.requested_by,
    created_at: run.created_at,
    started_at: run.started_at,
    completed_at: run.completed_at,
    exit_code: run.exit_code,
    error: run.error,
    summary: run.summary,
    phases: run.phases || [],
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

function combineHumanTestSummaries(phases) {
  return phases.reduce((summary, phase) => ({
    passed: summary.passed + Number(phase.summary?.passed || 0),
    failed: summary.failed + Number(phase.summary?.failed || 0),
    skipped: summary.skipped + Number(phase.summary?.skipped || 0),
  }), { passed: 0, failed: 0, skipped: 0 });
}

function repositoryTreeSha(sourceDir, sha, treePath) {
  if (!/^[a-f0-9]{40}$/i.test(String(sha || '')) || !/^[A-Za-z0-9_./-]+$/.test(String(treePath || ''))) return null;
  try {
    return execFileSync('git', ['rev-parse', `${sha}:${treePath}`], {
      cwd: sourceDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function startHumanTestRun({ mode, scope, requestedBy, expectedSha = null, targetRoute = null }) {
  const active = [...humanTestRuns.values()].find(run => run.status === 'queued' || run.status === 'running');
  if (active) return { existing: true, run: safeHumanTestRun(active) };
  if (!builderWorkerImage) throw new BuilderStepError(503, 'Human-test worker image is unavailable');
  const source = repositoryReadTarget();
  if (expectedSha && source.sha !== expectedSha) {
    const sourceWebTree = repositoryTreeSha(source.sourceDir, source.sha, 'apps/web');
    const deployedWebTree = repositoryTreeSha(source.sourceDir, expectedSha, 'apps/web');
    if (!sourceWebTree || !deployedWebTree || sourceWebTree !== deployedWebTree) {
      throw new BuilderStepError(409, `Human-test source web tree does not match the requested deployment (${source.sha.slice(0, 12)} != ${expectedSha.slice(0, 12)})`);
    }
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const artifactDir = path.join(stateDir, 'human-test-runs', id);
  const run = {
    id,
    mode,
    scope,
    status: 'queued',
    source_sha: source.sha,
    target_route: targetRoute,
    requested_by: requestedBy,
    created_at: now,
    started_at: null,
    completed_at: null,
    exit_code: null,
    error: null,
    summary: null,
    phases: [],
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
      const phaseModes = mode === 'suite' ? ['fixture', 'live'] : [mode];
      const phaseLogs = [];
      for (const phaseMode of phaseModes) {
        const phaseDir = path.join(artifactDir, phaseMode);
        fs.mkdirSync(phaseDir, { recursive: true });
        const result = await executeWorker({
          image: builderWorkerImage,
          sourceDir: source.sourceDir,
          artifactDir: phaseDir,
          profile: phaseMode === 'live' ? 'human-qa-live' : 'human-qa',
          timeoutMs: Math.min(Math.max(Number(process.env.BOB_HUMAN_TEST_TIMEOUT_MS) || 45 * 60_000, 5 * 60_000), 60 * 60_000),
          memory: process.env.BOB_HUMAN_TEST_MEMORY || (phaseMode === 'live' ? '2g' : '8g'),
          cpus: process.env.BOB_HUMAN_TEST_CPUS || (phaseMode === 'live' ? '2' : '4'),
          pidsLimit: Number(process.env.BOB_HUMAN_TEST_PIDS_LIMIT || (phaseMode === 'live' ? 256 : 1024)),
          environment: phaseMode === 'live'
            ? {
                HUMAN_TEST_LIVE: 'true',
                HUMAN_TEST_BASE_URL: process.env.HUMAN_TEST_BASE_URL,
                HUMAN_TEST_EXPECTED_SHA: expectedSha || source.sha,
                HUMAN_TEST_REQUIRE_DEPLOYMENT_MATCH: 'true',
                HUMAN_TEST_ADMIN_ROUTE: targetRoute,
                GRANDMASTER_TEST_EMAIL: process.env.GRANDMASTER_TEST_EMAIL,
                GRANDMASTER_TEST_PASSWORD: process.env.GRANDMASTER_TEST_PASSWORD,
                VERCEL_TOKEN: process.env.VERCEL_TOKEN,
                VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID,
                VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID,
              }
            : { HUMAN_TEST_LIVE: 'false', E2E_OFFLINE: '1' }
        });
        const phase = {
          mode: phaseMode,
          status: result.status,
          exit_code: result.exitCode,
          summary: summarizeHumanTest(result),
        };
        run.phases.push(phase);
        phaseLogs.push(`===== ${phaseMode.toUpperCase()} =====\n${result.stdout || ''}\n${result.stderr || ''}`);
        saveState();
        if (result.status !== 'succeeded') break;
      }
      run.summary = combineHumanTestSummaries(run.phases);
      const failedPhase = run.phases.find(phase => phase.status !== 'succeeded');
      run.status = failedPhase ? failedPhase.status : 'succeeded';
      run.exit_code = failedPhase?.exit_code ?? 0;
      fs.writeFileSync(path.join(artifactDir, 'human-test-output.log'), `${phaseLogs.join('\n')}\n`, { mode: 0o600 });
      fs.writeFileSync(path.join(artifactDir, 'human-test-receipt.json'), JSON.stringify({
        run_id: id,
        mode,
        scope,
        source_sha: source.sha,
        expected_sha: expectedSha || source.sha,
        target_route: targetRoute,
        result: { status: run.status, exit_code: run.exit_code },
        summary: run.summary,
        phases: run.phases,
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

function collectPinnedDesignContext(source) {
  if (!source.targetSha) return {};
  const gitSourceDir = source.gitSourceDir || source.sourceDir;
  const read = (filePath, maximum) => {
    try { return readRepositoryFile({ sourceDir: gitSourceDir, sha: source.targetSha, path: filePath }).content.slice(0, maximum); }
    catch { return ''; }
  };
  const productDesign = read('docs/canon/PRODUCT_DESIGN.md', 8_000);
  const tokenCss = read('apps/web/src/styles/tokens.css', 8_000);
  const designTokens = [...new Set(tokenCss.match(/--[a-z0-9-]+(?=\s*:)/gi) || [])];
  const task = String(source.taskDescription || source.title || '');
  const builderSurface = /\bbob builder\b|\bbuilder control(?:-| )room\b|BuilderControlRoomPage/i.test(task);
  return {
    existing_design_system: [
      'Canonical source: docs/canon/PRODUCT_DESIGN.md',
      productDesign,
      'Canonical token source: apps/web/src/styles/tokens.css',
      tokenCss
    ].join('\n').slice(0, 12_000),
    design_tokens: designTokens,
    ...(builderSurface ? {
      relevant_components: ['BuilderControlRoomPage', 'BuilderControlRoomPage.css', 'AdminShell', 'BobPanel'],
      existing_routes: ['AdminShell page id "builder"'],
      existing_access_boundaries: ['platform-only AdminShell page'],
      viewport_requirements: ['desktop and mobile', 'admin controls use --touch-target-admin']
    } : {})
  };
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
      ...collectPinnedDesignContext(source),
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
  const { data: job, error } = await builderSupabase.from('builder_jobs').select('id,title,task_description,workspace_branch,workspace_head_sha,target_sha').eq('id', jobId).single();
  if (error || !job?.target_sha) throw new Error('Builder job source is unavailable');
  if (!job.workspace_branch) {
    // No bound workspace yet: work from the job's own worktree at the pinned commit
    // (the image copy has no .git). The workspace route later binds this same branch.
    const gitSourceDir = builderGitSource(job.target_sha);
    const workspace = createBranchWorkspace({ sourceDir: gitSourceDir, workspaceRoot: builderWorkspaceRoot, jobId: job.id, targetSha: job.target_sha, recoverInterrupted: true });
    return { sourceDir: workspace.workspacePath, gitSourceDir, targetSha: job.target_sha, title: job.title, taskDescription: job.task_description };
  }
  const sourceDir = workspacePathForBranch(builderWorkspaceRoot, job.workspace_branch);
  if (!fs.existsSync(sourceDir)) throw new Error('Builder workspace is unavailable');
  if (job.workspace_head_sha !== job.target_sha) throw new Error('Builder job does not match its workspace head');
  // Re-pin the shared clone: it sits at whichever SHA the previous job used, and the engineer's
  // worktree checks verify against it (job f6df4b84: "source checkout does not match the target SHA" ×6).
  return { sourceDir, gitSourceDir: builderGitSource(job.target_sha), targetSha: job.target_sha, title: job.title, taskDescription: job.task_description };
}

// One Builder run per job at a time; runs continue after the HTTP caller has gone.
const runningBuilderJobs = new Map();
const agenticWallBudgetMs = Math.max(5 * 60_000, Number(process.env.BOB_BUILDER_AGENT_BUDGET_MS) || 45 * 60_000);
const agenticTurnTimeoutMs = Math.max(30_000, Number(process.env.BOB_BUILDER_TURN_TIMEOUT_MS) || 420_000);
// A legitimate agentic run can outlive the old 45-minute lease. Clearing it while its model turn
// is still active launches a second engineer against the same job and worktree.
const staleBuilderRunMs = Math.max(
  5 * 60_000,
  Number(process.env.BOB_BUILDER_STALE_RUN_MS) || 45 * 60_000,
  agenticWallBudgetMs + agenticTurnTimeoutMs + 5 * 60_000
);
const builderPreflightTimeoutMs = Math.max(30_000, Number(process.env.BOB_BUILDER_PREFLIGHT_TIMEOUT_MS) || 120_000);

function boundedPreflight(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${builderPreflightTimeoutMs}ms`)), builderPreflightTimeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

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
  const commit = commitVerifiedPatch({
    workspacePath: workspace.workspacePath,
    branchName: workspace.branchName,
    patch,
    message: `Bob Builder: ${String(job.title || 'verified change').trim()}`,
    body: `Builder job ${job.id}\nVerified patch artifact ${artifact.id}\nPinned to ${job.target_sha}`,
    requireVerifiedIdentity: builderGitHost === 'github',
  });
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
  const publication = publishWorkspaceBranch({
    workspacePath,
    branchName: job.workspace_branch,
    expectedHeadSha: job.workspace_head_sha,
    pushUrl: target.repoUrl,
    pushAuthHeader: target.authHeader,
    sshCommand: target.sshCommand,
    requireVerifiedIdentity: builderGitHost === 'github',
  });
  const { data: updated, error } = await builderSupabase.rpc('builder_record_workspace_publication', { _job_id: job.id, _expected_head_sha: publication.head });
  if (error || !updated) throw new BuilderStepError(409, 'Builder branch publication could not be recorded');
  return { branch: publication.branchName, head: publication.head, existing: false };
}

function defaultPullRequestBody(job) {
  return `## Bob Builder review\n\nVerified Builder workspace branch: \`${job.workspace_branch}\`\n\nPinned commit: \`${job.workspace_head_sha}\`\n\nThis pull request is for human review only. It does not authorize a merge or deployment.`;
}

async function openBuilderPullRequest(jobId, bodyFor = null, { draft = true } = {}) {
  const { data: job } = await builderSupabase.from('builder_jobs').select('id,title,workspace_branch,workspace_head_sha,workspace_published_head_sha,workspace_pull_request_head_sha,workspace_pull_request_url').eq('id', jobId).single();
  if (!job?.workspace_branch || !job.workspace_head_sha || job.workspace_published_head_sha !== job.workspace_head_sha) throw new BuilderStepError(409, 'Published Builder workspace is required');
  if (job.workspace_pull_request_head_sha === job.workspace_head_sha && job.workspace_pull_request_url) {
    const number = builderGitHost === 'github'
      ? Number(job.workspace_pull_request_url.match(/\/pull\/(\d+)$/)?.[1] || 0)
      : null;
    if (builderGitHost === 'github' && number < 1) throw new BuilderStepError(409, 'Recorded Builder pull request URL is invalid');
    return { branchName: job.workspace_branch, head: job.workspace_head_sha, url: job.workspace_pull_request_url, number, existing: true };
  }
  const workspacePath = workspacePathForBranch(builderWorkspaceRoot, job.workspace_branch);
  const reviewBody = typeof bodyFor === 'function' ? bodyFor(job.workspace_branch, job.workspace_head_sha) : defaultPullRequestBody(job);
  const pullRequest = builderGitHost === 'github'
    ? await createGitHubPullRequest({ workspacePath, branchName: job.workspace_branch, expectedHeadSha: job.workspace_head_sha, title: `Bob Builder: ${job.title}`, body: reviewBody, githubToken, owner: githubOwner, repo: githubRepo, draft })
    : await createGiteaPullRequest({ workspacePath, branchName: job.workspace_branch, expectedHeadSha: job.workspace_head_sha, title: `Bob Builder: ${job.title}`, body: reviewBody, giteaBaseUrl, giteaToken, owner: giteaOwner, repo: giteaRepo });
  const { data: updated, error } = await builderSupabase.rpc('builder_record_workspace_pull_request', { _job_id: job.id, _expected_head_sha: pullRequest.head, _pull_request_url: pullRequest.url });
  if (error || !updated) throw new BuilderStepError(409, 'Builder pull request could not be recorded');
  return { ...pullRequest, existing: false };
}

async function runBuilderJobBounded(jobId, body = {}, { singleStep = false } = {}) {
  clearStaleBuilderRun(jobId);
  if (runningBuilderJobs.has(jobId)) return { skipped: true, already_running: true, started_at: runningBuilderJobs.get(jobId) };
  const startedAt = new Date().toISOString();
  runningBuilderJobs.set(jobId, startedAt);
  const execution = (async () => {
    const source = await boundedPreflight(resolveBuilderSourceDir(jobId), 'Builder source resolution');
    const context = await boundedPreflight(builderRuntimeContext(body, source), 'Builder runtime context');
    const input = { supabase: builderSupabase, gateway: builderGateway, jobId, context, maxActions: body.maxActions };
    return singleStep ? advanceBuilderJob(input) : runBuilderUntilPause(input);
  })()
    .then((outcome) => { record('builder', 'builder.run.paused', jobId, { reason: outcome.reason, detail: outcome.detail ?? null, actions: outcome.history?.length ?? 0 }); return outcome; })
    .catch((error) => { record('builder', 'builder.run.failed', jobId, { error: String(error instanceof Error ? error.message : error).slice(0, 300) }); return { paused: true, reason: 'error', detail: String(error instanceof Error ? error.message : error).slice(0, 300) }; })
    .finally(() => runningBuilderJobs.delete(jobId));
  return { execution, started_at: startedAt };
}

// Bob autopilot: every tick, move the jobs the owner asked for in chat one step closer to a
// reviewed pull request. Human-only paths (merge, deploy, protected files) are untouched.
const autopilotEnabled = process.env.BOB_BUILDER_AUTOPILOT !== 'false';
const routineRepairEnabled = process.env.BOB_ROUTINE_SELF_HEAL !== 'false';
const autopilotIntervalMs = Math.max(15_000, Number(process.env.BOB_BUILDER_AUTOPILOT_INTERVAL_MS) || 60_000);
let autopilotBusy = false;
let mainHealthInFlight = null;
let interruptedModelRecoveryPromise = null;

async function routineBuilderProject() {
  let query = builderSupabase
    .from('builder_projects')
    .select('id,organization_id,gitea_owner,gitea_repo')
    .eq('status', 'active');
  const projectOwner = builderGitHost === 'github' ? githubOwner : giteaOwner;
  const projectRepo = builderGitHost === 'github' ? githubRepo : giteaRepo;
  if (projectOwner) query = query.eq('gitea_owner', projectOwner);
  if (projectRepo) query = query.eq('gitea_repo', projectRepo);
  const { data, error } = await query.limit(2);
  if (error || !Array.isArray(data) || data.length !== 1) {
    throw new Error('routine self-heal requires exactly one active Builder project for this repository');
  }
  return data[0];
}

const mainHealthEnabled = autopilotEnabled
  && process.env.BOB_MAIN_HEALTH !== 'false'
  && builderGitHost === 'github'
  && Boolean(builderSupabase && modelGatewayToken && builderWorkerImage && builderSourceConfigured && builderApiConfigured);

function mainHealthState(sha) {
  return mainHealthRuns.get(sha) ?? null;
}

function saveMainHealthState(state) {
  mainHealthRuns.set(state.sha, state);
  saveState();
}

function mainHealthRepairBrief({ sha, failure }) {
  const failingFiles = failure.failing_tests.map((file) => file.startsWith('apps/web/') ? file : `apps/web/${file}`);
  return [
    `Goal: make main green again by fixing the real cause of the failing web checks reported by Bob's isolated main-health run at ${sha}. Self-heal repairs the app, not just its tests.`,
    `Before: the repository is pinned to ${sha}; the main-health worker ran the web build, full Vitest unit/source-guard suite, and CI Playwright smoke suite against a read-only checkout.`,
    `During: the main-health worker exited ${failure.exit_code}; failing tests: ${failingFiles.join(', ')}.`,
    `Failure evidence (redacted and bounded):\n${failure.summary || 'See the bounded worker output below.'}\n${failure.stdout}\n${failure.stderr}`.slice(0, 9000),
    'Required diagnosis: first reproduce each failure at the pinned commit. Run src/**/*.test.ts(x) with npm run test --prefix apps/web -- <test paths>; run e2e/*.spec.ts with npm run test:e2e --prefix apps/web -- <spec paths> --project=desktop-chromium --workers=1 --ignore-snapshots. Then read each failing test and its application source/schema. If the application regressed, fix the application source. Change a test only when source/schema evidence proves it stale; never delete, skip, or weaken it. The validated specification must name the actual frontend and/or backend source files needed; unused lanes are skipped from that evidence, not given invented edits.',
    'Required verification: rerun the failing tests and the isolated main-health checks, independent code review, security review, and Atlas refresh. Preserve the exact tested main SHA and failing-test file set.',
    'Scope: the smallest root-cause repair across frontend and backend, with focused regression tests. Backend application code and new additive migrations may be drafted and independently verified. Unattended release remains limited to at most eight non-protected apps/web/src files; backend, browser-test, migration, legal, safety, identity, enforcement, finance, payroll, and evidential changes pause for Grandmaster approval before release. Auth/identity, dependencies, environment, CI/deploy and hand-editing the schema snapshot remain refused. No unrelated features or redesigns.',
    'After: open a pull request with the test receipts; release follows the normal independent gates.',
  ].join('\n');
}

async function openMainHealthRepair({ sha, failure }) {
  const failingFiles = [...new Set(failure.failing_tests.map((file) => file.startsWith('apps/web/') ? file : `apps/web/${file}`))];
  const testFilePattern = /^apps\/web\/(?:src\/[A-Za-z0-9_./-]+\.(?:test|spec)\.tsx?|e2e\/[A-Za-z0-9_./-]+\.spec\.ts)$/;
  if (!failingFiles.length || failingFiles.length > 8 || failingFiles.some((file) => !testFilePattern.test(file) || file.includes('..'))) {
    throw new Error(`main-health failure has no supported web test scope; parsed=${failingFiles.join(',').slice(0, 240) || 'none'}`);
  }
  if (builderRepositoryHead('main').sha !== sha) throw new Error('main moved before the repair job could be opened');
  const project = await routineBuilderProject();
  const open = () => builderSupabase.rpc('builder_open_main_health_repair', {
    _organization_id: project.organization_id,
    _project_id: project.id,
    _health_sha: sha,
    _target_sha: sha,
    _title: `Repair app regression behind ${failingFiles.length} failing main check${failingFiles.length === 1 ? '' : 's'}`,
    _task_description: mainHealthRepairBrief({ sha, failure }),
    _failed_files: failingFiles,
    _parent_job_id: null,
  });
  let { data: job, error } = await open();
  // The open RPC reuses an active repair for the same failing files. One the autopilot already handed
  // back after main moved would never be driven again, so retire it and open a fresh one on this SHA.
  // Hand-back is limited to workspace-free jobs, which the housekeeping RPC can retire.
  if (!error && job?.id && job.autopilot_state === 'done' && job.source_main_health_sha !== sha && !BUILDER_TERMINAL_STATUSES.has(job.status) && !job.workspace_branch && !job.workspace_pull_request_url) {
    const { error: retireError } = await builderSupabase.rpc('builder_retire_stale_job', {
      _job_id: job.id,
      _reason: `Bob handed this repair back after main moved; main-health re-tested ${sha} and opened a fresh repair for the same failing checks.`,
      _outcome: 'superseded_main_health',
      _details: { current_main_sha: sha, failed_files: failingFiles },
    });
    if (retireError) throw new Error(`handed-back main-health repair could not be retired: ${retireError.message}`);
    ({ data: job, error } = await open());
  }
  if (error || !job?.id) throw new Error(`main-health repair job could not be opened: ${error?.message || 'no job returned'}`);
  record('autopilot', 'builder.main_health_repair.started', job.id, { health_sha: sha, failed_files: failingFiles });
  return { id: job.id };
}

const mainHealthMonitor = createMainHealthMonitor({
  getMainSha: () => builderRepositoryHead('main').sha,
  runChecks: async ({ sha }) => {
    const mutableSource = builderGitSource(sha);
    const source = createDetachedWorkspace({
      sourceDir: mutableSource,
      workspaceRoot: path.join(builderWorkspaceRoot, 'main-health'),
      targetSha: sha,
    }).workspacePath;
    const artifactDir = path.join(stateDir, 'main-health-runs', sha);
    fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    return executeWorker({
      image: builderWorkerImage,
      sourceDir: source,
      artifactDir,
      profile: 'main-health',
      timeoutMs: Math.min(Math.max(Number(process.env.BOB_MAIN_HEALTH_TIMEOUT_MS) || 30 * 60_000, 5 * 60_000), 45 * 60_000),
      memory: process.env.BOB_MAIN_HEALTH_MEMORY || '8g',
      cpus: process.env.BOB_MAIN_HEALTH_CPUS || '4',
      pidsLimit: Number(process.env.BOB_MAIN_HEALTH_PIDS_LIMIT || 1024),
      environment: { E2E_OFFLINE: '1' },
    });
  },
  openRepair: openMainHealthRepair,
  readState: async (sha) => mainHealthState(sha),
  writeState: async (state) => saveMainHealthState(state),
  log: (entry) => record('autopilot', 'builder.main_health', entry.sha || 'main', entry),
});

async function recoverInterruptedModelSteps() {
  const { data: runs, error } = await builderSupabase
    .from('builder_model_runs')
    .select('id,job_id,step_id,started_at')
    .eq('status', 'running')
    .lt('started_at', controlPlaneStartedAt)
    .limit(100);
  if (error) throw new Error(`interrupted model runs could not be listed: ${error.message}`);
  let recovered = 0;
  for (const run of runs || []) {
    const reason = 'control plane restarted before the model reported';
    const { data: claimed, error: claimError } = await builderSupabase
      .from('builder_model_runs')
      .update({ status: 'failed', completed_at: new Date().toISOString(), error: reason })
      .eq('id', run.id)
      .eq('status', 'running')
      .select('id')
      .maybeSingle();
    if (claimError) throw new Error(`interrupted model run could not be claimed: ${claimError.message}`);
    if (!claimed) continue;
    const { error: abortError } = await builderSupabase.rpc('builder_abort_model_step', {
      _job_id: run.job_id,
      _step_id: run.step_id,
      _reason: reason,
    });
    if (abortError) {
      record('autopilot', 'builder.model_recovery.failed', run.job_id, { step_id: run.step_id, error: abortError.message.slice(0, 300) });
      continue;
    }
    recovered += 1;
    record('autopilot', 'builder.model_recovery.completed', run.job_id, { step_id: run.step_id, model_run_id: run.id });
  }
  return recovered;
}

function startInterruptedModelRecovery() {
  if (!interruptedModelRecoveryPromise) {
    interruptedModelRecoveryPromise = recoverInterruptedModelSteps().catch((error) => {
      interruptedModelRecoveryPromise = null;
      record('autopilot', 'builder.model_recovery.failed', 'startup', { error: String(error instanceof Error ? error.message : error).slice(0, 300) });
      throw error;
    });
  }
  return interruptedModelRecoveryPromise;
}

function startMainHealthCheck() {
  if (!mainHealthEnabled || mainHealthInFlight) return mainHealthInFlight;
  mainHealthInFlight = mainHealthMonitor.tick()
    .catch((error) => {
      record('autopilot', 'builder.main_health.failed', 'main', {
        error: String(error instanceof Error ? error.message : error).slice(0, 300),
      });
    })
    .finally(() => {
      mainHealthInFlight = null;
    });
  return mainHealthInFlight;
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

function hasVerifiedSelfHealDeployment(job) {
  const report = job?.autopilot_report;
  const deployment = report?.deployment;
  return Boolean(
    job?.workspace_pull_request_url
    && /^[a-f0-9]{40}$/i.test(String(report?.merge_sha || ''))
    && report?.merged === true
    && deployment?.status === 'success'
    && deployment?.live_verified === true
    && deployment?.source_sha === report.merge_sha
  );
}

async function reconcileInvalidSelfHealDeployments() {
  const { data, error } = await builderSupabase
    .from('builder_jobs')
    .select('id,organization_id,title,status,autopilot_source,autopilot_report,workspace_pull_request_url')
    .eq('status', 'deployed')
    .in('autopilot_source', ['main_monitor', 'routine_monitor'])
    .limit(20);
  if (error) throw new Error(`self-heal deployment states could not be checked: ${error.message}`);
  for (const job of data || []) {
    if (hasVerifiedSelfHealDeployment(job)) continue;
    const reason = 'Self-heal job was labelled deployed without verified pull-request, merge, production deployment, and live receipts.';
    const { error: updateError } = await builderSupabase
      .from('builder_jobs')
      .update({
        status: 'failed',
        autopilot_state: 'blocked',
        last_error: reason,
        autopilot_report: {
          ...(job.autopilot_report && typeof job.autopilot_report === 'object' ? job.autopilot_report : {}),
          headline: `Corrected false deployment status for "${String(job.title || 'self-heal job').slice(0, 160)}".`,
          text: `${reason} No code publication is inferred.`,
          deployment_reconciled_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'deployed');
    if (updateError) throw new Error(`invalid self-heal deployment could not be corrected: ${updateError.message}`);
    const { error: auditError } = await builderSupabase.from('builder_audit_events').insert({
      organization_id: job.organization_id,
      job_id: job.id,
      event_type: 'job_status_changed',
      actor_type: 'bot',
      new_value: { status: 'failed', reason: 'missing_release_receipts' },
      change_summary: reason,
    });
    if (auditError) throw new Error(`false deployment correction audit could not be recorded: ${auditError.message}`);
    record('autopilot', 'builder.self_heal.false_deployment_corrected', job.id, {});
  }
}

async function reconcileStaleBuilderJobs() {
  const { data: terminalApprovalCount, error: terminalApprovalError } = await builderSupabase.rpc('builder_cancel_terminal_approvals');
  if (terminalApprovalError) throw new Error(`terminal Builder approvals could not be reconciled: ${terminalApprovalError.message}`);
  if (Number(terminalApprovalCount) > 0) {
    record('autopilot', 'builder.housekeeping.approvals_cancelled', 'builder', { count: Number(terminalApprovalCount) });
  }
  const currentMainSha = builderRepositoryHead('main').sha;
  const currentMainHealthPassed = mainHealthState(currentMainSha)?.status === 'passed';
  const activeStatuses = [
    'intake', 'analysis_pending', 'specification_ready', 'design_pending',
    'implementation_pending', 'building', 'testing', 'security_review',
    'approval_pending', 'release_ready',
  ];
  const { data: jobs, error } = await builderSupabase
    .from('builder_jobs')
    .select('id,status,created_at,updated_at,workspace_branch,workspace_pull_request_url,autopilot_requested_by,autopilot_source,autopilot_state,source_main_health_sha')
    .in('status', activeStatuses)
    .order('updated_at', { ascending: true })
    .limit(100);
  if (error) throw new Error(`stale Builder jobs could not be listed: ${error.message}`);
  if (!jobs?.length) return 0;

  const jobIds = jobs.map((job) => job.id);
  const [modelRuns, workerRuns, approvals] = await Promise.all([
    builderSupabase.from('builder_model_runs').select('job_id').in('job_id', jobIds).in('status', ['pending', 'running']),
    builderSupabase.from('builder_worker_runs').select('job_id').in('job_id', jobIds).in('status', ['pending', 'running']),
    builderSupabase.from('builder_approvals').select('job_id').in('job_id', jobIds).eq('status', 'pending'),
  ]);
  if (modelRuns.error) throw new Error(`active Builder model runs could not be listed: ${modelRuns.error.message}`);
  if (workerRuns.error) throw new Error(`active Builder worker runs could not be listed: ${workerRuns.error.message}`);
  if (approvals.error) throw new Error(`pending Builder approvals could not be listed: ${approvals.error.message}`);
  const activeExecution = new Set([...(modelRuns.data || []), ...(workerRuns.data || [])].map((row) => row.job_id));
  const pendingApprovals = new Set((approvals.data || []).map((row) => row.job_id));

  let retired = 0;
  for (const job of jobs) {
    const decision = jobHygieneDecision(job, {
      currentMainSha,
      currentMainHealthPassed,
      activeExecution: activeExecution.has(job.id),
      pendingApproval: pendingApprovals.has(job.id),
    });
    if (!decision) continue;
    const { data: updated, error: retireError } = await builderSupabase.rpc('builder_retire_stale_job', {
      _job_id: job.id,
      _reason: decision.reason,
      _outcome: decision.outcome,
      _details: {
        current_main_sha: currentMainSha,
        current_main_health_passed: currentMainHealthPassed,
        source_main_health_sha: job.source_main_health_sha ?? null,
      },
    });
    if (retireError) throw new Error(`stale Builder job ${job.id} could not be retired: ${retireError.message}`);
    if (updated?.status === 'cancelled') {
      retired += 1;
      record('autopilot', 'builder.housekeeping.retired', job.id, { outcome: decision.outcome });
    }
  }
  return retired;
}

let lastWorkspaceRetentionAt = 0;
async function retireOldBuilderWorkspaces() {
  if (Date.now() - lastWorkspaceRetentionAt < 3600000 || !fs.existsSync(path.join(builderSourceDir, '.git'))) return;
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const counts = {};
  for (let offset = 0; ; offset += 100) {
    const { data: jobs, error } = await builderSupabase.from('builder_jobs')
      .select('id').in('status', ['deployed', 'failed', 'cancelled']).lt('updated_at', cutoff)
      .order('id').range(offset, offset + 99);
    if (error) throw new Error(`workspace retention could not list terminal jobs: ${error.message}`);
    for (const candidate of jobs || []) {
      const [current, models, workers, approvals] = await Promise.all([
        builderSupabase.from('builder_jobs').select('id,organization_id,status,updated_at,target_sha,workspace_branch,workspace_published_head_sha').eq('id', candidate.id).single(),
        builderSupabase.from('builder_model_runs').select('id').eq('job_id', candidate.id).in('status', ['pending', 'queued', 'running']).limit(1),
        builderSupabase.from('builder_worker_runs').select('id').eq('job_id', candidate.id).in('status', ['pending', 'queued', 'running']).limit(1),
        builderSupabase.from('builder_approvals').select('id').eq('job_id', candidate.id).eq('status', 'pending').limit(1),
      ]);
      if ([current, models, workers, approvals].some(result => result.error)) throw new Error('workspace retention could not verify current job activity; no workspace removed for this job');
      const input = {
        sourceDir: builderSourceDir, workspaceRoot: builderWorkspaceRoot, job: current.data,
        legacySourceDir: path.join(stateDir, 'builder-source'),
        activeExecution: runningBuilderJobs.has(candidate.id) || Boolean(models.data?.length || workers.data?.length),
        pendingApproval: Boolean(approvals.data?.length),
      };
      const preview = retireTerminalWorkspace(input);
      let reason = preview.reason;
      if (preview.eligible) {
        record('autopilot', 'builder.workspace.retention_started', candidate.id, { retention_days: 7 });
        const outcome = retireTerminalWorkspace({ ...input, dryRun: false });
        reason = outcome.reason;
        if (outcome.removed) record('autopilot', 'builder.workspace.retired', candidate.id, { retention_days: 7, branches_and_artifacts_preserved: true });
      }
      counts[reason] = (counts[reason] || 0) + 1;
    }
    if (!jobs || jobs.length < 100) break;
  }
  lastWorkspaceRetentionAt = Date.now();
  record('autopilot', 'builder.workspace.retention_checked', 'builder', { counts });
}

async function autopilotOnce() {
  if (autopilotBusy || !builderSupabase || !modelGatewayToken || !builderWorkerImage || !builderSourceConfigured || !builderApiConfigured) return [];
  autopilotBusy = true;
  try {
    await startInterruptedModelRecovery();
    startMainHealthCheck();
    await startRoutineRepairs();
    await reconcileInvalidSelfHealDeployments();
    await reconcileStaleBuilderJobs();
    try {
      await retireOldBuilderWorkspaces();
    } catch (error) {
      record('autopilot', 'builder.workspace.retention_failed', 'builder', { error: redactGitError(error.message) });
    }
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
        publish: async ({ job, validatedPatchId, bodyFor, automerge }) => {
          await bindBuilderWorkspace(job.id);
          const { data: fresh } = await builderSupabase.from('builder_jobs').select('workspace_head_sha,workspace_branch,target_sha').eq('id', job.id).single();
          if (fresh?.workspace_head_sha === fresh?.target_sha) await commitBuilderPatch(job.id, validatedPatchId);
          await publishBuilderBranch(job.id);
          const pullRequest = await openBuilderPullRequest(job.id, bodyFor, { draft: automerge?.ok !== true });
          if (automerge?.ok && builderGitHost === 'github') {
            const merge = await mergeGitHubPullRequest({ number: pullRequest.number, expectedHeadSha: pullRequest.head, githubToken, owner: githubOwner, repo: githubRepo });
            return { pullRequestUrl: pullRequest.url, merged: true, mergeSha: merge.sha };
          }
          return { pullRequestUrl: pullRequest.url, merged: false };
        },
        verifyRelease: async (job) => verifyGitHubProductionRelease(job.autopilot_report?.merge_sha),
        markDeployed: async (jobId, deployment) => {
          if (deployment?.status !== 'success' || deployment?.live_verified !== true || !/^[a-f0-9]{40}$/i.test(String(deployment?.source_sha || ''))) {
            throw new Error('Builder deployment receipt is incomplete');
          }
          const { data: current, error: readError } = await builderSupabase
            .from('builder_jobs')
            .select('id,organization_id,status,workspace_pull_request_url,autopilot_report')
            .eq('id', jobId)
            .single();
          if (readError || !current?.id || current.status !== 'release_ready' || !current.workspace_pull_request_url
              || current.autopilot_report?.merged !== true || current.autopilot_report?.merge_sha !== deployment.source_sha) {
            throw new Error('Builder job is not the verified merged release');
          }
          const { error: updateError } = await builderSupabase
            .from('builder_jobs')
            .update({ status: 'deployed', current_step_name: 'release_prep', last_error: null, updated_at: new Date().toISOString() })
            .eq('id', jobId)
            .eq('status', 'release_ready');
          if (updateError) throw new Error(`Builder deployment could not be recorded: ${updateError.message}`);
          const { error: auditError } = await builderSupabase.from('builder_audit_events').insert({
            organization_id: current.organization_id,
            job_id: jobId,
            event_type: 'job_status_changed',
            actor_type: 'bot',
            new_value: deployment,
            change_summary: 'Verified GitHub merge, successful Production deployment, and responsive live URL recorded',
          });
          if (auditError) throw new Error(`Builder deployment audit could not be recorded: ${auditError.message}`);
        },
        record: async (jobId, state, report) => {
          const { error } = await builderSupabase.rpc('builder_autopilot_record', { _job_id: jobId, _state: state, _report: report });
          if (error) throw new Error(`autopilot outcome could not be recorded: ${error.message}`);
          if (state === 'done') {
            const { data: current, error: currentError } = await builderSupabase
              .from('builder_jobs')
              .select('id,status,workspace_branch,workspace_pull_request_url')
              .eq('id', jobId)
              .single();
            if (currentError) throw new Error(`completed Builder job could not be checked: ${currentError.message}`);
            if (!BUILDER_TERMINAL_STATUSES.has(current.status) && !current.workspace_branch && !current.workspace_pull_request_url) {
              const reason = String(report?.reason || report?.text || 'Bob completed or superseded this job.')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 2000);
              const { error: retireError } = await builderSupabase.rpc('builder_retire_stale_job', {
                _job_id: jobId,
                _reason: reason,
                _outcome: 'completed_autopilot',
                _details: { report_state: report?.state ?? null, repair_outcome: report?.repair_outcome ?? null },
              });
              if (retireError) throw new Error(`completed Builder job could not be retired: ${retireError.message}`);
            }
          }
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
        fail: async (jobId, reason) => {
          const { error } = await builderSupabase
            .from('builder_jobs')
            .update({
              status: 'failed',
              last_error: String(reason || 'Builder could not continue').slice(0, 2000),
              updated_at: new Date().toISOString(),
            })
            .eq('id', jobId)
            .not('status', 'in', '("deployed","failed","cancelled")');
          if (error) throw new Error(`blocked Builder job could not be finalized: ${error.message}`);
        },
        // Self-heal (owner ruling 2026-09-27): a job blocked by a red main opens a repair job bound to the
        // same requester, and is re-opened on current main once the repair has landed.
        createJob: async (input) => {
          const { sha } = builderRepositoryHead('main');
          if (input.autopilotSource === 'main_monitor') {
            if (!input.sourceMainHealthSha || !Array.isArray(input.sourceMainHealthFiles) || !input.sourceMainHealthFiles.length) {
              throw new Error('main-health follow-up is missing its source SHA or failed-test allowlist');
            }
            const { data: repair, error: repairError } = await builderSupabase.rpc('builder_open_main_health_repair', {
              _organization_id: input.organizationId,
              _project_id: input.projectId,
              _health_sha: input.sourceMainHealthSha,
              _target_sha: sha,
              _title: String(input.title).slice(0, 200),
              _task_description: String(input.taskDescription).slice(0, 12000),
              _failed_files: input.sourceMainHealthFiles,
              _parent_job_id: input.parentJobId ?? null,
            });
            if (repairError || !repair?.id) throw new Error(`main-health follow-up could not be opened: ${repairError?.message || 'no job returned'}`);
            record('autopilot', 'builder.main_health_repair.reopened', repair.id, { parent: input.parentJobId ?? null, health_sha: input.sourceMainHealthSha });
            return repair;
          }
          const { data: created, error } = await builderSupabase.rpc('builder_create_autopilot_child', {
            _parent_job_id: input.parentJobId,
            _title: String(input.title).slice(0, 200),
            _task_description: String(input.taskDescription).slice(0, 12000),
            _target_sha: sha,
            _description: input.description ? String(input.description).slice(0, 500) : null,
            _frontend_required: input.frontendRequired === true,
            _backend_required: input.backendRequired === true,
            _code_review_mode: input.codeReviewMode || 'independent_ai',
          });
          if (error || !created?.id) throw new Error(`autopilot could not open a job: ${error?.message || 'no job returned'}`);
          record('autopilot', 'builder.autopilot.job_opened', created.id, { parent: input.parentJobId ?? null, title: String(input.title).slice(0, 120) });
          return created;
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
    const latestMainHealth = [...mainHealthRuns.values()].sort((left, right) => String(right.checked_at || right.started_at).localeCompare(String(left.checked_at || left.started_at)))[0] ?? null;
    return json(res, 200, { status: 'ok', service: 'bob-control-plane', storage: hostStorageStatus({ stateDir }), activeLease: Boolean(activeLease), builderGitHost, builderSourceConfigured, builderApiConfigured, builderSshConfigured: Boolean(githubSshCommand), autopilot: autopilotEnabled && Boolean(builderSupabase && modelGatewayToken && builderWorkerImage && builderSourceConfigured && builderApiConfigured), autopilotIntervalMs, mainHealth: { enabled: mainHealthEnabled, sourceHost: builderGitHost, latest: latestMainHealth ? { sha: latestMainHealth.sha, status: latestMainHealth.status, job_id: latestMainHealth.job_id ?? null, checked_at: latestMainHealth.checked_at ?? null } : null }, runningBuilderJobs: runningBuilderJobs.size, modelProviders: Object.fromEntries(Object.entries(providers).map(([name, p]) => [name, { configured: p.configured, healthy: p.healthy, ready_model: p.ready_model }])), laptopShell: { enabled: laptop.enabled, configured: laptop.configured, host: laptop.host || null, ssh_allowed: laptopLink ? laptopLink.ssh_allowed === true : null } });
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
  // Bob's VPS firewall (owner ruling 2026-10-21: direct, audited). Structured rules only; the
  // module refuses lockouts of SSH, the public app and Tailscale.
  if (req.method === 'GET' && url.pathname === '/api/bob/firewall/status') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    try { return json(res, 200, await firewall.status()); } catch (error) { return json(res, 503, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/bob/firewall/change') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const requestedBy = typeof body?.requested_by === 'string' ? body.requested_by.slice(0, 120) : 'bob';
    const purpose = typeof body?.purpose === 'string' ? body.purpose.slice(0, 300) : null;
    try {
      const result = await firewall.change({ op: body?.op, rule: body?.rule });
      record(requestedBy, 'firewall.change', result.rule ? `${body.op}:${result.rule.chain}` : null, { op: body?.op, rule: result.rule ?? body?.rule ?? null, changed: result.changed, purpose, rule_count: result.rules.length });
      return json(res, 200, result);
    } catch (error) {
      record(requestedBy, 'firewall.change.refused', null, { op: body?.op ?? null, rule: body?.rule ?? null, purpose, error: error.message });
      return json(res, 400, { ok: false, error: error.message });
    }
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
    const mode = body?.mode === 'suite' ? 'suite' : body?.mode === 'live' ? 'live' : 'fixture';
    const scope = 'full';
    const requestedBy = typeof body?.requested_by === 'string' ? body.requested_by.slice(0, 120) : 'bob';
    const expectedSha = typeof body?.expected_sha === 'string' && /^[a-f0-9]{40}$/i.test(body.expected_sha)
      ? body.expected_sha.toLowerCase()
      : null;
    const targetRoute = typeof body?.target_route === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(body.target_route)
      ? body.target_route
      : null;
    if ((mode === 'live' || mode === 'suite') && (!process.env.HUMAN_TEST_BASE_URL || !process.env.GRANDMASTER_TEST_EMAIL || !process.env.GRANDMASTER_TEST_PASSWORD || !process.env.VERCEL_TOKEN || !process.env.VERCEL_PROJECT_ID)) {
      return json(res, 409, { error: 'Dedicated live human-test identity and target URL are not configured' });
    }
    try {
      const started = await startHumanTestRun({ mode, scope, requestedBy, expectedSha, targetRoute });
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
  if (builderMatch && req.method === 'POST' && ['advance', 'run'].includes(builderMatch[2])) {
    if (!builderSupabase || !modelGatewayToken || !builderWorkerImage) {
      return json(res, 503, { error: 'Builder runtime is unavailable' });
    }
    const jobId = builderMatch[1];
    let started;
    try {
      started = await runBuilderJobBounded(jobId, body, { singleStep: builderMatch[2] === 'advance' });
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

// Owner vibe sessions: an independent chat-to-code lane (Supabase is the bus; see builder-vibe-session.js).
const vibeEnabled = Boolean(builderSupabase) && process.env.BOB_VIBE_ENABLED !== '0';
const vibePreview = vibeEnabled ? createVibePreviewManager({
  workspaceRoot: builderWorkspaceRoot,
  supabaseUrl: process.env.SUPABASE_URL,
  anonKey: process.env.BOB_VIBE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '',
  // Derived, so no new secret is needed; rotating the admin token signs every preview out.
  secret: crypto.createHmac('sha256', process.env.BOB_ADMIN_TOKEN || modelGatewayToken || 'unset').update('bob-vibe-preview-v1').digest(),
  maxConcurrent: Math.max(1, Number(process.env.BOB_VIBE_MAX_PREVIEWS || 2)),
  onStatus: async (sessionId, patch) => { await builderSupabase.from('builder_vibe_sessions').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', sessionId); },
}) : null;
const vibeWorker = vibeEnabled ? createVibeWorker({
  supabase: builderSupabase,
  deps: {
    firewall: {
      status: () => firewall.status(),
      change: async ({ op, rule, purpose }) => {
        const result = await firewall.change({ op, rule });
        record('bob-vibe', 'firewall.change', result.rule ? `${op}:${result.rule.chain}` : null, { op, rule: result.rule, changed: result.changed, purpose: purpose ?? null, rule_count: result.rules.length });
        return result;
      },
    },
    workspaceRoot: builderWorkspaceRoot,
    gateway: builderGateway,
    sourceDirFor: sha => builderGitSource(sha),
    resolveHead: () => builderRepositoryHead('main').sha,
    prepareWorkspace: workspacePath => vibePreview.ensureWebDependencies(workspacePath),
    publish: ({ workspacePath, branch, head }) => {
      const target = builderGitTarget();
      return publishWorkspaceBranch({ workspacePath, branchName: branch, expectedHeadSha: head, pushUrl: target.repoUrl, pushAuthHeader: target.authHeader, sshCommand: target.sshCommand, requireVerifiedIdentity: true });
    },
    openPullRequest: ({ workspacePath, branch, head, title, body }) => createGitHubPullRequest({ workspacePath, branchName: branch, expectedHeadSha: head, title: `Bob vibe: ${title}`, body, githubToken, owner: githubOwner, repo: githubRepo, draft: false }),
  },
}) : null;
const redeemVibeTicket = async (sessionId, ticket) => {
  const { data, error } = await builderSupabase.rpc('builder_vibe_redeem_preview_ticket', { p_session_id: sessionId, p_ticket: ticket });
  if (error) throw new Error(error.message);
  if (data) record(String(data), 'vibe.preview.opened', sessionId, {});
  return data || null;
};

const server = http.createServer(async (req, res) => {
  if (vibePreview && req.url.startsWith('/vibe/')) {
    try { if (await vibePreview.handleHttp(req, res, { redeemTicket: redeemVibeTicket })) return; } catch { if (!res.headersSent) return json(res, 502, { error: 'preview unavailable' }); return; }
  }
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
server.on('upgrade', (req, socket, head) => {
  if (!vibePreview || !vibePreview.handleUpgrade(req, socket, head)) socket.destroy();
});
server.listen(port, '0.0.0.0', () => console.log(`bob-control-plane listening on ${port}`));
if (vibeWorker) {
  vibeWorker.start();
  const vibePreviewTimer = setInterval(() => {
    vibePreview.reconcile(builderSupabase, sessionId => vibeWorkspacePath(builderWorkspaceRoot, sessionId)).catch(() => {});
  }, 5000);
  vibePreviewTimer.unref?.();
}
if (autopilotEnabled && builderSupabase) {
  startInterruptedModelRecovery().catch(() => {});
  // This process is the only verifier runner: anything still 'running' at startup was orphaned by
  // the restart and would otherwise hold its job until the lease ran out (job 72edc782: 33 minutes).
  recoverExpiredWorkerRuns(builderSupabase, console, { includeActive: true, reason: 'control plane restarted before the verifier reported' })
    .then((count) => { if (count) record('autopilot', 'builder.autopilot.recovered_on_restart', 'startup', { runs: count }); })
    .catch(() => {});
  const autopilotTimer = setInterval(() => { autopilotOnce().catch(() => {}); }, autopilotIntervalMs);
  autopilotTimer.unref?.();
  setTimeout(() => { autopilotOnce().catch(() => {}); }, 5_000).unref?.();
}