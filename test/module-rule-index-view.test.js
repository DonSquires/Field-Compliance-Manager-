const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const view = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913147000_module_rule_index_view.sql'), 'utf8');

test('module rule index view indexes rule sets by module and place scope', () => {
  assert.match(view, /module_rule_index_view/);
  assert.match(view, /active_rule_set_id/);
  assert.match(view, /place_scope/);
  assert.match(view, /module_rule_sets/);
  assert.match(view, /jurisdiction_rule_sets/);
  assert.match(view, /security_invoker = true/);
});
