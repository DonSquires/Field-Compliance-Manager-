const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const view = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913144000_effective_rule_resolution_view.sql'), 'utf8');

test('effective rule resolution view is read-only and combines module/jurisdiction place policy context', () => {
  assert.match(view, /effective_rule_resolution_view/);
  assert.match(view, /dominant_anchor_kind/);
  assert.match(view, /effective_policy_status/);
  assert.match(view, /latest_module_rules/);
  assert.match(view, /latest_jurisdiction_rules/);
  assert.match(view, /security_invoker = true/);
});
