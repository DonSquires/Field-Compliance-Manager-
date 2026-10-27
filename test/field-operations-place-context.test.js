const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/FieldOperationsPage.tsx'), 'utf8');

test('FieldOperationsPage retains agreement context without a place-based module gate', () => {
  assert.doesNotMatch(source, /useActiveModuleContext/);
  assert.match(source, /const dispatchAvailable = dispatchEnabled;/);
  assert.match(source, /useServiceRelationships/);
  assert.match(source, /selectedAgreementZones/);
});
