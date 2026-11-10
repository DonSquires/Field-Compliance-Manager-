const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20261017222450_retire_legacy_geometry_helpers.sql'),
  'utf8',
);
const scan = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'process-officer-scan', 'index.ts'),
  'utf8',
);
const rateEngine = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260904140000_rate_resolution_engine.sql'),
  'utf8',
);

test('retires only the four duplicate geometry helpers', () => {
  for (const helper of [
    'closure_at_point',
    'point_in_zone',
    'zones_for_site',
    'compute_point_distance_km',
  ]) {
    assert.match(migration, new RegExp(`drop function if exists public\\.${helper}`));
    assert.equal(
      fs.existsSync(path.join(root, 'supabase', 'schemas', 'public', 'functions', `${helper}.sql`)),
      false,
    );
  }
});

test('preserves the governed field context and closure paths', () => {
  assert.match(scan, /callerClient\.rpc\('resolve_operational_context_authorized'/);
  assert.match(scan, /rpc\('is_zone_closed'/);
  assert.match(scan, /resolution_source: locationSource === 'device_gps' \? 'resolve_operational_context_authorized' : locationSource/);
});

test('preserves the canonical travel-distance calculator', () => {
  assert.match(rateEngine, /function "public"\."compute_travel_distance_km"/i);
  assert.match(rateEngine, /public\.compute_travel_distance_km/);
});
