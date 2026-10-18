const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { changedFilesFromPatch, validatePatchText } = require('./frontend-worker');

const BRANCH_PREFIX = 'bob/job-';
const BUILDER_NAME = 'Bob Builder';
const BUILDER_EMAIL = 'bob-builder@fieldcompliance.local';
const VERIFIED_GITHUB_EMAIL = '256263525+DonSquires@users.noreply.github.com';

function builderCommitIdentity({ requireVerified = false } = {}) {
  const name = String(process.env.BOB_BUILDER_GIT_NAME || BUILDER_NAME).trim();
  const email = String(process.env.BOB_BUILDER_GIT_EMAIL || BUILDER_EMAIL).trim();
  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Builder commit identity is invalid');
  }
  if (requireVerified && email.toLowerCase() !== VERIFIED_GITHUB_EMAIL.toLowerCase()) {
    throw new Error(`BOB_BUILDER_GIT_EMAIL must be ${VERIFIED_GITHUB_EMAIL} before GitHub publication`);
  }
  return { name, email };
}

function assertVerifiedCommitIdentity(workspacePath, commitSha) {
  const expected = builderCommitIdentity({ requireVerified: true });
  const [name, email] = git(workspacePath, ['show', '-s', '--format=%an%x00%ae', commitSha]).split('\0');
  if (name !== expected.name || email.toLowerCase() !== expected.email.toLowerCase()) {
    throw new Error('Builder workspace head does not use the configured verified GitHub identity');
  }
}

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

