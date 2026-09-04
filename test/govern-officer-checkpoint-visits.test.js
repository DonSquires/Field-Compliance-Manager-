const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const migration = readFileSync(resolve(__dirname, '../supabase/migrations/20260904260000_govern_officer_checkpoint_visits.sql'), 'utf8');

test('checkpoint attendance is an authenticated, idempotent server-owned command', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.record_officer_checkpoint_visit/);
  assert.match(migration, /v_actor uuid := auth\.uid\(\)/);
  assert.match(migration, /p_client_request_id IS NULL/);
  assert.match(migration, /s\.officer_user_id = v_actor AND s\.status = 'in_progress'/);
  assert.match(migration, /id = p_checkpoint_id AND organization_id = v_org AND active = true/);
  assert.match(migration, /client_request_id = p_client_request_id/);
  assert.match(migration, /INSERT INTO public\.audit_log/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON public\.patrols FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON public\.patrol_checkpoint_visits FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.record_officer_checkpoint_visit/);
});