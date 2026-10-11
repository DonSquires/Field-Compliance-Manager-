const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerNoiseControlPanel.tsx'), 'utf8');

test('mobile noise control panel uses only the governed submit-noise-assessment command', () => {
  assert.match(source, /functions\.invoke<[\s\S]*?>\('submit-noise-assessment'/);
  assert.match(source, /client_request_id: requestId\.current/);
  assert.match(source, /assessed_at: assessedAt\.current/);
  assert.match(source, /shift_id: shiftId/);
  assert.match(source, /image_base64: imageBase64/);
  assert.match(source, /captureEvidencePhoto/);
  assert.doesNotMatch(source, /from\('noise_assessments'\)\.insert/);
  assert.doesNotMatch(source, /rpc\('submit_officer_noise_assessment'/);
});

test('mobile noise control panel calculates matrix score and requires notice number for statutory actions', () => {
  assert.match(source, /getCurrentTimeScore/);
  assert.match(source, /actionNeedsNotice/);
  assert.match(source, /volume_score: volumeScore/);
  assert.match(source, /tone_score: toneScore/);
  assert.match(source, /A photo cannot measure noise or determine whether it is excessive/);
  assert.match(source, /Noise assessment submission failed/);
});
