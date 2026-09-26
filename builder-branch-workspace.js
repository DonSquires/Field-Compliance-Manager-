const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { changedFilesFromPatch, validatePatchText } = require('./frontend-worker');

const BRANCH_PREFIX = 'bob/job-';
const BUILDER_NAME = 'Bob Builder';
const BUILDER_EMAIL = 'bob-builder@fieldcompliance.local';

function redactGitError(message) {
  return String(message || '').replace(/Authorization:\s*(Basic|Bearer|token)\s+\S+/gi, 'Authorization: [redacted]').replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@');
}

function git(directory, args, options = {}) {
  try {
    return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
  } catch (error) {
    // execFileSync echoes the full command line (including any auth header) into the error; never let that escape.
    const sanitized = new Error(redactGitError(error && error.message));
    sanitized.stderr = redactGitError(error && error.stderr);
    sanitized.status = error && error.status;
    throw sanitized;
  }
}

function branchNameForJob(jobId) {
  const normalized = String(jobId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.length < 8) throw new Error('Builder job id is invalid');
  return `${BRANCH_PREFIX}${normalized.slice(0, 20)}`;
}

function assertWorkspacePath(workspaceRoot, workspacePath) {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(workspacePath);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('Builder workspace is outside the configured root');
}

function workspacePathForBranch(workspaceRoot, branchName) {
  const workspacePath = path.join(path.resolve(workspaceRoot), String(branchName).replace('/', '-'));
  assertWorkspacePath(workspaceRoot, workspacePath);
  return workspacePath;
}

function verifySnapshot(sourceDir, targetSha) {
  if (!/^[a-f0-9]{40}$/i.test(String(targetSha ?? ''))) throw new Error('Builder target SHA must be a full Git SHA');
  if (git(sourceDir, ['rev-parse', 'HEAD']) !== targetSha) throw new Error('Builder source checkout does not match the target SHA');
  if (git(sourceDir, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Builder source checkout must be clean');
}

function createBranchWorkspace({ sourceDir, workspaceRoot, jobId, targetSha, branchName = branchNameForJob(jobId), recoverInterrupted = false }) {
  if (!branchName.startsWith(BRANCH_PREFIX) || !/^bob\/job-[a-z0-9]+$/.test(branchName)) throw new Error('Builder branch name is invalid');
  const workspacePath = workspacePathForBranch(workspaceRoot, branchName);
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });

  if (fs.existsSync(workspacePath)) {
    if (git(workspacePath, ['branch', '--show-current']) !== branchName) throw new Error('Existing Builder workspace has an unexpected branch');
    // A job whose branch was never bound/published owns a disposable scratch worktree at the
    // pinned commit. If an engineer run was interrupted (restart, crash) it leaves edits behind
    // that would otherwise wedge every later run on the clean-checkout guard; restore the pin.
    if (recoverInterrupted && (git(workspacePath, ['rev-parse', 'HEAD']) !== targetSha || git(workspacePath, ['status', '--porcelain', '--untracked-files=normal']))) {
      git(workspacePath, ['reset', '-q', '--hard', targetSha]);
      git(workspacePath, ['clean', '-fdq']);
    }
    verifySnapshot(workspacePath, targetSha);
    return { branchName, workspacePath, head: git(workspacePath, ['rev-parse', 'HEAD']), existing: true };
  }

  verifySnapshot(sourceDir, targetSha);
  git(sourceDir, ['worktree', 'add', '-b', branchName, workspacePath, targetSha]);
  return { branchName, workspacePath, head: git(workspacePath, ['rev-parse', 'HEAD']), existing: false };
}

