const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260902110000_builder_gitea_pull_requests.sql'), 'utf8');
const hostsMigration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260926090000_builder_pull_request_hosts.sql'), 'utf8');
const adapter = fs.readFileSync(path.resolve(__dirname, '../builder-branch-workspace.js'), 'utf8');
const controlPlane = fs.readFileSync(path.resolve(__dirname, '../bob-control-plane-server.js'), 'utf8');
const dockerfile = fs.readFileSync(path.resolve(__dirname, '../Dockerfile'), 'utf8');
const workspace = require('../builder-branch-workspace');

test('Builder Gitea pull requests require a published current branch and cannot merge or deploy', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS workspace_pull_request_url text/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS workspace_pull_request_head_sha text/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_record_workspace_pull_request/);
  assert.match(migration, /workspace_published_head_sha IS DISTINCT FROM _expected_head_sha/);
  assert.match(migration, /self-hosted Gitea pull request for human review; no merge or deployment performed/);
  assert.match(migration, /\^https\?:\/\/\[\^\[:space:\]\]\+\/pulls\/\[0-9\]\+\$/);
  assert.match(adapter, /async function createGiteaPullRequest/);
  assert.match(adapter, /\/api\/v1\/repos/);
  assert.match(adapter, /base: 'main', head: branchName/);
});

test('GitHub and Gitea pull-request URLs are both accepted as review records, nothing else', () => {
  assert.match(hostsMigration, /github\\\.com\/\[\^\/\[:space:\]\]\+\/\[\^\/\[:space:\]\]\+\/pull\/\[0-9\]\+\$/);
  assert.match(hostsMigration, /\/pulls\/\[0-9\]\+\$/);
  assert.match(hostsMigration, /no merge or deployment performed/);
  assert.match(hostsMigration, /GRANT EXECUTE ON FUNCTION public\.builder_record_workspace_pull_request\(uuid,text,text\) TO service_role/);
});

test('GitHub adapter opens verified PRs and exposes only the guarded direct merge helper', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-gh-adapter-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', 'bob/job-abcdef1234']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-q', '-m', 'fix']);
  const head = git(['rev-parse', 'HEAD']);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/git/ref/heads/bob%2Fjob-abcdef1234')) return { ok: true, status: 200, json: async () => ({ object: { sha: head } }) };
    if (url.endsWith('/pulls')) {
      const body = JSON.parse(init.body);
      assert.equal(body.draft, true);
      assert.equal(body.base, 'main');
      assert.equal(body.head, 'bob/job-abcdef1234');
      return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/DonSquires/Field-Compliance-Manager-/pull/42', number: 42 }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await workspace.createGitHubPullRequest({ workspacePath: repo, branchName: 'bob/job-abcdef1234', expectedHeadSha: head, title: 'Bob Builder: fix', body: 'review', githubToken: 'ghp_test', owner: 'DonSquires', repo: 'Field-Compliance-Manager-', fetchImpl });
  assert.equal(result.url, 'https://github.com/DonSquires/Field-Compliance-Manager-/pull/42');
  assert.equal(result.draft, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].init.headers.Authorization, /^Bearer ghp_test$/);
  assert.equal(calls[0].init.headers['X-GitHub-Api-Version'], '2022-11-28');

  await assert.rejects(
    workspace.createGitHubPullRequest({ workspacePath: repo, branchName: 'bob/job-abcdef1234', expectedHeadSha: head, title: 't', body: 'b', githubToken: 'ghp_test', owner: 'DonSquires', repo: 'Field-Compliance-Manager-', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ object: { sha: 'f'.repeat(40) } }) }) }),
    /Published GitHub branch does not match the verified head/
  );
  await assert.rejects(
    workspace.createGitHubPullRequest({ workspacePath: repo, branchName: 'feature/x', expectedHeadSha: head, title: 't', body: 'b', githubToken: 'ghp_test', owner: 'o', repo: 'r', fetchImpl }),
    /Builder workspace branch is invalid/
  );
  assert.match(adapter, /async function mergeGitHubPullRequest/);
  assert.match(adapter, /pullRequest\.data\?\.head\?\.sha !== expectedHeadSha/);
  assert.match(adapter, /pullRequest\.data\?\.base\?\.ref !== 'main'/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('GitHub adapter opens eligible PRs ready and recovers an interrupted draft before merging', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-gh-automerge-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', 'bob/job-automerge1']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-q', '-m', 'fix']);
  const head = git(['rev-parse', 'HEAD']);
  const calls = [];
  const pull = { node_id: 'PR_kwDOTest', state: 'open', draft: true, head: { sha: head }, base: { ref: 'main' } };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/git/ref/heads/bob%2Fjob-automerge1')) return { ok: true, status: 200, json: async () => ({ object: { sha: head } }) };
    if (url.endsWith('/pulls') && init.method === 'POST') {
      assert.equal(JSON.parse(init.body).draft, false);
      return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/DonSquires/Field-Compliance-Manager-/pull/43', number: 43 }) };
    }
    if (url.endsWith('/pulls/43') && init.method === 'GET') return { ok: true, status: 200, json: async () => pull };
    if (url.endsWith('/graphql')) {
      const body = JSON.parse(init.body);
      assert.equal(body.variables.pullRequestId, pull.node_id);
      assert.match(body.query, /markPullRequestReadyForReview/);
      return { ok: true, status: 200, json: async () => ({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false, headRefOid: head, baseRefName: 'main', state: 'OPEN' } } } }) };
    }
    if (url.endsWith('/pulls/43/merge')) return { ok: true, status: 200, json: async () => ({ merged: true, sha: 'f'.repeat(40) }) };
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  const created = await workspace.createGitHubPullRequest({ workspacePath: repo, branchName: 'bob/job-automerge1', expectedHeadSha: head, title: 'Bob Builder: fix', body: 'review', githubToken: 'ghp_test', owner: 'DonSquires', repo: 'Field-Compliance-Manager-', draft: false, fetchImpl });
  assert.equal(created.draft, false);
  const merged = await workspace.mergeGitHubPullRequest({ number: 43, expectedHeadSha: head, githubToken: 'ghp_test', owner: 'DonSquires', repo: 'Field-Compliance-Manager-', fetchImpl });
  assert.equal(merged.sha, 'f'.repeat(40));
  assert.ok(calls.some(({ url }) => url.endsWith('/graphql')));
  fs.rmSync(repo, { recursive: true, force: true });
});

