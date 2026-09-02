const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260901026000_builder_workspace_publication.sql'), 'utf8');

test('Builder branch publication is service-only and bound to the current workspace head', () => {
  assert.match(migration, /workspace_published_at timestamptz/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_record_workspace_publication/);
  assert.match(migration, /_job\.workspace_head_sha IS DISTINCT FROM _expected_head_sha/);
  assert.match(migration, /no merge or deployment performed/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.builder_record_workspace_publication.*TO service_role/);
});