function sshOptions(sshCommand) {
  return sshCommand ? { env: { ...process.env, GIT_SSH_COMMAND: sshCommand } } : {};
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

function verifySourceCommit(sourceDir, targetSha) {
  if (!/^[a-f0-9]{40}$/i.test(String(targetSha ?? ''))) throw new Error('Builder target SHA must be a full Git SHA');
  if (git(sourceDir, ['cat-file', '-t', targetSha]) !== 'commit') throw new Error('Builder target SHA must identify a commit');
}

function pruneDetachedWorkspaces({ sourceDir, workspaceRoot, activeWorkspacePath, retentionCount }) {
  const root = path.resolve(workspaceRoot);
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^snapshot-[a-f0-9]{40}$/i.test(entry.name))
    .map((entry) => {
      const workspacePath = path.join(root, entry.name);
      assertWorkspacePath(root, workspacePath);
      return { workspacePath, mtimeMs: fs.statSync(workspacePath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const retained = new Set([activeWorkspacePath]);
  for (const candidate of candidates) {
    if (retained.size >= retentionCount) break;
    retained.add(candidate.workspacePath);
  }
  for (const candidate of candidates) {
    if (retained.has(candidate.workspacePath)) continue;
    const targetSha = path.basename(candidate.workspacePath).slice('snapshot-'.length);
    verifySnapshot(candidate.workspacePath, targetSha);
    git(sourceDir, ['worktree', 'remove', '--force', candidate.workspacePath]);
  }
}

function createDetachedWorkspace({ sourceDir, workspaceRoot, targetSha, retentionCount = 8 }) {
  if (!/^[a-f0-9]{40}$/i.test(String(targetSha ?? ''))) throw new Error('Builder target SHA must be a full Git SHA');
  if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 64) throw new Error('Builder snapshot retention count is invalid');
  const workspacePath = path.join(path.resolve(workspaceRoot), `snapshot-${targetSha}`);
  assertWorkspacePath(workspaceRoot, workspacePath);
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });

  if (fs.existsSync(workspacePath)) {
    verifySnapshot(workspacePath, targetSha);
    pruneDetachedWorkspaces({ sourceDir, workspaceRoot, activeWorkspacePath: workspacePath, retentionCount });
    return { workspacePath, head: targetSha, existing: true };
  }

  verifySourceCommit(sourceDir, targetSha);
  git(sourceDir, ['worktree', 'add', '--detach', workspacePath, targetSha]);
  verifySnapshot(workspacePath, targetSha);
  pruneDetachedWorkspaces({ sourceDir, workspaceRoot, activeWorkspacePath: workspacePath, retentionCount });
  return { workspacePath, head: targetSha, existing: false };
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

  // The shared clone may serve another job at a different HEAD. Only the new worktree must
  // match this job's pin; neither the clone's branch nor its working files are changed here.
  verifySourceCommit(sourceDir, targetSha);
  git(sourceDir, ['worktree', 'add', '-b', branchName, workspacePath, targetSha]);
  verifySnapshot(workspacePath, targetSha);
  return { branchName, workspacePath, head: git(workspacePath, ['rev-parse', 'HEAD']), existing: false };
}

function retireTerminalWorkspace({ sourceDir, legacySourceDir = null, workspaceRoot, job, activeExecution = false, pendingApproval = false, now = Date.now(), dryRun = true }) {
  const skip = reason => ({ removed: false, eligible: false, reason });
  if (!['deployed', 'failed', 'cancelled'].includes(job?.status)) return skip('not_terminal');
  if (activeExecution || pendingApproval) return skip('active_or_awaiting_approval');
  const updated = Date.parse(job.updated_at || '');
  if (!Number.isFinite(updated) || now - updated < 7 * 86400000) return skip('retention_window');
  const branchName = branchNameForJob(job.id);
  if (job.workspace_branch && job.workspace_branch !== branchName) return skip('branch_mismatch');
  const workspacePath = workspacePathForBranch(workspaceRoot, branchName);
  if (!fs.existsSync(workspacePath)) return skip('absent');
  if (fs.lstatSync(workspacePath).isSymbolicLink()) return skip('symlink');
  const commonDir = directory => fs.realpathSync(git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const workspaceCommon = commonDir(workspacePath);
  if (workspaceCommon !== commonDir(sourceDir)) {
    if (!legacySourceDir || !fs.existsSync(path.join(legacySourceDir, '.git')) || workspaceCommon !== commonDir(legacySourceDir)) return skip('different_repository');
    sourceDir = legacySourceDir;
  }
  if (git(workspacePath, ['branch', '--show-current']) !== branchName) return skip('branch_mismatch');
  if (git(workspacePath, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'])) return skip('local_files');
  const head = git(workspacePath, ['rev-parse', 'HEAD']);
  // Remove only untouched pins or commits with both a publication receipt and matching remote ref.
  if (head !== job.target_sha) {
    if (head !== job.workspace_published_head_sha) return skip('unpublished_commits');
    const refs = git(sourceDir, ['for-each-ref', '--format=%(objectname)', `refs/remotes/origin/${branchName}`]);
    if (refs !== head) return skip('publication_not_confirmed');
  }
  if (!dryRun) git(sourceDir, ['worktree', 'remove', workspacePath]);
  return { removed: !dryRun, eligible: true, reason: dryRun ? 'dry_run' : 'retired', workspacePath };
}

function commitVerifiedPatch({ workspacePath, branchName, patch, message, body = '', push = false, requireVerifiedIdentity = false }) {
  if (!branchName.startsWith(BRANCH_PREFIX) || git(workspacePath, ['branch', '--show-current']) !== branchName) throw new Error('Builder workspace branch is invalid');
  if (git(workspacePath, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Builder workspace must be clean before applying a patch');
  // The lane worker has already verified this patch; the commit step enforces path safety and the protected paths, not the lane fence.
  const changedFiles = validatePatchText(patch, { lane: 'verified' });
  const patchPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bob-verified-patch-')), 'patch.diff');
  const head = git(workspacePath, ['rev-parse', 'HEAD']);
  try {
    fs.writeFileSync(patchPath, patch, { mode: 0o600 });
    git(workspacePath, ['apply', '--check', '--whitespace=error-all', patchPath]);
    // Apply to the index as well as the tree: a file the patch creates is otherwise untracked,
    // `git diff` leaves it out, and the manifest check fails a patch that is in fact exact
    // (job f6fbd0da added test/bob-builder-e2e-driver.test.js).
    git(workspacePath, ['apply', '--index', '--whitespace=error-all', patchPath]);
    const actualFiles = changedFilesFromPatch(git(workspacePath, ['diff', '--cached', '--binary']));
    if (JSON.stringify(actualFiles) !== JSON.stringify(changedFiles)) throw new Error('Applied patch files do not match its declared manifest');
    const identity = builderCommitIdentity({ requireVerified: requireVerifiedIdentity });
    git(workspacePath, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '-m', String(message || 'Bob Builder verified change').slice(0, 200), ...(body ? ['-m', String(body).slice(0, 2000)] : [])]);
    const commitSha = git(workspacePath, ['rev-parse', 'HEAD']);
    if (push) git(workspacePath, ['push', 'origin', branchName]);
    return { branchName, commitSha, changedFiles, pushed: push };
  } catch (error) {
    // Leave the worktree as we found it; a half-applied patch would wedge every later attempt
    // on the clean-checkout guard ("Builder source checkout must be clean").
    if (git(workspacePath, ['rev-parse', 'HEAD']) === head) {
      try { git(workspacePath, ['reset', '-q', '--hard', head]); git(workspacePath, ['clean', '-fdq']); } catch { /* the original error is the one to report */ }
    }
    throw error;
  } finally {
    fs.rmSync(path.dirname(patchPath), { recursive: true, force: true });
  }
}

function publishWorkspaceBranch({ workspacePath, branchName, expectedHeadSha, pushUrl = null, pushAuthHeader = null, sshCommand = null, requireVerifiedIdentity = false }) {
  if (!branchName.startsWith(BRANCH_PREFIX) || git(workspacePath, ['branch', '--show-current']) !== branchName) throw new Error('Builder workspace branch is invalid');
  if (git(workspacePath, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Builder workspace must be clean before publication');
  const head = git(workspacePath, ['rev-parse', 'HEAD']);
  if (head !== expectedHeadSha) throw new Error('Builder workspace head is stale');
  if (requireVerifiedIdentity) assertVerifiedCommitIdentity(workspacePath, head);
  if (pushUrl) {
    // Credentials travel per invocation, never inside the remote URL or .git/config.
    const credentialFreeHttp = /^https?:\/\/[^\s@]+$/.test(String(pushUrl));
    const credentialFreeGithubSsh = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(String(pushUrl));
    if (!credentialFreeHttp && !credentialFreeGithubSsh) throw new Error('Builder push URL must be a credential-free URL');
    git(workspacePath, [...(pushAuthHeader ? ['-c', `http.extraheader=${pushAuthHeader}`] : []), 'push', pushUrl, `HEAD:refs/heads/${branchName}`], sshOptions(sshCommand));
    return { branchName, head, remote: pushUrl };
  }
  const remote = git(workspacePath, ['remote', 'get-url', 'origin']);
  if (!remote) throw new Error('Builder workspace has no origin remote');
  git(workspacePath, ['push', 'origin', `HEAD:refs/heads/${branchName}`], sshOptions(sshCommand));
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

function githubSshRepoUrl(owner, repo) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(owner)) || !/^[A-Za-z0-9_.-]+$/.test(String(repo))) throw new Error('GitHub repository coordinates are invalid');
  return `git@github.com:${owner}/${repo}.git`;
}

function resolveRemoteHead({ repoUrl, authHeader = null, sshCommand = null, ref = 'main', cwd = os.tmpdir() }) {
  if (!/^[A-Za-z0-9_./-]+$/.test(String(ref))) throw new Error('Git ref is invalid');
  const output = git(cwd, [...(authHeader ? ['-c', `http.extraheader=${authHeader}`] : []), 'ls-remote', repoUrl, `refs/heads/${ref}`], sshOptions(sshCommand));
  const sha = output.split(/\s+/)[0] || '';
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error(`Remote ref ${ref} could not be resolved`);
  return sha;
}

/** Keep a persistent, detached checkout of the repository at exactly `sha` (clone on first use). */
function ensureSourceCheckout({ sourceDir, repoUrl, authHeader = null, sshCommand = null, sha }) {
  if (!/^[a-f0-9]{40}$/i.test(String(sha ?? ''))) throw new Error('Builder target SHA must be a full Git SHA');
  const authArgs = authHeader ? ['-c', `http.extraheader=${authHeader}`] : [];
  const transportOptions = sshOptions(sshCommand);
  fs.mkdirSync(path.dirname(path.resolve(sourceDir)), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(sourceDir, '.git'))) {
    git(path.dirname(path.resolve(sourceDir)), [...authArgs, 'clone', '--no-checkout', repoUrl, path.resolve(sourceDir)], transportOptions);
  }
  if (git(sourceDir, ['remote', 'get-url', 'origin']) !== repoUrl) throw new Error('Builder source checkout points at an unexpected repository');
  try {
    git(sourceDir, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    git(sourceDir, [...authArgs, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], transportOptions);
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

async function githubGraphql({ fetchImpl, githubToken, query, variables }) {
  const response = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: ['Bearer', githubToken].join(' '),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bob-builder',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok && !data?.errors?.length, status: response.status, data };
}

async function createGitHubPullRequest({ workspacePath, branchName, expectedHeadSha, title, body, githubToken, owner, repo, base = 'main', draft = true, fetchImpl = globalThis.fetch }) {
  if (!branchName.startsWith(BRANCH_PREFIX) || git(workspacePath, ['branch', '--show-current']) !== branchName) throw new Error('Builder workspace branch is invalid');
  if (git(workspacePath, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Builder workspace must be clean before opening a pull request');
  if (git(workspacePath, ['rev-parse', 'HEAD']) !== expectedHeadSha) throw new Error('Builder workspace head is stale');
  if (!githubToken || !owner || !repo || typeof fetchImpl !== 'function') throw new Error('Builder GitHub integration is not configured');
  githubRepoUrl(owner, repo);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const ref = await githubApi({ fetchImpl, githubToken, method: 'GET', urlPath: `${repoPath}/git/ref/heads/${encodeURIComponent(branchName)}` });
  if (!ref.ok || ref.data?.object?.sha !== expectedHeadSha) throw new Error('Published GitHub branch does not match the verified head');
  const created = await githubApi({ fetchImpl, githubToken, method: 'POST', urlPath: `${repoPath}/pulls`, body: { base, head: branchName, title: String(title).slice(0, 200), body: String(body).slice(0, 10000), draft: draft === true, maintainer_can_modify: true } });
  if (!created.ok || typeof created.data?.html_url !== 'string' || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(created.data.html_url)) throw new Error('GitHub pull request creation failed');
  return { branchName, head: expectedHeadSha, url: created.data.html_url, number: created.data.number ?? null, draft: draft === true };
}

async function mergeGitHubPullRequest({ number, expectedHeadSha, githubToken, owner, repo, fetchImpl = globalThis.fetch }) {
  if (!Number.isInteger(Number(number)) || Number(number) < 1) throw new Error('GitHub pull request number is invalid');
  if (!/^[a-f0-9]{40}$/i.test(String(expectedHeadSha || ''))) throw new Error('GitHub pull request head is invalid');
  if (!githubToken || !owner || !repo || typeof fetchImpl !== 'function') throw new Error('Builder GitHub integration is not configured');
  githubRepoUrl(owner, repo);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const pullPath = `${repoPath}/pulls/${Number(number)}`;
  const pullRequest = await githubApi({ fetchImpl, githubToken, method: 'GET', urlPath: pullPath });
  if (!pullRequest.ok || pullRequest.data?.state !== 'open'
      || pullRequest.data?.head?.sha !== expectedHeadSha || pullRequest.data?.base?.ref !== 'main') {
    throw new Error('GitHub pull request is not the verified open main-targeted change');
  }
  if (pullRequest.data?.draft === true) {
    if (typeof pullRequest.data?.node_id !== 'string' || !pullRequest.data.node_id) {
      throw new Error('GitHub pull request node identity is unavailable');
    }
    const ready = await githubGraphql({
      fetchImpl,
      githubToken,
      query: 'mutation MarkPullRequestReady($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft headRefOid baseRefName state } } }',
      variables: { pullRequestId: pullRequest.data.node_id }
    });
    const readyPull = ready.data?.data?.markPullRequestReadyForReview?.pullRequest;
    if (!ready.ok || readyPull?.isDraft === true || readyPull?.state !== 'OPEN'
        || readyPull?.headRefOid !== expectedHeadSha || readyPull?.baseRefName !== 'main') {
      throw new Error('GitHub pull request could not be marked ready for verified merge');
    }
  }
  const merged = await githubApi({ fetchImpl, githubToken, method: 'PUT', urlPath: `${repoPath}/pulls/${Number(number)}/merge`, body: { sha: expectedHeadSha, merge_method: 'squash' } });
  if (!merged.ok || merged.data?.merged !== true) throw new Error('GitHub did not merge the verified pull request');
  return { number: Number(number), sha: merged.data.sha ?? expectedHeadSha, merged_at: merged.data.merged_at ?? null };
}

function giteaRepositoryPath(remote) {
  const httpsMatch = String(remote).match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  const sshUrlMatch = String(remote).match(/^ssh:\/\/[^@\s]+@[^/\s]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  const sshMatch = String(remote).match(/^[^@\s]+@[^:\s]+:([^/]+\/[^/]+?)(?:\.git)?$/);
  return (httpsMatch?.[1] || sshUrlMatch?.[1] || sshMatch?.[1] || '').replace(/\.git$/, '');
}

async function createGiteaPullRequest({ workspacePath, branchName, expectedHeadSha, title, body, giteaBaseUrl, giteaToken, owner, repo, publicBaseUrl = process.env.GITEA_PUBLIC_URL, fetchImpl = globalThis.fetch }) {
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
  return { branchName, head: expectedHeadSha, url: publicGiteaUrl(data.html_url, { baseUrl, publicBaseUrl }) };
}

// Gitea builds html_url from its own ROOT_URL, which on this host is the compose-internal
// http://gitea:3000. People need the public host; the API call keeps using the internal base.
function publicGiteaUrl(url, { baseUrl, publicBaseUrl }) {
  const pub = String(publicBaseUrl || '').replace(/\/+$/, '');
  if (!pub || !/^https?:\/\//.test(pub)) return url;
  const internal = String(baseUrl || '').replace(/\/+$/, '');
  for (const prefix of [internal, 'http://gitea:3000']) {
    if (prefix && url.startsWith(`${prefix}/`)) return `${pub}${url.slice(prefix.length)}`;
  }
  return url;
}

module.exports = { BRANCH_PREFIX, BUILDER_NAME, BUILDER_EMAIL, VERIFIED_GITHUB_EMAIL, builderCommitIdentity, branchNameForJob, workspacePathForBranch, createBranchWorkspace, createDetachedWorkspace, retireTerminalWorkspace, commitVerifiedPatch, publishWorkspaceBranch, giteaRepositoryPath, createGiteaPullRequest, publicGiteaUrl, verifySnapshot, githubAuthHeader, githubRepoUrl, githubSshRepoUrl, resolveRemoteHead, ensureSourceCheckout, createGitHubPullRequest, mergeGitHubPullRequest, redactGitError };