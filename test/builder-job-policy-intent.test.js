const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260901021000_builder_job_policy_intent.sql'), 'utf8');

test('Builder job policy intent is persisted, audited, and production-safe', () => {
  for (const column of ['requested_action', 'target_environment']) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_create_job_v2/);
  assert.match(migration, /Production Builder jobs must prepare a release/);
  assert.match(migration, /Production Builder jobs require human code review/);
  assert.match(migration, /builder_job_policy_bound/);
  assert.match(migration, /'target_sha', _job\.target_sha/);
});