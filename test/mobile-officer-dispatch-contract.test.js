const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerDispatchPanel.tsx'), 'utf8');

test('mobile dispatch reads jobs only through the active shift', () => {
  assert.match(source, /from\('dispatch_jobs'\)\.select/);
  assert.match(source, /\.eq\('shift_id', shiftId\)/);
  assert.match(source, /ACTIVE_STATUSES/);
  assert.match(source, /zone:zone_id\(name, center_point\)/);
  assert.match(source, /site: site \?\? \(zone \?/);
});

test('mobile dispatch uses the governed status transition and requires completion outcome', () => {
  assert.match(source, /rpc\('advance_dispatch_job_status'/);
  assert.match(source, /p_expected_status: job\.status/);
  assert.match(source, /next === 'completed' && !outcome/);
  assert.match(source, /The dispatch status change was not confirmed/);
});