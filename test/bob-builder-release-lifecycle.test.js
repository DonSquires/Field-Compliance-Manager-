const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830150000_builder_release_preparation.sql'),
  'utf8'
);

test('release preparation is evidence-backed, service-only, and stops at human approval', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_register_release_artifact/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_complete_release_preparation/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_abort_release_preparation/);
  assert.match(migration, /_artifact_type NOT IN \('release_notes', 'rollback_plan', 'deployment_manifest'\)/);
  assert.match(migration, /_security_run\.review_summary->>'passed' <> 'true'/);
  assert.match(migration, /COALESCE\(\(_security_run\.review_summary->>'critical'\)::integer, 0\) <> 0/);
  assert.match(migration, /status = 'approval_pending'/);
  assert.match(migration, /public\.builder_request_approval/);
  assert.match(migration, /'release_approval'/);
  assert.doesNotMatch(migration, /status = 'deployed'/);
  assert.match(migration, /retryable = true/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
});