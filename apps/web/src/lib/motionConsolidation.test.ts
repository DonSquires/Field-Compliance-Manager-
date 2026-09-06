import { describe, expect, it } from 'vitest';
import { consolidateResultData, cosineSimilarity } from './motionConsolidation';

describe('motionConsolidation in frontend', () => {
  it('computes cosine similarity accurately', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('consolidates raw motion segments into deduplicated person and vehicle events', () => {
    const rawData = {
      total_frames_parsed: 300,
      total_duration: 10.0,
      motion_segments: [
        {
          frames: [
            {
              frame_index: 0,
              relative_timestamp_seconds: 0.0,
              face: { success: true, faces: [{ embedding: [1, 0, 0], bbox: { width: 50, height: 50 } }] },
              alpr: { success: true, plate: 'NZP123', confidence: 0.9 },
            },
            {
              frame_index: 10,
              relative_timestamp_seconds: 0.5,
              face: { success: true, faces: [{ embedding: [1, 0, 0], bbox: { width: 55, height: 55 } }] },
              alpr: { success: true, plate: 'NZP123', confidence: 0.95 },
            },
            {
              frame_index: 20,
              relative_timestamp_seconds: 1.0,
              face: { success: true, faces: [{ embedding: [0, 1, 0], bbox: { width: 40, height: 40 } }] },
              alpr: { success: true, plate: 'NZP123', confidence: 0.92 },
            },
          ],
        },
      ],
    };

    const consolidated = consolidateResultData(rawData, { maxGapSeconds: 5.0 });

    expect(consolidated.summary_counts.unique_faces).toBe(2);
    expect(consolidated.summary_counts.face_events).toBe(2);
    expect(consolidated.summary_counts.unique_vehicles).toBe(1);
    expect(consolidated.summary_counts.vehicle_events).toBe(1);
    expect(consolidated.vehicle_events[0].plate).toBe('NZP123');
    expect(consolidated.vehicle_events[0].frame_count).toBe(3);
    expect(consolidated.keyframes.length).toBeGreaterThan(0);
  });
});
