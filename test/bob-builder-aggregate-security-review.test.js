const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830183000_builder_aggregate_security_review.sql'),
  'utf8'
);

test('aggregate security claim accepts at most one frontend and one backend worker', () => {
  assert.match(migration, /cardinality\(_implementation_worker_run_ids\) NOT BETWEEN 1 AND 2/);
  assert.match(migration, /count\(DISTINCT profile\)/);
  assert.match(migration, /'frontend-verify', 'backend-verify'/);
});

test('aggregate security claim binds every patch, manifest, and log to tenant and target SHA', () => {
  assert.match(migration, /run\.organization_id = _job\.organization_id/);
  assert.match(migration, /run\.target_sha = _job\.target_sha/);
  assert.match(migration, /artifact_type = 'changed_file_manifest'/);
  assert.match(migration, /artifact_type = 'build_logs'/);
  assert.match(migration, /_patch_ids \|\| _manifest_ids \|\| _log_ids/);
});

test('aggregate security claim is service-only', () => {
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION public\.builder_claim_aggregate_security_review[\s\S]*FROM PUBLIC,anon,authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.builder_claim_aggregate_security_review[\s\S]*TO service_role/);
});