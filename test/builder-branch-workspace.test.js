const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { VERIFIED_GITHUB_EMAIL, branchNameForJob, builderCommitIdentity, createBranchWorkspace, createDetachedWorkspace, commitVerifiedPatch, publishWorkspaceBranch, createGiteaPullRequest, mergeGitHubPullRequest, readGitHubPullRequestState } = require('../builder-branch-workspace');
const { retireTerminalWorkspace } = require('../builder-branch-workspace');

const patch = ['diff --git a/apps/web/src/example.ts b/apps/web/src/example.ts', '--- a/apps/web/src/example.ts', '+++ b/apps/web/src/example.ts', '@@ -1 +1 @@', '-export const value = 1;', '+export const value = 2;', ''].join('\n');

function git(directory, args) { return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim(); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-branch-workspace-'));
  fs.mkdirSync(path.join(root, 'apps/web/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps/web/src/example.ts'), 'export const value = 1;\n');
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.com']); git(root, ['add', '.']); git(root, ['commit', '-qm', 'fixture']);
  return { root, sha: git(root, ['rev-parse', 'HEAD']), workspaceRoot: path.join(root, '.builder-workspaces') };
}

test('terminal workspace retention preserves active, dirty and unpublished work and removes only eligible worktrees', () => {
  const repo = fixture();
  try {
    const job = { id: '12345678-1234-1234-1234-123456789abc', status: 'cancelled', target_sha: repo.sha, updated_at: new Date(Date.now() - 8 * 86400000).toISOString() };
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: job.id, targetSha: repo.sha });
    const input = { sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, job };
    assert.equal(retireTerminalWorkspace({ ...input, activeExecution: true }).reason, 'active_or_awaiting_approval');
    assert.equal(retireTerminalWorkspace({ ...input, pendingApproval: true }).reason, 'active_or_awaiting_approval');
    assert.equal(retireTerminalWorkspace({ ...input, job: { ...job, status: 'building' } }).reason, 'not_terminal');
    assert.equal(retireTerminalWorkspace({ ...input, job: { ...job, updated_at: new Date().toISOString() } }).reason, 'retention_window');
    fs.writeFileSync(path.join(workspace.workspacePath, 'unpublished.txt'), 'keep me');
    assert.equal(retireTerminalWorkspace(input).reason, 'local_files');
    fs.unlinkSync(path.join(workspace.workspacePath, 'unpublished.txt'));
    const committed = commitVerifiedPatch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, patch, message: 'unpublished work' });
    assert.equal(retireTerminalWorkspace(input).reason, 'unpublished_commits');
    const published = { ...job, workspace_published_head_sha: committed.commitSha };
    assert.equal(retireTerminalWorkspace({ ...input, job: published }).reason, 'publication_not_confirmed');
    git(repo.root, ['update-ref', `refs/remotes/origin/${workspace.branchName}`, committed.commitSha]);
    assert.equal(retireTerminalWorkspace({ ...input, job: published }).reason, 'dry_run');
    assert.ok(fs.existsSync(workspace.workspacePath));
    assert.equal(retireTerminalWorkspace({ ...input, job: published, dryRun: false }).removed, true);
    assert.ok(!fs.existsSync(workspace.workspacePath));
    assert.equal(git(repo.root, ['rev-parse', workspace.branchName]), committed.commitSha, 'the branch and its commits remain');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('terminal workspace retention refuses symbolic links and unknown timestamps', () => {
  const repo = fixture();
  try {
    const job = { id: '12345678-1234-1234-1234-123456789abc', status: 'failed', target_sha: repo.sha, updated_at: new Date(0).toISOString() };
    fs.mkdirSync(repo.workspaceRoot);
    fs.symlinkSync(repo.root, path.join(repo.workspaceRoot, 'bob-job-12345678123412341234'), 'junction');
    const input = { sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, job };
    assert.equal(retireTerminalWorkspace(input).reason, 'symlink');
    assert.equal(retireTerminalWorkspace({ ...input, job: { ...job, updated_at: 'invalid' } }).reason, 'retention_window');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});
test('Builder can require an explicitly configured verified GitHub commit identity', () => {
  const previousName = process.env.BOB_BUILDER_GIT_NAME;
  const previousEmail = process.env.BOB_BUILDER_GIT_EMAIL;
  try {
    delete process.env.BOB_BUILDER_GIT_NAME;
    delete process.env.BOB_BUILDER_GIT_EMAIL;
    assert.throws(() => builderCommitIdentity({ requireVerified: true }), /BOB_BUILDER_GIT_EMAIL/);
    process.env.BOB_BUILDER_GIT_NAME = 'Don Squires';
    process.env.BOB_BUILDER_GIT_EMAIL = 'unverified@example.com';
    assert.throws(() => builderCommitIdentity({ requireVerified: true }), /verified GitHub identity/);
    process.env.BOB_BUILDER_GIT_NAME = 'Don Squires';
    process.env.BOB_BUILDER_GIT_EMAIL = VERIFIED_GITHUB_EMAIL;
    assert.throws(() => builderCommitIdentity({ requireVerified: true }), /verified GitHub identity/);
    process.env.BOB_BUILDER_GIT_NAME = 'DonSquires';
    process.env.BOB_BUILDER_GIT_EMAIL = 'squires.don@gmail.com';
    assert.deepEqual(builderCommitIdentity({ requireVerified: true }), {
      name: 'DonSquires',
      email: 'squires.don@gmail.com',
    });
    process.env.BOB_BUILDER_GIT_NAME = 'Don Squires';
    process.env.BOB_BUILDER_GIT_EMAIL = '256263525+DonSquires@users.noreply.github.com';
    assert.throws(() => builderCommitIdentity({ requireVerified: true }), /verified GitHub identity/);
    process.env.BOB_BUILDER_GIT_NAME = 'DonSquires';
    process.env.BOB_BUILDER_GIT_EMAIL = VERIFIED_GITHUB_EMAIL.toUpperCase();
    assert.throws(() => builderCommitIdentity({ requireVerified: true }), /verified GitHub identity/);
  } finally {
    if (previousName === undefined) delete process.env.BOB_BUILDER_GIT_NAME;
    else process.env.BOB_BUILDER_GIT_NAME = previousName;
    if (previousEmail === undefined) delete process.env.BOB_BUILDER_GIT_EMAIL;
    else process.env.BOB_BUILDER_GIT_EMAIL = previousEmail;
  }
});

test('retention recognises the designated legacy clone only, without treating arbitrary repositories as owned', () => {
  const repo = fixture();
  const other = fixture();
  try {
    const job = { id: '12345678-1234-1234-1234-123456789abc', status: 'cancelled', target_sha: repo.sha, updated_at: new Date(0).toISOString() };
    createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: job.id, targetSha: repo.sha });
    const input = { sourceDir: other.root, workspaceRoot: repo.workspaceRoot, job };
    assert.equal(retireTerminalWorkspace(input).reason, 'different_repository');
    assert.equal(retireTerminalWorkspace({ ...input, legacySourceDir: repo.root }).reason, 'dry_run');
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(other.root, { recursive: true, force: true });
  }
});
test('Builder branch workspace is pinned, isolated, and commits only validated patches', () => {
  const repo = fixture();
  try {
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: '12345678-1234-1234-1234-123456789abc', targetSha: repo.sha });
    assert.equal(workspace.branchName, 'bob/job-12345678123412341234');
    assert.equal(workspace.head, repo.sha);
    const committed = commitVerifiedPatch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, patch, message: 'Bob Builder: update example', body: 'Builder job j-1\nVerified patch artifact a-1' });
    assert.match(committed.commitSha, /^[a-f0-9]{40}$/);
    assert.equal(git(repo.root, ['log', '-1', '--format=%s', committed.commitSha]), 'Bob Builder: update example');
    assert.equal(git(repo.root, ['log', '-1', '--format=%b', committed.commitSha]).trim(), 'Builder job j-1\nVerified patch artifact a-1', 'the body carries provenance a reviewer can follow');
    assert.deepEqual(committed.changedFiles, ['apps/web/src/example.ts']);
    assert.equal(git(repo.root, ['show', `${committed.commitSha}:apps/web/src/example.ts`]), 'export const value = 2;');
    assert.equal(git(repo.root, ['show', `${repo.sha}:apps/web/src/example.ts`]), 'export const value = 1;');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('detached verification workspace remains pinned when the shared source checkout moves', () => {
  const repo = fixture();
  try {
    const firstSha = repo.sha;
    const snapshot = createDetachedWorkspace({
      sourceDir: repo.root,
      workspaceRoot: path.join(repo.workspaceRoot, 'main-health'),
      targetSha: firstSha,
    });
    fs.writeFileSync(path.join(repo.root, 'apps/web/src/example.ts'), 'export const value = 2;\n');
    git(repo.root, ['add', '.']);
    git(repo.root, ['commit', '-qm', 'move shared source']);
    const secondSha = git(repo.root, ['rev-parse', 'HEAD']);

    assert.notEqual(secondSha, firstSha);
    assert.equal(git(snapshot.workspacePath, ['rev-parse', 'HEAD']), firstSha);
    assert.equal(fs.readFileSync(path.join(snapshot.workspacePath, 'apps/web/src/example.ts'), 'utf8'), 'export const value = 1;\n');
    assert.equal(createDetachedWorkspace({
      sourceDir: repo.root,
      workspaceRoot: path.join(repo.workspaceRoot, 'main-health'),
      targetSha: firstSha,
    }).existing, true);
    assert.throws(() => createDetachedWorkspace({
      sourceDir: repo.root,
      workspaceRoot: path.join(repo.workspaceRoot, 'main-health'),
      targetSha: '../main',
    }), /full Git SHA/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('detached verification workspace retention removes only old clean snapshots', () => {
  const repo = fixture();
  const healthRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-health-snapshots-'));
  try {
    const shas = [repo.sha];
    for (const value of [2, 3]) {
      fs.writeFileSync(path.join(repo.root, 'apps/web/src/example.ts'), `export const value = ${value};\n`);
      git(repo.root, ['add', '.']);
      git(repo.root, ['commit', '-qm', `fixture ${value}`]);
      shas.push(git(repo.root, ['rev-parse', 'HEAD']));
    }
    for (const sha of shas) {
      git(repo.root, ['checkout', '--detach', '-q', sha]);
      createDetachedWorkspace({ sourceDir: repo.root, workspaceRoot: healthRoot, targetSha: sha, retentionCount: 2 });
    }

    assert.equal(fs.existsSync(path.join(healthRoot, `snapshot-${shas[2]}`)), true);
    assert.equal(fs.readdirSync(healthRoot).filter((name) => name.startsWith('snapshot-')).length, 2);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(healthRoot, { recursive: true, force: true });
  }
});

test('a damaged retired snapshot is kept for inspection and never blocks the active check', () => {
  const repo = fixture();
  const healthRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-health-damaged-'));
  try {
    const shas = [repo.sha];
    for (const value of [2, 3]) {
      fs.writeFileSync(path.join(repo.root, 'apps/web/src/example.ts'), `export const value = ${value};\n`);
      git(repo.root, ['add', '.']);
      git(repo.root, ['commit', '-qm', `fixture ${value}`]);
      shas.push(git(repo.root, ['rev-parse', 'HEAD']));
    }
    const damaged = createDetachedWorkspace({ sourceDir: repo.root, workspaceRoot: healthRoot, targetSha: shas[0], retentionCount: 1 });
    // Production shape: an interrupted removal left the index stripped (every file staged as deleted).
    git(damaged.workspacePath, ['rm', '-q', '--cached', '-r', '.']);
    const clean = createDetachedWorkspace({ sourceDir: repo.root, workspaceRoot: healthRoot, targetSha: shas[1], retentionCount: 1 });
    assert.equal(fs.existsSync(damaged.workspacePath), true, 'a damaged snapshot is not deleted blind');
    assert.deepEqual(clean.unverifiedSnapshots.map((entry) => entry.path), [`snapshot-${shas[0]}`]);
    assert.match(clean.unverifiedSnapshots[0].error, /must be clean/);

    const next = createDetachedWorkspace({ sourceDir: repo.root, workspaceRoot: healthRoot, targetSha: shas[2], retentionCount: 1 });
    assert.equal(git(next.workspacePath, ['rev-parse', 'HEAD']), shas[2]);
    assert.equal(fs.existsSync(clean.workspacePath), false, 'clean retired snapshots are still pruned');
    assert.equal(fs.existsSync(damaged.workspacePath), true);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
    fs.rmSync(healthRoot, { recursive: true, force: true });
  }
});

test('new workspaces use the requested commit even when the shared checkout has moved or has unrelated edits', () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo.root, 'apps/web/src/example.ts'), 'export const value = 2;\n');
    git(repo.root, ['add', 'apps/web/src/example.ts']);
    git(repo.root, ['commit', '-qm', 'advance shared checkout']);
    const head = git(repo.root, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo.root, 'apps/web/src/example.ts'), 'export const value = 3;\n');
    for (const workspace of [
      createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: 'oldpin12345678', targetSha: repo.sha }),
      createDetachedWorkspace({ sourceDir: repo.root, workspaceRoot: path.join(repo.workspaceRoot, 'checks'), targetSha: repo.sha }),
    ]) {
      assert.equal(git(workspace.workspacePath, ['rev-parse', 'HEAD']), repo.sha);
      assert.equal(git(workspace.workspacePath, ['status', '--porcelain']), '');
      assert.equal(fs.readFileSync(path.join(workspace.workspacePath, 'apps/web/src/example.ts'), 'utf8'), 'export const value = 1;\n');
    }
    assert.equal(git(repo.root, ['rev-parse', 'HEAD']), head);
    assert.equal(fs.readFileSync(path.join(repo.root, 'apps/web/src/example.ts'), 'utf8'), 'export const value = 3;\n');
    const treeSha = git(repo.root, ['rev-parse', 'HEAD^{tree}']);
    assert.throws(() => createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: 'notcommit12345678', targetSha: treeSha }), /must identify a commit/);
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
    const dependencyPatch = ['diff --git a/package.json b/package.json', '--- a/package.json', '+++ b/package.json', '@@ -1 +1 @@', '-{"name":"fixture"}', '+{"name":"fixture","dependencies":{"left-pad":"*"}}', ''].join('\n');
    const dependencyCommit = commitVerifiedPatch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, patch: dependencyPatch, message: 'Bob Builder: verified dependency change' });
    assert.deepEqual(dependencyCommit.changedFiles, ['package.json']);
    assert.deepEqual(JSON.parse(git(repo.root, ['show', `${dependencyCommit.commitSha}:package.json`])).dependencies, { 'left-pad': '*' });
    const protectedPatch = ['diff --git a/vercel.json b/vercel.json', 'new file mode 100644', '--- /dev/null', '+++ b/vercel.json', '@@ -0,0 +1 @@', '+{}', ''].join('\n');
    assert.throws(() => commitVerifiedPatch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, patch: protectedPatch, message: 'x' }), /protected changes require separate approval: vercel.json/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('a verified patch that creates a new file commits with an exact manifest, and a failed commit leaves the workspace clean', () => {
  const repo = fixture();
  try {
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: 'f6fbd0da474b48fb92649cc641d9d55f', targetSha: repo.sha });
    // Live failure (job f6fbd0da): the added test file was untracked after `git apply`, `git diff`
    // omitted it, and the manifest check rejected an exact patch — then the half-applied tree
    // wedged every later publish attempt on "must be clean".
    const newFilePatch = [
      'diff --git a/apps/web/src/example.ts b/apps/web/src/example.ts', '--- a/apps/web/src/example.ts', '+++ b/apps/web/src/example.ts', '@@ -1 +1 @@', '-export const value = 1;', '+export const value = 3;',
      'diff --git a/test/example.test.js b/test/example.test.js', 'new file mode 100644', '--- /dev/null', '+++ b/test/example.test.js', '@@ -0,0 +1 @@', '+// added by Bob', ''
    ].join('\n');
    const committed = commitVerifiedPatch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, patch: newFilePatch, message: 'Bob Builder: add a test' });
    assert.deepEqual(committed.changedFiles, ['apps/web/src/example.ts', 'test/example.test.js']);
    assert.equal(git(repo.root, ['show', `${committed.commitSha}:test/example.test.js`]), '// added by Bob');
    assert.equal(git(workspace.workspacePath, ['status', '--porcelain']), '');

    // A patch that no longer applies must not leave a dirty tree behind.
    const stalePatch = ['diff --git a/apps/web/src/example.ts b/apps/web/src/example.ts', '--- a/apps/web/src/example.ts', '+++ b/apps/web/src/example.ts', '@@ -1 +1 @@', '-export const value = 1;', '+export const value = 4;', ''].join('\n');
    assert.throws(() => commitVerifiedPatch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, patch: stalePatch, message: 'x' }));
    assert.equal(git(workspace.workspacePath, ['status', '--porcelain']), '');
    assert.equal(git(workspace.workspacePath, ['rev-parse', 'HEAD']), committed.commitSha);
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
    assert.equal(fs.readFileSync(path.join(recovered.workspacePath, 'apps/web/src/example.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const value = 1;\n');
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

test('GitHub publication rejects an unverified workspace head even when its recorded SHA is current', () => {
  const repo = fixture();
  const previousName = process.env.BOB_BUILDER_GIT_NAME;
  const previousEmail = process.env.BOB_BUILDER_GIT_EMAIL;
  try {
    process.env.BOB_BUILDER_GIT_NAME = 'DonSquires';
    process.env.BOB_BUILDER_GIT_EMAIL = VERIFIED_GITHUB_EMAIL;
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: '22345678-1234-1234-1234-123456789abc', targetSha: repo.sha });
    assert.throws(
      () => publishWorkspaceBranch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, expectedHeadSha: repo.sha, requireVerifiedIdentity: true }),
      /verified GitHub identity/
    );
  } finally {
    if (previousName === undefined) delete process.env.BOB_BUILDER_GIT_NAME;
    else process.env.BOB_BUILDER_GIT_NAME = previousName;
    if (previousEmail === undefined) delete process.env.BOB_BUILDER_GIT_EMAIL;
    else process.env.BOB_BUILDER_GIT_EMAIL = previousEmail;
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test('Bob preserves a concurrent agent commit while advancing with a verified release head', () => {
  const repo = fixture();
  const previousName = process.env.BOB_BUILDER_GIT_NAME;
  const previousEmail = process.env.BOB_BUILDER_GIT_EMAIL;
  try {
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: '32345678-1234-1234-1234-123456789abc', targetSha: repo.sha });

    fs.writeFileSync(path.join(repo.root, 'apps/web/src/concurrent.ts'), 'export const concurrent = true;\n');
    git(repo.root, ['add', '.']);
    git(repo.root, ['-c', 'user.name=Concurrent Agent', '-c', 'user.email=don@squires.local', 'commit', '-qm', 'concurrent app work']);
    const concurrentSha = git(repo.root, ['rev-parse', 'HEAD']);

    process.env.BOB_BUILDER_GIT_NAME = 'DonSquires';
    process.env.BOB_BUILDER_GIT_EMAIL = VERIFIED_GITHUB_EMAIL;
    const committed = commitVerifiedPatch({
      workspacePath: workspace.workspacePath,
      branchName: workspace.branchName,
      patch,
      message: 'Bob Builder: concurrent-safe change',
      requireVerifiedIdentity: true,
    });
    assert.equal(git(repo.root, ['show', '-s', '--format=%ae', committed.commitSha]), VERIFIED_GITHUB_EMAIL);
    assert.equal(git(repo.root, ['rev-parse', `${committed.commitSha}^`]), repo.sha);

    git(repo.root, ['-c', 'user.name=DonSquires', '-c', `user.email=${VERIFIED_GITHUB_EMAIL}`, 'merge', '--no-ff', '-qm', 'merge Bob after concurrent work', committed.commitSha]);
    const releaseSha = git(repo.root, ['rev-parse', 'HEAD']);
    assert.equal(git(repo.root, ['merge-base', '--is-ancestor', concurrentSha, releaseSha]), '');
    assert.equal(git(repo.root, ['merge-base', '--is-ancestor', committed.commitSha, releaseSha]), '');
    assert.equal(fs.readFileSync(path.join(repo.root, 'apps/web/src/concurrent.ts'), 'utf8'), 'export const concurrent = true;\n');
    assert.equal(fs.readFileSync(path.join(repo.root, 'apps/web/src/example.ts'), 'utf8'), 'export const value = 2;\n');
  } finally {
    if (previousName === undefined) delete process.env.BOB_BUILDER_GIT_NAME;
    else process.env.BOB_BUILDER_GIT_NAME = previousName;
    if (previousEmail === undefined) delete process.env.BOB_BUILDER_GIT_EMAIL;
    else process.env.BOB_BUILDER_GIT_EMAIL = previousEmail;
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
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
    // With a public host configured, people get a link they can open; the API call stays internal.
    const { publicGiteaUrl } = require('../builder-branch-workspace');
    assert.equal(publicGiteaUrl('http://gitea:3000/Iron-Eagle-Security-Ltd/field-compliance-manager/pulls/3', { baseUrl: 'http://gitea:3000', publicBaseUrl: 'https://git.fcmanager.co.nz/' }), 'https://git.fcmanager.co.nz/Iron-Eagle-Security-Ltd/field-compliance-manager/pulls/3');
    assert.equal(publicGiteaUrl('https://gitea.internal/o/r/pulls/1', { baseUrl: 'https://gitea.internal', publicBaseUrl: '' }), 'https://gitea.internal/o/r/pulls/1');
    assert.equal(publicGiteaUrl('https://elsewhere.example/o/r/pulls/1', { baseUrl: 'https://gitea.internal', publicBaseUrl: 'https://git.fcmanager.co.nz' }), 'https://elsewhere.example/o/r/pulls/1');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('Bob merges only the exact open, non-draft GitHub PR targeting main', async () => {
  const sha = 'a'.repeat(40);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith(`/commits/${sha}/check-runs?per_page=100`)) return { ok: true, json: async () => ({ total_count: 1, check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }) };
    if (url.endsWith(`/commits/${sha}/status?per_page=100`)) return { ok: true, json: async () => ({ state: 'success', statuses: [] }) };
    if (url.endsWith('/reviews?per_page=100') || url.endsWith('/comments?per_page=100')) return { ok: true, json: async () => [] };
    if (url.endsWith('/graphql')) return { ok: true, json: async () => ({ data: { node: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } }) };
    if (init.method === 'GET') return { ok: true, json: async () => ({ node_id: 'PR_test', state: 'open', draft: false, head: { sha }, base: { ref: 'main' } }) };
    return { ok: true, json: async () => ({ merged: true, sha: 'b'.repeat(40), merged_at: '2026-10-12T05:00:00Z' }) };
  };
  const merged = await mergeGitHubPullRequest({ number: 17, expectedHeadSha: sha, githubToken: 'token', owner: 'owner', repo: 'repo', fetchImpl });
  assert.deepEqual(merged, { number: 17, sha: 'b'.repeat(40), merged_at: '2026-10-12T05:00:00Z' });
  assert.equal(requests[0].url, 'https://api.github.com/repos/owner/repo/pulls/17');
  const mergeRequest = requests.find(request => request.url.endsWith('/pulls/17/merge'));
  assert.ok(mergeRequest);
  assert.deepEqual(JSON.parse(mergeRequest.init.body), { sha, merge_method: 'rebase' });
});

