const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const officerPage = fs.readFileSync(path.join(root, 'apps/web/src/pages/OfficerParkingPage.tsx'), 'utf8');
const oversightPage = fs.readFileSync(path.join(root, 'apps/web/src/pages/ParkingOversightPage.tsx'), 'utf8');
const ruleFunction = fs.readFileSync(path.join(root, 'supabase/functions/update-parking-zone-rule/index.ts'), 'utf8');

test('officer Parking capture is owned by the canonical scan pipeline', () => {
  assert.match(officerPage, /moduleKey: 'parking_enforcement'/);
  assert.match(officerPage, /functions\.invoke<ParkingScanResult>\('process-officer-scan'/);
  assert.doesNotMatch(officerPage, /\.from\(['"]parking_chalk_records['"]\)\s*\.insert/);
  assert.doesNotMatch(officerPage, /\.from\(['"]parking_chalk_records['"]\)\s*\.update/);
});

test('Parking rule updates derive authority, lock versions, and audit provenance', () => {
  assert.match(schema, /manage_parking_zone_rule/);
  assert.match(schema, /auth\.uid\(\)/);
  assert.match(schema, /FOR UPDATE/i);
  assert.match(schema, /configuration_version/);
  assert.match(schema, /parking_limit_source/);
  assert.match(schema, /parking_limit_set_by/);
  assert.match(schema, /parking_limit_set_at/);
  assert.match(schema, /parking_zone_rule_updated/);
});

test('Parking oversight exposes rule source and private signage intake', () => {
  assert.match(oversightPage, /parking_time_limit_minutes/);
  assert.match(oversightPage, /parking_limit_source/);
  assert.match(oversightPage, /update-parking-zone-rule/);
  assert.match(oversightPage, /parking_signage_photo_url/);
});

test('Parking signage intake delegates authority and cleans failed uploads', () => {
  assert.match(ruleFunction, /caller\.rpc\('manage_parking_zone_rule'/);
  assert.match(ruleFunction, /parking-signage\/\$\{zoneId\}/);
  assert.match(ruleFunction, /JPEG image/);
  assert.match(ruleFunction, /if \(uploadedPath\)/);
  assert.match(ruleFunction, /storage\.from\(EVIDENCE_BUCKET\)\.remove\(\[uploadedPath\]\)/);
});

test('authenticated users cannot mutate Parking evidence or rules directly', () => {
  assert.match(schema, /REVOKE INSERT,UPDATE,DELETE ON TABLE "public"\."parking_chalk_records" FROM PUBLIC,"anon","authenticated"/);
  assert.match(schema, /REVOKE UPDATE ON TABLE "public"\."location_zones" FROM PUBLIC,"anon","authenticated"/);
});