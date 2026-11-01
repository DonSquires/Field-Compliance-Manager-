import { describe, expect, it } from 'vitest';
import type { ConsoleObservation } from './cctvConsole';
import {
  accuracyByKind,
  adjacentId,
  basisLabel,
  calibrationLabel,
  detectionBox,
  engineLabel,
  inferenceCoverage,
  nextPendingId,
  observationProvenance,
  parseAccuracySummary,
  percent,
  triageKeyAction,
  wilsonLowerBound,
} from './cctvQuality';

const observation = (overrides: Partial<ConsoleObservation>): ConsoleObservation => ({
  id: 'o1', evidenceId: 'c0', importId: 'imp', sourceEventId: 'e2-vehicle-1', kind: 'vehicle', observedAtMs: 0, observedToMs: null,
  label: null, plate: null, species: null, speciesConfidence: null, isPest: null, confidence: 0.9, qualityState: 'clear', attributes: {}, thumbnail: null,
  reviewState: 'unreviewed', portfolioKey: null, portfolioState: 'unmatched', candidates: [], personRecordId: null, canonicalPersonId: null, profileName: null, profileDetails: {}, canonicalVehicleId: null, reviewedAt: null, reviewNotes: null,
  ...overrides,
});

describe('observation provenance', () => {
  it('reads the engine v2 attributes the watcher records', () => {
    const provenance = observationProvenance(observation({
      attributes: {
        engine_version: 'cctv-engine-v2', detector_model: 'rf-detr-large-704-coco', track_hits: 6, track_confirmed: true,
        review_candidate_basis: 'temporal_consensus', motion_state: 'stationary', resident_object_id: 'r1', resident_sighting_count: '14',
        resident_first_seen_at: '2026-10-30T01:00:00Z', carried_review_state: 'accepted',
      },
    }));
    expect(provenance).toMatchObject({
      engineVersion: 'cctv-engine-v2', detectorModel: 'rf-detr-large-704-coco', trackHits: 6, trackConfirmed: true,
      basis: 'temporal_consensus', basisLabel: 'seen in several frames', motionState: 'stationary', residentObjectId: 'r1', residentSightings: 14,
      carriedDecision: 'accepted',
    });
  });

  it('reports a legacy sighting as unrecorded rather than guessing', () => {
    const provenance = observationProvenance(observation({ attributes: { frame_count: 2 } }));
    expect(provenance.engineVersion).toBeNull();
    expect(provenance.trackHits).toBe(2);
    expect(provenance.trackConfirmed).toBeNull();
    expect(provenance.basisLabel).toBe('basis not recorded');
    expect(basisLabel('future_basis')).toBe('future basis');
  });
});

describe('detection box', () => {
  it('maps a source-pixel box onto a 4:3 still that letterboxes a 16:9 frame', () => {
    const box = detectionBox(observation({ attributes: { frame_width: 1920, frame_height: 1080, bbox: { x: 960, y: 540, width: 192, height: 108 } } }));
    // 16:9 in 4:3 fills the width; the picture is 75% tall with 12.5% bars top and bottom.
    expect(box).toEqual({ left: 50, top: 50, width: 10, height: 7.5 });
  });

  it('pillarboxes a portrait frame and clamps a box that runs off the frame', () => {
    const box = detectionBox(observation({ attributes: { frame_width: 1080, frame_height: 1920, bbox: { x: 1000, y: -100, width: 200, height: 300 } } }));
    expect(box).not.toBeNull();
    expect(box!.top).toBe(0);
    expect(box!.left + box!.width).toBeCloseTo(71.09, 1);
  });

  it('draws nothing when the frame size or box is missing', () => {
    expect(detectionBox(observation({ attributes: { bbox: { x: 1, y: 1, width: 10, height: 10 } } }))).toBeNull();
    expect(detectionBox(observation({ attributes: { frame_width: 640, frame_height: 480 } }))).toBeNull();
    expect(detectionBox(observation({ attributes: { frame_width: 640, frame_height: 480, bbox: { x: 700, y: 10, width: 10, height: 10 } } }))).toBeNull();
  });
});

