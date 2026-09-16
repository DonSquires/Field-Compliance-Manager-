const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260915183000_cctv_imports_and_identity_portfolios.sql'), 'utf8');
const oracle = fs.readFileSync(path.join(root, 'supabase/tests/20260915183000_cctv_imports_and_identity_portfolios.sql'), 'utf8');

const section = (start, end) => {
  const from = migration.indexOf(start);
  assert.ok(from >= 0, `missing section start: ${start}`);
  const to = end ? migration.indexOf(end, from) : migration.length;
  return migration.slice(from, to > from ? to : migration.length);
};

test('an import is anchored to a house and its registry place before any file is accepted', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cctv_imports \([\s\S]*location_id uuid NOT NULL REFERENCES public\.locations\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /canonical_place_id uuid NOT NULL REFERENCES public\.canonical_places\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /NEW\.canonical_place_id := v_house\.canonical_place_id/);
  assert.match(migration, /CCTV import site is not a facet of the chosen house/);
  assert.match(migration, /CCTV import zone is not a facet of the chosen house/);
  assert.match(migration, /watermark_location_hint text/);
  assert.match(migration, /Unknown time zone %/);
  assert.match(migration, /Video must be stored under %/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS cctv_import_id uuid REFERENCES public\.cctv_imports\(id\) ON DELETE SET NULL/);
});

test('entity observations sit on the canonical spine, not the tenant vehicles table', () => {
  assert.match(migration, /FOREIGN KEY \(canonical_person_id\) REFERENCES public\.canonical_people\(id\)/);
  assert.match(migration, /FOREIGN KEY \(canonical_vehicle_id\) REFERENCES public\.canonical_vehicles\(id\)/);
  assert.doesNotMatch(migration, /REFERENCES public\.vehicles\(id\)/);
  assert.match(migration, /person_record_id uuid REFERENCES public\.person_records\(id\)/);
  assert.match(migration, /face_vec public\.vector\(128\)/);
  assert.match(migration, /appearance_vec public\.vector\(256\)/);
  assert.match(migration, /USING hnsw \(face_vec public\.vector_cosine_ops\)/);
  assert.match(migration, /quality_state IN \('clear', 'glitch', 'flare', 'ir_switch', 'degraded', 'occluded'\)/);
  assert.match(migration, /is_pest boolean/);
});

test('the P2 worker baseline did not accept an identity; later profile projection remains provisional until review', () => {
  const worker = section('CREATE OR REPLACE FUNCTION public.record_cctv_entity_observations', 'CREATE OR REPLACE FUNCTION public.review_cctv_entity_observation');
  assert.doesNotMatch(worker, /canonical_vehicle_id\s*=|canonical_person_id\s*=|person_record_id\s*=/);
  assert.match(worker, /portfolio_key = coalesce\(portfolio_key, v_key\)/);
  assert.match(worker, /WHEN 'face' THEN 0\.72 ELSE 0\.80/);
  assert.match(worker, /WHERE cctv_entity_observations\.review_state = 'unreviewed'/);
  assert.match(worker, /GRANT EXECUTE ON FUNCTION public\.record_cctv_entity_observations\(uuid, uuid, uuid, jsonb\) TO service_role/);
  const review = section('CREATE OR REPLACE FUNCTION public.review_cctv_entity_observation', 'CREATE OR REPLACE FUNCTION public.create_cctv_import');
  assert.match(review, /'accept', 'reject', 'link_person', 'new_person', 'link_vehicle', 'new_vehicle', 'merge_portfolio', 'accept_portfolio'/);
  assert.match(review, /public\.ensure_canonical_vehicle\(v_plate/);
  assert.match(review, /public\.ensure_canonical_person_for_record\(/);
  assert.match(review, /A readable plate is required to create a vehicle/);
  assert.match(review, /INSERT INTO public\.audit_log/);
  assert.match(review, /NOT public\.org_access_allowed\(v_obs\.organization_id\)/);
});

test('portfolio search thresholds and sources are pinned', () => {
  const finder = section('CREATE OR REPLACE FUNCTION public.find_cctv_portfolio_matches', 'CREATE OR REPLACE FUNCTION public.record_cctv_entity_observations');
  assert.match(finder, /WHEN 'face' THEN 0\.65 WHEN 'face_legacy' THEN 0\.65 WHEN 'appearance' THEN 0\.70 ELSE 0\.60/);
  assert.match(finder, /extensions\.similarity\(cv\.plate_number, v_plate\)/);
  assert.match(finder, /o\.review_state <> 'rejected'/);
  assert.match(finder, /FROM public\.face_observations fo/);
});

test('truth table covers the chain end to end', () => {
  for (const label of ['import anchored to the registry place', 'registration queues a video_motion job', 'similar face joins the same portfolio',
    'plate-less vehicle joins the portfolio by appearance', 'accepting a plated vehicle creates or links the canonical vehicle',
    'a plate-less vehicle cannot be minted', 'new_person creates an org person record and its canonical person', 'stranger cannot see the import or its events']) {
    assert.ok(oracle.includes(label), `oracle missing: ${label}`);
  }
});
