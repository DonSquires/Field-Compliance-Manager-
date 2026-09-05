const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260905004200_branch_operating_provider_quotes.sql'), 'utf8');

test('operating-provider quote creation preserves branch accountability', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.create_crm_draft_quote_for_provider/);
  assert.match(migration, /p_operating_provider_organization_id uuid/);
  assert.match(migration, /public\.is_admin_for_org\(v_provider\.id\)/);
  assert.match(migration, /Operating provider must be a service provider or internal branch/);
  assert.match(migration, /quote\.provider_org_id = v_provider\.id/);
  assert.match(migration, /operating_provider_organization_id/);
  assert.doesNotMatch(migration, /insert into public\.service_agreements/);
});