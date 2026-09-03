const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerFieldReportPanel.tsx'), 'utf8');

test('mobile field reports use only the governed idempotent submission RPC', () => {
  assert.match(source, /rpc\('submit_officer_field_report'/);
  assert.match(source, /p_client_event_id: eventId\.current/);
  assert.match(source, /p_reported_at: capturedAt\.current/);
  assert.match(source, /p_shift_id: shiftId/);
  assert.doesNotMatch(source, /from\('officer_field_reports'\)\.insert/);
});

test('mobile reports retain required evidence and follow-up validation', () => {
  assert.match(source, /captureCoordinates/);
  assert.match(source, /title\.trim\(\)\.length >= 5/);
  assert.match(source, /description\.trim\(\)\.length >= 10/);
  assert.match(source, /Report receipt was not confirmed/);
});