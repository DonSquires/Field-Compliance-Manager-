const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260831087000_authorize_resolve_context.sql'), 'utf8');

test('browser geofence resolution is tenant-scoped through an authenticated wrapper', () => {
  assert.match(sql, /auth\.uid\(\) is null or not public\.org_access_allowed\(p_org_id\)/i);
  assert.match(sql, /Geofence context access denied/);
  assert.match(sql, /return query select \* from public\.resolve_context/);
  assert.match(sql, /grant execute on function public\.resolve_context_authorized[\s\S]*to authenticated/i);
});

test('canonical resolver is service-only and unavailable to anonymous or direct authenticated calls', () => {
  assert.match(sql, /revoke all on function public\.resolve_context[\s\S]*from public,anon,authenticated/i);
  assert.match(sql, /grant execute on function public\.resolve_context[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /grant execute on function public\.resolve_context\([^;]+to authenticated/i);
});