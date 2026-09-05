const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260905004300_branch_rate_book_inheritance.sql'), 'utf8');

test('proposal pricing permits operating branch rules with explicit parent template fallback', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.manage_crm_quote_proposal_module/);
  assert.match(migration, /with recursive provider_tree as/);
  assert.match(migration, /organization\.id = v_quote\.provider_org_id/);
  assert.match(migration, /rule\.organization_id in \(select id from provider_tree\)/);
  assert.match(migration, /Active operating-provider or parent-template billing rate rule required/);
  assert.doesNotMatch(migration, /insert into public\.service_agreement_modules/);
});