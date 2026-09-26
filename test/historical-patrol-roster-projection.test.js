const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260927140000_fix_historical_forestry_roster_rpc.sql'), 'utf8');
const cleanupMigration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260927150000_drop_broken_historical_roster_rpc_overload.sql'), 'utf8');
const script = fs.readFileSync(path.resolve(__dirname, '../scripts/seed-rm-forestry-roster-history.mjs'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../scripts/data/patrol-roster-projections/rm-forestry-roster-history.json'), 'utf8'));

test('date-specific roster import is tenant-admin-only, audited, replay-safe, and notification-suppressed', () => {
  assert.match(migration, /public\.is_admin_for_org\(p_organization_id\)/);
  assert.match(migration, /audit\.action = 'historical_roster_assignment_imported'/);
  assert.match(migration, /external_refs->>'source_key' = v_source_key/);
  assert.match(migration, /IF new\.external_refs->>'source' IN \('rm_forestry_roster_history', 'rm_patrol_log_roster_evidence'\)/);
  assert.match(migration, /'notifications_created', 0/);
});

test('correction disables task-geocode roster slots and replaces only the superseded projection', () => {
  assert.match(migration, /Superseded: import the dedicated forestry roster/);
  assert.match(migration, /DELETE FROM public\.roster_slots slot[\s\S]*rm_patrol_log_roster_projection/);
  assert.match(migration, /DELETE FROM public\.patrol_route_zones/);
  assert.match(migration, /DELETE FROM public\.patrol_route_sites/);
  assert.doesNotMatch(migration, /INSERT INTO public\.roster_slots/);
  assert.doesNotMatch(migration, /INSERT INTO public\.shifts/);
  assert.doesNotMatch(migration, /INSERT INTO public\.(user_profiles|staff_profiles)/);
});

test('roster assignments preserve exact dates, optional task times, beats, and event provenance', () => {
  assert.match(migration, /INSERT INTO public\.roster_assignments/);
  assert.match(migration, /specific_date/);
  assert.match(migration, /nullif\(v_item->>'start_time', ''\)::time/);
  assert.match(migration, /'source_rows', coalesce\(v_item->'source_rows'/);
  assert.match(migration, /'beat_names', coalesce\(v_item->'beat_names'/);
  assert.match(migration, /'source_event_refs', grouped\.source_event_refs/);
  assert.match(migration, /event\.organization_id = p_client_organization_id/);
  assert.match(migration, /observation\.organization_id = p_client_organization_id/);
  assert.match(migration, /p_client_organization_id uuid/);
  assert.match(migration, /'prior_slots_removed', v_prior_slots_removed/);
});

test('seed function is PostgreSQL-only and future dates are rejected', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.apply_historical_roster_assignment_import\(uuid, uuid, uuid, text, text, jsonb, jsonb, text\[\], jsonb, boolean\) FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.apply_historical_roster_assignment_import\(uuid, uuid, uuid, text, text, jsonb, jsonb, text\[\], jsonb, boolean\) TO postgres/);
  assert.match(migration, /IF \(v_item->>'specific_date'\)::date > current_date/);
  assert.match(cleanupMigration, /DROP FUNCTION IF EXISTS public\.apply_historical_roster_assignment_import\([\s\S]*uuid, uuid, text, text, jsonb, jsonb, text\[\], jsonb, boolean/);
});

test('dedicated roster maps only forestry beat columns and keeps Marlborough distinct', () => {
  assert.equal(config.beat_columns.length, 11);
  assert.deepEqual(config.beat_columns.filter((beat) => beat.route_code === 'RM-BLENHEIM-FORESTRY').map((beat) => beat.contains), ['Marlborough']);
  assert.equal(config.beat_columns.some((beat) => /toilets|rabbit|fencing|pathways/i.test(beat.contains)), false);
  assert.ok(config.beat_columns.some((beat) => beat.shift === 'swing'));
  assert.equal(config.field_source_codes.includes('OFO2026'), true);
});

test('roster importer is dry-run-first and hashes unresolved notes before persistence', () => {
  assert.match(script, /apply_historical_roster_assignment_import/);
  assert.match(script, /args\.includes\('--apply'\) \? 'apply' : 'dry-run'/);
  assert.match(script, /const batchSize = 250/);
  assert.match(script, /const isFinalChunk = index === chunks\.length - 1/);
  assert.match(script, /const chunkSourceCodes = isFinalChunk \? sourceCodes : ''/);
  assert.match(script, /ARRAY\[\$\{chunkSourceCodes\}\]::text\[\]/);
  assert.match(script, /chunkRequestId/);
  assert.match(script, /value_hash: valueHash/);
  assert.doesNotMatch(script, /unresolvedValues.*value,/);
});