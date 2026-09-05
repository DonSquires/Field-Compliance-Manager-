const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260905004000_parent_consolidated_commercial_overview.sql'), 'utf8');

test('parent commercial consolidation is a descendant-scoped read model', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_consolidated_commercial_overview/);
  assert.match(migration, /public\.is_admin_for_org\(p_root_organization_id\)/);
  assert.match(migration, /public\.get_descendant_organizations\(p_root_organization_id\)/);
  for (const source of ['public.invoices', 'public.quotes', 'public.service_agreements', 'public.monthly_report_packs']) assert.match(migration, new RegExp(source.replace('.', '\\.')));
  assert.doesNotMatch(migration, /insert into public\.(invoices|quotes|service_agreements|monthly_report_packs)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_consolidated_commercial_overview/);
});