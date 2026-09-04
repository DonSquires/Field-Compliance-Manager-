const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/web/src/components/CrmSiteDialog.tsx'), 'utf8');

test('CRM site creation resolves and confirms a canonical address first', () => {
  assert.match(source, /resolveAddressCandidates\(address, 1\)/);
  assert.match(source, /setResolvedAddress\(candidate\)/);
  assert.match(source, /setAddress\(candidate\.label\)/);
  assert.match(source, /Canonical address ready/);
  assert.match(source, /disabled=\{saving \|\| resolvingAddress \|\| !name\.trim\(\) \|\| !resolvedAddress\}/);
  assert.match(source, /supabase\.rpc\('create_crm_site'/);
});