test('Bob refuses a changed-head, closed, or non-main GitHub pull request', async () => {
  const sha = 'a'.repeat(40);
  for (const pullRequest of [
    { state: 'open', draft: false, head: { sha: 'b'.repeat(40) }, base: { ref: 'main' } },
    { state: 'closed', draft: false, head: { sha }, base: { ref: 'main' } },
    { state: 'open', draft: false, head: { sha }, base: { ref: 'release' } },
  ]) {
    let mergeRequested = false;
    await assert.rejects(mergeGitHubPullRequest({
      number: 17,
      expectedHeadSha: sha,
      githubToken: 'token',
      owner: 'owner',
      repo: 'repo',
      fetchImpl: async (_url, init) => {
        if (init.method === 'PUT') mergeRequested = true;
        return { ok: true, json: async () => pullRequest };
      },
    }), /not the verified open main-targeted change/);
    assert.equal(mergeRequested, false);
  }
});
test('readGitHubPullRequestState reports merged, closed and open PRs only for the configured repository', async () => {
  const pulls = {
    1: { merged: true, merged_at: '2026-10-25T02:40:00Z', merge_commit_sha: 'c'.repeat(40), merged_by: { login: 'DonSquires' }, head: { sha: 'd'.repeat(40) }, base: { ref: 'main' }, state: 'closed' },
    2: { merged: false, merged_at: null, state: 'closed', closed_at: '2026-10-24T00:00:00Z', head: { sha: 'e'.repeat(40) } },
    3: { node_id: 'PR_test', merged: false, state: 'open', draft: true, head: { sha: 'f'.repeat(40) }, base: { ref: 'main' } },
  };
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith('/check-runs?per_page=100')) return { ok: true, status: 200, json: async () => ({ total_count: 1, check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }) };
    if (url.endsWith('/status?per_page=100')) return { ok: true, status: 200, json: async () => ({ state: 'success', statuses: [] }) };
    if (url.endsWith('/reviews?per_page=100') || url.endsWith('/comments?per_page=100')) return { ok: true, status: 200, json: async () => [] };
    if (url.endsWith('/graphql')) return { ok: true, status: 200, json: async () => ({ data: { node: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } }) };
    const number = Number(url.split('/').pop());
    return { ok: Boolean(pulls[number]), status: pulls[number] ? 200 : 404, json: async () => pulls[number] || {} };
  };
  const read = (url) => readGitHubPullRequestState({ url, githubToken: 'token', owner: 'Owner', repo: 'repo', fetchImpl });
  assert.deepEqual(await read('https://github.com/owner/repo/pull/1'), { state: 'merged', mergeSha: 'c'.repeat(40), mergedAt: '2026-10-25T02:40:00Z', mergedBy: 'DonSquires', headSha: 'd'.repeat(40), baseRef: 'main' });
  assert.deepEqual(await read('https://github.com/owner/repo/pull/2'), { state: 'closed', closedAt: '2026-10-24T00:00:00Z', headSha: 'e'.repeat(40) });
  assert.deepEqual(await read('https://github.com/owner/repo/pull/3'), {
    state: 'open', draft: true, headSha: 'f'.repeat(40), baseRef: 'main', checks: 'success',
    checkRuns: [{ name: 'CI', status: 'completed', conclusion: 'success' }], feedback: [], feedbackComplete: true, error: null,
  });
  assert.equal((await read('https://github.com/owner/repo/pull/4')).state, 'unknown');
  assert.equal((await read('https://github.com/someone/else/pull/1')).state, 'unknown');
  assert.equal((await readGitHubPullRequestState({ url: 'https://github.com/owner/repo/pull/1', githubToken: '', owner: 'owner', repo: 'repo', fetchImpl })).state, 'unknown');
  assert.equal(requested.filter(url => /\/pulls\/[1-4]$/.test(url)).length, 4, 'foreign or unconfigured PRs are never fetched');
  assert.ok(requested.every(url => url.startsWith('https://api.github.com/')));
});

