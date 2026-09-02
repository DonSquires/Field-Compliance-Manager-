const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260902110000_builder_gitea_pull_requests.sql'), 'utf8');
const adapter = fs.readFileSync(path.resolve(__dirname, '../builder-branch-workspace.js'), 'utf8');

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
  assert.doesNotMatch(adapter, /github\.com/);
});