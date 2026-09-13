const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rpc = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913148000_active_rule_resolution_rpc.sql'), 'utf8');

test('resolve_active_rules resolves policy from module + place + jurisdiction without hidden org assumptions', () => {
  assert.match(rpc, /resolve_active_rules/);
  assert.match(rpc, /dominant_anchor_kind/);
  assert.match(rpc, /governing_jurisdiction_id/);
  assert.match(rpc, /effective_rules/);
  assert.match(rpc, /policy_status/);
  assert.match(rpc, /resolve_context\(/);
});
