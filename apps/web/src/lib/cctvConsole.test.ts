import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bytesLabel,
  cameraItem,
  candidateAction,
  clipAtTime,
  clipItem,
  clipStatusLabel,
  clusterMarks,
  createRefreshCoalescer,
  custodyBadge,
  DEFAULT_CCTV_INSPECTION,
  describeConsoleFailure,
  durationLabel,
  entityTitle,
  fitTiles,
  followClock,
  gridColumns,
  groupClipsByDay,
  importIdsOf,
  inferenceReviewLabel,
  initialView,
  isDefaultCCTVInspection,
  isEnhancementActive,
  isWeakInferenceCandidate,
  keyboardAction,
  layoutForCount,
  nextClipAfter,
  nextInspectionZoom,
  nextRate,
  normalizeCCTVInspection,
  observationCountsByEvidence,
  observationsToPins,
  panView,
  parseClipIntegrity,
  tickIntervalMs,
  ticksFor,
  timeToX,
  timelineBounds,
  xToTime,
  zoomView,
  type ConsoleClip,
  type ConsoleMark,
  type ConsoleObservation,
} from './cctvConsole';

const T0 = Date.parse('2026-09-15T02:18:19.000Z');
const clip = (start: number, end: number, id = `c${start}`): ConsoleClip => ({
  evidenceId: id, importId: 'imp', jobId: null, jobStatus: 'complete', fileName: id, startMs: T0 + start * 1000, endMs: T0 + end * 1000,
  bucket: 'bob-uploads', playbackPath: null, sourcePath: `org/x/cctv/imp/${id}.mp4`, fileType: 'video/mp4',
  sizeBytes: null, sha256: null, courtReady: false, lockedAt: null, retentionHold: false, integrity: null,
});
const mark = (start: number, end: number, severity: ConsoleMark['severity'], id = `m${start}`): ConsoleMark => ({
  id, startMs: T0 + start * 1000, endMs: T0 + end * 1000, severity, source: 'device_snapshot', kind: 'motion', thumbnailPath: null, label: id,
});
const observation = (overrides: Partial<ConsoleObservation>): ConsoleObservation => ({
  id: 'o1', evidenceId: 'c0', importId: 'imp', sourceEventId: 'vehicle-1', kind: 'vehicle', observedAtMs: T0 + 30_000, observedToMs: T0 + 35_000,
  label: null, plate: null, species: null, speciesConfidence: null, isPest: null, confidence: 0.9, qualityState: 'clear', attributes: {}, thumbnail: null,
  reviewState: 'unreviewed', portfolioKey: null, portfolioState: 'unmatched', candidates: [], personRecordId: null, canonicalPersonId: null, profileName: null, profileDetails: {}, canonicalVehicleId: null, reviewedAt: null, reviewNotes: null,
  ...overrides,
});