test('publication may replace only remote branch tips this workspace produced itself', () => {
  const repo = fixture();
  const previousName = process.env.BOB_BUILDER_GIT_NAME;
  const previousEmail = process.env.BOB_BUILDER_GIT_EMAIL;
  try {
    process.env.BOB_BUILDER_GIT_NAME = 'DonSquires';
    process.env.BOB_BUILDER_GIT_EMAIL = VERIFIED_GITHUB_EMAIL;
    const remote = path.join(repo.root, '.remote.git');
    git(repo.root, ['init', '-q', '--bare', remote]);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    const workspace = createBranchWorkspace({ sourceDir: repo.root, workspaceRoot: repo.workspaceRoot, jobId: '42345678-1234-1234-1234-123456789abc', targetSha: repo.sha });
    const first = commitVerifiedPatch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, patch, message: 'Bob Builder: first', requireVerifiedIdentity: true });
    publishWorkspaceBranch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, expectedHeadSha: first.commitSha, replaceOwnHistory: true });
    const remoteHead = () => git(repo.root, ['ls-remote', remote, `refs/heads/${workspace.branchName}`]).split(/\s+/)[0];
    assert.equal(remoteHead(), first.commitSha);

    fs.writeFileSync(path.join(repo.root, 'apps/web/src/main-only.ts'), 'export const mainOnly = true;\n');
    git(repo.root, ['add', 'apps/web/src/main-only.ts']);
    git(repo.root, ['commit', '-qm', 'main moved']);
    const main = git(repo.root, ['rev-parse', 'HEAD']);
    git(workspace.workspacePath, ['-c', 'user.name=DonSquires', '-c', `user.email=${VERIFIED_GITHUB_EMAIL}`, 'rebase', '-q', main]);
    const rebased = git(workspace.workspacePath, ['rev-parse', 'HEAD']);
    assert.throws(() => publishWorkspaceBranch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, expectedHeadSha: rebased }), /rejected|non-fast-forward|failed to push/i);
    publishWorkspaceBranch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, expectedHeadSha: rebased, replaceOwnHistory: true });
    assert.equal(remoteHead(), rebased);

    git(repo.root, ['commit', '-q', '--allow-empty', '-m', 'someone else pushed this']);
    const foreign = git(repo.root, ['rev-parse', 'HEAD']);
    git(repo.root, ['push', '-q', '--force', remote, `${foreign}:refs/heads/${workspace.branchName}`]);
    assert.throws(
      () => publishWorkspaceBranch({ workspacePath: workspace.workspacePath, branchName: workspace.branchName, expectedHeadSha: rebased, replaceOwnHistory: true }),
      /did not produce/
    );
    assert.equal(remoteHead(), foreign, 'a tip this workspace never had is never overwritten');
  } finally {
    if (previousName === undefined) delete process.env.BOB_BUILDER_GIT_NAME;
    else process.env.BOB_BUILDER_GIT_NAME = previousName;
    if (previousEmail === undefined) delete process.env.BOB_BUILDER_GIT_EMAIL;
    else process.env.BOB_BUILDER_GIT_EMAIL = previousEmail;
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});
