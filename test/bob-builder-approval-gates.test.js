const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationPath = path.resolve(
  __dirname,
  '../supabase/migrations/20260830010000_builder_approval_gates.sql'
);

test('builder approval gates snapshot evidence and enforce human decisions', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS requested_target_sha text/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS reviewed_artifact_ids uuid\[\]/);
  assert.match(migration, /CREATE UNIQUE INDEX builder_approvals_one_pending_gate/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_request_approval/);
  assert.match(migration, /IF auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_decide_approval/);
  assert.match(migration, /IF auth\.role\(\) <> 'authenticated'/);
  assert.match(migration, /public\.can_approve_action\(_uid, _approval\.organization_id\)/);
  assert.match(migration, /requested_target_sha IS DISTINCT FROM _job\.target_sha/);
  assert.match(migration, /'specification_ready'.*'design_pending'/s);
  assert.match(migration, /'approval_pending'.*'release_ready'/s);
  assert.match(migration, /INSERT INTO public\.builder_audit_events/);
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.builder_decide_approval\(uuid, text, text\)\s+TO authenticated/
  );
  assert.doesNotMatch(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.builder_decide_approval\(uuid, text, text\)\s+TO service_role/
  );
});