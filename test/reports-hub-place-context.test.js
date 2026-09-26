const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/ReportsHubPage.tsx'), 'utf8');

test('ReportsHubPage scopes report data to the agreement selected in the hub', () => {
  assert.doesNotMatch(source, /useActiveModuleContext/);
  assert.match(source, /useServiceRelationships/);
  // The reader chooses the agreement on the hub; its zones scope breaches and observations (owner walk 2026-09-19).
  assert.match(source, /const \[agreementFilterId, setAgreementFilterId\] = useState\(''\);/);
  assert.match(source, /\.from\('service_agreement_locations'\)\.select\('zone_id'\)\.eq\('service_agreement_id', selectedAgreement\.id\)/);
});
