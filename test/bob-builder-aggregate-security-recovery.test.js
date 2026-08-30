const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830185000_builder_aggregate_security_recovery.sql'),
  'utf8'
);

test('aggregate security recovery expires leases and restores retryable testing state', () => {
  assert.match(migration, /profile = 'security-review' AND status = 'running' AND lease_expires_at <= now\(\)/);
  assert.match(migration, /status = 'failed', retryable = true/);
  assert.match(migration, /SET status = 'testing'/);
  assert.match(migration, /output_artifact_ids = '\{\}'/);
});

test('aggregate security recovery is service-only', () => {
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION public\.builder_recover_expired_security_review\(\) FROM PUBLIC,anon,authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.builder_recover_expired_security_review\(\) TO service_role/);
});