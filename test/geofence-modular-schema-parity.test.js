const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('modular scan tables retain immutable geofence evidence contracts', () => {
  const observations = read('supabase/schemas/public/tables/observations.sql');
  const parking = read('supabase/schemas/public/tables/parking_chalk_records.sql');
  const preserve = read('supabase/schemas/public/functions/preserve_scan_geofence_context.sql');

  for (const table of [observations, parking]) {
    assert.match(table, /"geofence_context"\s+jsonb\s+not null default '\{\}'::jsonb/i);
    assert.match(table, /execute function public\.preserve_scan_geofence_context\(\)/i);
  }
  assert.match(preserve, /Captured geofence context is immutable/);
  assert.match(preserve, /grant execute[\s\S]*service_role/i);
  assert.doesNotMatch(preserve, /grant execute[\s\S]*authenticated/i);
});

test('modular standalone Site resolver matches the governed migration contract', () => {
  const modular = read('supabase/schemas/public/functions/resolve_verified_site_context.sql');
  const migration = read('supabase/migrations/20260831086000_resolve_verified_site_context.sql');

  for (const sql of [modular, migration]) {
    assert.match(sql, /boundary_verification\s*=\s*'verified'/i);
    assert.match(sql, /st_covers\(s\.boundary\s*,\s*p\.geometry\)/i);
    assert.match(sql, /st_dwithin\([\s\S]*onsite_radius_meters/i);
    assert.match(sql, /grant execute[\s\S]*service_role/i);
  }
});