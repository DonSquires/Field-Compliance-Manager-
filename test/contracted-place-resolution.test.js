const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20260925230000_contracted_site_zone_resolution.sql'), 'utf8');
const nullStartCorrection = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20260926011000_operational_context_null_start_dates.sql'), 'utf8');
const relationships = fs.readFileSync(path.join(__dirname, '..', 'apps/web/src/context/ServiceRelationshipContext.tsx'), 'utf8');

test('operational GPS resolves contracted Zones, then Sites, while preserving blocked geometry states', () => {
  assert.match(migration, /Existing verified contracted-Zone path/);
  assert.match(migration, /A verified Site is independently selectable/);
  assert.match(migration, /cs\.boundary_verification = 'verified'/);
  assert.match(migration, /'unresolved_unverified'::text/);
  assert.match(migration, /'unresolved_invalid'::text/);
  assert.match(migration, /sal\.status = 'active'/);
  assert.match(migration, /sa\.invitation_status = 'accepted'/);
});

test('legacy accepted agreements with no start date remain operationally in force', () => {
  assert.equal((nullStartCorrection.match(/sa\.starts_on IS NULL OR sa\.starts_on <= p_at::date/g) || []).length, 6);
  assert.doesNotMatch(nullStartCorrection, /AND sa\.starts_on <= p_at::date/);
});

test('browser GPS uses only the tenant-authorized operational wrapper', () => {
  assert.match(migration, /auth\.uid\(\) IS NULL OR NOT public\.org_access_allowed\(p_org_id\)/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.resolve_operational_context_authorized[\s\S]*TO authenticated, service_role/);
  assert.match(relationships, /supabase\.rpc\('resolve_operational_context_authorized'/);
  assert.doesNotMatch(relationships, /supabase\.rpc\('resolve_context_authorized'/);
});