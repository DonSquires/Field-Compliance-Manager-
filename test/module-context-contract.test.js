const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const contract = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913149000_module_context_contract.sql'), 'utf8');

test('module context contract exposes a single app-facing effective module context', () => {
  assert.match(contract, /module_context_contract/);
  assert.match(contract, /effective_rules/);
  assert.match(contract, /policy_status/);
  assert.match(contract, /resolve_active_rules/);
  assert.match(contract, /security_invoker = true/);
});
