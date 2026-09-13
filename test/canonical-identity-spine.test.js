const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913154000_global_canonical_identity_spine.sql'), 'utf8');
const backfill = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913154100_backfill_canonical_place_projection_links.sql'), 'utf8');

test('canonical identity spine keeps global identity separate from organization projections', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.canonical_places/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.canonical_place_links/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.canonical_people/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.canonical_person_links/);
  assert.match(migration, /UNIQUE\(source_table, source_id\)/g);
  assert.match(migration, /Global vehicle identity/);
  assert.match(migration, /Global SCV registry identity/);
});

test('operational records retain place and organization context while linking global identities', () => {
  assert.match(migration, /ALTER TABLE public\.observations[\s\S]*canonical_place_id/);
  assert.match(migration, /ALTER TABLE public\.observations[\s\S]*canonical_person_id/);
  assert.match(migration, /ALTER TABLE public\.incidents[\s\S]*canonical_place_id/);
  assert.match(migration, /ALTER TABLE public\.officer_field_reports[\s\S]*canonical_place_id/);
  assert.match(migration, /ALTER TABLE public\.location_events[\s\S]*canonical_place_id/);
  assert.match(migration, /organization_id uuid REFERENCES public\.organizations/);
});

test('existing house, site, and zone projections converge on one canonical place identity', () => {
  assert.match(backfill, /canonical_key = 'location:' \|\| l\.id::text/);
  assert.match(backfill, /source_table, source_id/);
  assert.match(backfill, /COALESCE\(location_cp\.id, site_cp\.canonical_place_id/);
  assert.match(backfill, /ON CONFLICT \(source_table, source_id\) DO NOTHING/);
});

test('tenant person projections receive global identities without automatic cross-org merging', () => {
  const personBackfill = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913154200_backfill_canonical_person_projection_links.sql'), 'utf8');
  assert.match(personBackfill, /person_record:' \|\| p\.id::text/);
  assert.match(personBackfill, /source_table, source_id, organization_id/);
  assert.match(personBackfill, /No cross-organization names are merged automatically/);
});
