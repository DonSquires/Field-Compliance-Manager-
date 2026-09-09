const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const contract = fs.readFileSync(path.join(__dirname, '..', 'docs/CCTV_CAPTURE_ENDPOINT_CONTRACT.md'), 'utf8');
const enhancement = fs.readFileSync(path.join(__dirname, '..', 'services/vision/capture_enhancement.py'), 'utf8');

test('CCTV capture endpoint keeps enhancement provisional and provenance-backed', () => {
  assert.match(contract, /deterministic_capture_v1/);
  assert.match(contract, /source_frame_hash/);
  assert.match(contract, /enhanced_crop_hash/);
  assert.match(contract, /face matching may suggest candidates but cannot assign identity/i);
  assert.match(contract, /ALPR may suggest text but cannot confirm a plate/i);
  assert.match(contract, /animal_detection/);
  assert.match(enhancement, /generative: bool/);
  assert.match(enhancement, /source_sha256/);
  assert.match(enhancement, /enhanced_sha256/);
  assert.match(enhancement, /CLAHE/);
});
