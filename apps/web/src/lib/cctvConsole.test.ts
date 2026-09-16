import { describe, expect, it } from 'vitest';
import {
  candidateAction,
  clipAtTime,
  clusterMarks,
  entityTitle,
  followClock,
  gridColumns,
  initialView,
  keyboardAction,
  nextClipAfter,
  nextRate,
  observationsToPins,
  panView,
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
});
const mark = (start: number, end: number, severity: ConsoleMark['severity'], id = `m${start}`): ConsoleMark => ({
  id, startMs: T0 + start * 1000, endMs: T0 + end * 1000, severity, source: 'device_snapshot', kind: 'motion', thumbnailPath: null, label: id,
});
const observation = (overrides: Partial<ConsoleObservation>): ConsoleObservation => ({
  id: 'o1', evidenceId: 'c0', importId: 'imp', sourceEventId: 'vehicle-1', kind: 'vehicle', observedAtMs: T0 + 30_000, observedToMs: T0 + 35_000,
  label: null, plate: null, species: null, speciesConfidence: null, isPest: null, confidence: 0.9, qualityState: 'clear', attributes: {}, thumbnail: null,
  reviewState: 'unreviewed', portfolioKey: null, portfolioState: 'unmatched', candidates: [], personRecordId: null, canonicalVehicleId: null, reviewedAt: null, reviewNotes: null,
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