test('GitHub credentials travel as a per-invocation header, never inside a remote URL', () => {
  assert.equal(workspace.githubRepoUrl('DonSquires', 'Field-Compliance-Manager-'), 'https://github.com/DonSquires/Field-Compliance-Manager-.git');
  assert.equal(workspace.githubSshRepoUrl('DonSquires', 'Field-Compliance-Manager-'), 'git@github.com:DonSquires/Field-Compliance-Manager-.git');
  assert.throws(() => workspace.githubRepoUrl('Don/Squires', 'x'), /coordinates are invalid/);
  assert.throws(() => workspace.githubSshRepoUrl('Don/Squires', 'x'), /coordinates are invalid/);
  assert.equal(workspace.githubAuthHeader('tok'), `Authorization: Basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
  assert.throws(() => workspace.githubAuthHeader(''), /GitHub token is not configured/);
  assert.match(adapter, /http\.extraheader=\$\{pushAuthHeader\}/);
  assert.match(adapter, /credential-free URL/);
  assert.match(adapter, /GIT_SSH_COMMAND: sshCommand/);
  assert.match(controlPlane, /BOB_GITHUB_ACCESS_TOKEN \|\| process\.env\.GITHUB_API_TOKEN/);
  assert.match(controlPlane, /BOB_GITHUB_SSH_KEY_FILE/);
  assert.match(controlPlane, /BOB_GITHUB_KNOWN_HOSTS_FILE/);
  assert.throws(() => workspace.publishWorkspaceBranch({ workspacePath: '/nonexistent', branchName: 'feature/x', expectedHeadSha: 'a'.repeat(40), pushUrl: 'https://user:tok@github.com/o/r.git' }), /Builder workspace branch is invalid|credential-free URL/);
});

test('a failing git command never echoes an auth header or embedded credential', () => {
  assert.equal(workspace.redactGitError('git -c http.extraheader=Authorization: Basic ZG9uOnNlY3JldA== push https://x:y@host/r.git'), 'git -c http.extraheader=Authorization: [redacted] push https://[redacted]@host/r.git');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-redact-'));
  execFileSync('git', ['init', '-q', repo]);
  assert.throws(
    () => workspace.resolveRemoteHead({ repoUrl: 'http://127.0.0.1:9/none.git', authHeader: 'Authorization: Basic c2VjcmV0', ref: 'main', cwd: repo }),
    (error) => !/c2VjcmV0/.test(String(error.message) + String(error.stderr || '')) && /\[redacted\]|could not be resolved|Connection refused|unable to access/i.test(error.message)
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

test('control plane routes publication and pull requests by git host and keeps git available in the image', () => {
  assert.match(controlPlane, /const builderGitHost = 'github'/);
  assert.match(controlPlane, /BOB_GITHUB_ACCESS_TOKEN \|\| process\.env\.GITHUB_API_TOKEN/);
  assert.match(controlPlane, /BOB_GITHUB_SSH_KEY_FILE/);
  assert.match(controlPlane, /BOB_GITHUB_KNOWN_HOSTS_FILE/);
  assert.match(controlPlane, /const builderSourceConfigured = Boolean\(\(githubSshConfigured \|\| builderApiConfigured\)/);
  // Git transport uses the deployed SSH identity; PR operations require a separate durable API token.
  assert.match(controlPlane, /publishWorkspaceBranch\(\{ workspacePath, branchName: job\.workspace_branch, expectedHeadSha: job\.workspace_head_sha, pushUrl: target\.repoUrl, pushAuthHeader: target\.authHeader, sshCommand: target\.sshCommand \}\)/);
  assert.match(controlPlane, /builderGitHost === 'github'\s*\?\s*await createGitHubPullRequest/);
  assert.match(controlPlane, /mergeGitHubPullRequest\(\{ number: pullRequest\.number/);
  assert.match(controlPlane, /mainHealthEnabled/);
  assert.match(controlPlane, /\/api\/bob\/builder\/repository\/head/);
  assert.match(controlPlane, /const sourceDir = selectBuilderSourceDir\(target\.repoUrl\)/);
  assert.match(controlPlane, /ensureSourceCheckout\(\{ sourceDir, repoUrl: target\.repoUrl, authHeader: target\.authHeader, sshCommand: target\.sshCommand, sha: targetSha \}\)/);
  // Git work never starts from the image copy (it has no .git); assessment reads may.
  assert.doesNotMatch(controlPlane, /createBranchWorkspace\(\{ sourceDir: assessmentRoot/);
  assert.match(dockerfile, /apk add --no-cache git/);
});