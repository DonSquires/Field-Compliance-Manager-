const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260902008000_govern_patrol_lifecycle.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const page = fs.readFileSync(path.join(root, 'apps/web/src/pages/PatrolPage.tsx'), 'utf8');

test('Patrol sessions derive active officer and assigned shift authority server-side', () => {
  assert.match(migration, /start_patrol_session/i);
  assert.match(migration, /auth\.uid\(\)/i);
  assert.match(migration, /officer_user_id IS DISTINCT FROM v_actor/i);
  assert.match(migration, /FOR UPDATE/i);
  assert.match(migration, /patrol\.started/i);
});

test('Patrol checkpoint evidence supports both checkpoint models and is computed before insert', () => {
  assert.match(migration, /route_checkpoint_id/i);
  assert.match(migration, /patrol_checkpoint_visits_one_checkpoint_chk/i);
  assert.match(migration, /ST_Distance/i);
  assert.match(migration, /GPS accuracy is too poor/i);
  assert.match(migration, /outside the checkpoint radius/i);
  assert.match(migration, /record_patrol_checkpoint_visit/i);
  assert.match(migration, /patrol\.checkpoint_recorded/i);
});

test('Patrol checkpoint recording is retry-safe and links resolvable shift stops', () => {
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /created boolean/i);
  assert.match(migration, /shift_stop_id/i);
  assert.match(migration, /client_site_id|zone_id/i);
});

test('Patrol completion requires mandatory evidence and is audited', () => {
  assert.match(migration, /complete_patrol_session/i);
  assert.match(migration, /mandatory checkpoints remain/i);
  assert.match(migration, /patrol\.completed/i);
  assert.match(migration, /ended_at/i);
});

test('Patrol UI uses governed RPCs and cannot directly mutate lifecycle tables', () => {
  for (const rpc of ['start_patrol_session', 'record_patrol_checkpoint_visit', 'complete_patrol_session']) assert.match(page, new RegExp(rpc));
  assert.doesNotMatch(page, /\.from\(['"]patrols['"]\)\s*\.(insert|update|delete)/);
  assert.doesNotMatch(page, /\.from\(['"]patrol_checkpoint_visits['"]\)\s*\.insert/);
  assert.match(schema, /REVOKE INSERT,UPDATE,DELETE ON TABLE "public"\."patrols" FROM PUBLIC,"anon","authenticated"/i);
  assert.match(schema, /REVOKE INSERT,UPDATE,DELETE ON TABLE "public"\."patrol_checkpoint_visits" FROM PUBLIC,"anon","authenticated"/i);
});