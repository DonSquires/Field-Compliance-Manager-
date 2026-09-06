const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cosineSimilarity,
  consolidateFaces,
  consolidateVehicles,
  extractKeyframes,
  consolidateMotionSummary,
} = require('../services/vision/motion_consolidator');

test('cosineSimilarity computes expected vector similarity', () => {
  const v1 = [1, 0, 0];
  const v2 = [1, 0, 0];
  const v3 = [0, 1, 0];
  const v4 = [0.5, 0.5, 0];

  assert.equal(cosineSimilarity(v1, v2), 1.0);
  assert.equal(cosineSimilarity(v1, v3), 0.0);
  assert.ok(Math.abs(cosineSimilarity(v1, v4) - 0.7071) < 0.001);
  assert.equal(cosineSimilarity([], []), 0);
});

test('consolidateFaces clusters continuous frames into one subject and handles returns', async () => {
  const embA = [0.8, 0.6, 0.0];
  const embB = [0.0, 0.8, 0.6];

  const frames = [
    // Person A seen consecutively at t=0, 1, 2
    { frame_index: 0, relative_timestamp_seconds: 0.0, sha256_hash: 'h0', face: { success: true, faces: [{ embedding: embA, bbox: { width: 40, height: 40 } }] } },
    { frame_index: 10, relative_timestamp_seconds: 1.0, sha256_hash: 'h1', face: { success: true, faces: [{ embedding: embA, bbox: { width: 50, height: 50 } }] } },
    { frame_index: 20, relative_timestamp_seconds: 2.0, sha256_hash: 'h2', face: { success: true, faces: [{ embedding: embA, bbox: { width: 45, height: 45 } }] } },
    // Person B seen at t=2.5
    { frame_index: 25, relative_timestamp_seconds: 2.5, sha256_hash: 'h3', face: { success: true, faces: [{ embedding: embB, bbox: { width: 30, height: 30 } }] } },
    // Person A returns after 30 seconds (gap > 15s) at t=35.0, 36.0
    { frame_index: 350, relative_timestamp_seconds: 35.0, sha256_hash: 'h4', face: { success: true, faces: [{ embedding: embA, bbox: { width: 60, height: 60 } }] } },
    { frame_index: 360, relative_timestamp_seconds: 36.0, sha256_hash: 'h5', face: { success: true, faces: [{ embedding: embA, bbox: { width: 65, height: 65 } }] } },
  ];

  const { events, uniqueSubjectsCount } = await consolidateFaces(frames, { maxGapSeconds: 15.0 });

  assert.equal(uniqueSubjectsCount, 2, 'Should identify exactly 2 unique persons');
  assert.equal(events.length, 3, 'Should have 3 consolidated events (Person 1 initial, Person 2, Person 1 return)');

  // Check Person 1 initial event
  assert.equal(events[0].subject_id, 1);
  assert.equal(events[0].subject_label, 'Person #1');
  assert.equal(events[0].is_return, false);
  assert.equal(events[0].frame_count, 3);
  assert.equal(events[0].first_seen_seconds, 0.0);
  assert.equal(events[0].last_seen_seconds, 2.0);
  assert.equal(events[0].duration_seconds, 2.0);

  // Check Person 2 event
  assert.equal(events[1].subject_id, 2);
  assert.equal(events[1].subject_label, 'Person #2');
  assert.equal(events[1].frame_count, 1);

  // Check Person 1 return event
  assert.equal(events[2].subject_id, 1);
  assert.equal(events[2].subject_label, 'Person #1 (Return)');
  assert.equal(events[2].is_return, true);
  assert.equal(events[2].frame_count, 2);
  assert.equal(events[2].first_seen_seconds, 35.0);
  assert.equal(events[2].last_seen_seconds, 36.0);
});

test('consolidateVehicles clusters ALPR plate detections and handles returns', async () => {
  const frames = [
    // Vehicle ABC123 seen across t=1.0 -> 3.0
    { frame_index: 10, relative_timestamp_seconds: 1.0, sha256_hash: 'v0', alpr: { success: true, plate: 'ABC123', confidence: 0.85 } },
    { frame_index: 20, relative_timestamp_seconds: 2.0, sha256_hash: 'v1', alpr: { success: true, plate: 'ABC123', confidence: 0.95 } },
    { frame_index: 30, relative_timestamp_seconds: 3.0, sha256_hash: 'v2', alpr: { success: true, plate: 'ABC123', confidence: 0.90 } },
    // Vehicle XYZ789 seen at t=5.0
    { frame_index: 50, relative_timestamp_seconds: 5.0, sha256_hash: 'v3', alpr: { success: true, plate: 'XYZ789', confidence: 0.92 } },
    // Vehicle ABC123 returns at t=40.0 (gap > 15s)
    { frame_index: 400, relative_timestamp_seconds: 40.0, sha256_hash: 'v4', alpr: { success: true, plate: 'ABC123', confidence: 0.88 } },
  ];

  const { events, uniqueVehiclesCount } = await consolidateVehicles(frames, { maxGapSeconds: 15.0 });

  assert.equal(uniqueVehiclesCount, 2);
  assert.equal(events.length, 3);

  assert.equal(events[0].plate, 'ABC123');
  assert.equal(events[0].frame_count, 3);
  assert.equal(events[0].first_seen_seconds, 1.0);
  assert.equal(events[0].last_seen_seconds, 3.0);
  assert.equal(events[0].duration_seconds, 2.0);
  assert.equal(events[0].confidence, 0.95);
  assert.equal(events[0].is_return, false);

  assert.equal(events[1].plate, 'XYZ789');
  assert.equal(events[1].frame_count, 1);

  assert.equal(events[2].plate, 'ABC123');
  assert.equal(events[2].is_return, true);
  assert.equal(events[2].first_seen_seconds, 40.0);
});

test('consolidateMotionSummary wraps events and counts into summary', async () => {
  const summary = {
    total_duration: 60.0,
    total_frames_parsed: 1800,
    motion_segments: [
      {
        start_time_seconds: 0,
        end_time_seconds: 10,
        frames: [
          { frame_index: 0, relative_timestamp_seconds: 0.0, sha256_hash: 'f0', alpr: { success: true, plate: 'TES789', confidence: 0.9 } },
          { frame_index: 30, relative_timestamp_seconds: 1.0, sha256_hash: 'f1', alpr: { success: true, plate: 'TES789', confidence: 0.95 } },
        ]
      }
    ]
  };

  const consolidated = await consolidateMotionSummary(summary);
  assert.ok(consolidated.consolidated_events);
  assert.equal(consolidated.consolidated_events.summary_counts.vehicle_events, 1);
  assert.equal(consolidated.consolidated_events.vehicle_events[0].plate, 'TES789');
  assert.equal(consolidated.consolidated_events.keyframes.length, 2);
});