describe('shared clock and clips', () => {
  const clips = [clip(0, 149), clip(149, 300), clip(400, 500)];

  it('finds the clip covering an instant and the next one across a recording gap', () => {
    expect(clipAtTime(clips, T0 + 10_000)?.evidenceId).toBe('c0');
    expect(clipAtTime(clips, T0 + 149_000)?.evidenceId).toBe('c149');
    expect(clipAtTime(clips, T0 + 350_000)).toBeNull();
    expect(nextClipAfter(clips, T0 + 350_000)?.evidenceId).toBe('c400');
    expect(nextClipAfter(clips, T0 + 500_000)).toBeNull();
  });

  it('bounds the timeline from clips, marks and observations together', () => {
    const bounds = timelineBounds(clips, [mark(-60, -50, 'motion')], [observation({ observedAtMs: T0 + 600_000, observedToMs: null })]);
    expect(bounds).toEqual({ startMs: T0 - 60_000, endMs: T0 + 600_000 });
    expect(timelineBounds([], [], [])).toBeNull();
  });

  it('steps playback rates through the NVR ladder and clamps at both ends', () => {
    expect(nextRate(1, 1)).toBe(2);
    expect(nextRate(2, 1)).toBe(4);
    expect(nextRate(16, 1)).toBe(16);
    expect(nextRate(0.5, -1)).toBe(0.5);
    expect(nextRate(3, 1)).toBe(2);
  });

  it('maps grid layouts to columns', () => {
    expect([1, 2, 4, 9].map((layout) => gridColumns(layout as 1 | 2 | 4 | 9))).toEqual([1, 2, 2, 3]);
  });

  it('picks the smallest grid that holds the wall and pads or trims tiles to it', () => {
    expect([0, 1, 2, 3, 4, 5, 9, 12].map(layoutForCount)).toEqual([1, 1, 2, 4, 4, 9, 9, 9]);
    const items = [cameraItem('a'), clipItem(clip(0, 10)), null, cameraItem('b')];
    expect(fitTiles(items, 2)).toEqual([items[0], items[1]]);
    expect(fitTiles([items[0]], 4)).toEqual([items[0], null, null, null]);
  });

  it('gives wall items stable ids and lists each camera once however many of its recordings are pinned', () => {
    expect(cameraItem('imp')).toEqual({ id: 'camera:imp', kind: 'camera', importId: 'imp' });
    expect(clipItem(clip(0, 10))).toEqual({ id: 'clip:c0', kind: 'clip', importId: 'imp', evidenceId: 'c0' });
    expect(importIdsOf([cameraItem('imp'), clipItem(clip(0, 10)), clipItem(clip(20, 30)), null, cameraItem('other')])).toEqual(['imp', 'other']);
  });
});

