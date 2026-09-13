const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../apps/web/src/pages');
const dispatch = fs.readFileSync(path.join(root, 'OfficerDispatchPage.tsx'), 'utf8');
const map = fs.readFileSync(path.join(root, 'OfficerMapPage.tsx'), 'utf8');
const overnight = fs.readFileSync(path.join(root, 'OfficerOvernightVerificationPage.tsx'), 'utf8');
const vehicleLookup = fs.readFileSync(path.join(root, 'OfficerVehicleLookupPage.tsx'), 'utf8');

test('OfficerDispatchPage resolves active agreement zones before loading jobs', () => {
  assert.match(dispatch, /selectedAgreementZones/);
  assert.match(dispatch, /scopedShiftQuery/);
  assert.match(dispatch, /scopedJobQuery/);
  assert.match(dispatch, /in\('zone_id', activeZoneIds\)/);
});

test('OfficerMapPage resolves active agreement zones before loading GPS positions', () => {
  assert.match(map, /selectedAgreementZones/);
  assert.match(map, /scopedGpsQuery/);
  assert.match(map, /in\('zone_id', activeZoneIds\)/);
  assert.match(map, /eq\('organization_id', orgId\)/);
});

test('OfficerOvernightVerificationPage resolves active agreement zones before loading sessions', () => {
  assert.match(overnight, /selectedAgreementZones/);
  assert.match(overnight, /scopedSessionQuery/);
  assert.match(overnight, /in\('zone_id', activeZoneIds\)/);
  assert.match(overnight, /eq\('organization_id', orgId\)/);
});

test('OfficerVehicleLookupPage resolves active agreement zones before loading history', () => {
  assert.match(vehicleLookup, /selectedAgreementZones/);
  assert.match(vehicleLookup, /in\('zone_id', activeZoneIds\)/);
  assert.match(vehicleLookup, /from\('observations'\)/);
  assert.match(vehicleLookup, /from\('breach_alerts'\)/);
});
