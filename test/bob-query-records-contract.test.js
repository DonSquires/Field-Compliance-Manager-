const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../supabase/functions/bob-query-records/index.ts'), 'utf8');

test('Bob query_records exposes every conductor lookup as an authenticated bounded read', () => {
  for (const lookup of ['find_org', 'get_org', 'list_orgs', 'list_sites', 'list_routes', 'list_zones', 'find_user']) {
    assert.match(source, new RegExp(`'${lookup}'`));
  }
  assert.match(source, /caller\.auth\.getUser\(\)/);
  assert.match(source, /CAN_QUERY\.has\(role\)/);
  assert.match(source, /boundedLimit/);
  assert.match(source, /limit\(limit\)/);
  assert.doesNotMatch(source, /deprecated_endpoint/);
  assert.doesNotMatch(source, /\.rpc\('execute_sql'/);
});

test('Bob query_records derives scope from the authenticated profile', () => {
  assert.match(source, /profile\.organization_id/);
  assert.match(source, /const unrestricted = role === 'grand_master'/);
  assert.match(source, /if \(!unrestricted\) request = request\.eq\('organization_id', scopedOrgId\)/);
  assert.match(source, /display_name, role, organization_id/);
  assert.doesNotMatch(source, /select\('\*'\)/);
});