const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerNoiseControlPanel.tsx'), 'utf8');

test('mobile noise control panel uses only the governed submit_officer_noise_assessment RPC', () => {
  assert.match(source, /rpc\('submit_officer_noise_assessment'/);
  assert.match(source, /p_client_request_id: requestId\.current/);
  assert.match(source, /p_assessed_at: assessedAt\.current/);
  assert.match(source, /p_shift_id: shiftId/);
  assert.doesNotMatch(source, /from\('noise_assessments'\)\.insert/);
});

test('mobile noise control panel calculates matrix score and requires notice number for statutory actions', () => {
  assert.match(source, /getCurrentTimeScore/);
  assert.match(source, /actionNeedsNotice/);
  assert.match(source, /p_volume_score: volumeScore/);
  assert.match(source, /p_tone_score: toneScore/);
  assert.match(source, /Noise assessment submission failed/);
});
