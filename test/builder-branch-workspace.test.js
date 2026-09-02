const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { branchNameForJob, createBranchWorkspace, commitVerifiedPatch, publishWorkspaceBranch, createGithubPullRequest } = require('../builder-branch-workspace');

const patch = ['diff --git a/apps/web/src/example.ts b/apps/web/src/example.ts', '--- a/apps/web/src/example.ts', '+++ b/apps/web/src/example.ts', '@@ -1 +1 @@', '-export const value = 1;', '+export const value = 2;', ''].join('\n');

function git(directory, args) { return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim(); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-branch-workspace-'));
  fs.mkdirSync(path.join(root, 'apps/web/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps/web/src/example.ts'), 'export const value = 1;\n');
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.com']); git(root, ['add', '.']); git(root, ['commit', '-qm', 'fixture']);
  return { root, sha: git(root, ['rev-parse', 'HEAD']), workspaceRoot: path.join(root, '.builder-workspaces') };
}

test('Builder branch workspace is pinned, isolated, and commits only validated patches', () => {
  const repo = fixture();
  try {
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: '12345678-1234-1234-1234-123456789abc', targetSha: repo.sha });
    assert.equal(workspace.branchName, 'bob/job-12345678123412341234');
    assert.equal(workspace.head, repo.sha);
    const committed = commitVerifiedPatch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, patch, message: 'Bob Builder: update example' });
    assert.match(committed.commitSha, /^[a-f0-9]{40}$/);
    assert.deepEqual(committed.changedFiles, ['apps/web/src/example.ts']);
    assert.equal(git(repo.root, ['show', `${committed.commitSha}:apps/web/src/example.ts`]), 'export const value = 2;');
    assert.equal(git(repo.root, ['show', `${repo.sha}:apps/web/src/example.ts`]), 'export const value = 1;');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('Builder branch names are deterministic and cannot target protected branches', () => {
  assert.equal(branchNameForJob('abcdefgh-1234'), 'bob/job-abcdefgh1234');
  assert.throws(() => branchNameForJob('short'), /invalid/);
});

test('Builder publication rejects a workspace whose recorded head is stale', () => {
  const repo = fixture();
  try {
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: '12345678-1234-1234-1234-123456789abc', targetSha: repo.sha });
    assert.throws(() => publishWorkspaceBranch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, expectedHeadSha: '0'.repeat(40) }), /stale/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('Builder pull request creation rejects non-GitHub workspace remotes', () => {
  const repo = fixture();
  try {
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: '12345678-1234-1234-1234-123456789abc', targetSha: repo.sha });
    assert.throws(() => createGithubPullRequest({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, expectedHeadSha: repo.sha, title: 'PR', body: 'Review' }), /approved GitHub remote/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});