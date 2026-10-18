const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261018140000_surface_live_finance_activity.sql'), 'utf8');

test('finance period summary exposes live draft costs without closing the period', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_finance_pl_period_summary/);
  assert.match(migration, /public\.finance_service_costs/);
  assert.match(migration, /public\.finance_pl_periods/);
  assert.match(migration, /public\.is_admin_for_org\(v_org\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_finance_pl_period_summary/);
  assert.doesNotMatch(migration, /UPDATE public\.finance_pl_periods[\s\S]*get_finance_pl_period_summary/);
});

test('closing a period persists complete revenue and result snapshot fields', () => {
  assert.match(migration, /invoice_count,\s+gross_profit,\s+gross_margin_pct/);
  assert.match(migration, /round\(revenue\.total_revenue - costs\.total_cost, 2\)/);
});

test('commercial overview scopes rows to provider roots and branches and reports internal costs', () => {
  assert.match(migration, /organization\.id = p_root_organization_id\s+OR organization\.organization_type = 'branch'/);
  assert.match(migration, /service_cost_count integer/);
  assert.match(migration, /service_cost_total numeric/);
  assert.match(migration, /JOIN public\.finance_pl_periods period/);
  assert.match(migration, /period\.period_start <= p_to/);
});
