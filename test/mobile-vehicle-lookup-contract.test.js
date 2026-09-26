const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerVehicleLookup.tsx'), 'utf8');

test('mobile vehicle lookup uses only canonical read sources', () => {
  for (const table of ['canonical_vehicles', 'canonical_scv', 'observations', 'breach_alerts', 'entity_flags']) {
    assert.match(source, new RegExp(`from\\('${table}'\\)\\.select`));
  }
  assert.doesNotMatch(source, /\.insert\(/);
  assert.doesNotMatch(source, /\.update\(/);
});

test('mobile vehicle flags remain scoped to the officer organization', () => {
  assert.match(source, /\.eq\('organization_id', organizationId\)/);
  assert.match(source, /\.eq\('entity_type', 'vehicle'\)/);
  assert.match(source, /\.eq\('active', true\)/);
});

test('mobile vehicle lookup keeps technical failures in warnings, not the officer error', () => {
  assert.match(source, /catch \(cause\) \{\s*console\.warn\('Vehicle lookup failed', cause\);\s*setError\("We couldn't look up this vehicle right now\. Please try again\."\);\s*\} finally/);
  assert.match(source, /\{error && <Text style=\{styles\.error\}>\{error\}<\/Text>\}/);
});