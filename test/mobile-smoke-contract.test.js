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
  assert.match(source, /<Image[\s\S]*Captured smoke evidence/);
  assert.match(source, /Remove captured smoke evidence/);
  assert.match(source, /actionNeedsNotice.*noticeNumber/);
  assert.match(source, /Smoke assessment was not confirmed/);
  assert.match(source, /source_confirmed: sourceConfirmed/);
  assert.match(source, /notes: notes\.trim\(\) \|\| null/);
  assert.match(source, /sourceConfirmed &&/);
  assert.match(source, /Boolean\(sceneDescription\.trim\(\)\)/);
  assert.match(source, /'moderate'/);
  assert.doesNotMatch(source, /'medium'/);
});

test('mobile smoke control panel states machine authority and blocked requirements explicitly', () => {
  assert.match(source, /cannot establish a breach, legal basis, notice, or enforcement action/);
  assert.match(source, /Still needed:/);
  assert.match(source, /accessibilityLiveRegion="polite"/);
  assert.match(source, /accessibilityRole="checkbox"/);
  assert.match(source, /minHeight: 44/);
});
