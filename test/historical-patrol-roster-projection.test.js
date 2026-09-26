const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260927100000_project_historical_patrol_roster.sql'), 'utf8');
const script = fs.readFileSync(path.resolve(__dirname, '../scripts/seed-historical-patrol-roster.mjs'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../scripts/data/patrol-roster-projections/rm-ofo-forestry.json'), 'utf8'));

test('historical roster projection is tenant-bound, admin-only, and reads existing evidence', () => {
  assert.match(migration, /public\.is_admin_for_org\(p_provider_organization_id\)/);
  assert.match(migration, /agreement\.provider_organization_id = p_provider_organization_id/);
  assert.match(migration, /agreement\.client_organization_id = p_client_organization_id/);
  assert.match(migration, /FROM public\.location_events event/);
  assert.match(migration, /FROM public\.observations observation/);
});

test('projection creates route and roster structure without inventing shifts or identities', () => {
  assert.match(migration, /INSERT INTO public\.patrol_routes/);
  assert.match(migration, /INSERT INTO public\.patrol_route_zones/);
  assert.match(migration, /INSERT INTO public\.patrol_route_sites/);
  assert.match(migration, /INSERT INTO public\.roster_work_units/);
  assert.match(migration, /INSERT INTO public\.roster_slots/);
  assert.doesNotMatch(migration, /INSERT INTO public\.shifts/);
  assert.doesNotMatch(migration, /INSERT INTO public\.(user_profiles|staff_profiles)/);
  assert.match(migration, /'future_schedule_created', false/);
  assert.match(migration, /'shifts_created', 0/);
});

test('historical slots are replay-safe and preserve source-event provenance', () => {
  assert.match(migration, /md5\(/);
  assert.match(migration, /client_request_id = v_slot_request_id/);
  assert.match(migration, /'source', 'rm_patrol_log_roster_projection'/);
  assert.match(migration, /'source_event_refs', v_slot\.source_event_refs/);
  assert.match(migration, /status = 'completed'/);
  assert.match(migration, /'unresolved_place_events', v_unresolved_place/);
  assert.match(migration, /'uncontracted_place_events', v_uncontracted_place/);
  assert.match(migration, /'ambiguous_staff_days', v_ambiguous_staff_days/);
});

test('seed entry point is intentionally postgres-only', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.project_historical_patrol_roster\(uuid, uuid, uuid, text\[\], jsonb, boolean\) FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.project_historical_patrol_roster\(uuid, uuid, uuid, text\[\], jsonb, boolean\) TO postgres/);
});

test('OFO seed uses stored evidence and declares the two requested regional routes', () => {
  assert.match(script, /The source workbook is never opened/);
  assert.match(script, /project_historical_patrol_roster/);
  assert.match(script, /args\.includes\('--apply'\) \? 'apply' : 'dry-run'/);
  assert.deepEqual(config.source_codes, ['OFO2025', 'OFO2026']);
  assert.equal(config.link_missing_agreement_locations, true);
  assert.deepEqual(config.routes.map((route) => route.name), ['Nelson Forestry Patrol', 'Blenheim Forestry Patrol']);
  assert.match(config.provenance.limitations, /Unplaced events and ambiguous overlapping route-days remain unseeded/);
});