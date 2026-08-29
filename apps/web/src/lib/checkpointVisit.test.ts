import { describe, expect, it } from 'vitest';
import { countCompletedCheckpoints, evaluateCheckpointVisit, mapCheckpointVisitScanMethod } from './checkpointVisit';

describe('evaluateCheckpointVisit', () => {
  it('accepts a close GPS fix within the checkpoint radius', () => {
    const result = evaluateCheckpointVisit({
      checkpointLat: -36.8485,
      checkpointLng: 174.7633,
      officerLat: -36.8484,
      officerLng: 174.7634,
      checkpointRadiusMetres: 25,
      gpsPrecisionMetres: 2,
    });

    expect(result.mode).toBe('gps');
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe('gps_within_radius');
    expect(result.withinRadius).toBe(true);
  });

  it('rejects a GPS fix outside the checkpoint radius', () => {
    const result = evaluateCheckpointVisit({
      checkpointLat: -36.8485,
      checkpointLng: 174.7633,
      officerLat: -36.8470,
      officerLng: 174.7645,
      checkpointRadiusMetres: 25,
      gpsPrecisionMetres: 2,
    });

    expect(result.mode).toBe('gps');
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('gps_outside_radius');
    expect(result.withinRadius).toBe(false);
  });

  it('allows manual fallback only when GPS is missing and fallback is explicitly enabled', () => {
    const allowed = evaluateCheckpointVisit({
      checkpointLat: -36.8485,
      checkpointLng: 174.7633,
      officerLat: null,
      officerLng: null,
      checkpointRadiusMetres: 25,
      allowManualFallback: true,
    });

    const blocked = evaluateCheckpointVisit({
      checkpointLat: -36.8485,
      checkpointLng: 174.7633,
      officerLat: null,
      officerLng: null,
      checkpointRadiusMetres: 25,
      allowManualFallback: false,
    });

    expect(allowed.mode).toBe('manual');
    expect(allowed.accepted).toBe(true);
    expect(allowed.reason).toBe('gps_missing_manual_allowed');

    expect(blocked.mode).toBe('manual');
    expect(blocked.accepted).toBe(false);
    expect(blocked.reason).toBe('gps_missing_manual_blocked');
  });

  it('declines GPS when the precision is worse than the checkpoint radius', () => {
    const result = evaluateCheckpointVisit({
      checkpointLat: -36.8485,
      checkpointLng: 174.7633,
      officerLat: -36.8484,
      officerLng: 174.7634,
      checkpointRadiusMetres: 25,
      gpsPrecisionMetres: 100,
    });

    expect(result.mode).toBe('gps');
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('gps_inaccurate');
    expect(result.withinRadius).toBe(false);
  });

  it('maps checkpoint evaluation to schema-safe visit methods', () => {
    expect(mapCheckpointVisitScanMethod({ mode: 'gps', accepted: true })).toBe('qr_camera');
    expect(mapCheckpointVisitScanMethod({ mode: 'manual', accepted: true })).toBe('manual_code');
    expect(mapCheckpointVisitScanMethod({ mode: 'gps', accepted: false })).toBe('url_deep_link');
  });

  it('counts completed checkpoints by unique checkpoint instead of raw visit rows', () => {
    expect(
      countCompletedCheckpoints([
        { checkpoint_id: 'a' },
        { checkpoint_id: 'a' },
        { checkpoint_id: 'b' },
      ])
    ).toBe(2);
  });
});
