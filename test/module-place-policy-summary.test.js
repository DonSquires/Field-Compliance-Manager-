const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const summary = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913143000_module_place_policy_summary.sql'), 'utf8');

test('module place policy summary joins module rules, jurisdiction rules, and place coverage', () => {
  assert.match(summary, /module_place_policy_summary/);
  assert.match(summary, /dominant_anchor_kind/);
  assert.match(summary, /policy_status/);
  assert.match(summary, /latest_module_rules/);
  assert.match(summary, /latest_jurisdiction_rules/);
  assert.match(summary, /organization_modules/);
  assert.match(summary, /security_invoker = true/);
});
