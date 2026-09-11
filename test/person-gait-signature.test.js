const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGaitSignature } = require('../services/vision/motion_consolidator');

test('person gait signature preserves numerical motion evidence without assigning identity or style', () => {
  const signature = buildGaitSignature([
    { timestamp: 0, center: { x: 10, y: 20 }, width: 30, height: 100 },
    { timestamp: 0.4, center: { x: 20, y: 21 }, width: 31, height: 101 },
    { timestamp: 0.8, center: { x: 31, y: 20 }, width: 29, height: 99 },
    { timestamp: 1.2, center: { x: 43, y: 21 }, width: 31, height: 100 },
  ]);

  assert.equal(signature.state, 'provisional_motion_signature');
  assert.equal(signature.walking_style_label, null);
  assert.equal(signature.identity_resolution, 'manual_review_required');
  assert.equal(signature.review_required, true);
  assert.ok(signature.normalized_speed_body_lengths_per_second > 0);
});

test('short person tracks do not claim a gait signature', () => {
  assert.deepEqual(buildGaitSignature([
    { timestamp: 0, center: { x: 10, y: 20 }, width: 30, height: 100 },
  ]), { state: 'insufficient_track', review_required: true });
});
