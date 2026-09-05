const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260905004100_parent_consolidated_reporting_overview.sql'), 'utf8');

test('parent reporting consolidation is a descendant-scoped read model', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_consolidated_reporting_overview/);
  assert.match(migration, /public\.is_admin_for_org\(p_root_organization_id\)/);
  assert.match(migration, /public\.get_descendant_organizations\(p_root_organization_id\)/);
  for (const source of ['public.breach_alerts', 'public.observations', 'public.monthly_report_packs']) assert.match(migration, new RegExp(source.replace('.', '\\.')));
  assert.doesNotMatch(migration, /insert into public\.(breach_alerts|observations|monthly_report_packs)/);
});