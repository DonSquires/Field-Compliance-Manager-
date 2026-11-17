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
const { collectRepositoryContext, normalizeHealthPath, isHealthTestPath } = require('./supabase/functions/_shared/builder-repository-context');
const { collectBuilderLiveContext } = require('./builder-live-context');
const { buildAtlasGraph } = require('./scripts/atlas-graph');
const { createModelGatewayConfig, defaultReviewerModel, invokeBuilderModel, modelHealth } = require('./builder-model-gateway');
const { buildDocumentReviewItems, processDocumentReviewItems, verifyDocumentSourceBytes } = require('./builder-document-review');
const { loadBuilderRuntimeSnapshot, advanceBuilderJob, runBuilderUntilPause, recoverExpiredWorkerRuns } = require('./builder-runtime-coordinator');
const { fileSha256, listRepositoryTree, readRepositoryFile, searchRepository } = require('./builder-repository-read');
const { autopilotTick, listAutopilotJobs, listPendingApprovals } = require('./builder-autopilot');
const { finaliseOrphanedModelRuns } = require('./builder-model-run-reaper');
const { planRoutineIntake, routinePacketAutomationStatus, routineRepairBrief, routineRepairStillDriven, routineSignature } = require('./builder-routine-intake');
const { laptopStatus, runLaptopCommand, laptopConfig, loadLaptopLink, mergeLaptopLink, describeLink } = require('./bob-laptop-shell');
const { createVibeWorker, vibeWorkspacePath, assertLocalVisionUrl } = require('./builder-vibe-session');
const { createKnowledgeTool } = require('./builder-knowledge');
const { embedText, embeddingConfig } = require('./services/fcm-api/src/bob/knowledgeEmbedding');
const { createModelRouter, setDefaultModelRouter } = require('./services/fcm-api/src/bob/modelRouter');
const { createBuilderChatWorker } = require('./builder-chat-session');
const { routeChangeRequests, implementChangeRequest, parkChangeRequest } = require('./builder-change-request-intake');
const { createPlatformTools } = require('./bob-platform-diagnostics');
const { runBrowserSpecs, runVibeHumanTest } = require('./builder-vibe-human-test');
const { createFirewall } = require('./bob-firewall');
const { createTailscale } = require('./bob-tailscale');
const { createVibePreviewManager } = require('./builder-vibe-preview');
const { createBranchWorkspace, createDetachedWorkspace, retireTerminalWorkspace, commitVerifiedPatch, publishWorkspaceBranch, createGiteaPullRequest, workspacePathForBranch, createGitHubPullRequest, mergeGitHubPullRequest, closeGitHubPullRequest, readGitHubPullRequestState, ensureSourceCheckout, githubAuthHeader, githubRepoUrl, githubSshRepoUrl, resolveRemoteHead, redactGitError } = require('./builder-branch-workspace');
const { executeWorker, summarizeHumanTest, humanTestDeploymentPreflight } = require('./worker-executor');
const { createMainHealthMonitor, verifyToolingSandbox } = require('./bob-main-health');
const { createProductionHumanTestMonitor, evictableProductionStates, liveDeploymentPreflight, resolveVercelProductionDeployment, worstPreflight } = require('./builder-production-human-test');
const { collectLiveHttpFindings, fileDrBobFindings, openDrBobPacketFinder } = require('./builder-dr-bob-triage');
const { TERMINAL_STATUSES: BUILDER_TERMINAL_STATUSES, jobHygieneDecision, historicalHealthResolution } = require('./builder-job-hygiene');

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
const platformTools = createPlatformTools({
  sourceRoot: assessmentRoot,
  audit: result => record('bob-platform-diagnostics', 'platform.inspect', null, result),
});
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
// Data-driven auto routing for Builder, Vibe and Builder chat (bob_model_catalog / _routing_policies).
setDefaultModelRouter(builderSupabase && !/^static$/i.test(String(process.env.BOB_MODEL_ROUTING || '')) ? createModelRouter({ supabase: builderSupabase }) : null);
const retrieveBuilderKnowledge = createKnowledgeTool({
  supabase: builderSupabase,
  embed: async text => {
    const ollamaUrl = await assertLocalVisionUrl(modelGatewayConfig.ollama.baseUrl);
    return embedText(text, {
      config: { ...embeddingConfig(), ollamaUrl, timeoutMs: 15_000 },
      fetchImpl: (url, options) => fetch(url, { ...options, redirect: 'error' }),
    });
  },
});
const builderGateway = {
  gatewayUrl: process.env.BOB_MODEL_GATEWAY_URL || `http://127.0.0.1:${port}`,
  apiToken: modelGatewayToken
};
const builderWorkerImage = process.env.BOB_WORKER_IMAGE || '';
const firewall = createFirewall({ stateDir, image: builderWorkerImage });
const tailscale = createTailscale({ stateDir });
// Host network control handed to Bob's autonomous lanes (Vibe Builder, self-heal, autopilot):
// owner ruling 2026-10-21. Every change is audited under the acting lane.
function hostNetworkFor(actor) {
  return {
    status: () => firewall.status(),
    change: async ({ op, rule, purpose, job_id: jobId }) => {
      record(actor, 'firewall.change.requested', jobId ?? null, { op, rule, purpose: purpose ?? null });
      try {
        const result = await firewall.change({ op, rule });
        record(actor, 'firewall.change', result.rule ? `${op}:${result.rule.chain}` : null, { op, rule: result.rule, changed: result.changed, purpose: purpose ?? null, job_id: jobId ?? null, rule_count: result.rules.length });
        return result;
      } catch (error) {
        record(actor, 'firewall.change.refused', jobId ?? null, { op, purpose: purpose ?? null, error: error.message });
        throw error;
      }
    },
    tailnet: tailscale.configured ? {
      status: () => tailscale.status(),
      acl: async ({ op, policy, ifMatch, purpose, job_id: jobId }) => {
        if (op === 'set') record(actor, 'tailnet.acl.requested', tailscale.tailnet, { purpose: purpose ?? null, job_id: jobId ?? null });
        try {
          const result = await tailscale.acl({ op, policy, ifMatch });
          if (op === 'set') record(actor, 'tailnet.acl.set', tailscale.tailnet, { purpose: purpose ?? null, job_id: jobId ?? null, etag: result.etag ?? null, backup: result.previous_policy_backup ?? null, bytes: Buffer.byteLength(String(policy ?? '')) });
          return result;
        } catch (error) {
          if (op === 'set') record(actor, 'tailnet.acl.refused', tailscale.tailnet, { purpose: purpose ?? null, job_id: jobId ?? null, error: error.message });
          throw error;
        }
      },
    } : null,
  };
}
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
const productionHumanTests = new Map();
let activeLease = null;

