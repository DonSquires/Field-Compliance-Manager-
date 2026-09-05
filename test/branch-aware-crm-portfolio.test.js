const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260905004800_branch_aware_crm_portfolio.sql'), 'utf8');

test('CRM portfolio preserves operating branch ownership with parent oversight', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_crm_provider_portfolio/);
  assert.match(migration, /v_selected_provider = v_home_provider then public\.get_descendant_organizations\(v_home_provider\)/);
  assert.match(migration, /child\.parent_organization_id = provider\.id/);
  assert.match(migration, /agreement\.provider_organization_id = provider\.id and agreement\.agreement_type = 'operational'/);
  assert.match(migration, /operating_provider_organization_id/);
  assert.doesNotMatch(migration, /insert into public\.(organizations|service_agreements|quotes)/);
});