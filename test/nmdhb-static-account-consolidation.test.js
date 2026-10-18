const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20261018150000_consolidate_nmdhb_static_account.sql'),
  'utf8',
);

test('NMDHB consolidation is guarded by the reviewed Model A identities', () => {
  assert.match(migration, /organization_type = 'government'[\s\S]*parent_organization_id IS NULL/);
  assert.match(migration, /organization_type = 'client'[\s\S]*parent_organization_id = v_provider_org/);
  assert.match(migration, /Legacy NMDHB operational surface changed after review/);
  assert.match(migration, /module\.module_key = 'static_guarding'/);
});

test('NMDHB operational records move to the own-rooted organization without deleting audit history', () => {
  for (const table of [
    'public.locations',
    'public.canonical_place_links',
    'public.boundary_proposals',
    'public.client_sites',
    'public.location_zones',
    'public.crm_contacts',
    'public.service_agreements',
  ]) {
    assert.match(migration, new RegExp(`UPDATE ${table.replace('.', '\\.')}`));
  }
  assert.match(migration, /name = 'NMDHB \(legacy R&M prospect shell\)'/);
  assert.match(migration, /retained_legacy_shell', true/);
  assert.doesNotMatch(migration, /DELETE FROM public\.organizations/);
});

test('platform billing placeholders and test work units cannot masquerade as live static delivery', () => {
  assert.match(migration, /Layer-1 platform billing agreement must not own an operational place/);
  assert.match(migration, /UPDATE public\.service_agreement_locations[\s\S]*status = 'ended'/);
  assert.match(migration, /UPDATE public\.roster_work_units[\s\S]*name = 'Test'/);
  assert.match(migration, /action,[\s\S]*'nmdhb_organization_consolidated'/);
});
