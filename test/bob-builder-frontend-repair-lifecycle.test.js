const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830110000_builder_frontend_repair.sql'),
  'utf8'
);

test('frontend repair authorization is service-only and bounded to three attempts', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_authorize_frontend_repair/);
  assert.match(migration, /IF auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /_step\.attempt_count >= 3/);
  assert.match(migration, /'authorized', false/);
  assert.doesNotMatch(migration, /RAISE EXCEPTION 'Frontend repair attempt limit reached'/);
  assert.match(migration, /_step\.status <> 'failed' OR NOT _step\.retryable/);
  assert.match(migration, /_failed_run\.target_sha IS DISTINCT FROM _job\.target_sha/);
  assert.match(migration, /artifact_type <> 'build_logs'/);
  assert.match(migration, /'model_run_started'/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
});