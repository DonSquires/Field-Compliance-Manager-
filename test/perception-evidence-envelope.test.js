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
const cctvAlprMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20261010230154_cctv_alpr_perception_envelope_adapter.sql'),
  'utf8',
);
const cctvAlprGateMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20261010230747_fix_cctv_alpr_service_role_gate.sql'),
  'utf8',
);
const cctvPersonMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20261010231809_cctv_person_face_perception_envelope_adapter.sql'),
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

test('CCTV ALPR projection preserves custody and fails closed around weak or conflicting recognition', () => {
  assert.match(cctvAlprMigration, /FUNCTION public\.record_cctv_alpr_perception_envelopes\(p_job_id uuid\)/);
  assert.match(cctvAlprMigration, /CCTV source custody SHA-256 is required/);
  assert.match(cctvAlprMigration, /cctv-alpr:' \|\| v_observation\.id::text \|\| ':v1:'/);
  assert.match(cctvAlprMigration, /v_evidence_quality = 'insufficient'/);
  assert.match(cctvAlprMigration, /plate_width_px'\)::integer, 0\) < 48/);
  assert.match(cctvAlprMigration, /v_temporal_consensus[\s\S]*v_agreement[\s\S]*v_char_confidence, 0\) >= 0\.55/);
  assert.match(cctvAlprMigration, /'differs_from_temporal_candidate'/);
  assert.match(cctvAlprMigration, /'vehicle\.plate_number'/);
  assert.match(cctvAlprMigration, /v_conflicts, v_authority, true/);
  assert.match(cctvAlprGateMigration, /auth\.role\(\) <> 'service_role'/);
  assert.match(cctvAlprGateMigration, /record_cctv_alpr_perception_envelopes_unchecked/);
  assert.match(cctvAlprGateMigration, /REVOKE ALL ON FUNCTION public\.record_cctv_alpr_perception_envelopes_unchecked\(uuid\)[\s\S]*service_role/);
  assert.match(cctvAlprGateMigration, /REVOKE ALL ON FUNCTION public\.record_cctv_alpr_perception_envelopes\(uuid\)[\s\S]*GRANT EXECUTE[\s\S]*service_role/);
});

test('CCTV observation review remains the single human authority for shared ALPR fields', () => {
  assert.match(cctvAlprMigration, /FUNCTION public\.sync_cctv_alpr_perception_review\(\)/);
  assert.match(cctvAlprMigration, /CREATE TRIGGER sync_cctv_alpr_perception_review_trigger/);
  assert.match(cctvAlprMigration, /NEW\.review_state = 'accepted'[\s\S]*v_next_authority := 'human_approved'/);
  assert.match(cctvAlprMigration, /INSERT INTO public\.perception_evidence_reviews/);
  assert.match(cctvAlprMigration, /'cctv_entity_observation_id', NEW\.id/);
  assert.match(cctvAlprMigration, /NEW\.reviewed_by/);
  assert.match(cctvAlprMigration, /NEW\.review_state = 'superseded'[\s\S]*authority_state = 'superseded'/);
});

test('CCTV person receipts preserve provenance without copying biometric templates or candidate identities', () => {
  assert.match(cctvPersonMigration, /FUNCTION public\.record_cctv_person_perception_envelopes\(p_job_id uuid\)/);
  assert.match(cctvPersonMigration, /CCTV source custody SHA-256 is required before person evidence/);
  assert.match(cctvPersonMigration, /'person\.presence'/);
  assert.match(cctvPersonMigration, /'person\.face_detected'/);
  assert.match(cctvPersonMigration, /'person\.portfolio_candidate'/);
  assert.match(cctvPersonMigration, /'biometric_template_included', false/);
  assert.match(cctvPersonMigration, /'biometric_templates_copied', false/);
  assert.match(cctvPersonMigration, /human_review_required_no_tenant_face_calibration_v1/);
  assert.doesNotMatch(cctvPersonMigration, /\bface_vec\b|\bappearance_vec\b|\bcandidate_embedding\b|\bappearance_embedding\b/);
  assert.doesNotMatch(cctvPersonMigration, /portfolio_candidates->|display_name/);
  assert.match(cctvPersonMigration, /REVOKE ALL ON FUNCTION public\.record_cctv_person_perception_envelopes\(uuid\)[\s\S]*GRANT EXECUTE[\s\S]*service_role/);
});

test('existing person observation review is the only authority that can approve a shared identity', () => {
  assert.match(cctvPersonMigration, /FUNCTION public\.apply_cctv_person_review_to_perception\(p_observation_id uuid\)/);
  assert.match(cctvPersonMigration, /portfolio_state IN \('linked', 'new_identity'\)/);
  assert.match(cctvPersonMigration, /'person\.identity_reference'/);
  assert.match(cctvPersonMigration, /'explicit_human_cctv_identity_link_v1'/);
  assert.match(cctvPersonMigration, /v_target_authority := 'human_approved'/);
  assert.match(cctvPersonMigration, /INSERT INTO public\.perception_evidence_reviews/);
  assert.match(cctvPersonMigration, /v_observation\.reviewed_by/);
  assert.match(cctvPersonMigration, /CREATE TRIGGER sync_cctv_person_perception_review_trigger/);
  assert.match(cctvPersonMigration, /REVOKE ALL ON FUNCTION public\.apply_cctv_person_review_to_perception\(uuid\)[\s\S]*service_role/);
});
