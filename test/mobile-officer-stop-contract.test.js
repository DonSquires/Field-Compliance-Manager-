const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerStopPanel.tsx'), 'utf8');

test('mobile patrol stops are scoped to the active shift', () => {
  assert.match(source, /from\('shift_stops'\)\.select/);
  assert.match(source, /\.eq\('shift_id', shiftId\)/);
  assert.match(source, /\['pending', 'en_route', 'on_scene'\]/);
});

test('mobile stop completion uses the governed RPC with captured GPS', () => {
  assert.match(source, /captureCoordinates/);
  assert.match(source, /rpc\('complete_shift_stop'/);
  assert.match(source, /p_stop_id: stop\.id/);
  assert.match(source, /p_gps_lat: coordinates\?\.lat \?\? null/);
  assert.match(source, /Stop completion was not confirmed/);
});