const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerSmokeControlPanel.tsx'), 'utf8');

test('mobile smoke control panel uses only the governed submit-smoke-assessment command', () => {
  assert.match(source, /functions\.invoke[\s\S]*?'submit-smoke-assessment'/);
  assert.match(source, /client_request_id: requestId\.current/);
  assert.match(source, /assessed_at: assessedAt\.current/);
  assert.match(source, /shift_id: shiftId/);
  assert.doesNotMatch(source, /from\('smoke_assessments'\)\.insert/);
});

test('mobile smoke control panel retains photo evidence and notice validation', () => {
  assert.match(source, /captureEvidencePhoto/);
  assert.match(source, /actionNeedsNotice.*noticeNumber/);
  assert.match(source, /Smoke assessment was not confirmed/);
});
