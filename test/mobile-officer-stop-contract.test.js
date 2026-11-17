const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerStopPanel.tsx'), 'utf8');

test('mobile patrol stops are scoped to the active shift', () => {
  assert.match(source, /rpc\('get_officer_patrol_stops', \{ p_shift_id: shiftId \}\)/);
  assert.match(source, /stop\.status === 'pending' \|\| stop\.status === 'en_route' \|\| stop\.status === 'on_scene'/);
});

test('mobile stop arrival and departure use the officer RPC with captured GPS', () => {
  assert.match(source, /captureCoordinates/);
  assert.match(source, /rpc\('manage_officer_patrol_stop'/);
  assert.match(source, /p_stop_id: stop\.id/);
  assert.match(source, /p_gps_lat: coordinates\?\.lat \?\? null/);
  assert.match(source, /Departure was not recorded/);
});

test('mobile arrival is gated on the stop safety briefing', () => {
  assert.match(source, /rpc\('get_shift_safety_briefing', \{ p_shift_id: shiftId, p_stop_id: stop\.id \}\)/);
  assert.match(source, /rpc\('acknowledge_safety_briefing'/);
});