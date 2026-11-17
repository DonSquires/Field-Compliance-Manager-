const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/OfficerParkingPage.tsx'), 'utf8');

test('OfficerParkingPage loads the officer\'s complete parking history across Zones', () => {
  assert.match(source, /useActiveModuleContext/);
  assert.match(source, /useServiceRelationships/);
  assert.match(source, /\.eq\('officer_id', profile\.id\)/);
  assert.doesNotMatch(source, /selectedAgreementZones/);
});
