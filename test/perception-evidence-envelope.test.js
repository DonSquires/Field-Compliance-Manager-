'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20261010224625_shared_perception_evidence_envelope.sql'),
  'utf8',
);
const policyMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20261010225100_tighten_perception_evidence_read_policies.sql'),
  'utf8',
);
const validationMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20261010225539_harden_perception_envelope_payload_validation.sql'),
  'utf8',
);

test('shared perception evidence schema is versioned, tenant-scoped, indexed, and review-gated', () => {
  for (const table of [
    'perception_model_calibrations',
    'perception_evidence_envelopes',
    'perception_evidence_fields',
    'perception_evidence_reviews',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE public\\.${table}`));
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated`));
  }
  assert.match(migration, /schema_version integer NOT NULL DEFAULT 1/);
  assert.match(migration, /source_sha256 text NOT NULL CHECK \(source_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(migration, /authority_state IN \('insufficient','candidate','verified_candidate','human_approved','rejected','superseded'\)/);
  assert.match(migration, /CREATE INDEX perception_evidence_envelopes_attachment_idx/);
  assert.match(migration, /CREATE INDEX perception_evidence_fields_normalized_identifier_idx/);
});

test('shared perception evidence writes are replay-safe and approval is attributable', () => {
  assert.match(migration, /FUNCTION public\.record_perception_evidence_envelope/);
  assert.match(migration, /idempotency_key = p_idempotency_key/);
  assert.match(migration, /Service identity required/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.record_perception_evidence_envelope\(uuid,text,jsonb\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /FUNCTION public\.review_perception_evidence_field/);
  assert.match(migration, /public\.is_admin_for_org\(v_field\.organization_id\)/);
  assert.match(migration, /INSERT INTO public\.perception_evidence_reviews/);
  assert.match(migration, /decided_by uuid NOT NULL REFERENCES public\.user_profiles/);
  assert.doesNotMatch(migration, /auth\.role\(\)/);
});

test('raw perception candidates are admin-only until domain task-entitlement policies land', () => {
  for (const table of [
    'perception_evidence_envelopes',
    'perception_evidence_fields',
    'perception_evidence_reviews',
  ]) {
    assert.match(policyMigration, new RegExp(`CREATE POLICY ${table}_select[\\s\\S]*public\\.is_admin_for_org\\(organization_id\\)`));
  }
  assert.match(policyMigration, /\(organization_id IS NULL AND status = 'approved'\)/);
  assert.doesNotMatch(policyMigration, /org_access_allowed/);
});

test('writer rejects missing or empty candidate arrays before recording an envelope', () => {
  assert.match(validationMigration, /jsonb_typeof\(p_payload\) IS DISTINCT FROM 'object'/);
  assert.match(validationMigration, /jsonb_typeof\(p_payload->'fields'\) IS DISTINCT FROM 'array'/);
  assert.match(validationMigration, /jsonb_array_length\(p_payload->'fields'\) = 0/);
  assert.match(validationMigration, /REVOKE ALL ON FUNCTION public\.record_perception_evidence_envelope_unchecked\(uuid,text,jsonb\)[\s\S]*service_role/);
});
