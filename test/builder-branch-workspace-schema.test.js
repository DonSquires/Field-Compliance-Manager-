const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260901024000_builder_branch_workspaces.sql'), 'utf8');

test('Builder workspace binding is service-only and pinned to the job target SHA', () => {
  assert.match(migration, /workspace_branch text/);
  assert.match(migration, /workspace_head_sha text/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_bind_workspace/);
  assert.match(migration, /_workspace_head_sha IS DISTINCT FROM _job\.target_sha/);
  assert.match(migration, /\^bob\/job-\[a-z0-9\]\+\$/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.builder_bind_workspace.*TO service_role/);
});