describe('triage keyboard', () => {
  it('maps J/K/A/R and ignores typing and modified keys', () => {
    expect(triageKeyAction({ key: 'j' })).toBe('next');
    expect(triageKeyAction({ key: 'K' })).toBe('previous');
    expect(triageKeyAction({ key: 'a' })).toBe('accept');
    expect(triageKeyAction({ key: 'r' })).toBe('reject');
    expect(triageKeyAction({ key: '?' })).toBeNull();
    expect(triageKeyAction({ key: 'a', targetTag: 'textarea' })).toBeNull();
    expect(triageKeyAction({ key: 'a', isEditable: true })).toBeNull();
    expect(triageKeyAction({ key: 'r', ctrlKey: true })).toBeNull();
    expect(triageKeyAction({ key: 'x' })).toBeNull();
  });

  it('never decides from a held key, but keeps repeating navigation', () => {
    expect(triageKeyAction({ key: 'a', repeat: true })).toBeNull();
    expect(triageKeyAction({ key: 'R', repeat: true })).toBeNull();
    expect(triageKeyAction({ key: 'j', repeat: true })).toBe('next');
    expect(triageKeyAction({ key: 'ArrowUp', repeat: true })).toBe('previous');
  });

  it('turns every single-character shortcut off on request, leaving the arrow keys (WCAG 2.1.4)', () => {
    for (const key of ['a', 'A', 'r', 'R', 'j', 'J', 'k', 'K']) expect(triageKeyAction({ key, characterShortcuts: false })).toBeNull();
    expect(triageKeyAction({ key: 'ArrowDown', characterShortcuts: false })).toBe('next');
    expect(triageKeyAction({ key: 'ArrowUp', characterShortcuts: false })).toBe('previous');
  });

  it('moves to the next undecided sighting, wrapping once', () => {
    const list = [
      observation({ id: 'a' }),
      observation({ id: 'b', reviewState: 'accepted' }),
      observation({ id: 'c' }),
    ];
    expect(nextPendingId(list, 'a')).toBe('c');
    expect(nextPendingId(list, 'c')).toBe('a');
    expect(nextPendingId([observation({ id: 'a' })], 'a')).toBeNull();
    expect(adjacentId(list, 'a', -1)).toBe('a');
    expect(adjacentId(list, 'b', 1)).toBe('c');
    expect(adjacentId(list, null, 1)).toBe('a');
  });
});

describe('accuracy summary', () => {
  const raw = {
    since: '2026-08-01T00:00:00Z',
    calibration_minimum_decisions: 30,
    groups: [
      { entity_kind: 'vehicle', engine_version: 'cctv-engine-v2', detector_model: 'rf-detr-large-704-coco', review_basis: 'temporal_consensus', confidence_band: '0.85-1.00', total: 40, accepted: 27, rejected: 3, inconclusive: 2, pending: 8 },
      { entity_kind: 'vehicle', engine_version: 'cctv-engine-v2', detector_model: 'rf-detr-large-704-coco', review_basis: 'single_frame_high_confidence', confidence_band: '0.85-1.00', total: 5, accepted: 1, rejected: 1, inconclusive: 0, pending: 3, precision: 0.5, precision_lower_bound: 0.0945 },
      { entity_kind: 'person', engine_version: 'legacy', total: 9, accepted: 2, rejected: 7 },
      { entity_kind: 'robot', total: 1 },
    ],
    missed_detections: [{ entity_kind: 'vehicle', engine_version: 'cctv-engine-v2', open: 1, confirmed_missed: 2, not_missed: 0 }],
  };

  it('parses groups, counts decisions and drops unknown kinds', () => {
    const summary = parseAccuracySummary(raw);
    expect(summary.groups).toHaveLength(3);
    expect(summary.groups[0]).toMatchObject({ decided: 30, calibrated: true });
    expect(summary.groups[1]).toMatchObject({ decided: 2, calibrated: false, precisionLowerBound: 0.0945 });
    expect(summary.groups[2]).toMatchObject({ detectorModel: 'unreported', reviewBasis: 'unrecorded' });
    expect(parseAccuracySummary(null)).toEqual({ since: null, calibrationMinimum: 30, groups: [], missed: [] });
  });

  it('matches the database Wilson bound and combines groups per kind', () => {
    expect(wilsonLowerBound(1, 2)).toBeCloseTo(0.0945, 4);
    expect(wilsonLowerBound(0, 0)).toBeNull();
    const [person, vehicle, animal] = accuracyByKind(parseAccuracySummary(raw), 'cctv-engine-v2');
    expect(person.decided).toBe(0);
    expect(vehicle).toMatchObject({ total: 45, decided: 32, accepted: 28, pending: 11, calibrated: true, confirmedMissed: 2, openMissed: 1 });
    expect(vehicle.precision).toBeCloseTo(0.875, 3);
    expect(vehicle.precisionLowerBound!).toBeLessThan(vehicle.precision!);
    expect(animal.precisionLowerBound).toBeNull();
  });

  it('labels calibration, engines and percentages plainly', () => {
    expect(calibrationLabel(0, 30)).toBe('No decisions yet');
    expect(calibrationLabel(29, 30)).toBe('1 more decision to calibrate');
    expect(calibrationLabel(30, 30)).toBe('Calibrated');
    expect(engineLabel('cctv-engine-v2')).toBe('Engine v2');
    expect(engineLabel('legacy')).toBe('Engine v1 (legacy)');
    expect(percent(0.8749)).toBe('87%');
    expect(percent(null)).toBe('—');
  });
});

