const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cosineSimilarity,
  consolidateFaces,
  consolidatePeople,
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
  assert.equal(events.length, 2, 'Should have one representative event per unique person');

  // Check Person 1 initial event
  assert.equal(events[0].subject_id, 1);
  assert.equal(events[0].subject_label, 'Person #1');
  assert.equal(events[0].is_return, true);
  assert.equal(events[0].visit_count, 2);
  assert.equal(events[0].frame_count, 5);
  assert.equal(events[0].first_seen_seconds, 0.0);
  assert.equal(events[0].last_seen_seconds, 36.0);
  assert.equal(events[0].duration_seconds, 36.0);

  // Check Person 2 event
  assert.equal(events[1].subject_id, 2);
  assert.equal(events[1].subject_label, 'Person #2');
  assert.equal(events[1].frame_count, 1);

});

test('consolidateVehicles clusters ALPR plate detections and handles returns', async () => {
  const frames = [
    // Vehicle ABC123 seen across t=1.0 -> 3.0
    { frame_index: 10, relative_timestamp_seconds: 1.0, sha256_hash: 'v0', alpr: { success: true, plate: 'ABC123', confidence: 0.85, box: { x: 10, y: 20, width: 20, height: 10 } } },
    { frame_index: 20, relative_timestamp_seconds: 2.0, sha256_hash: 'v1', alpr: { success: true, plate: 'ABC123', confidence: 0.95, box: { x: 20, y: 20, width: 20, height: 10 } } },
    { frame_index: 30, relative_timestamp_seconds: 3.0, sha256_hash: 'v2', alpr: { success: true, plate: 'ABC123', confidence: 0.90, box: { x: 30, y: 20, width: 20, height: 10 } } },
    // Vehicle XYZ789 seen at t=5.0
    { frame_index: 50, relative_timestamp_seconds: 5.0, sha256_hash: 'v3', alpr: { success: true, plate: 'XYZ789', confidence: 0.92 } },
    // Vehicle ABC123 returns at t=40.0 (gap > 15s)
    { frame_index: 400, relative_timestamp_seconds: 40.0, sha256_hash: 'v4', alpr: { success: true, plate: 'ABC123', confidence: 0.88 } },
  ];

  const { events, uniqueVehiclesCount } = await consolidateVehicles(frames, { maxGapSeconds: 15.0, metersPerPixel: 0.5 });

  assert.equal(uniqueVehiclesCount, 2);
  assert.equal(events.length, 2);

  assert.equal(events[0].plate, 'ABC123');
  assert.equal(events[0].frame_count, 4);
  assert.equal(events[0].visit_count, 2);
  assert.equal(events[0].first_seen_seconds, 1.0);
  assert.equal(events[0].last_seen_seconds, 40.0);
  assert.equal(events[0].duration_seconds, 39.0);
  assert.equal(events[0].confidence, 0.95);
  assert.equal(events[0].is_return, true);
  assert.equal(events[0].speed_px_per_second, 10);
  assert.equal(events[0].speed_kmh, 18);

  assert.equal(events[1].plate, 'XYZ789');
  assert.equal(events[1].frame_count, 1);

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
          { frame_index: 0, relative_timestamp_seconds: 0.0, sha256_hash: 'f0', alpr: { success: true, plate: 'TES789', confidence: 0.9 }, inference: { success: true, data: { vehicle_make: 'Toyota', vehicle_model: 'Corolla', vehicle_year: 2020, vehicle_colour: 'white', vehicle_attribute_confidence: 0.88, inference_provider: 'local' } } },
          { frame_index: 30, relative_timestamp_seconds: 1.0, sha256_hash: 'f1', alpr: { success: true, plate: 'TES789', confidence: 0.95 }, inference: { success: true, data: { vehicle_make: 'Toyota', vehicle_model: 'Corolla', vehicle_year: 2020, vehicle_colour: 'white', vehicle_attribute_confidence: 0.91, inference_provider: 'local' } } },
        ]
      }
    ]
  };

  const consolidated = await consolidateMotionSummary(summary);
  assert.ok(consolidated.consolidated_events);
  assert.equal(consolidated.consolidated_events.summary_counts.vehicle_events, 1);
  assert.equal(consolidated.consolidated_events.vehicle_events[0].plate, 'TES789');
  assert.equal(consolidated.consolidated_events.vehicle_events[0].vehicle_make, 'Toyota');
  assert.equal(consolidated.consolidated_events.vehicle_events[0].vehicle_model, 'Corolla');
  assert.equal(consolidated.consolidated_events.vehicle_events[0].vehicle_year, 2020);
  assert.equal(consolidated.consolidated_events.vehicle_events[0].vehicle_colour, 'white');
  assert.equal(consolidated.consolidated_events.keyframes.length, 2);
});

test('consolidatePeople retains side-on full-body detections without a face', async () => {
  const result = await consolidatePeople([
    { relative_timestamp_seconds: 59, sha256_hash: 'p0', people: { success: true, people: [{ confidence: 0.392, bbox: { x: 664, y: 469, width: 674, height: 598 } }] } },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].event_type, 'person');
  assert.equal(result[0].best_bbox.width, 674);
});

test('consolidatePeople excludes degraded glare/occlusion frames but records the quality gate', async () => {
  const result = await consolidatePeople([
    { relative_timestamp_seconds: 1, sha256_hash: 'degraded', visual_quality: 'degraded', visual_quality_reason: 'dominant_colour_cast_possible_glare_or_camera_artifact', people: { success: true, people: [{ confidence: 0.99, bbox: { x: 1, y: 1, width: 100, height: 200 } }] } },
    { relative_timestamp_seconds: 2, sha256_hash: 'usable', visual_quality: 'usable', people: { success: true, people: [{ confidence: 0.88, bbox: { x: 2, y: 2, width: 100, height: 200 } }] } },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].frame_count, 1);
  assert.equal(result[0].visual_quality_gate, 'degraded_frames_excluded_from_person_inference');
  assert.equal(result[0].excluded_degraded_frame_count, 1);
});
