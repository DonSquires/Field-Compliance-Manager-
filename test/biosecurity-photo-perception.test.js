'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20261010235316_biosecurity_photo_perception_adapter.sql'),
  'utf8',
);
const custodyFixMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20261011000013_fail_closed_biosecurity_source_hash.sql'),
  'utf8',
);
const submit = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'submit-biosecurity-assessment', 'index.ts'),
  'utf8',
);
const classifier = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'classify-photo', 'index.ts'),
  'utf8',
);
const smokeSubmit = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'submit-smoke-assessment', 'index.ts'),
  'utf8',
);

test('biosecurity photo projection is service-only, custody-bound, and replay-safe', () => {
  assert.match(migration, /FUNCTION public\.record_biosecurity_photo_perception_envelope/);
  assert.match(migration, /auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /missing_source_hash/);
  assert.match(migration, /classification_unavailable/);
  assert.match(migration, /biosecurity-photo:' \|\| v_assessment\.id::text \|\| ':v1:' \|\| v_source_hash/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.record_biosecurity_photo_perception_envelope\(uuid, jsonb\)\s+FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.record_biosecurity_photo_perception_envelope\(uuid, jsonb\)\s+TO service_role/);
  assert.match(custodyFixMigration, /\(v_source_hash ~ '\^\[0-9a-f\]\{64\}\$'\) IS DISTINCT FROM TRUE/);
  assert.match(custodyFixMigration, /record_biosecurity_photo_perception_envelope_v1_unchecked/);
  assert.match(custodyFixMigration, /FROM PUBLIC, anon, authenticated, service_role/);
});

test('machine biosecurity candidates retain model provenance without gaining human authority', () => {
  for (const field of [
    'biosecurity.species_candidate',
    'biosecurity.density_candidate',
    'biosecurity.threat_level_candidate',
  ]) assert.match(migration, new RegExp(field.replace('.', '\\.')));
  assert.match(migration, /v_authority := CASE WHEN v_confidence < 0\.5 THEN 'insufficient' ELSE 'candidate' END/);
  assert.match(migration, /advisory_biosecurity_photo_candidate_human_review_required_v1/);
  assert.match(migration, /model_receipt, derivative_receipts/);
  assert.match(migration, /'machine_confirmation_permitted', false/);
});

test('human classification review is attributable and preserves corrected candidates', () => {
  assert.match(migration, /FUNCTION public\.review_biosecurity_photo_classification/);
  assert.match(migration, /public\.is_admin_for_org\(v_assessment\.organization_id\)/);
  assert.match(migration, /INSERT INTO public\.perception_evidence_reviews/);
  assert.match(migration, /'superseded'/);
  assert.match(migration, /species_confirmed = v_action IN \('confirm','correct'\)/);
  assert.match(migration, /species_review_decision = CASE WHEN v_action IN \('confirm','correct'\) THEN 'confirmed' ELSE 'rejected' END/);
  assert.match(migration, /An unavailable machine classification cannot be confirmed/);
  assert.doesNotMatch(migration, /SET[\s\S]{0,120}(notice_number|mpi_referral_number)/);
});

test('biosecurity submission retains structured classifier receipts and repairs envelope writes on replay', () => {
  for (const property of ['details:', 'reasoning:', 'classifier:', 'provider:', 'model:', 'prompt_version:']) {
    assert.match(submit, new RegExp(property));
  }
  assert.match(submit, /createClient\(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY\)/);
  assert.match(submit, /rpc\(\s*'record_biosecurity_photo_perception_envelope'/);
  assert.match(submit, /if \(perceptionError\) throw new Error/);
});

test('shared classifier validates modules, shape, confidence, and identifies its model receipt', () => {
  assert.match(classifier, /module is not supported/);
  assert.match(classifier, /Classification response did not match the governed evidence contract/);
  assert.match(classifier, /result\.confidence < 0/);
  assert.match(classifier, /classifier: 'bob_vision'/);
  assert.match(classifier, /prompt_version: `\$\{body\.module\}_photo_v1`/);
});

test('smoke receipt RPC executes in caller context and retains structured classifier evidence', () => {
  assert.match(smokeSubmit, /global: \{ headers: \{ Authorization: authorization \} \}/);
  assert.match(smokeSubmit, /rpc\('submit_smoke_assessment_receipt_v2'/);
  assert.match(smokeSubmit, /reasoning: classData\.reasoning/);
  assert.match(smokeSubmit, /prompt_version: classData\.prompt_version/);
});
