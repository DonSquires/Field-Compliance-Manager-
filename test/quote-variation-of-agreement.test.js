const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260918090000_quote_variation_of_agreement.sql'), 'utf8');

test('a draft quote can be raised as a variation of an existing operational agreement', () => {
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.create_crm_draft_quote_for_provider\(uuid, uuid, uuid, text, numeric, date, text\);/);
  assert.match(migration, /p_service_agreement_id uuid DEFAULT NULL/);
  assert.match(migration, /insert into public\.quotes\([^)]*service_agreement_id[^)]*\)/);
  assert.match(migration, /'relationship_state',case when p_service_agreement_id is null then 'proposal_only' else 'variation_of_agreement' end/);
});

test('a variation must belong to the same client, an operational agreement, the provider tree, and must not have ended', () => {
  assert.match(migration, /v_agreement\.client_organization_id <> v_client\.id/);
  assert.match(migration, /v_agreement\.agreement_type <> 'operational'/);
  assert.match(migration, /v_agreement\.provider_organization_id = any\(v_provider_tree\)/);
  assert.match(migration, /v_agreement\.ends_on < current_date/);
  assert.match(migration, /Raise a new agreement instead of a variation/);
});

test('the variation seam keeps the existing accountability boundary and grants', () => {
  assert.match(migration, /public\.is_admin_for_org\(v_provider\.id\)/);
  assert.match(migration, /Operating provider must be a service provider or internal branch/);
  assert.doesNotMatch(migration, /insert into public\.service_agreements/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.create_crm_draft_quote_for_provider\(uuid, uuid, uuid, text, numeric, date, text, uuid\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.create_crm_draft_quote_for_provider\(uuid, uuid, uuid, text, numeric, date, text, uuid\) TO postgres, authenticated, service_role;/);
});
