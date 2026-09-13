const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913154300_converge_operational_records_on_canonical_identity.sql'), 'utf8');

test('operational records converge on canonical identities through table-specific anchors', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.resolve_record_canonical_identity/);
  assert.match(migration, /TG_TABLE_NAME = 'observations'/);
  assert.match(migration, /TG_TABLE_NAME = 'incidents'/);
  assert.match(migration, /TG_TABLE_NAME = 'officer_field_reports'/);
  assert.match(migration, /COALESCE\(NEW\.client_site_id, NEW\.zone_id\)/);
  assert.match(migration, /canonical_scv_id/);
  assert.match(migration, /CREATE TRIGGER trg_observations_resolve_canonical_identity/);
  assert.match(migration, /CREATE TRIGGER trg_location_events_resolve_canonical_identity/);
});