function saveState() {
  fs.mkdirSync(stateDir, { recursive: true });
  const state = {
    jobs: [...jobs.values()],
    deliveries: [...deliveries],
    audit,
    humanTestRuns: [...humanTestRuns.values()],
    mainHealthRuns: [...mainHealthRuns.values()],
    productionHumanTests: [...productionHumanTests.values()]
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
    for (const persisted of state.productionHumanTests || []) {
      if (persisted && /^[a-f0-9]{40}$/i.test(String(persisted.sha || ''))) productionHumanTests.set(persisted.sha, persisted);
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

// A loopback override exists only for hermetic tests; any other value keeps Vercel's API host.
const vercelApiBase = /^http:\/\/127\.0\.0\.1:\d+$/.test(String(process.env.BOB_VERCEL_API_URL || ''))
  ? process.env.BOB_VERCEL_API_URL
  : 'https://api.vercel.com';

function resolveProductionDeployment() {
  return resolveVercelProductionDeployment({
    token: process.env.VERCEL_TOKEN,
    projectId: process.env.VERCEL_PROJECT_ID,
    teamId: process.env.VERCEL_TEAM_ID,
    targetUrl: process.env.HUMAN_TEST_BASE_URL,
    apiBase: vercelApiBase,
  });
}

function repositoryCommitOnMain(sourceDir, sha, mainSha) {
  if (!/^[a-f0-9]{40}$/i.test(String(sha || '')) || !/^[a-f0-9]{40}$/i.test(String(mainSha || ''))) return false;
  if (sha.toLowerCase() === mainSha.toLowerCase()) return true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, mainSha], { cwd: sourceDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function startHumanTestRun({ mode, scope, requestedBy, expectedSha = null, targetRoute = null }) {
  const active = [...humanTestRuns.values()].find(run => run.status === 'queued' || run.status === 'running');
  if (active) return { existing: true, run: safeHumanTestRun(active) };
  if (!builderWorkerImage) throw new BuilderStepError(503, 'Human-test worker image is unavailable');
  const readTarget = repositoryReadTarget();
  // Test the code that is deployed: the requested deployment commit itself, or main's head.
  const testSha = expectedSha || readTarget.sha;
  if (!repositoryTreeSha(readTarget.sourceDir, testSha, 'apps/web')) {
    throw new BuilderStepError(409, `Human-test deployment commit ${testSha.slice(0, 12)} is not yet in Bob's source repository`);
  }
  // The live phase hands the worker the dedicated test identity: only reviewed code merged
  // to main may hold them, never an arbitrary branch commit named by a caller.
  if (mode !== 'fixture' && !repositoryCommitOnMain(readTarget.sourceDir, testSha, readTarget.sha)) {
    throw new BuilderStepError(409, `Live Dr Bob only tests commits merged to main; ${testSha.slice(0, 12)} is not on main ${String(readTarget.sha).slice(0, 12)} yet`);
  }
  // A private detached snapshot: the shared checkout is force-checked-out and cleaned by main
  // health and chat reads, which must never change files under a running browser walk.
  const snapshot = createDetachedWorkspace({
    sourceDir: readTarget.sourceDir,
    workspaceRoot: path.join(builderWorkspaceRoot, 'human-tests'),
    targetSha: testSha,
    retentionCount: 4,
  });
  const source = { sha: testSha, sourceDir: snapshot.workspacePath };
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
        const liveSha = expectedSha || source.sha;
        const before = phaseMode === 'live' ? liveDeploymentPreflight(await resolveProductionDeployment(), liveSha) : null;
        if (before && before.result !== 'matched') {
          run.phases.push({
            mode: phaseMode,
            status: 'failed',
            exit_code: null,
            summary: { passed: 0, failed: 0, skipped: 0 },
            deployment_preflight: before.result,
            error: before.error,
          });
          phaseLogs.push(`===== ${phaseMode.toUpperCase()} =====\n[CONTROL-PLANE DEPLOYMENT PREFLIGHT] result=${before.result}\n`);
          saveState();
          break;
        }
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
                HUMAN_TEST_EXPECTED_SHA: liveSha,
                HUMAN_TEST_REQUIRE_DEPLOYMENT_MATCH: 'true',
                HUMAN_TEST_DEPLOYMENT_VERIFIED_SHA: before.sha,
                HUMAN_TEST_ADMIN_ROUTE: targetRoute,
                GRANDMASTER_TEST_EMAIL: process.env.GRANDMASTER_TEST_EMAIL,
                GRANDMASTER_TEST_PASSWORD: process.env.GRANDMASTER_TEST_PASSWORD,
              }
            : { HUMAN_TEST_LIVE: 'false', E2E_OFFLINE: '1' }
        });
        const phase = {
          mode: phaseMode,
          status: result.status,
          exit_code: result.exitCode,
          summary: summarizeHumanTest(result),
        };
        if (phaseMode === 'live') {
          // Production may move during the walk; only an unchanged deployment makes the walk evidence for this SHA.
          const after = liveDeploymentPreflight(await resolveProductionDeployment(), liveSha);
          phase.deployment_preflight = worstPreflight(before.result, after.result, humanTestDeploymentPreflight(result));
          if (phase.deployment_preflight !== 'matched') {
            phase.status = 'failed';
            phase.error = after.error || 'Live deployment preflight was not confirmed';
          }
        }
        run.phases.push(phase);
        phaseLogs.push(`===== ${phaseMode.toUpperCase()} =====\n${result.stdout || ''}\n${result.stderr || ''}`);
        saveState();
        if (phase.status !== 'succeeded') break;
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
  record(requestedBy || 'bob', 'human_test.started', id, { mode, scope, source_sha: source.sha, ...(snapshot.unverifiedSnapshots?.length ? { unverified_snapshots: snapshot.unverifiedSnapshots } : {}) });
  return { existing: false, run: safeHumanTestRun(run) };
}

function liveHumanTestConfigured() {
  return Boolean(process.env.HUMAN_TEST_BASE_URL && process.env.GRANDMASTER_TEST_EMAIL && process.env.GRANDMASTER_TEST_PASSWORD && process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID);
}

function activeHumanTestCount() {
  return [...humanTestRuns.values()].filter(run => run.status === 'queued' || run.status === 'running').length;
}

function latestHumanTestRun() {
  return [...humanTestRuns.values()].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0] ?? null;
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
    // Frontend authors type-check and run Vitest in their own worktree from the shared lockfile cache.
    prepareWorkspace: (workspacePath) => vibePreview
      ? vibePreview.ensureWebDependencies(workspacePath)
      : Promise.reject(new Error('the apps/web dependency cache is disabled on this control plane (BOB_VIBE_ENABLED=0)')),
    // Frontend authors run the Playwright specs their change targets before handoff (builder-browser-gate).
    browserTest: builderBrowserTest,
    workerImage: builderWorkerImage,
    firewall: hostNetworkFor('bob-builder'),
    runnerId: builderRunnerId,
    reviewerModelName: typeof body.reviewerModelName === 'string' && body.reviewerModelName.trim() ? body.reviewerModelName.slice(0, 200) : defaultReviewerModel(process.env, providers.openai?.installed ?? null),
    frontendFiles: boundedStringArray(body.frontendFiles, 30),
    backendFiles: boundedStringArray(body.backendFiles, 40),
    constraints: boundedStringArray(body.constraints, 100),
    requestedFromUsers: boundedStringArray(body.requestedFromUsers, 100),
    startAfterProvider: typeof body.startAfterProvider === 'string' && /^[a-z0-9_-]{1,60}$/i.test(body.startAfterProvider) ? body.startAfterProvider : null,
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
// The frontend author's browser gate (BOB_BUILDER_BROWSER_TEST=0 disables it) can extend the author's
// wall once (15 min) and then run a patched and a base browser pass, each bounded by the worker timeout.
const builderBrowserTest = process.env.BOB_BUILDER_BROWSER_TEST === '0' || !builderWorkerImage ? null : runBrowserSpecs;
const builderBrowserAllowanceMs = builderBrowserTest
  ? 15 * 60_000 + 2 * Math.max(5 * 60_000, Number(process.env.BOB_BUILDER_BROWSER_TEST_TIMEOUT_MS) || 15 * 60_000)
  : 0;
// A legitimate agentic run can outlive the old 45-minute lease. Clearing it while its model turn
// is still active launches a second engineer against the same job and worktree.
const staleBuilderRunMs = Math.max(
  5 * 60_000,
  Number(process.env.BOB_BUILDER_STALE_RUN_MS) || 45 * 60_000,
  agenticWallBudgetMs + agenticTurnTimeoutMs + builderBrowserAllowanceMs + 5 * 60_000
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
// Owner ruling 2026-11-13: unprotected page change requests go to Bob Builder chat automatically.
const changeRequestAutobuildEnabled = process.env.BOB_CHANGE_REQUEST_AUTOBUILD !== 'false';
const autopilotIntervalMs = Math.max(15_000, Number(process.env.BOB_BUILDER_AUTOPILOT_INTERVAL_MS) || 60_000);
let autopilotBusy = false;
const documentReviewEnabled = process.env.BOB_DOCUMENT_REVIEW_AUTOMATION !== 'false';
const documentReviewIntervalMs = Math.max(30_000, Number(process.env.BOB_DOCUMENT_REVIEW_INTERVAL_MS) || 120_000);
let documentReviewBusy = false;
let documentReviewOffset = 0;
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
  const failingFiles = failure.failing_tests.map(normalizeHealthPath);
  return [
    `Goal: make main green again by fixing the real cause of the failing root or web checks reported by Bob's isolated main-health run at ${sha}. Self-heal repairs the app, not just its tests.`,
    `Before: the repository is pinned to ${sha}; the main-health worker ran root node:test, lint, web build, full Vitest unit/source-guard, and CI Playwright smoke steps against a read-only checkout. Each step has an independent START/PASS/FAIL receipt.`,
    `During: the main-health worker exited ${failure.exit_code}; failing tests: ${failingFiles.join(', ')}.`,
    `Failure evidence (redacted and bounded):\n${failure.summary || 'See the bounded worker output below.'}\n${failure.stdout}\n${failure.stderr}`.slice(0, 9000),
    'Required diagnosis: first reproduce each failure at the pinned commit. Run test/*.test.js with node --test --test-reporter=tap <test paths>; run src/**/*.test.ts(x) with npm run test --prefix apps/web -- <test paths>; run e2e/*.spec.ts with npm run test:e2e --prefix apps/web -- <spec paths> --project=desktop-chromium --workers=1. Do not ignore snapshots. Then read each failing test and its application source/schema. If the application regressed, fix the application source. Change a test or screenshot baseline only when source/schema evidence and, for visual changes, Dr Bob human-test evidence prove the intended behaviour changed; never delete, skip, or weaken coverage. The validated specification must name the actual frontend and/or backend source files needed; unused lanes are skipped from that evidence, not given invented edits.',
    'Required verification: rerun the failing tests and the isolated main-health checks, independent code review, security review, and Atlas refresh. Preserve the exact tested main SHA and failing-test file set.',
    'Scope: the smallest root-cause repair across frontend and backend, with focused regression tests. Backend application code and new additive migrations may be drafted and independently verified. Unattended release remains limited to at most eight non-protected apps/web/src files; backend, browser-test, migration, legal, safety, identity, enforcement, finance, payroll, and evidential changes pause for Grandmaster approval before release. Auth/identity, dependencies, environment, CI/deploy and hand-editing the schema snapshot remain refused. No unrelated features or redesigns.',
    'After: open a pull request with the test receipts; release follows the normal independent gates.',
  ].join('\n');
}

async function openMainHealthRepair({ sha, failure }) {
  const failingFiles = [...new Set(failure.failing_tests.map(normalizeHealthPath))];
  if (!failingFiles.length || failingFiles.length > 8 || failingFiles.some(file => !isHealthTestPath(file))) {
    throw new Error(`main-health failure has no supported test scope; parsed=${failingFiles.join(',').slice(0, 240) || 'none'}`);
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
    const snapshot = createDetachedWorkspace({
      sourceDir: mutableSource,
      workspaceRoot: path.join(builderWorkspaceRoot, 'main-health'),
      targetSha: sha,
    });
    if (snapshot.unverifiedSnapshots?.length) record('autopilot', 'builder.main_health.snapshot_retained', sha, { unverified: snapshot.unverifiedSnapshots });
    const source = snapshot.workspacePath;
    const artifactDir = path.join(stateDir, 'main-health-runs', sha);
    fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    const result = await executeWorker({
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
    return { ...result, toolingSourceDir: mutableSource };
  },
  verifyTooling: ({ sha, sourceDir }) => verifyToolingSandbox({ workspaceRoot: path.join(stateDir, 'main-health-tooling'), sourceDir, expectedSha: sha }),
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

// Bob verifies every settled production deployment himself with Dr Bob (owner ruling 2026-10-27):
// fixture walk then live walk as the dedicated test identity, no person requests or approves it.
const productionHumanTestEnabled = process.env.BOB_PRODUCTION_HUMAN_TEST !== 'false'
  && Boolean(builderWorkerImage && builderSourceConfigured)
  && liveHumanTestConfigured();
const productionHumanTestIntervalMs = Math.max(60_000, Number(process.env.BOB_PRODUCTION_HUMAN_TEST_INTERVAL_MS) || 5 * 60_000);
const productionHumanTestStartupDelayMs = Math.min(600_000, Math.max(1_000, Number(process.env.BOB_PRODUCTION_HUMAN_TEST_STARTUP_DELAY_MS) || 120_000));
const releasedShaFile = process.env.BOB_RELEASE_DEPLOYED_SHA_FILE || path.join(stateDir, 'release-lane', 'deployed_sha');
// One authenticated production page observed read-only, so the live route check never silently skips.
const productionHumanTestRoute = /^\/[A-Za-z0-9/_-]*$/.test(String(process.env.BOB_PRODUCTION_HUMAN_TEST_ROUTE || ''))
  ? process.env.BOB_PRODUCTION_HUMAN_TEST_ROUTE
  : '/admin/builder';

function saveProductionHumanTestState(state) {
  productionHumanTests.set(state.sha, state);
  for (const stale of evictableProductionStates(productionHumanTests.values())) productionHumanTests.delete(stale.sha);
  saveState();
}

function latestProductionHumanTest() {
  return [...productionHumanTests.values()]
    .sort((left, right) => String(right.first_seen_at).localeCompare(String(left.first_seen_at)))[0] ?? null;
}

// A genuine live failure files its distinct HTTP findings into governed triage as the dedicated test
// identity (docs/HUMAN_TESTING.md). Routine packets enter Builder intake; the rest wait for the Grandmaster.
const drBobTriageEnabled = process.env.BOB_DR_BOB_TRIAGE !== 'false';

async function fileProductionHumanTestFindings({ sha, run_id: runId }) {
  if (!drBobTriageEnabled) return { status: 'disabled', filed: [], skipped: [], errors: [] };
  if (!builderSupabase) return { status: 'unconfigured', filed: [], skipped: [], errors: [{ error: 'Supabase service access is not configured' }] };
  if (!/^[0-9a-f-]{36}$/i.test(String(runId || ''))) return { status: 'failed', filed: [], skipped: [], errors: [{ error: 'Dr Bob run id is missing' }] };
  const collected = collectLiveHttpFindings({ resultsDir: path.join(stateDir, 'human-test-runs', runId, 'live', 'test-results') });
  const outcome = await fileDrBobFindings({
    findings: collected.findings,
    sha,
    supabaseUrl: process.env.SUPABASE_URL,
    anonKey: process.env.BOB_VIBE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
    email: process.env.GRANDMASTER_TEST_EMAIL,
    password: process.env.GRANDMASTER_TEST_PASSWORD,
    findOpenPacket: openDrBobPacketFinder(builderSupabase),
  });
  return { ...outcome, unique: collected.unique, truncated: collected.truncated };
}

const productionHumanTestMonitor = createProductionHumanTestMonitor({
  resolveProduction: resolveProductionDeployment,
  readReleasedSha: async () => {
    try { return fs.readFileSync(releasedShaFile, 'utf8').trim().toLowerCase() || null; } catch { return null; }
  },
  readState: async (sha) => productionHumanTests.get(sha) ?? null,
  writeState: async (state) => saveProductionHumanTestState(state),
  listStates: async () => [...productionHumanTests.values()],
  startRun: ({ sha }) => startHumanTestRun({ mode: 'suite', scope: 'full', requestedBy: 'bob:production-verify', expectedSha: sha, targetRoute: productionHumanTestRoute }),
  getRun: async (id) => humanTestRuns.get(id) ?? null,
  isIdle: async () => {
    if (activeHumanTestCount()) return { idle: false, reason: 'a Dr Bob run is already in flight' };
    if (runningBuilderJobs.size) return { idle: false, reason: 'a Builder job is executing' };
    if (mainHealthInFlight) return { idle: false, reason: 'main health is verifying' };
    return { idle: true };
  },
  log: (entry) => record('bob:production-verify', 'human_test.production_verify', entry.sha || 'production', entry),
  onFailedVerdict: fileProductionHumanTestFindings,
});

function productionHumanTestStatus() {
  const latest = latestProductionHumanTest();
  return {
    enabled: productionHumanTestEnabled,
    route: productionHumanTestRoute,
    latest: latest ? {
      sha: latest.sha,
      status: latest.status,
      run_id: latest.run_id ?? null,
      attempts: latest.attempts ?? 0,
      summary: latest.summary ?? null,
      release_lane_behind: latest.release_lane_behind ?? null,
      completed_at: latest.completed_at ?? null,
      error: latest.error ?? latest.waiting_reason ?? null,
      triage_intake: latest.triage_intake ? {
        status: latest.triage_intake.status,
        attempts: latest.triage_intake.attempts ?? 0,
        findings: latest.triage_intake.findings ?? null,
        truncated: latest.triage_intake.truncated === true,
        packets: (latest.triage_intake.filed || []).map((packet) => ({
          packet_id: packet.packet_id,
          status: packet.status,
          endpoint: packet.endpoint,
          page: packet.page,
          repair_risk: packet.repair_risk,
          automation_status: packet.automation_status,
        })),
        already_open: (latest.triage_intake.skipped || []).map((entry) => entry.packet_id).filter(Boolean),
        errors: (latest.triage_intake.errors || []).length + (latest.triage_intake.error ? 1 : 0),
      } : null,
    } : null,
    observation: productionHumanTestMonitor.lastObservation(),
  };
}

// Open routine repairs keyed by failure signature: a newly claimed packet with the same signature is covered
// by that job instead of opening a second repair for another page. Only jobs the autopilot still drives count.
async function openRoutineRepairSignatures() {
  const { data: jobs, error } = await builderSupabase
    .from('builder_jobs')
    .select('id,source_friction_packet_id,autopilot_state,autopilot_report')
    .eq('autopilot_source', 'routine_monitor')
    .not('status', 'in', '("deployed","failed","cancelled")')
    .not('source_friction_packet_id', 'is', null)
    .limit(50);
  if (error) throw new Error(`open routine repairs could not be read: ${error.message}`);
  const driven = (Array.isArray(jobs) ? jobs : []).filter(routineRepairStillDriven);
  if (!driven.length) return [];
  const { data: sources, error: sourceError } = await builderSupabase
    .from('bob_friction_packets')
    .select('id,envelope,automation_status')
    .in('id', driven.map((job) => job.source_friction_packet_id));
  if (sourceError) throw new Error(`open routine repair packets could not be read: ${sourceError.message}`);
  const byPacket = new Map((sources || []).map((packet) => [packet.id, packet]));
  return driven
    .filter((job) => byPacket.has(job.source_friction_packet_id))
    .map((job) => {
      const source = byPacket.get(job.source_friction_packet_id);
      return { jobId: job.id, signature: routineSignature(source), automationStatus: source.automation_status ?? null };
    });
}

async function coverRoutinePacket(packet, jobId, signature, automationStatus = 'builder_started') {
  const { error } = await builderSupabase.from('bob_friction_packets').update({
    automation_status: automationStatus,
    covered_by_job_id: jobId,
    automation_error_redacted: null,
    automation_updated_at: new Date().toISOString(),
  }).eq('id', packet.id).eq('automation_status', 'claimed');
  if (error) throw new Error(`routine packet could not be attached to its open repair: ${error.message}`);
  record('autopilot', 'builder.routine_repair.covered', jobId, { packet_id: packet.id, signature: String(signature).slice(0, 200), automation_status: automationStatus });
}

async function requeueRoutinePacket(packet, detail) {
  await builderSupabase.from('bob_friction_packets').update({
    automation_status: packet.automation_attempt_count >= 5 ? 'failed' : 'queued',
    automation_error_redacted: detail,
    automation_updated_at: new Date().toISOString(),
  }).eq('id', packet.id).eq('automation_status', 'claimed');
}

// The release lane writes deployed_sha only after a verified production release; its mtime is when that
// release went live. Null when no release has been recorded (or the file is unreadable).
function releasedMarker() {
  try {
    const sha = fs.readFileSync(releasedShaFile, 'utf8').trim().toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(sha)) return null;
    return { sha, releasedAt: fs.statSync(releasedShaFile).mtime.toISOString() };
  } catch {
    return null;
  }
}

// A routine repair that failed under code since replaced by a verified release gets one more bounded
// attempt (at most three in total; the RPC enforces the window, the cap, and one retry per release).
async function requeueFailedRoutineRepairs() {
  const released = releasedMarker();
  if (!released) return [];
  const { data, error } = await builderSupabase.rpc('builder_requeue_failed_routine_repairs', {
    _release_sha: released.sha,
    _released_at: released.releasedAt,
    _limit: 3,
  });
  if (error) throw new Error(`failed routine repairs could not be re-queued: ${error.message}`);
  const requeued = Array.isArray(data) ? data : [];
  for (const packet of requeued) {
    record('autopilot', 'builder.routine_repair.retry_after_release', packet.id, {
      release_sha: released.sha,
      attempt: Number(packet.automation_attempt_count) + 1,
      page: String(packet.envelope?.before?.page || 'unknown').slice(0, 120),
    });
  }
  return requeued;
}

// Why earlier attempts on these packets stopped, so the retry starts from that reason instead of repeating it.
async function previousRoutineAttempts(packetIds) {
  const { data, error } = await builderSupabase
    .from('builder_jobs')
    .select('id,status,last_error')
    .in('source_friction_packet_id', packetIds)
    .in('status', ['failed', 'cancelled'])
    .order('updated_at', { ascending: false })
    .limit(5);
  if (error) throw new Error(`previous routine attempts could not be read: ${error.message}`);
  return (Array.isArray(data) ? data : []).map((job) => ({ jobId: job.id, error: job.last_error || `ended as ${job.status}` }));
}

async function startChangeRequestIntake() {
  if (!changeRequestAutobuildEnabled || !builderChatWorker) return [];
  try {
    return await routeChangeRequests({ supabase: builderSupabase, project: await routineBuilderProject(), record: (event, id, data) => record('autopilot', event, id, data) });
  } catch (error) {
    record('autopilot', 'builder.change_request.intake_unavailable', null, { error: String(error instanceof Error ? error.message : error).slice(0, 300) });
    return [];
  }
}

async function startRoutineRepairs() {
  if (!routineRepairEnabled) return [];
  try {
    await requeueFailedRoutineRepairs();
  } catch (error) {
    record('autopilot', 'builder.routine_repair.retry_unavailable', null, { error: String(error instanceof Error ? error.message : error).slice(0, 300) });
  }
  const project = await routineBuilderProject();
  const { sha } = builderRepositoryHead('main');
  const { data: packets, error: claimError } = await builderSupabase.rpc('builder_claim_routine_repairs', { _limit: 3 });
  if (claimError) throw new Error(`routine repair queue could not be claimed: ${claimError.message}`);
  if (!Array.isArray(packets) || !packets.length) return [];
  const outcomes = [];
  let openRepairs = [];
  try {
    openRepairs = await openRoutineRepairSignatures();
  } catch (error) {
    record('autopilot', 'builder.routine_repair.dedupe_unavailable', null, { error: String(error instanceof Error ? error.message : error).slice(0, 300) });
  }
  const { repairs, covered } = planRoutineIntake(packets, openRepairs);
  for (const { packet, jobId, signature, automationStatus } of covered) {
    try {
      await coverRoutinePacket(packet, jobId, signature, automationStatus);
      outcomes.push({ packet: packet.id, job: jobId, outcome: 'covered' });
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 300);
      await requeueRoutinePacket(packet, detail);
      outcomes.push({ packet: packet.id, outcome: 'failed', error: detail });
    }
  }
  for (const { packet, signature, followers } of repairs) {
    let createdJobId = null;
    let boundSuccessfully = false;
    try {
      const page = String(packet.envelope?.before?.page || 'application error').replace(/\s+/g, ' ').slice(0, 120);
      let previousAttempts = [];
      try {
        previousAttempts = await previousRoutineAttempts([packet.id, ...followers.map((follower) => follower.id)]);
      } catch (error) {
        record('autopilot', 'builder.routine_repair.history_unavailable', packet.id, { error: String(error instanceof Error ? error.message : error).slice(0, 300) });
      }
      const { data: created, error } = await builderSupabase.rpc('builder_create_job_v2', {
        _organization_id: project.organization_id,
        _project_id: project.id,
        _title: `Routine repair: ${page}`.slice(0, 200),
        _task_description: routineRepairBrief(packet, { alsoReported: followers, previousAttempts }).slice(0, 12000),
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
      record('autopilot', 'builder.routine_repair.started', boundJob.id, { packet_id: packet.id, page, covers: followers.length });
      outcomes.push({ packet: packet.id, job: boundJob.id, outcome: 'started' });
      for (const follower of followers) {
        try {
          await coverRoutinePacket(follower, boundJob.id, signature);
          outcomes.push({ packet: follower.id, job: boundJob.id, outcome: 'covered' });
        } catch (error) {
          const detail = String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 300);
          await requeueRoutinePacket(follower, detail);
          outcomes.push({ packet: follower.id, outcome: 'failed', error: detail });
        }
      }
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 300);
      if (createdJobId && !boundSuccessfully) {
        await builderSupabase.from('builder_jobs').update({
          status: 'cancelled',
          last_error: 'Routine repair intake failed before policy binding.',
          updated_at: new Date().toISOString(),
        }).eq('id', createdJobId).is('source_friction_packet_id', null);
      }
      for (const queued of boundSuccessfully ? [] : [packet, ...followers]) await requeueRoutinePacket(queued, detail);
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
  const jobIds = (jobs || []).map((job) => job.id);
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
  for (const job of jobs || []) {
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
  if (currentMainHealthPassed) {
    const project = await routineBuilderProject();
    const { data: historical, error: historicalError } = await builderSupabase.from('builder_jobs')
      .select('id,status,autopilot_state,autopilot_source,source_main_health_sha,source_main_health_files,workspace_branch,workspace_pull_request_url')
      .eq('organization_id', project.organization_id).eq('project_id', project.id)
      .eq('autopilot_source', 'main_monitor').in('status', ['failed', 'cancelled'])
      .or('autopilot_state.is.null,autopilot_state.neq.done')
      .is('workspace_branch', null).is('workspace_pull_request_url', null)
      .order('updated_at', { ascending: true }).limit(100);
    if (historicalError) throw new Error(`historical health repairs could not be listed: ${historicalError.message}`);
    const verification = { ...mainHealthState(currentMainSha), profile: 'main-health' };
    const verifiedFiles = new Set();
    for (const job of historical || []) {
      for (const file of job.source_main_health_files || []) {
        if (!isHealthTestPath(file) || verifiedFiles.has(file)) continue;
        // Read from the tested commit, not a mutable worktree or a filename in an old error.
        try {
          readRepositoryFile({ sourceDir: builderSourceDir, sha: currentMainSha, path: file });
          verifiedFiles.add(file);
        } catch (error) {
          if (error.code !== 'NOT_FOUND') throw error;
          record('autopilot', 'builder.housekeeping.historical_unproven', job.id, { current_main_sha: currentMainSha, missing_test: file });
        }
      }
      const decision = historicalHealthResolution(job, {
        currentMainSha, currentMainHealthPassed, verifiedFiles: [...verifiedFiles],
      });
      if (!decision) continue;
      if (builderRepositoryHead('main').sha !== currentMainSha) break;
      const { data: resolved, error: resolveError } = await builderSupabase.rpc('builder_resolve_historical_health_job', {
        _job_id: job.id, _organization_id: project.organization_id, _project_id: project.id,
        _main_sha: currentMainSha, _source_sha: job.source_main_health_sha,
        _verified_files: job.source_main_health_files, _verification: verification,
      });
      if (resolveError) throw new Error(`historical health repair ${job.id} could not be resolved: ${resolveError.message}`);
      if (resolved?.autopilot_state === 'done') {
        retired += 1;
        record('autopilot', 'builder.housekeeping.historical_resolved', job.id, { current_main_sha: currentMainSha, historical_status: resolved.status });
      }
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

async function documentReviewOnce() {
  if (documentReviewBusy || !builderSupabase || !modelGatewayToken) return [];
  documentReviewBusy = true;
  try {
    const [documentsResult, proposalsResult, receiptsResult, health] = await Promise.all([
      builderSupabase.from('documents')
        .select('id,organization_id,original_filename,current_scope,sha256,storage_bucket,storage_object_ref,document_versions(id,extracted_text,ocr_required,created_at,updated_at,metadata_json,document_classifications(privacy_class,contains_pii,contains_operational_security,contains_financial_data,contains_legal_privilege,classifier_source,created_at))')
        .not('organization_id', 'is', null)
        .in('current_scope', ['conversation_only', 'tenant', 'quarantined'])
        .order('id', { ascending: true }).range(documentReviewOffset, documentReviewOffset + 99),
      builderSupabase.from('document_promotion_proposals')
        .select('id,organization_id,target_type,status,proposed_payload,source_map,created_at,document_version:document_versions(id,extracted_text,ocr_required,updated_at,documents(id,organization_id,original_filename,sha256,storage_bucket,storage_object_ref))')
        .not('organization_id', 'is', null).eq('status', 'proposed')
        .order('created_at', { ascending: true }).limit(100),
      builderSupabase.from('bob_document_auto_review_receipts')
        .select('id,organization_id,proposal_id,review_kind,status')
        .in('status', ['approved']).eq('review_kind', 'promotion').limit(10),
      modelHealth(modelGatewayConfig).catch(() => ({})),
    ]);
    if (documentsResult.error || proposalsResult.error || receiptsResult.error) {
      throw new Error('tenant-scoped document review queue could not be loaded');
    }

    const items = buildDocumentReviewItems({ documents: documentsResult.data || [], proposals: proposalsResult.data || [] });
    const documents = documentsResult.data || [];
    const versionIds = [...new Set(items.map(item => item.documentVersionId))];
    const terminalReceiptsResult = versionIds.length
      ? await builderSupabase.from('bob_document_auto_review_receipts')
        .select('document_version_id,proposal_id,review_kind,source_text_sha256,status')
        .in('document_version_id', versionIds).in('status', ['approved', 'rejected', 'quarantined', 'blocked', 'applied']).limit(500)
      : { data: [], error: null };
    if (terminalReceiptsResult.error) throw new Error('document review receipts could not be checked');
    const terminalKeys = new Set((terminalReceiptsResult.data || []).map(receipt =>
      `${receipt.review_kind}:${receipt.document_version_id}:${receipt.proposal_id || '-'}:${receipt.source_text_sha256}`));
    const pending = items.filter(item => {
      if (item.subjectKind === 'promotion' && (receiptsResult.data || []).some(receipt => receipt.proposal_id === item.proposalId)) return false;
      return !terminalKeys.has(`${item.subjectKind}:${item.documentVersionId}:${item.proposalId || '-'}:${item.sourceTextHash}`);
    });
    const byOrganization = new Map();
    for (const item of pending) {
      const organizationId = item.organizationId || documents.find(document => document.id === item.documentId)?.organization_id;
      if (!organizationId) continue;
      const tenantItems = byOrganization.get(organizationId) || [];
      tenantItems.push({ ...item, organizationId });
      byOrganization.set(organizationId, tenantItems);
    }

    const outcomes = [];
    for (const [organizationId, tenantItems] of byOrganization) {
      if (outcomes.length >= 10) break;
      const result = await processDocumentReviewItems({
        items: tenantItems, health, config: modelGatewayConfig, invoke: invokeBuilderModel, limit: Math.min(2, 10 - outcomes.length),
        verifySource: async item => {
          if (!/\.(?:txt|md|csv|tsv)$/i.test(String(item.fileName || ''))) return verifyDocumentSourceBytes(item, null);
          if (!item.storageBucket || !item.storageObjectRef) throw new Error('Stored source is unavailable');
          const { data, error } = await builderSupabase.storage.from(item.storageBucket).download(item.storageObjectRef);
          if (error || !data || data.size > 144000) throw new Error('Stored source cannot be verified');
          return verifyDocumentSourceBytes(item, new Uint8Array(await data.arrayBuffer()));
        },
        claim: async item => {
          const { data, error } = await builderSupabase.rpc('claim_bob_document_auto_review', {
            p_document_version_id: item.documentVersionId,
            p_review_kind: item.subjectKind,
            p_proposal_id: item.proposalId || null,
            p_source_text_sha256: item.sourceTextHash,
          });
          if (error) throw error;
          const claim = Array.isArray(data) ? data[0] : data;
          return { receipt_id: claim?.receipt_id, state: claim?.state, claimed: claim?.claimed === true, attempt_token: claim?.attempt_token };
        },
        finish: async (item, receiptId, review) => {
          const { data, error } = await builderSupabase.rpc('finish_bob_document_auto_review', {
            p_receipt_id: receiptId,
            p_decision: review.decision,
            p_decision_reason: review.reason,
            p_reviewers: review.reviewers || [],
            p_source_claims: review.source_claims || [],
            p_classification: review.classification || null,
            p_scope: item.targetScope || null,
            p_promotion_metadata: review.promotion_metadata || {},
            p_attempt_token: review.attempt_token,
          });
          if (error) throw error;
          return data;
        },
        applyProposal: async (_item, receiptId) => {
          const { data, error } = await builderSupabase.rpc('apply_bob_document_auto_proposal', { p_receipt_id: receiptId });
          if (error) throw error;
          return data?.status || 'applied';
        },
      });
      outcomes.push(...result.map(result => ({ ...result, organization_id: organizationId })));
    }

    for (const receipt of receiptsResult.data || []) {
      const { data, error } = await builderSupabase.rpc('apply_bob_document_auto_proposal', { p_receipt_id: receipt.id });
      outcomes.push({ id: receipt.proposal_id, organization_id: receipt.organization_id, outcome: error ? 'apply_retry_pending' : data?.status || 'applied' });
    }
    if (pending.length <= outcomes.filter(outcome => outcome.outcome !== 'claim_unavailable' && outcome.outcome !== 'finish_retry_pending').length) {
      documentReviewOffset = (documentsResult.data || []).length === 100 ? documentReviewOffset + 100 : 0;
    }
    if (outcomes.length) record('document-review', 'queue.processed', 'documents', { count: outcomes.length, outcomes });
    return outcomes;
  } catch (error) {
    record('document-review', 'queue.failed', 'documents', { error: String(error.message || error).slice(0, 300) });
    return [];
  } finally {
    documentReviewBusy = false;
  }
}

async function autopilotOnce() {
  if (autopilotBusy || !builderSupabase || !modelGatewayToken || !builderWorkerImage || !builderSourceConfigured || !builderApiConfigured) return [];
  autopilotBusy = true;
  try {
    await startInterruptedModelRecovery();
    startMainHealthCheck();
    await startRoutineRepairs();
    await startChangeRequestIntake();
    await reconcileInvalidSelfHealDeployments();
    await reconcileStaleBuilderJobs();
    try {
      const { finalised } = await finaliseOrphanedModelRuns({ supabase: builderSupabase, staleAfterMs: staleBuilderRunMs, isExecuting: jobId => runningBuilderJobs.has(jobId) });
      if (finalised.length) record('autopilot', 'builder.model_run.orphans_finalised', 'builder', { count: finalised.length, run_ids: finalised, stale_after_ms: staleBuilderRunMs });
    } catch (error) {
      record('autopilot', 'builder.model_run.orphan_sweep_failed', 'builder', { error: String(error.message || error).slice(0, 300) });
    }
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
        run: async (jobId, jobRoute) => {
          const routeText = `${jobRoute?.description || ''}\n${jobRoute?.task_description || ''}`;
          const startAfterProvider = routeText.match(/\[\[start_after_provider:([a-z0-9_-]{1,60})\]\]/i)?.[1] || null;
          const started = await runBuilderJobBounded(jobId, { maxActions: 8, startAfterProvider });
          return started.skipped ? started : await started.execution;
        },
        publish: async ({ job, validatedPatchId, bodyFor, automerge }) => {
          await bindBuilderWorkspace(job.id);
          const { data: fresh } = await builderSupabase.from('builder_jobs').select('workspace_head_sha,workspace_branch,target_sha').eq('id', job.id).single();
          if (fresh?.workspace_head_sha === fresh?.target_sha) await commitBuilderPatch(job.id, validatedPatchId);
          await publishBuilderBranch(job.id);
          const pullRequest = await openBuilderPullRequest(job.id, bodyFor, { draft: automerge?.ok !== true });
          return { pullRequestUrl: pullRequest.url, merged: false };
        },
        ...(builderGitHost === 'github' ? { mergePullRequest: async (job, expectedHeadSha) => {
          const number = Number(job.workspace_pull_request_url?.match(/\/pull\/(\d+)$/)?.[1] || 0);
          if (number < 1) throw new Error('Builder pull request URL is invalid');
          const merge = await mergeGitHubPullRequest({ number, expectedHeadSha, githubToken, owner: githubOwner, repo: githubRepo });
          return { merged: true, sha: merge.sha, merged_at: merge.merged_at };
        } } : {}),
        verifyRelease: async (job) => verifyGitHubProductionRelease(job.autopilot_report?.merge_sha),
        ...(builderGitHost === 'github' ? { pullRequestState: async (job) => readGitHubPullRequestState({ url: job.workspace_pull_request_url, githubToken, owner: githubOwner, repo: githubRepo }) } : {}),
        ...(builderGitHost === 'github' ? {
          pullRequestEvidence: async (job) => {
            const snapshot = await loadBuilderRuntimeSnapshot(builderSupabase, job.id);
            return collectEvidence({ supabase: builderSupabase, snapshot });
          },
          closePullRequest: async (job, expectedHeadSha) => closeGitHubPullRequest({ url: job.workspace_pull_request_url, expectedHeadSha, githubToken, owner: githubOwner, repo: githubRepo }),
        } : {}),
        closeDeclinedJob: async (job, details = {}) => {
          const { error } = await builderSupabase.rpc('builder_record_pull_request_closed', { _job_id: job.id, _pull_request_url: job.workspace_pull_request_url, _details: details });
          if (error) throw new Error(`declined Builder job ${job.id} could not be closed: ${error.message}`);
          record('autopilot', 'builder.pull_request.closed_unmerged', job.id, { url: job.workspace_pull_request_url });
        },
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
          if ((routineJob?.autopilot_source === 'routine_monitor' || routineJob?.autopilot_source == null) && routineJob?.source_friction_packet_id) {
            const automationStatus = routinePacketAutomationStatus(state, report);
            const { error: packetStatusError } = await builderSupabase.from('bob_friction_packets').update({
              automation_status: automationStatus,
              automation_updated_at: new Date().toISOString(),
            }).eq('id', routineJob.source_friction_packet_id);
            if (packetStatusError) throw new Error(`routine repair status could not be recorded: ${packetStatusError.message}`);
            // Packets with the same failure signature that this job covers follow its status, and move with
            // the work when it continues as another job.
            const resumedAs = state === 'done' && /^[0-9a-f-]{36}$/i.test(String(report?.resumed_as_job_id || '')) ? report.resumed_as_job_id : null;
            const { error: coveredStatusError } = await builderSupabase.from('bob_friction_packets').update({
              automation_status: automationStatus,
              automation_updated_at: new Date().toISOString(),
              ...(resumedAs ? { covered_by_job_id: resumedAs } : {}),
            }).eq('covered_by_job_id', jobId);
            if (coveredStatusError) record('autopilot', 'builder.routine_repair.covered_status_failed', jobId, { error: String(coveredStatusError.message).slice(0, 300) });
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
          let taskDescription = String(input.taskDescription || '').slice(0, 12000);
          let description = input.description ? String(input.description).slice(0, 500) : null;
          if (input.rotateAuthor === true) {
            const { data: steps, error: stepsError } = await builderSupabase.from('builder_job_steps')
              .select('id').eq('job_id', input.parentJobId).in('step_id', ['frontend_implementation', 'backend_implementation']);
            if (stepsError || !steps?.length) throw new Error('the previous author run could not be identified for provider rotation');
            const { data: authors, error: authorsError } = await builderSupabase.from('builder_model_runs')
              .select('provider').eq('job_id', input.parentJobId).in('step_id', steps.map((step) => step.id))
              .order('created_at', { ascending: false }).limit(1);
            const provider = authors?.[0]?.provider;
            if (authorsError || typeof provider !== 'string' || !/^[a-z0-9_-]{1,60}$/i.test(provider)) {
              throw new Error('the previous author provider is unavailable for safe rotation');
            }
            const marker = `[[start_after_provider:${provider}]]`;
            description = description ? `${description.slice(0, Math.max(0, 500 - marker.length - 1))} ${marker}` : marker;
            taskDescription = `${taskDescription.slice(0, 11400)}\nAuthor rotation is required: route this implementation after ${provider} to the next configured eligible provider/model.\n${marker}`;
          }
          if (input.parentJobId && String(input.description || '').includes('after GitHub CI/review feedback')) {
            const { data: related, error: relatedError } = await builderSupabase.from('builder_jobs')
              .select('id,description,task_description').eq('parent_job_id', input.parentJobId).limit(20);
            if (relatedError) throw new Error('an existing CI correction could not be checked');
            const existing = (related || []).find((candidate) => candidate.description === description || candidate.task_description === taskDescription);
            if (existing) return existing;
          }
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
              _task_description: taskDescription,
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
            _task_description: taskDescription,
            _target_sha: sha,
            _description: description,
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
    return json(res, 200, { status: 'ok', service: 'bob-control-plane', storage: hostStorageStatus({ stateDir }), activeLease: Boolean(activeLease), builderGitHost, builderSourceConfigured, builderApiConfigured, builderSshConfigured: Boolean(githubSshCommand), autopilot: autopilotEnabled && Boolean(builderSupabase && modelGatewayToken && builderWorkerImage && builderSourceConfigured && builderApiConfigured), autopilotIntervalMs, mainHealth: { enabled: mainHealthEnabled, sourceHost: builderGitHost, latest: latestMainHealth ? { sha: latestMainHealth.sha, status: latestMainHealth.status, job_id: latestMainHealth.job_id ?? null, checked_at: latestMainHealth.checked_at ?? null } : null }, runningBuilderJobs: runningBuilderJobs.size, activeHumanTests: activeHumanTestCount(), productionHumanTest: productionHumanTestStatus(), modelProviders: Object.fromEntries(Object.entries(providers).map(([name, p]) => [name, { configured: p.configured, healthy: p.healthy, ready_model: p.ready_model }])), laptopShell: { enabled: laptop.enabled, configured: laptop.configured, host: laptop.host || null, ssh_allowed: laptopLink ? laptopLink.ssh_allowed === true : null } });
  }
  if (req.method === 'GET' && url.pathname === '/api/bob/builder/model-health') {
    if (!modelGatewayAuthorized(req) && !authorized(req)) return json(res, 401, { error: 'model gateway unauthorized' });
    return json(res, 200, await modelHealth(modelGatewayConfig));
  }
  if (req.method === 'POST' && url.pathname === '/api/bob/officer/privacy') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    res.setHeader('Cache-Control', 'no-store');
    const controller = new AbortController();
    const cancelOnDisconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancelOnDisconnect);
    try {
      const { reviewOfficerPrivacy } = require('./officer-privacy-oracle');
      const result = await reviewOfficerPrivacy({ fields: body?.fields, invoke: invokeBuilderModel, config: modelGatewayConfig, signal: controller.signal });
      if (!res.destroyed) return json(res, 200, result);
    } catch {
      record('officer-privacy', 'officer.privacy.unavailable', null, { outcome: 'withheld' });
      if (!res.destroyed) return json(res, 503, { error: 'Private Oracle review unavailable; briefing text remains withheld' });
    } finally { res.removeListener('close', cancelOnDisconnect); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/bob/builder/model-run') {
    if (!modelGatewayAuthorized(req)) return json(res, 401, { error: 'model gateway unauthorized' });
    const controller = new AbortController();
    const cancelOnDisconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancelOnDisconnect);
    try {
      const result = await invokeBuilderModel({ input: body, config: modelGatewayConfig, signal: controller.signal });
      if (!res.destroyed) return json(res, result.status, result.body);
    } finally {
      res.removeListener('close', cancelOnDisconnect);
    }
    return;
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
  if (req.method === 'GET' && url.pathname === '/api/bob/tailnet/status') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    try { return json(res, 200, { configured: tailscale.configured, ...(tailscale.configured ? await tailscale.status() : {}) }); } catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/bob/tailnet/acl') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const requestedBy = typeof body?.requested_by === 'string' ? body.requested_by.slice(0, 120) : 'bob';
    const purpose = typeof body?.purpose === 'string' ? body.purpose.slice(0, 300) : null;
    try {
      const result = await tailscale.acl({ op: body?.op, policy: body?.policy, ifMatch: body?.if_match });
      if (body?.op === 'set') record(requestedBy, 'tailnet.acl.set', tailscale.tailnet, { purpose, etag: result.etag ?? null, backup: result.previous_policy_backup ?? null });
      return json(res, 200, result);
    } catch (error) {
      if (body?.op === 'set') record(requestedBy, 'tailnet.acl.refused', tailscale.tailnet, { purpose, error: error.message });
      return json(res, 400, { ok: false, error: error.message });
    }
  }
  const isAssessmentRoute = url.pathname === '/assessment' || ['/api/bob/assessment', '/api/bob/builder/assessment'].includes(url.pathname);
  if (req.method === 'GET' && ['/docker/services', '/api/bob/docker/services', '/api/bob/builder/docker/services'].includes(url.pathname)) {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const result = await platformTools.inspect_platform({ action: 'docker_services' });
    return result.error ? json(res, 503, result) : json(res, 200, { ...result.data, evidence: result.evidence });
  }
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
    if ((mode === 'live' || mode === 'suite') && !liveHumanTestConfigured()) {
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
    const latest = latestHumanTestRun();
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
    firewall: hostNetworkFor('bob-vibe'),
    workspaceRoot: builderWorkspaceRoot,
    gateway: builderGateway,
    sourceDirFor: sha => builderGitSource(sha),
    resolveHead: () => builderRepositoryHead('main').sha,
    prepareWorkspace: workspacePath => vibePreview.ensureWebDependencies(workspacePath),
    // Dr Bob's offline browser walk of the session branch (BOB_VIBE_HUMAN_TEST=0 disables it).
    humanTest: process.env.BOB_VIBE_HUMAN_TEST === '0' || !process.env.BOB_WORKER_IMAGE ? null : runVibeHumanTest,
    publish: ({ workspacePath, branch, head, replaceOwnHistory = false }) => {
      const target = builderGitTarget();
      return publishWorkspaceBranch({ workspacePath, branchName: branch, expectedHeadSha: head, pushUrl: target.repoUrl, pushAuthHeader: target.authHeader, sshCommand: target.sshCommand, requireVerifiedIdentity: true, replaceOwnHistory });
    },
    openPullRequest: ({ workspacePath, branch, head, title, body }) => createGitHubPullRequest({ workspacePath, branchName: branch, expectedHeadSha: head, title: `Bob vibe: ${title}`, body, githubToken, owner: githubOwner, repo: githubRepo, draft: false }),
    readPullRequest: ({ url }) => readGitHubPullRequestState({ url, githubToken, owner: githubOwner, repo: githubRepo }),
  },
}) : null;
// Bob Builder chat: the Builder page's own conversation lane, independent of in-app Bob (onspace-ai-chat).
const builderChatWorker = Boolean(builderSupabase) && process.env.BOB_BUILDER_CHAT_ENABLED !== '0' ? createBuilderChatWorker({
  supabase: builderSupabase,
  deps: {
    workspaceRoot: builderWorkspaceRoot,
    gateway: builderGateway,
    platformTools,
    retrieveKnowledge: retrieveBuilderKnowledge,
    sourceDirFor: sha => builderGitSource(sha),
    resolveHead: () => builderRepositoryHead('main').sha,
    changeRequests: {
      implement: async ({ message, proposal, head }) => implementChangeRequest({ supabase: builderSupabase, project: await routineBuilderProject(), message, proposal, head }),
      park: ({ packetId, reason }) => parkChangeRequest({ supabase: builderSupabase, packetId, reason }),
    },
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
if (builderChatWorker) builderChatWorker.start();
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
if (builderSupabase && documentReviewEnabled) {
  const documentReviewTimer = setInterval(() => { documentReviewOnce().catch(() => {}); }, documentReviewIntervalMs);
  documentReviewTimer.unref?.();
  setTimeout(() => { documentReviewOnce().catch(() => {}); }, 12_000).unref?.();
}

if (productionHumanTestEnabled) {
  const productionHumanTestTimer = setInterval(() => { productionHumanTestMonitor.tick().catch(() => {}); }, productionHumanTestIntervalMs);
  productionHumanTestTimer.unref?.();
  setTimeout(() => { productionHumanTestMonitor.tick().catch(() => {}); }, productionHumanTestStartupDelayMs).unref?.();
}
