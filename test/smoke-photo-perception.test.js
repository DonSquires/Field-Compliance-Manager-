'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20261011003729_smoke_photo_perception_adapter.sql'),
  'utf8',
);
const submit = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'submit-smoke-assessment', 'index.ts'),
  'utf8',
);

test('smoke photo writer is service-only, custody-bound, and replay-safe', () => {
  assert.match(migration, /FUNCTION public\.record_smoke_photo_perception_envelope/);
  assert.match(migration, /auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /\(v_source_hash ~ '\^\[0-9a-f\]\{64\}\$'\) IS DISTINCT FROM TRUE/);
  assert.match(migration, /missing_source_hash/);
  assert.match(migration, /classification_unavailable/);
  assert.match(migration, /smoke-photo:' \|\| v_assessment\.id::text \|\| ':v1:' \|\| v_source_hash/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.record_smoke_photo_perception_envelope\(uuid, jsonb\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.record_smoke_photo_perception_envelope\(uuid, jsonb\)[\s\S]*TO service_role/);
});

test('machine smoke candidates remain advisory and retain model provenance', () => {
  for (const field of [
    'smoke.source_candidate',
    'smoke.severity_candidate',
    'smoke.visibility_impact_candidate',
  ]) assert.match(migration, new RegExp(field.replace('.', '\\.')));
  assert.match(migration, /v_authority := CASE WHEN v_confidence < 0\.5 THEN 'insufficient' ELSE 'candidate' END/);
  assert.match(migration, /'machine_legal_decision_permitted', false/);
  assert.match(migration, /'statutory_threshold_permitted', false/);
  assert.match(migration, /'manual_review_required'/);
});

test('human smoke photo review is attributable and cannot create legal action', () => {
  assert.match(migration, /FUNCTION public\.review_smoke_photo_classification/);
  assert.match(migration, /public\.is_admin_for_org\(v_assessment\.organization_id\)/);
  assert.match(migration, /INSERT INTO public\.perception_evidence_reviews/);
  assert.match(migration, /'superseded'/);
  assert.match(migration, /'human_approved'/);
  assert.match(migration, /An unavailable machine classification cannot be approved/);
  assert.match(migration, /'legal_action_changed', false/);
  assert.match(migration, /'notice_changed', false/);
  const reviewBody = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.review_smoke_photo_classification'));
  assert.doesNotMatch(reviewBody, /SET[\s\S]{0,160}(action_taken|notice_number|legal_basis)/);
});

test('v2 smoke receipt preserves source confirmation and structured analysis', () => {
  assert.match(migration, /FUNCTION public\.submit_smoke_assessment_receipt_v2/);
  assert.match(migration, /Officer must confirm the observed smoke source/);
  assert.match(migration, /source_confirmed = true/);
  assert.match(migration, /notes = nullif/);
  assert.match(migration, /smoke_ai_analysis = p_classification/);
  assert.match(migration, /review_state = 'requires_supervisor_review'/);
});

test('edge submission uses caller-context receipt and service-only projection', () => {
  assert.match(submit, /global: \{ headers: \{ Authorization: authorization \} \}/);
  assert.match(submit, /rpc\('submit_smoke_assessment_receipt_v2'/);
  assert.match(submit, /p_source_confirmed: sourceConfirmed/);
  assert.match(submit, /p_notes: notes \|\| null/);
  assert.match(submit, /rpc\(\s*'record_smoke_photo_perception_envelope'/);
  assert.match(submit, /if \(perceptionError\) throw new Error/);
  assert.match(submit, /console\.error\('Smoke photo classification failed'/);
});
