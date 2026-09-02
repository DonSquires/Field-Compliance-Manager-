const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260901027000_builder_github_pull_requests.sql'), 'utf8');
const adapter = fs.readFileSync(path.resolve(__dirname, '../builder-branch-workspace.js'), 'utf8');

test('Builder GitHub pull requests require a published current branch and cannot merge or deploy', () => {
  assert.match(migration, /workspace_pull_request_url text/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_record_workspace_pull_request/);
  assert.match(migration, /workspace_published_head_sha IS DISTINCT FROM _expected_head_sha/);
  assert.match(migration, /no merge or deployment performed/);
  assert.match(adapter, /function createGithubPullRequest/);
  assert.match(adapter, /--base', 'main'/);
  assert.match(adapter, /--head', branchName/);
  assert.doesNotMatch(adapter, /pr merge/);
});