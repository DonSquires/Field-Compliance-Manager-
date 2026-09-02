const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { changedFilesFromPatch, validatePatchText } = require('./frontend-worker');

const BRANCH_PREFIX = 'bob/job-';
const BUILDER_NAME = 'Bob Builder';
const BUILDER_EMAIL = 'bob-builder@fieldcompliance.local';

function git(directory, args, options = {}) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
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

function createBranchWorkspace({ sourceDir, workspaceRoot, jobId, targetSha, branchName = branchNameForJob(jobId) }) {
  if (!branchName.startsWith(BRANCH_PREFIX) || !/^bob\/job-[a-z0-9]+$/.test(branchName)) throw new Error('Builder branch name is invalid');
  const workspacePath = workspacePathForBranch(workspaceRoot, branchName);
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });

  if (fs.existsSync(workspacePath)) {
    if (git(workspacePath, ['branch', '--show-current']) !== branchName) throw new Error('Existing Builder workspace has an unexpected branch');
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

function publishWorkspaceBranch({ workspacePath, branchName, expectedHeadSha }) {
  if (!branchName.startsWith(BRANCH_PREFIX) || git(workspacePath, ['branch', '--show-current']) !== branchName) throw new Error('Builder workspace branch is invalid');
  if (git(workspacePath, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Builder workspace must be clean before publication');
  const head = git(workspacePath, ['rev-parse', 'HEAD']);
  if (head !== expectedHeadSha) throw new Error('Builder workspace head is stale');
  const remote = git(workspacePath, ['remote', 'get-url', 'origin']);
  if (!remote) throw new Error('Builder workspace has no origin remote');
  git(workspacePath, ['push', 'origin', `HEAD:refs/heads/${branchName}`]);
  return { branchName, head, remote };
}

function createGithubPullRequest({ workspacePath, branchName, expectedHeadSha, title, body }) {
  if (!branchName.startsWith(BRANCH_PREFIX) || git(workspacePath, ['branch', '--show-current']) !== branchName) throw new Error('Builder workspace branch is invalid');
  if (git(workspacePath, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Builder workspace must be clean before opening a pull request');
  if (git(workspacePath, ['rev-parse', 'HEAD']) !== expectedHeadSha) throw new Error('Builder workspace head is stale');
  let remote = '';
  try { remote = git(workspacePath, ['remote', 'get-url', 'origin']); } catch {}
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(remote)) throw new Error('Builder workspace origin is not an approved GitHub remote');
  const output = execFileSync('gh', ['pr', 'create', '--repo', remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''), '--base', 'main', '--head', branchName, '--title', String(title).slice(0, 200), '--body', String(body).slice(0, 10000)], { cwd: workspacePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(output)) throw new Error('GitHub pull request creation returned an invalid URL');
  return { branchName, head: expectedHeadSha, url: output };
}

module.exports = { BRANCH_PREFIX, BUILDER_NAME, BUILDER_EMAIL, branchNameForJob, workspacePathForBranch, createBranchWorkspace, commitVerifiedPatch, publishWorkspaceBranch, createGithubPullRequest, verifySnapshot };