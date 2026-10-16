import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20261016224751_govern_enforcement_mode_actions.sql'),
  'utf8',
);
const resolver = fs.readFileSync(
  path.join(root, 'supabase', 'schemas', 'public', 'functions', 'resolve_enforcement_mode.sql'),
  'utf8',
);
const observationBasisMigration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20261016231057_wire_observation_direct_initiation_basis.sql'),
  'utf8',
);

test('officer enforcement proves actor, place, and task authority', () => {
  for (const evidence of [
    'v_observation.officer_id <> v_actor',
    'is_enforcement_operator_for_org',
    'has_location_access',
    'user_has_task_entitlement',
    'for update',
    'p_expected_status',
  ]) {
    assert.match(migration, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('server resolves all three enforcement mode dispositions', () => {
  assert.match(migration, /v_mode := public\.resolve_enforcement_mode/);
  assert.match(migration, /v_mode = 'officer_direct'/);
  assert.match(migration, /v_mode = 'hybrid' and p_action <> 'infringement'/);
  assert.match(migration, /administrator_review/);
  assert.match(migration, /status = case when v_direct then 'actioned' else 'acknowledged' end/);
});

test('officer retries are idempotent and return durable receipts', () => {
  assert.match(migration, /create unique index if not exists idx_breach_alerts_request_id/);
  assert.match(migration, /where b\.request_id = p_request_id/);
  assert.match(migration, /requested_action text,[\s\S]*enforcement_mode text,[\s\S]*disposition text/);
  assert.match(migration, /officer_breach_action_direct/);
  assert.match(migration, /officer_breach_action_requested/);
});

test('administrator approval cannot silently change the requested action', () => {
  assert.match(migration, /v_alert\.status = 'acknowledged' and p_action = 'approve_requested'/);
  assert.match(migration, /v_action_type := v_alert\.requested_action/);
  assert.match(migration, /v_alert\.status <> p_expected_status/);
});

test('mode resolver is internal and has a fixed search path', () => {
  assert.match(resolver, /set search_path = public/);
  assert.match(resolver, /revoke all[\s\S]*from public, "anon", "authenticated"/);
  assert.doesNotMatch(resolver, /grant execute[\s\S]*to public/);
});

test('officer-authored observations create the canonical direct-initiation basis', () => {
  assert.match(observationBasisMigration, /after insert on public\.observations/);
  assert.match(observationBasisMigration, /'direct_module_initiation'/);
  assert.match(observationBasisMigration, /new\.officer_id/);
  assert.match(observationBasisMigration, /if new\.officer_id is null then/);
  assert.match(observationBasisMigration, /where o\.officer_id is not null/);
  assert.match(observationBasisMigration, /new\.observed_at/);
  assert.match(observationBasisMigration, /idx_task_assignments_observation_direct_unique/);
  assert.match(observationBasisMigration, /Historical observation direct-initiation basis backfilled/);
});