describe('inference coverage', () => {
  it('reports what the detector examined, by machine, from the worker plan', () => {
    const coverage = inferenceCoverage({
      total_frames_parsed: 1480,
      classification_truncated: true,
      classification_plan: { motion_frames: 960, coverage: { frames_selected: 120, frames_triaged: 120, frames_untriaged: 0, triage_providers: { vps: 42, local_gpu: 78 } } },
    });
    expect(coverage).toMatchObject({ framesParsed: 1480, motionFrames: 960, framesSampled: 120, framesExamined: 120, framesUnanswered: 0, capped: true, mixedDetectors: true, engineVersion: null });
    expect(coverage!.providers).toEqual([
      { provider: 'local_gpu', label: 'Laptop GPU', frames: 78 },
      { provider: 'vps', label: 'VPS CPU', frames: 42 },
    ]);
  });

  it('reads the engine v2 manifest and never infers coverage for a result without a plan', () => {
    const coverage = inferenceCoverage({
      total_frames_parsed: 300,
      classification_plan: {
        coverage: { frames_selected: 60, frames_triaged: 58, frames_untriaged: 2, triage_providers: { local_gpu: 40, gpu: 18 } },
        model_manifest: { engine_version: 'cctv-engine-v2', pinned_detector_model: 'rf-detr-large-704-coco', detector_models: { 'rf-detr-large-704-coco': 58 } },
      },
    });
    expect(coverage).toMatchObject({ framesUnanswered: 2, capped: false, mixedDetectors: false, engineVersion: 'cctv-engine-v2', pinnedModel: 'rf-detr-large-704-coco' });
    expect(coverage!.detectorModels).toEqual([{ model: 'rf-detr-large-704-coco', frames: 58 }]);
    expect(coverage!.motionFrames).toBeNull();
    expect(coverage!.providers.find((entry) => entry.provider === 'gpu')?.label).toBe('RunPod GPU (legacy)');
    expect(inferenceCoverage({ total_frames_parsed: 10 })).toBeNull();
    expect(inferenceCoverage(null)).toBeNull();
  });

  it('does not claim full coverage for a legacy plan that never counted the examined frames', () => {
    // Skipped detector batches left plans like this one: sampled frames, no examination count.
    expect(inferenceCoverage({ total_frames_parsed: 900, classification_plan: { sampled_frames: 120 } })).toBeNull();
    expect(inferenceCoverage({ classification_plan: { sampled_frames: 120, coverage: { frames_selected: 120 } } })).toBeNull();
    expect(inferenceCoverage({ classification_plan: { coverage: { frames_selected: 120, frames_triaged: 0, triage_providers: {} } } }))
      .toMatchObject({ framesSampled: 120, framesExamined: 0, framesUnanswered: 120 });
  });
});
