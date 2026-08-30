const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationPath = path.resolve(
  __dirname,
  '../supabase/migrations/20260830030000_builder_approval_activity.sql'
);

test('builder approval activity is authenticated, scoped, and metadata-only', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_builder_approvals_activity/);
  assert.match(migration, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(migration, /public\.can_approve_action\(v_user_id, a\.organization_id\)/);
  assert.match(migration, /a\.requested_from_users/);
  assert.match(migration, /jsonb_agg/);
  assert.match(migration, /'checksum'/);
  assert.doesNotMatch(migration, /storage_location/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO authenticated/);
  assert.match(migration, /REVOKE EXECUTE[\s\S]*FROM PUBLIC, anon, service_role/);
});