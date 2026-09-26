const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { branchNameForJob, createBranchWorkspace, commitVerifiedPatch, publishWorkspaceBranch, createGiteaPullRequest } = require('../builder-branch-workspace');

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

test('a verified backend patch commits (the commit step enforces protected paths, not the frontend fence)', () => {
  const repo = fixture();
  try {
    fs.mkdirSync(path.join(repo.root, 'services/api'), { recursive: true });
    fs.writeFileSync(path.join(repo.root, 'services/api/verify.js'), 'const RE = /^(yes|ok)$/i;\n');
    fs.writeFileSync(path.join(repo.root, 'package.json'), '{"name":"fixture"}\n');
    git(repo.root, ['add', '.']); git(repo.root, ['commit', '-qm', 'backend fixture']);
    const sha = git(repo.root, ['rev-parse', 'HEAD']);
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: '0123456789abcdef0123456789abcdef', targetSha: sha });
    const backendPatch = ['diff --git a/services/api/verify.js b/services/api/verify.js', '--- a/services/api/verify.js', '+++ b/services/api/verify.js', '@@ -1 +1 @@', '-const RE = /^(yes|ok)$/i;', '+const RE = /^(yes|ok|go for it)$/i;', ''].join('\n');
    const committed = commitVerifiedPatch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, patch: backendPatch, message: 'Bob Builder: backend change' });
    assert.deepEqual(committed.changedFiles, ['services/api/verify.js']);
    assert.equal(git(repo.root, ['show', `${committed.commitSha}:services/api/verify.js`]), 'const RE = /^(yes|ok|go for it)$/i;');
    const protectedPatch = ['diff --git a/package.json b/package.json', '--- a/package.json', '+++ b/package.json', '@@ -1 +1 @@', '-{"name":"fixture"}', '+{"name":"fixture","dependencies":{"left-pad":"*"}}', ''].join('\n');
    assert.throws(() => commitVerifiedPatch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, patch: protectedPatch, message: 'x' }), /protected changes require separate approval: package.json/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('an unbound scratch workspace left dirty by an interrupted run is restored to the pin only when asked', () => {
  const repo = fixture();
  try {
    const first = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: 'abcdefabcdefabcdefabcdef', targetSha: repo.sha });
    fs.writeFileSync(path.join(first.workspacePath, 'apps/web/src/example.ts'), 'export const value = 99;\n');
    fs.writeFileSync(path.join(first.workspacePath, 'scratch.txt'), 'left behind\n');
    // Default behaviour is unchanged: a dirty workspace is refused (a bound/published branch must never be silently reset).
    assert.throws(() => createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: 'abcdefabcdefabcdefabcdef', targetSha: repo.sha }), /must be clean/);
    const recovered = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: 'abcdefabcdefabcdefabcdef', targetSha: repo.sha, recoverInterrupted: true });
    assert.equal(recovered.existing, true);
    assert.equal(recovered.head, repo.sha);
    assert.equal(git(recovered.workspacePath, ['status', '--porcelain', '--untracked-files=normal']), '');
    assert.equal(fs.readFileSync(path.join(recovered.workspacePath, 'apps/web/src/example.ts'), 'utf8'), 'export const value = 1;\n');
    assert.equal(fs.existsSync(path.join(recovered.workspacePath, 'scratch.txt')), false);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('Builder branch names are deterministic and cannot target protected branches', () => {
  assert.equal(branchNameForJob('abcdefgh-1234'), 'bob/job-abcdefgh1234');
  assert.throws(() => branchNameForJob('short'), /invalid/);
});

test('Builder recognizes HTTPS and SSH Gitea remotes as the same repository identity', () => {
  const { giteaRepositoryPath } = require('../builder-branch-workspace');
  assert.equal(giteaRepositoryPath('https://git.fcmanager.co.nz/Iron-Eagle-Security-Ltd/field-compliance-manager.git'), 'Iron-Eagle-Security-Ltd/field-compliance-manager');
  assert.equal(giteaRepositoryPath('ssh://git@git.fcmanager.co.nz:2222/Iron-Eagle-Security-Ltd/field-compliance-manager.git'), 'Iron-Eagle-Security-Ltd/field-compliance-manager');
  assert.equal(giteaRepositoryPath('git@git.fcmanager.co.nz:Iron-Eagle-Security-Ltd/field-compliance-manager.git'), 'Iron-Eagle-Security-Ltd/field-compliance-manager');
});

test('Builder publication rejects a workspace whose recorded head is stale', () => {
  const repo = fixture();
  try {
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: '12345678-1234-1234-1234-123456789abc', targetSha: repo.sha });
    assert.throws(() => publishWorkspaceBranch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, expectedHeadSha: '0'.repeat(40) }), /stale/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('Builder pull request creation requires the configured self-hosted Gitea remote', async () => {
  const repo = fixture();
  try {
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: '12345678-1234-1234-1234-123456789abc', targetSha: repo.sha });
    await assert.rejects(createGiteaPullRequest({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, expectedHeadSha: repo.sha, title: 'PR', body: 'Review', giteaBaseUrl: 'https://gitea.internal', giteaToken: 'token', owner: 'Iron-Eagle-Security-Ltd', repo: 'field-compliance-manager' }), /configured Gitea repository/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('Builder opens a human-review-only pull request through the configured Gitea API', async () => {
  const repo = fixture();
  try {
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: '12345678-1234-1234-1234-123456789abc', targetSha: repo.sha });
    git(workspace.workspacePath, ['remote', 'add', 'origin', 'https://gitea.internal/Iron-Eagle-Security-Ltd/field-compliance-manager.git']);
    let request;
    const result = await createGiteaPullRequest({
      workspacePath: workspace.workspacePath,
      branchName: workspace.branchName,
      expectedHeadSha: repo.sha,
      title: 'Bob Builder: review',
      body: 'Human review only.',
      giteaBaseUrl: 'https://gitea.internal',
      giteaToken: 'token',
      owner: 'Iron-Eagle-Security-Ltd',
      repo: 'field-compliance-manager',
      fetchImpl: async (url, init) => {
        request = { url, init };
        return { ok: true, json: async () => ({ html_url: 'https://gitea.internal/Iron-Eagle-Security-Ltd/field-compliance-manager/pulls/42' }) };
      }
    });
    assert.equal(request.url, 'https://gitea.internal/api/v1/repos/Iron-Eagle-Security-Ltd/field-compliance-manager/pulls');
    assert.equal(request.init.headers.Authorization, 'token token');
    assert.deepEqual(JSON.parse(request.init.body), { base: 'main', head: workspace.branchName, title: 'Bob Builder: review', body: 'Human review only.' });
    assert.equal(result.url, 'https://gitea.internal/Iron-Eagle-Security-Ltd/field-compliance-manager/pulls/42');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});