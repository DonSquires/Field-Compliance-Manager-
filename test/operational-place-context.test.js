const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../apps/web/src/pages');
const sources = {
  dispatch: fs.readFileSync(path.join(root, 'DispatchConsolePage.tsx'), 'utf8'),
  welfare: fs.readFileSync(path.join(root, 'WelfareAlertsPage.tsx'), 'utf8'),
  admin: fs.readFileSync(path.join(root, 'AdminHubPage.tsx'), 'utf8'),
};

test('dispatch console resolves agreement zones before organization fallback', () => {
  assert.match(sources.dispatch, /selectedAgreementZones/);
  assert.match(sources.dispatch, /in\('zone_id', activeZoneIds\)/);
  assert.match(sources.dispatch, /eq\('organization_id', operatingBranchId\)/);
});

test('welfare alerts resolve agreement zones before organization fallback', () => {
  assert.match(sources.welfare, /selectedAgreementZones/);
  assert.match(sources.welfare, /scopedAlertQuery/);
  assert.match(sources.welfare, /in\('zone_id', activeZoneIds\)/);
  assert.match(sources.welfare, /eq\('organization_id', profile\.organizationId\)/);
});

test('admin command centre resolves agreement zones before organization fallback', () => {
  assert.match(sources.admin, /selectedAgreementZones/);
  assert.match(sources.admin, /in\('zone_id', activeZoneIds\)/);
  assert.match(sources.admin, /eq\('organization_id', organizationId\)/);
});
