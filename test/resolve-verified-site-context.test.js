const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260831086000_resolve_verified_site_context.sql'), 'utf8');

test('standalone Site resolution uses only authorized verified geometry', () => {
  assert.match(sql, /client_organization_id=any\(coalesce\(p_client_org_ids/);
  assert.match(sql, /s\.boundary_verification='verified'/);
  assert.match(sql, /st_isvalid\(s\.boundary\)/);
  assert.match(sql, /not st_isempty\(s\.boundary\)/);
  assert.match(sql, /st_covers\(s\.boundary,p\.geometry\)/);
  assert.match(sql, /st_dwithin\(coalesce\(s\.center_point,s\.boundary\)::geography/);
});

test('standalone Site resolution prefers polygon coverage and is service-only', () => {
  assert.match(sql, /order by case when st_covers\(s\.boundary,p\.geometry\) then 0 else 1 end/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.resolve_verified_site_context[\s\S]*public,anon,authenticated/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.resolve_verified_site_context[\s\S]*service_role/i);
});