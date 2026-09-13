const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/OfficerNoiseControlPage.tsx'), 'utf8');

test('OfficerNoiseControlPage resolves the active place-first module context before loading assessments', () => {
  assert.match(source, /useActiveModuleContext/);
  assert.match(source, /useServiceRelationships/);
  assert.match(source, /selectedAgreementZones/);
});
