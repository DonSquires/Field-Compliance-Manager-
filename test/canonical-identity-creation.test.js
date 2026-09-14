const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260914003000_create_canonical_identities_from_field_records.sql'),
  'utf8',
);

test('field records create missing canonical vehicle, place, and person identities with provenance', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.ensure_canonical_vehicle\(/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.ensure_canonical_place_for_projection\(/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.ensure_canonical_person_for_record\(/);
  assert.match(migration, /INSERT INTO public\.canonical_vehicle_links[\s\S]*'field_observation'/);
  assert.match(migration, /INSERT INTO public\.canonical_place_links[\s\S]*'projection'/);
  assert.match(migration, /INSERT INTO public\.canonical_person_links[\s\S]*'projection'/);
  assert.match(migration, /NEW\.canonical_vehicle_id := public\.ensure_canonical_vehicle\(/);
  assert.match(migration, /NEW\.canonical_place_id := public\.ensure_canonical_place_for_projection\(/);
  assert.match(migration, /NEW\.canonical_person_id := public\.ensure_canonical_person_for_record\(/);
});

test('created vehicles carry only observed attributes and never a fabricated identity', () => {
  const ensure = migration.slice(
    migration.indexOf('FUNCTION public.ensure_canonical_vehicle('),
    migration.indexOf('FUNCTION public.ensure_canonical_place_for_projection('),
  );
  assert.match(ensure, /INSERT INTO public\.canonical_vehicles \(plate_number, make, model, colour, last_seen_at\)/);
  assert.doesNotMatch(ensure, /registered_owner_name|rego_status|wof_status|cof_status|compliance_source/);
  assert.match(ensure, /IF length\(v_alnum\) > 10 THEN RETURN NULL; END IF;/);
  assert.match(ensure, /IF v_plate IS NULL THEN RETURN NULL; END IF;/);
  assert.match(ensure, /ON CONFLICT \(plate_number\) DO NOTHING/);
});

test('resolver runs as definer and helpers are not callable by tenant roles', () => {
  const resolver = migration.slice(migration.indexOf('FUNCTION public.resolve_record_canonical_identity()'));
  assert.match(resolver, /RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public/);
  for (const fn of ['ensure_canonical_vehicle', 'ensure_canonical_place_for_projection', 'ensure_canonical_person_for_record']) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM public, anon, authenticated;`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role;`));
  }
});

test('backfill routes through the trigger with self-assignment only', () => {
  const backfill = migration.slice(migration.indexOf('-- Backfill through the trigger'));
  const sets = [...backfill.matchAll(/UPDATE public\.\w+ SET (\w+) = (\w+)\s/g)];
  assert.ok(sets.length >= 4);
  for (const [, left, right] of sets) assert.equal(left, right);
});
