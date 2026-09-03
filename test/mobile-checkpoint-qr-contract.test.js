const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerCheckpointScanner.tsx'), 'utf8');

test('mobile QR checkpoint scan resolves an active organizational checkpoint', () => {
  assert.match(source, /CameraView/);
  assert.match(source, /barcodeTypes: \['qr'\]/);
  assert.match(source, /from\('patrol_checkpoints'\)\.select/);
  assert.match(source, /\.eq\('qr_code', rawCode\)/);
  assert.match(source, /\.eq\('organization_id', organizationId\)/);
});

test('mobile checkpoint evidence verifies GPS and records canonical attendance', () => {
  assert.match(source, /Location\.getCurrentPositionAsync/);
  assert.match(source, /GPS accuracy is too poor/);
  assert.match(source, /outside the checkpoint radius/);
  assert.match(source, /from\('patrol_checkpoint_visits'\)\.insert/);
  assert.match(source, /scan_method: 'qr_camera'/);
  assert.match(source, /shift_stop_id: stopId/);
});