const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const context = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/context/ServiceRelationshipContext.tsx'), 'utf8');
const banner = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/components/PlaceContextBanner.tsx'), 'utf8');
const shells = ['OfficerShell.tsx', 'AdminShell.tsx', 'ModuleShell.tsx', 'ClientShell.tsx', 'ScanShell.tsx']
  .map((file) => fs.readFileSync(path.resolve(__dirname, `../apps/web/src/shells/${file}`), 'utf8'));

test('service relationships select agreement places from the current geofence', () => {
  assert.match(context, /resolve_context_authorized/);
  assert.match(context, /matched_zone_id/);
  assert.match(context, /matched_site_id|site_id/);
  assert.match(context, /setSelectedZoneId\(zoneId\)/);
  assert.match(context, /setSelectedSiteId\(siteId\)/);
  assert.match(context, /setLocationStatus\('outside_geofence'\)/);
  assert.match(context, /setSelectedSiteId\(null\);\s*setSelectedZoneId\(null\);/);
});

test('outside geofences expose current GPS and physical address evidence', () => {
  assert.match(context, /resolveAddressForCoordinates/);
  assert.match(context, /currentCoordinates/);
  assert.match(banner, /GPS:/);
  assert.match(banner, /Address:/);
  assert.match(banner, /outside_geofence/);
});

test('every authenticated shell mounts the shared place context banner', () => {
  for (const source of shells) assert.match(source, /PlaceContextBanner/);
});
