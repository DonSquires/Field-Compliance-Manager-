const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20261010191817_idempotent_external_record_evidence.sql'),
  'utf8',
);
const triggerMigration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20261010192005_allow_external_record_photos.sql'),
  'utf8',
);
const evidenceKindMigration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20261010192110_allow_external_observation_photo_kind.sql'),
  'utf8',
);

test('external record evidence is hash-deduplicated per record', () => {
  assert.match(migration, /evidence_items_external_record_hash_unique/);
  assert.match(migration, /metadata->>'record_kind'/);
  assert.match(migration, /metadata->>'record_id'/);
  assert.match(migration, /sha256_hash/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test('observation photo junctions are replay safe', () => {
  assert.match(migration, /observation_supporting_external_photo_unique/);
  assert.match(migration, /ON CONFLICT \(organization_id, observation_id, storage_path\)/);
  assert.match(migration, /DO NOTHING/);
});

test('the governed RPC keeps tenant access, path, and audit checks', () => {
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(migration, /org_access_allowed\(v_org\)/);
  assert.match(migration, /record-evidence/);
  assert.match(migration, /external_photo_attached/);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*PUBLIC, anon, authenticated, service_role/);
});

test('external historical photos remain evidence without claiming court-ready capture', () => {
  assert.match(triggerMigration, /new\.module_key = 'record_review'/);
  assert.match(triggerMigration, /new\.metadata->>'provenance' = 'external'/);
  assert.match(triggerMigration, /new\.is_court_ready := false/);
  assert.match(triggerMigration, /new\.locked_at := NULL/);
  assert.match(triggerMigration, /watermark_service[\s\S]*inference/);
});

test('supporting evidence accepts the external photo kind written by the RPC', () => {
  assert.match(evidenceKindMigration, /observation_supporting_evidence_evidence_kind_check/);
  assert.match(evidenceKindMigration, /'external_photo'/);
  assert.match(evidenceKindMigration, /not court-ready by default/);
});
