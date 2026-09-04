const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const mobileRoot = resolve(__dirname, '../apps/mobile/src');
const components = [
  'components/OfficerCheckpointScanner.tsx',
  'components/OfficerFieldReportPanel.tsx',
  'components/OfficerSafetyBar.tsx',
  'components/OfficerScanScreen.tsx',
  'components/NotificationInbox.tsx',
];

test('officer-console error alerts keep raw backend exceptions out of field-facing copy', () => {
  const helper = readFileSync(resolve(mobileRoot, 'lib/userFacingError.ts'), 'utf8');
  assert.match(helper, /console\.error/);

  for (const component of components) {
    const source = readFileSync(resolve(mobileRoot, component), 'utf8');
    assert.doesNotMatch(source, /Alert\.alert\([^\n]*error\.message/);
  }
});