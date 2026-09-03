const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const tracking = readFileSync(resolve(__dirname, '../apps/mobile/src/lib/backgroundTracking.ts'), 'utf8');
const safetyBar = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerSafetyBar.tsx'), 'utf8');

test('background tracking uses Expo task manager and canonical breadcrumb delivery', () => {
  assert.match(tracking, /TaskManager\.defineTask\(BACKGROUND_LOCATION_TASK/);
  assert.match(tracking, /recordMobileBreadcrumb/);
  assert.match(tracking, /BREADCRUMB_INTERVAL_MS/);
  assert.match(tracking, /Location\.startLocationUpdatesAsync/);
  assert.match(tracking, /Location\.stopLocationUpdatesAsync/);
});

test('background tracking is officer-controlled and limited to active shifts', () => {
  assert.match(safetyBar, /if \(!shiftId\)/);
  assert.match(safetyBar, /Track active shift/);
  assert.match(safetyBar, /Stop background tracking/);
  assert.match(safetyBar, /Tracking not confirmed/);
});