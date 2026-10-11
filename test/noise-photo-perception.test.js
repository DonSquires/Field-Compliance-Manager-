'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20261011005701_noise_photo_perception_adapter.sql'),
  'utf8',
);
const serviceIdentityFix = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20261011011008_fix_noise_photo_service_identity.sql'),
  'utf8',
);
const submit = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'submit-noise-assessment', 'index.ts'),
  'utf8',
);
const classifier = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'classify-photo', 'index.ts'),
  'utf8',
);

test('noise photo writer is service-only, custody-bound, and replay-safe', () => {
  assert.match(migration, /FUNCTION public\.record_noise_photo_perception_envelope/);
  assert.match(migration, /\(lower\(v_evidence\.sha256_hash\) ~ '\^\[0-9a-f\]\{64\}\$'\) IS DISTINCT FROM TRUE/);
  assert.match(migration, /missing_evidence_link/);
  assert.match(migration, /missing_source_hash/);
  assert.match(migration, /noise-photo:' \|\| v_assessment\.id::text \|\| ':v1:'/);
  assert.match(migration, /TO service_role/);
  assert.match(serviceIdentityFix, /pg_get_functiondef/);
  assert.match(serviceIdentityFix, /REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(serviceIdentityFix, /GRANT EXECUTE[\s\S]*TO service_role/);
});

test('machine noise photo candidates cannot become acoustic or legal authority', () => {
  for (const field of [
    'noise.source_candidate',
    'noise.equipment_candidate',
    'noise.estimated_level_candidate',
  ]) assert.match(migration, new RegExp(field.replace('.', '\\.')));
  assert.match(migration, /'machine_acoustic_decision_permitted', false/);
  assert.match(migration, /'machine_legal_decision_permitted', false/);
  assert.match(migration, /'excessive_noise_decision_permitted',false/);
  assert.match(migration, /'manual_review_required'/);
});

test('human photo review is attributable and leaves matrix and legal action unchanged', () => {
  assert.match(migration, /FUNCTION public\.review_noise_photo_classification/);
  assert.match(migration, /public\.is_admin_for_org\(v_assessment\.organization_id\)/);
  assert.match(migration, /INSERT INTO public\.perception_evidence_reviews/);
  assert.match(migration, /'human_approved'/);
  assert.match(migration, /'acoustic_matrix_changed',false/);
  assert.match(migration, /'legal_action_changed',false/);
  const body = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.review_noise_photo_classification'));
  assert.doesNotMatch(body, /SET[\s\S]{0,180}(matrix_total|volume_score|time_score|tone_score|action_taken|notice_number|end_number)/);
});

test('noise submission retains custody and calls projection after caller-context receipt', () => {
  assert.match(submit, /global: \{ headers: \{ Authorization: authorization \} \}/);
  assert.match(submit, /rpc\('submit_officer_noise_assessment_v2'/);
  assert.match(submit, /watermarked_sha256/);
  assert.match(submit, /rpc\(\s*'record_noise_photo_perception_envelope'/);
  assert.match(submit, /Noise photo classification failed/);
});

test('noise classifier states visual-only authority and fails malformed output explicitly', () => {
  assert.match(classifier, /You cannot hear or measure noise from a photograph/);
  assert.match(classifier, /Do not decide whether noise[\s\S]*is excessive/);
  assert.match(classifier, /Classification service returned invalid structured output/);
  assert.doesNotMatch(classifier, /classification: 'unknown',\s*confidence: 0/);
});
