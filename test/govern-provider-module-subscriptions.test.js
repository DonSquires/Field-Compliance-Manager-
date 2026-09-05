const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260905004500_govern_provider_module_subscriptions.sql'), 'utf8');

test('Layer 1 provider subscription status is owner-governed and audited', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.manage_provider_module_subscription_status/);
  assert.match(migration, /public\.is_grand_master\(\)/);
  assert.match(migration, /'active', 'suspended', 'cancelled'/);
  assert.match(migration, /A cancelled platform subscription requires a new contract/);
  assert.match(migration, /provider_module_subscription_status_managed/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.manage_provider_module_subscription_status/);
});