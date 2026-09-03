const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const breadcrumb = readFileSync(resolve(__dirname, '../apps/mobile/src/lib/officerBreadcrumb.ts'), 'utf8');
const bar = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerSafetyBar.tsx'), 'utf8');

test('mobile heartbeat uses the canonical idempotent breadcrumb RPC', () => {
  assert.match(breadcrumb, /BREADCRUMB_INTERVAL_MS = 120_000/);
  assert.match(breadcrumb, /rpc\('record_officer_breadcrumb'/);
  assert.match(breadcrumb, /p_client_event_id: event\.clientEventId/);
  assert.match(breadcrumb, /p_shift_id: event\.shiftId/);
});

test('foreground heartbeat retains unconfirmed location events for retry', () => {
  assert.match(breadcrumb, /AsyncStorage\.setItem\(QUEUE_KEY/);
  assert.match(breadcrumb, /attempts: item\.attempts \+ 1/);
  assert.match(bar, /setInterval\(\(\) => void heartbeat\(\), BREADCRUMB_INTERVAL_MS\)/);
  assert.match(bar, /flushMobileBreadcrumbs/);
});