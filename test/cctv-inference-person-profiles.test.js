const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260916150000_cctv_inference_person_profiles.sql'), 'utf8');
const oracle = fs.readFileSync(path.join(root, 'supabase/tests/20260916150000_cctv_inference_person_profiles.sql'), 'utf8');

const section = (start, end) => {
  const from = migration.indexOf(start);
  assert.ok(from >= 0, `missing section start: ${start}`);
  const to = end ? migration.indexOf(end, from) : migration.length;
  return migration.slice(from, to > from ? to : migration.length);
};

test('CCTV inference creates one provisional canonical profile per person portfolio', () => {
  const profile = section('CREATE OR REPLACE FUNCTION public.ensure_cctv_person_profile', 'CREATE OR REPLACE FUNCTION public.record_cctv_entity_observations');
  assert.match(profile, /pg_advisory_xact_lock\(hashtextextended\('cctv_unknown_person:'/);
  assert.match(profile, /'Unknown Person #' \|\| v_unknown_number/);
  assert.match(profile, /'cctv_unknown_person_number', v_unknown_number/);
  assert.match(profile, /'identity_status', 'unknown_pending_human_review'/);
  assert.match(profile, /public\.ensure_canonical_person_for_record\(v_person_id\)/);
  assert.match(profile, /review_state = 'manual_review_required'/);
});

test('CCTV writer attaches inferred face/body observations without asserting a reviewed identity', () => {
  const writer = section('CREATE OR REPLACE FUNCTION public.record_cctv_entity_observations', 'CREATE OR REPLACE FUNCTION public.update_cctv_person_profile');
  assert.match(writer, /FROM public\.ensure_cctv_person_profile\(/);
  assert.match(writer, /SET person_record_id = v_person_id,\s*canonical_person_id = v_canonical_id/);
  assert.match(writer, /AND review_state = 'unreviewed'/);
  assert.doesNotMatch(writer, /SET[\s\S]{0,400}review_state = 'accepted'/);
});

test('only a human-authorized profile update can name or enrich an inferred person profile', () => {
  const update = section('CREATE OR REPLACE FUNCTION public.update_cctv_person_profile', 'CREATE OR REPLACE FUNCTION public.complete_motion_inference');
  assert.match(update, /IF v_actor IS NULL OR NOT public\.org_access_allowed\(v_observation\.organization_id\)/);
  assert.match(update, /p_profile_details jsonb DEFAULT '\{\}'::jsonb/);
  assert.match(update, /SET display_name = v_display_name/);
  assert.match(update, /'identity_status', 'named_by_human_review'/);
  assert.match(update, /profile_detail_keys/);
  assert.match(update, /review_state = 'manual_review_required'/);
  assert.doesNotMatch(update, /review_state = 'verified'/);
});

test('face completion reuses the inferred profile rather than creating a duplicate record', () => {
  const complete = section('CREATE OR REPLACE FUNCTION public.complete_motion_inference', 'DO $$');
  assert.match(complete, /observation\.attributes->>'face_event_id' = face_event\.event->>'event_id'/);
  assert.match(complete, /FROM public\.ensure_cctv_person_profile\(/);
  assert.match(complete, /person_record_id,\s*confidence,\s*purpose/);
  assert.doesNotMatch(complete, /INSERT INTO public\.person_records/);
});

test('truth table covers profile creation, reuse, human naming, monotonic numbering and face reuse', () => {
  for (const label of [
    'inference creates an unknown person record and canonical profile',
    'similar face/body inference reuses the portfolio profile',
    'a dissimilar person creates the next unknown profile',
    'human profile update renames the existing record and canonical projection',
    'unknown numbering remains monotonic after a human renames an earlier profile',
    'completion attaches face evidence to the inferred profile without a duplicate person',
  ]) assert.ok(oracle.includes(label), `oracle missing: ${label}`);
});
