const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260905004900_activate_provider_branch.sql'), 'utf8');

test('provider branches activate under their parent without a client agreement', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.activate_provider_branch/);
  assert.match(migration, /v_branch\.organization_type <> 'branch'/);
  assert.match(migration, /v_parent\.organization_type not in \('owner', 'service_provider', 'branch'\)/);
  assert.match(migration, /public\.is_admin_for_org\(v_parent\.id\)/);
  assert.match(migration, /Only a provider branch in prospect status can be activated/);
  assert.match(migration, /provider_branch_activated/);
  assert.doesNotMatch(migration, /service_agreements/);
});