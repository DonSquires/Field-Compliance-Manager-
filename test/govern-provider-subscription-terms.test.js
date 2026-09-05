const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260905004600_govern_provider_subscription_terms.sql'), 'utf8');

test('Layer 1 subscription overrides are owner-governed, validated, and audited', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.manage_provider_module_subscription_terms/);
  assert.match(migration, /public\.is_grand_master\(\)/);
  assert.match(migration, /Platform price overrides cannot be negative/);
  assert.match(migration, /Discount must be between zero and 100 percent/);
  assert.match(migration, /Unsupported billing period/);
  assert.match(migration, /provider_module_subscription_terms_managed/);
});