describe('recordings browser', () => {
  it('groups recordings by calendar day in the camera zone, in start order', () => {
    // 02:18 UTC on 15 Sep is 14:18 NZST on 15 Sep; 12 h later is 02:18 NZST on 16 Sep.
    const groups = groupClipsByDay([clip(12 * 3600, 12 * 3600 + 150, 'late'), clip(0, 150, 'early'), clip(150, 300, 'second')], 'Pacific/Auckland');
    expect(groups.map((group) => group.clips.map((item) => item.evidenceId))).toEqual([['early', 'second'], ['late']]);
    expect(groups[0].day).not.toBe(groups[1].day);
    expect(groups[0].dayMs).toBe(T0);
    expect(groupClipsByDay([], 'Pacific/Auckland')).toEqual([]);
  });

  it('counts sightings per recording, separating what is still to review and what raised an alert', () => {
    const counts = observationCountsByEvidence([
      observation({ id: 'a', evidenceId: 'c0', plate: 'ABC123' }),
      observation({ id: 'b', evidenceId: 'c0', reviewState: 'accepted', reviewedAt: '2026-09-15T03:00:00Z' }),
      observation({ id: 'c', evidenceId: 'c149', kind: 'animal', species: 'possum', isPest: true }),
      observation({ id: 'd', evidenceId: 'c149', kind: 'person' }),
    ]);
    expect(counts.c0).toEqual({ total: 2, pending: 1, alerts: 1 });
    expect(counts.c149).toEqual({ total: 2, pending: 2, alerts: 1 });
    expect(counts.c400).toBeUndefined();
  });

  it('labels durations, sizes and analysis states in plain words', () => {
    expect(durationLabel(45_000)).toBe('45 s');
    expect(durationLabel(150_000)).toBe('2 min 30 s');
    expect(durationLabel(25 * 60_000 + 5_000)).toBe('25 min');
    expect(durationLabel(90 * 60_000)).toBe('1 h 30 min');
    expect(durationLabel(-5)).toBe('0 s');
    expect(bytesLabel(null)).toBe('—');
    expect(bytesLabel(512)).toBe('1 KB');
    expect(bytesLabel(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(bytesLabel(250 * 1024 * 1024)).toBe('250 MB');
    expect(bytesLabel(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
    expect(clipStatusLabel('complete')).toBe('Analysed');
    expect(clipStatusLabel('processing')).toBe('Analysing');
    expect(clipStatusLabel('none')).toBe('Not analysed');
  });

  it('keeps inspection adjustments bounded and zoom steps stable', () => {
    expect(normalizeCCTVInspection({ zoom: 8, brightness: 20, contrast: 300, saturation: -1, detail: 999, focusX: 140, focusY: -20, enhance: 'weird' as never })).toEqual({ zoom: 4, brightness: 60, contrast: 180, saturation: 0, detail: 200, focusX: 100, focusY: 0, enhance: 'auto' });
    expect(nextInspectionZoom(1, 1)).toBe(1.25);
    expect(nextInspectionZoom(4, 1)).toBe(4);
    expect(nextInspectionZoom(1, -1)).toBe(1);
    expect(nextInspectionZoom(1.7, 1)).toBe(2);
    expect(nextInspectionZoom(1.7, -1)).toBe(1.5);
    expect(isDefaultCCTVInspection({ ...DEFAULT_CCTV_INSPECTION })).toBe(true);
    expect(isEnhancementActive({ ...DEFAULT_CCTV_INSPECTION })).toBe(false);
    expect(isEnhancementActive({ ...DEFAULT_CCTV_INSPECTION, zoom: 2 })).toBe(true);
    expect(isEnhancementActive({ ...DEFAULT_CCTV_INSPECTION, zoom: 2, enhance: 'off' })).toBe(false);
    expect(isEnhancementActive({ ...DEFAULT_CCTV_INSPECTION, enhance: 'on' })).toBe(true);
  });
});

describe('timeline geometry', () => {
  const view = { startMs: T0, endMs: T0 + 100_000 };
  const bounds = { startMs: T0 - 100_000, endMs: T0 + 400_000 };

  it('converts between time and pixels and back', () => {
    expect(timeToX(T0 + 50_000, view, 1000)).toBe(500);
    expect(xToTime(250, view, 1000)).toBe(T0 + 25_000);
    expect(xToTime(-40, view, 1000)).toBe(T0);
  });

  it('zooms around an anchor, never narrower than 10 s and never past the bounds', () => {
    const zoomed = zoomView(view, T0 + 50_000, 0.5, bounds);
    expect(zoomed).toEqual({ startMs: T0 + 25_000, endMs: T0 + 75_000 });
    expect(zoomView(view, T0 + 50_000, 0.00001, bounds).endMs - zoomView(view, T0 + 50_000, 0.00001, bounds).startMs).toBe(10_000);
    const wide = zoomView(view, T0, 100, bounds);
    expect(wide).toEqual(bounds);
  });

  it('pans within bounds and follows the playhead when it leaves the view', () => {
    expect(panView(view, 50_000, bounds)).toEqual({ startMs: T0 + 50_000, endMs: T0 + 150_000 });
    expect(panView(view, -1_000_000, bounds).startMs).toBe(bounds.startMs);
    expect(followClock(view, T0 + 20_000, bounds)).toEqual(view);
    const followed = followClock(view, T0 + 150_000, bounds);
    expect(followed.startMs).toBe(T0 + 140_000);
    expect(followed.endMs - followed.startMs).toBe(100_000);
  });

  it('picks readable tick spacing and lists ticks inside the view', () => {
    expect(tickIntervalMs(view, 1000)).toBe(10_000);
    expect(tickIntervalMs({ startMs: T0, endMs: T0 + 6 * 3_600_000 }, 1000)).toBe(3_600_000);
    expect(tickIntervalMs({ startMs: T0, endMs: T0 + 6 * 3_600_000 }, 2000)).toBe(1_800_000);
    const ticks = ticksFor(view, 1000);
    expect(ticks[0]).toBeGreaterThanOrEqual(view.startMs);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(view.endMs);
    expect(ticks.length).toBeGreaterThan(5);
  });

  it('clusters dense snapshot ticks into a few DOM nodes carrying the highest severity', () => {
    const marks = Array.from({ length: 500 }, (_, index) => mark(index * 0.2, index * 0.2 + 0.1, index === 250 ? 'alert' : 'motion', `t${index}`));
    marks.push(mark(80, 82, 'quality', 'q1'));
    const clusters = clusterMarks(marks, view, 1000, 3);
    expect(clusters.length).toBeLessThan(40);
    expect(clusters.reduce((sum, cluster) => sum + cluster.count, 0)).toBe(501);
    expect(clusters.some((cluster) => cluster.severity === 'alert')).toBe(true);
    expect(clusters.find((cluster) => cluster.marks.some((item) => item.id === 'q1'))?.severity).toBe('quality');
  });

  it('opens a camera on the whole window when it is short and on a six-hour page otherwise', () => {
    expect(initialView(bounds, T0)).toEqual(bounds);
    const day = { startMs: T0, endMs: T0 + 24 * 3_600_000 };
    const opened = initialView(day, T0 + 12 * 3_600_000);
    expect(opened.endMs - opened.startMs).toBe(6 * 3_600_000);
    expect(opened.startMs).toBeLessThanOrEqual(T0 + 12 * 3_600_000);
  });

  it('opens on the footage, padded and at least ten minutes wide, when snapshots stretch the day past the clips', () => {
    const day = { startMs: T0, endMs: T0 + 3 * 3_600_000 };
    const footage = { startMs: T0 + 2 * 3_600_000, endMs: T0 + 2 * 3_600_000 + 150_000 };
    const opened = initialView(day, footage.startMs, footage);
    expect(opened.endMs - opened.startMs).toBe(10 * 60_000);
    expect(opened.startMs).toBeLessThanOrEqual(footage.startMs);
    expect(opened.endMs).toBeGreaterThanOrEqual(footage.endMs);
    const long = { startMs: T0, endMs: T0 + 2 * 3_600_000 };
    expect(initialView(day, T0, long).endMs - initialView(day, T0, long).startMs).toBe(2.5 * 3_600_000);
  });
});

describe('keyboard', () => {
  it('maps the NVR keys and ignores typing in fields', () => {
    expect(keyboardAction({ key: ' ' })).toEqual({ type: 'toggle_play' });
    expect(keyboardAction({ key: 'ArrowLeft' })).toEqual({ type: 'seek', deltaMs: -10_000 });
    expect(keyboardAction({ key: 'ArrowUp' })).toEqual({ type: 'seek', deltaMs: 1_000 });
    expect(keyboardAction({ key: ']' })).toEqual({ type: 'rate', direction: 1 });
    expect(keyboardAction({ key: '4' })).toEqual({ type: 'layout', layout: 4 });
    expect(keyboardAction({ key: 'f' })).toEqual({ type: 'fullscreen' });
    expect(keyboardAction({ key: 'm' })).toEqual({ type: 'mute' });
    expect(keyboardAction({ key: ',' })).toEqual({ type: 'frame', direction: -1 });
    expect(keyboardAction({ key: '.' })).toEqual({ type: 'frame', direction: 1 });
    expect(keyboardAction({ key: 'b' })).toEqual({ type: 'bookmark' });
    expect(keyboardAction({ key: 's' })).toEqual({ type: 'snapshot' });
    expect(keyboardAction({ key: 'b', targetTag: 'textarea' })).toBeNull();
    expect(keyboardAction({ key: ' ', targetTag: 'input' })).toBeNull();
    expect(keyboardAction({ key: 'f', isEditable: true })).toBeNull();
    expect(keyboardAction({ key: 'f', ctrlKey: true })).toBeNull();
    expect(keyboardAction({ key: 'z' })).toBeNull();
  });
});

describe('entities and portfolio actions', () => {
  it('titles observations from what was read, never inventing an identity', () => {
    expect(entityTitle(observation({ plate: 'ABC123' }))).toBe('Vehicle ABC123');
    expect(entityTitle(observation({ label: 'white truck' }))).toBe('Vehicle · white truck');
    expect(entityTitle(observation({ kind: 'animal', species: 'possum', isPest: true }))).toBe('Pest · Possum');
    expect(entityTitle(observation({ kind: 'animal', species: 'other' }))).toBe('Unidentified animal');
    expect(entityTitle(observation({ kind: 'person' }))).toBe('Person');
  });

  it('makes weak inference explicit instead of presenting it as a confirmed sighting', () => {
    const weak = observation({ kind: 'person', confidence: 0.55, attributes: { frame_count: 1 } });
    expect(isWeakInferenceCandidate(weak)).toBe(true);
    expect(inferenceReviewLabel(weak)).toBe('Weak AI candidate · 55% · one sampled frame');
    const faceBacked = observation({ kind: 'person', confidence: 0.55, attributes: { frame_count: 1, face_event_id: 'face-1' } });
    expect(isWeakInferenceCandidate(faceBacked)).toBe(false);
    expect(inferenceReviewLabel(faceBacked)).toBe('AI candidate · 55% · face-backed');
  });

  it('turns a candidate into the matching review action for its kind', () => {
    const vehicle = observation({});
    expect(candidateAction(vehicle, { match_kind: 'canonical_vehicle', match_id: 'cv', canonical_vehicle_id: 'cv', plate_number: 'ABC123' })).toEqual({ action: 'link_vehicle', targetId: 'cv', label: 'Same vehicle as ABC123' });
    expect(candidateAction(vehicle, { match_kind: 'observation', match_id: 'o9', observation_id: 'o9' })).toEqual({ action: 'merge_portfolio', targetId: 'o9', label: 'Same vehicle as this earlier sighting' });
    const person = observation({ kind: 'person' });
    expect(candidateAction(person, { match_kind: 'person_record', match_id: 'pr', person_record_id: 'pr', display_name: 'Unknown male' })).toEqual({ action: 'link_person', targetId: 'pr', label: 'Same person as Unknown male' });
    expect(candidateAction(person, { match_kind: 'canonical_vehicle', match_id: 'cv', canonical_vehicle_id: 'cv' })).toBeNull();
    const animal = observation({ kind: 'animal' });
    expect(candidateAction(animal, { match_kind: 'observation', match_id: 'o3', observation_id: 'o3' })?.action).toBe('merge_portfolio');
  });

  it('pins observations onto the timeline with alerts for plated vehicles and pests', () => {
    const pins = observationsToPins([
      observation({ plate: 'ABC123' }),
      observation({ id: 'o2', kind: 'animal', species: 'possum', isPest: true, observedToMs: null }),
      observation({ id: 'o3', kind: 'person' }),
    ]);
    expect(pins.map((pin) => pin.severity)).toEqual(['alert', 'alert', 'detection']);
    expect(pins[1].endMs - pins[1].startMs).toBe(1000);
  });
});

describe('chain of custody', () => {
  it('reads the worker integrity record and ignores anything malformed', () => {
    expect(parseClipIntegrity(null)).toBeNull();
    expect(parseClipIntegrity({ state: 'tampered' })).toBeNull();
    expect(parseClipIntegrity({ state: 'verified', checked_at: '2026-09-18T10:00:00Z', check_count: 3, mismatch_count: 0 }))
      .toEqual({ state: 'verified', checkedAt: '2026-09-18T10:00:00Z', checkCount: 3, mismatchCount: 0 });
    expect(parseClipIntegrity({ state: 'mismatch', check_count: '2', mismatch_count: '1' })).toMatchObject({ state: 'mismatch', checkCount: 2, mismatchCount: 1 });
  });

  it('badges custody honestly: a mismatch outranks a lock, a lock outranks a bare hash', () => {
    const hash = 'ab'.repeat(32);
    expect(custodyBadge({ sha256: null, lockedAt: null, integrity: null })).toMatchObject({ label: 'No hash yet', tone: 'none' });
    expect(custodyBadge({ sha256: hash, lockedAt: null, integrity: null })).toMatchObject({ label: 'Hashed', tone: 'hashed' });
    const locked = custodyBadge({ sha256: hash, lockedAt: '2026-09-18T10:00:00Z', integrity: { state: 'verified', checkedAt: null, checkCount: 2, mismatchCount: 0 } });
    expect(locked).toMatchObject({ label: 'Locked', tone: 'locked' });
    expect(locked.detail).toContain('verified 2 times');
    const mismatch = custodyBadge({ sha256: hash, lockedAt: '2026-09-18T10:00:00Z', integrity: { state: 'mismatch', checkedAt: null, checkCount: 3, mismatchCount: 1 } });
    expect(mismatch).toMatchObject({ label: 'Integrity mismatch', tone: 'mismatch' });
    expect(mismatch.detail).toContain('Treat this recording as altered');
  });
});

describe('data-service failures', () => {
  it('names the scope and the safe next step for a dropped connection instead of echoing the raw fetch error', () => {
    const failure = describeConsoleFailure('TypeError: Failed to fetch', 'recordings for this camera');
    expect(failure.kind).toBe('transport');
    expect(failure.retryable).toBe(true);
    expect(failure.text).toContain('recordings for this camera');
    expect(failure.text).toContain('Nothing was changed');
    expect(failure.text).not.toContain('TypeError');
  });

  it('tells an offline reviewer the console will retry when the connection returns', () => {
    const failure = describeConsoleFailure('TypeError: Failed to fetch', 'camera list', false);
    expect(failure.kind).toBe('offline');
    expect(failure.retryable).toBe(true);
  });

  it('does not offer a retry for a permission failure and points at the role instead', () => {
    const failure = describeConsoleFailure('permission denied for table cctv_entity_observations', 'observations for this camera');
    expect(failure.kind).toBe('permission');
    expect(failure.retryable).toBe(false);
    expect(failure.text).toContain('administrator');
    expect(describeConsoleFailure('JWT expired', 'camera list').kind).toBe('permission');
  });

  it('separates a database timeout from a network fault and does not mistake ids for HTTP codes', () => {
    expect(describeConsoleFailure('canceling statement due to statement timeout', 'camera events').kind).toBe('timeout');
    expect(describeConsoleFailure('relation "x401" does not exist', 'camera events').kind).toBe('other');
    expect(describeConsoleFailure('', 'camera events').text).toContain('unknown error');
  });
});

describe('refresh coalescing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses a burst of realtime requests for one import into a single reload', async () => {
    const run = vi.fn((_id: string) => Promise.resolve());
    const coalescer = createRefreshCoalescer(run, 1500);
    for (let i = 0; i < 25; i += 1) coalescer.request('imp-a');
    coalescer.request('imp-b');
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(([id]) => id).sort()).toEqual(['imp-a', 'imp-b']);
    coalescer.dispose();
  });

  it('runs exactly one follow-up when requests arrive while a reload is in flight', async () => {
    const releases: Array<() => void> = [];
    const run = vi.fn((_id: string) => new Promise<void>((resolve) => { releases.push(resolve); }));
    const coalescer = createRefreshCoalescer(run, 100);
    coalescer.request('imp');
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
    coalescer.request('imp');
    coalescer.request('imp');
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(2);
    coalescer.dispose();
  });

  it('drops pending work once disposed so an unmounted console issues no queries', async () => {
    const run = vi.fn((_id: string) => Promise.resolve());
    const coalescer = createRefreshCoalescer(run, 100);
    coalescer.request('imp');
    coalescer.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    coalescer.request('imp');
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
  });
});
