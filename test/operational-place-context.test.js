const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../apps/web/src/pages');
const sources = {
  dispatch: fs.readFileSync(path.join(root, 'DispatchConsolePage.tsx'), 'utf8'),
  welfare: fs.readFileSync(path.join(root, 'WelfareAlertsPage.tsx'), 'utf8'),
  admin: fs.readFileSync(path.join(root, 'AdminHubPage.tsx'), 'utf8'),
  breachReview: fs.readFileSync(path.join(root, 'BreachReviewPage.tsx'), 'utf8'),
  parkingOversight: fs.readFileSync(path.join(root, 'ParkingOversightPage.tsx'), 'utf8'),
  noiseOversight: fs.readFileSync(path.join(root, 'NoiseControlOversightPage.tsx'), 'utf8'),
  biosecurityOversight: fs.readFileSync(path.join(root, 'BiosecurityOversightPage.tsx'), 'utf8'),
  fieldReports: fs.readFileSync(path.join(root, 'FieldReportsPage.tsx'), 'utf8'),
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

test('breach review resolves agreement zones before organization fallback', () => {
  assert.match(sources.breachReview, /useServiceRelationships/);
  assert.match(sources.breachReview, /selectedAgreementZones/);
  assert.match(sources.breachReview, /query\.in\('zone_id'/);
});

test('parking oversight resolves agreement zones before organization fallback', () => {
  assert.match(sources.parkingOversight, /useServiceRelationships/);
  assert.match(sources.parkingOversight, /selectedAgreementZones/);
  assert.match(sources.parkingOversight, /query\.in\('zone_id'/);
});

test('noise oversight resolves agreement sites before organization fallback', () => {
  assert.match(sources.noiseOversight, /useServiceRelationships/);
  assert.match(sources.noiseOversight, /selectedAgreementSites/);
  assert.match(sources.noiseOversight, /query\.in\('site_id'/);
});

test('biosecurity oversight resolves agreement sites before organization fallback', () => {
  assert.match(sources.biosecurityOversight, /useServiceRelationships/);
  assert.match(sources.biosecurityOversight, /selectedAgreementSites/);
  assert.match(sources.biosecurityOversight, /query\.in\('site_id'/);
});

test('field reports resolve agreement Sites and Zones before organization fallback', () => {
  assert.match(sources.fieldReports, /useServiceRelationships/);
  assert.match(sources.fieldReports, /selectedAgreementSites/);
  assert.match(sources.fieldReports, /selectedAgreementZones/);
  assert.match(sources.fieldReports, /buildAgreementPlaceFilter/);
  assert.match(sources.fieldReports, /query\.or\(placeFilter\)/);
});