function commitVerifiedPatch({ workspacePath, branchName, patch, message, push = false }) {
  if (!branchName.startsWith(BRANCH_PREFIX) || git(workspacePath, ['branch', '--show-current']) !== branchName) throw new Error('Builder workspace branch is invalid');
  if (git(workspacePath, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Builder workspace must be clean before applying a patch');
  const changedFiles = validatePatchText(patch);
  const patchPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bob-verified-patch-')), 'patch.diff');
  try {
    fs.writeFileSync(patchPath, patch, { mode: 0o600 });
    git(workspacePath, ['apply', '--check', '--whitespace=error-all', patchPath]);
    git(workspacePath, ['apply', '--whitespace=error-all', patchPath]);
    const actualFiles = changedFilesFromPatch(git(workspacePath, ['diff', '--binary']));
    if (JSON.stringify(actualFiles) !== JSON.stringify(changedFiles)) throw new Error('Applied patch files do not match its declared manifest');
    git(workspacePath, ['add', '--', ...changedFiles]);
    git(workspacePath, ['-c', `user.name=${BUILDER_NAME}`, '-c', `user.email=${BUILDER_EMAIL}`, 'commit', '-m', String(message || 'Bob Builder verified change').slice(0, 200)]);
    const commitSha = git(workspacePath, ['rev-parse', 'HEAD']);
    if (push) git(workspacePath, ['push', 'origin', branchName]);
    return { branchName, commitSha, changedFiles, pushed: push };
  } finally {
    fs.rmSync(path.dirname(patchPath), { recursive: true, force: true });
  }
}

function publishWorkspaceBranch({ workspacePath, branchName, expectedHeadSha, pushUrl = null, pushAuthHeader = null }) {
  if (!branchName.startsWith(BRANCH_PREFIX) || git(workspacePath, ['branch', '--show-current']) !== branchName) throw new Error('Builder workspace branch is invalid');
  if (git(workspacePath, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Builder workspace must be clean before publication');
  const head = git(workspacePath, ['rev-parse', 'HEAD']);
  if (head !== expectedHeadSha) throw new Error('Builder workspace head is stale');
  if (pushUrl) {
    // Credentials travel as a per-invocation header, never inside the URL or .git/config.
    // Plain http is only ever the compose-internal Gitea address; GitHub is always https.
    if (!/^https?:\/\/[^\s@]+$/.test(String(pushUrl))) throw new Error('Builder push URL must be a credential-free URL');
    git(workspacePath, [...(pushAuthHeader ? ['-c', `http.extraheader=${pushAuthHeader}`] : []), 'push', pushUrl, `HEAD:refs/heads/${branchName}`]);
    return { branchName, head, remote: pushUrl };
  }
  const remote = git(workspacePath, ['remote', 'get-url', 'origin']);
  if (!remote) throw new Error('Builder workspace has no origin remote');
  git(workspacePath, ['push', 'origin', `HEAD:refs/heads/${branchName}`]);
  return { branchName, head, remote };
}

// ── GitHub host adapter ───────────────────────────────────────────────────────
// Bob's self-heal lane works in the GitHub repository the way a coding agent
// does: a real clone as the source of truth, a branch per job, a verified
// commit, a push, and a DRAFT pull request for human review. Nothing merges.

function githubAuthHeader(token) {
  if (!token) throw new Error('GitHub token is not configured');
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

function githubRepoUrl(owner, repo) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(owner)) || !/^[A-Za-z0-9_.-]+$/.test(String(repo))) throw new Error('GitHub repository coordinates are invalid');
  return `https://github.com/${owner}/${repo}.git`;
}

function resolveRemoteHead({ repoUrl, authHeader = null, ref = 'main', cwd = os.tmpdir() }) {
  if (!/^[A-Za-z0-9_./-]+$/.test(String(ref))) throw new Error('Git ref is invalid');
  const output = git(cwd, [...(authHeader ? ['-c', `http.extraheader=${authHeader}`] : []), 'ls-remote', repoUrl, `refs/heads/${ref}`]);
  const sha = output.split(/\s+/)[0] || '';
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error(`Remote ref ${ref} could not be resolved`);
  return sha;
}

/** Keep a persistent, detached checkout of the repository at exactly `sha` (clone on first use). */
function ensureSourceCheckout({ sourceDir, repoUrl, authHeader = null, sha }) {
  if (!/^[a-f0-9]{40}$/i.test(String(sha ?? ''))) throw new Error('Builder target SHA must be a full Git SHA');
  const authArgs = authHeader ? ['-c', `http.extraheader=${authHeader}`] : [];
  fs.mkdirSync(path.dirname(path.resolve(sourceDir)), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(sourceDir, '.git'))) {
    git(path.dirname(path.resolve(sourceDir)), [...authArgs, 'clone', '--no-checkout', repoUrl, path.resolve(sourceDir)]);
  }
  if (git(sourceDir, ['remote', 'get-url', 'origin']) !== repoUrl) throw new Error('Builder source checkout points at an unexpected repository');
  try {
    git(sourceDir, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    git(sourceDir, [...authArgs, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
  }
  git(sourceDir, ['checkout', '--detach', '--force', sha]);
  git(sourceDir, ['clean', '-fdx']);
  verifySnapshot(sourceDir, sha);
  return { sourceDir: path.resolve(sourceDir), head: sha };
}

async function githubApi({ fetchImpl, githubToken, method, urlPath, body }) {
  const response = await fetchImpl(`https://api.github.com${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bob-builder',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function createGitHubPullRequest({ workspacePath, branchName, expectedHeadSha, title, body, githubToken, owner, repo, base = 'main', fetchImpl = globalThis.fetch }) {
  if (!branchName.startsWith(BRANCH_PREFIX) || git(workspacePath, ['branch', '--show-current']) !== branchName) throw new Error('Builder workspace branch is invalid');
  if (git(workspacePath, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Builder workspace must be clean before opening a pull request');
  if (git(workspacePath, ['rev-parse', 'HEAD']) !== expectedHeadSha) throw new Error('Builder workspace head is stale');
  if (!githubToken || !owner || !repo || typeof fetchImpl !== 'function') throw new Error('Builder GitHub integration is not configured');
  githubRepoUrl(owner, repo);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const ref = await githubApi({ fetchImpl, githubToken, method: 'GET', urlPath: `${repoPath}/git/ref/heads/${encodeURIComponent(branchName)}` });
  if (!ref.ok || ref.data?.object?.sha !== expectedHeadSha) throw new Error('Published GitHub branch does not match the verified head');
  const created = await githubApi({ fetchImpl, githubToken, method: 'POST', urlPath: `${repoPath}/pulls`, body: { base, head: branchName, title: String(title).slice(0, 200), body: String(body).slice(0, 10000), draft: true, maintainer_can_modify: true } });
  if (!created.ok || typeof created.data?.html_url !== 'string' || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(created.data.html_url)) throw new Error('GitHub pull request creation failed');
  return { branchName, head: expectedHeadSha, url: created.data.html_url, number: created.data.number ?? null, draft: true };
}

function giteaRepositoryPath(remote) {
  const httpsMatch = String(remote).match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  const sshUrlMatch = String(remote).match(/^ssh:\/\/[^@\s]+@[^/\s]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  const sshMatch = String(remote).match(/^[^@\s]+@[^:\s]+:([^/]+\/[^/]+?)(?:\.git)?$/);
  return (httpsMatch?.[1] || sshUrlMatch?.[1] || sshMatch?.[1] || '').replace(/\.git$/, '');
}

async function createGiteaPullRequest({ workspacePath, branchName, expectedHeadSha, title, body, giteaBaseUrl, giteaToken, owner, repo, fetchImpl = globalThis.fetch }) {
  if (!branchName.startsWith(BRANCH_PREFIX) || git(workspacePath, ['branch', '--show-current']) !== branchName) throw new Error('Builder workspace branch is invalid');
  if (git(workspacePath, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Builder workspace must be clean before opening a pull request');
  if (git(workspacePath, ['rev-parse', 'HEAD']) !== expectedHeadSha) throw new Error('Builder workspace head is stale');
  if (!giteaBaseUrl || !giteaToken || !owner || !repo || typeof fetchImpl !== 'function') throw new Error('Builder Gitea integration is not configured');
  let remote = '';
  try { remote = git(workspacePath, ['remote', 'get-url', 'origin']); } catch {}
  if (giteaRepositoryPath(remote) !== `${owner}/${repo}`) throw new Error('Builder workspace origin is not the configured Gitea repository');
  const baseUrl = String(giteaBaseUrl).replace(/\/+$/, '');
  const response = await fetchImpl(`${baseUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
    method: 'POST',
    headers: { Authorization: `token ${giteaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: 'main', head: branchName, title: String(title).slice(0, 200), body: String(body).slice(0, 10000) })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.html_url !== 'string' || !/^https?:\/\/[^\s]+\/pulls\/\d+$/.test(data.html_url)) throw new Error('Gitea pull request creation failed');
  return { branchName, head: expectedHeadSha, url: data.html_url };
}

module.exports = { BRANCH_PREFIX, BUILDER_NAME, BUILDER_EMAIL, branchNameForJob, workspacePathForBranch, createBranchWorkspace, commitVerifiedPatch, publishWorkspaceBranch, giteaRepositoryPath, createGiteaPullRequest, verifySnapshot, githubAuthHeader, githubRepoUrl, resolveRemoteHead, ensureSourceCheckout, createGitHubPullRequest, redactGitError };