const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerBiosecurityPanel.tsx'), 'utf8');

test('mobile biosecurity panel uses only the governed submit-biosecurity-assessment command', () => {
  assert.match(source, /functions\.invoke[\s\S]*?'submit-biosecurity-assessment'/);
  assert.match(source, /client_request_id: requestId\.current/);
  assert.match(source, /assessed_at: assessedAt\.current/);
  assert.match(source, /shift_id: shiftId/);
  assert.doesNotMatch(source, /from\('biosecurity_assessments'\)\.insert/);
});

test('mobile biosecurity panel retains evidence photo and notice validation', () => {
  assert.match(source, /captureEvidencePhoto/);
  assert.match(source, /densityEstimate === 'not_found' \|\| Boolean\(speciesName\.trim\(\)\)/);
  assert.match(source, /actionNeedsNotice.*noticeNumber/);
  assert.match(source, /actionNeedsReferral.*mpiReferralNumber/);
  assert.match(source, /Biosecurity assessment was not confirmed/);
});
