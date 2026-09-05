const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260905003800_invoice_requires_commercial_source.sql'),
  'utf8',
);

test('invoice generation fails closed without accepted commercial pricing', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.generate_crm_invoice_from_agreement/);
  assert.match(migration, /quote\.service_agreement_id = v_agreement\.id and quote\.status = 'accepted'/);
  assert.match(migration, /v_comm\.base_rate_per_hour > 0/);
  assert.match(migration, /Commercial configuration incomplete: an accepted quote line or positive agreement rate is required before invoicing/);
  assert.doesNotMatch(migration, /Field Compliance & Safety Service Retainer/);
  assert.doesNotMatch(migration, /500\.00/);
});