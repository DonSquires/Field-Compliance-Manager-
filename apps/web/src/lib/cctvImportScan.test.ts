import { describe, expect, it } from 'vitest';
import {
  assessHiddenPartitionCard,
  buildDeviceEvents,
  buildManifest,
  classifyFolder,
  detectDeviceKind,
  formatBytes,
  isEmptyVideoHeader,
  isValidTimeZone,
  parseTapoSnapshotName,
  parseTapoVideoName,
  storagePathFor,
  summarize,
  zonedWallClockToIso,
} from './cctvImportScan';

const ftyp = () => new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
const zeros = () => new Uint8Array(16);
const fileOf = (name: string, bytes: Uint8Array | number, type = 'video/mp4') => {
  const content = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes;
  // jsdom stringifies typed-array blob parts; hand it the underlying buffer as a browser would store it.
  return new File([content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer], name, { type });
};

describe('TAPO naming', () => {
  it('reads the camera local wall clock in the source zone', () => {
    const parsed = parseTapoVideoName('20260911_143156_tp00000.mp4', 'Pacific/Auckland');
    expect(parsed).toEqual({ startAt: '2026-09-11T02:31:56.000Z', slot: 0 });
    // Chatham is +12:45 on that date, so the same wall clock is an earlier instant.
    expect(parseTapoVideoName('20260911_143156_tp00000.mp4', 'Pacific/Chatham')?.startAt).toBe('2026-09-11T01:46:56.000Z');
    expect(parseTapoVideoName('xxxxxxxx_000000_tp00002.mp4', 'Pacific/Auckland')).toBeNull();
    expect(parseTapoVideoName('20261341_000000_tp00002.mp4', 'Pacific/Auckland')).toBeNull();
  });

  it('handles the NZ daylight-saving boundary without drifting an hour', () => {
    // 2026-09-27 02:00 NZST -> 03:00 NZDT (clocks skip 02:00-03:00). 01:30 is still +12, 03:30 is +13.
    expect(zonedWallClockToIso(2026, 9, 27, 1, 30, 0, 'Pacific/Auckland')).toBe('2026-09-26T13:30:00.000Z');
    expect(zonedWallClockToIso(2026, 9, 27, 3, 30, 0, 'Pacific/Auckland')).toBe('2026-09-26T14:30:00.000Z');
  });

  it('reads snapshot event windows as UTC epochs', () => {
    expect(parseTapoSnapshotName('1789271600_1789271617_02.jpg')).toEqual({ startAt: '2026-09-13T03:53:20.000Z', endAt: '2026-09-13T03:53:37.000Z', code: '02' });
    expect(parseTapoSnapshotName('1789271617_1789271600_02.jpg')).toBeNull();
    expect(parseTapoSnapshotName('thumb.jpg')).toBeNull();
  });
});

describe('empty ring slots', () => {
  it('recognises container signatures and rejects blank headers', () => {
    expect(isEmptyVideoHeader(ftyp())).toBe(false);
    expect(isEmptyVideoHeader(zeros())).toBe(true);
    expect(isEmptyVideoHeader(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]))).toBe(false);
    expect(isEmptyVideoHeader(new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0, 0]))).toBe(false);
    expect(isEmptyVideoHeader(new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7]))).toBe(true);
  });
});

describe('device detection', () => {
  it('names the device family from the folder shape', () => {
    expect(detectDeviceKind(['20260911_143156_tp00000.mp4', 'index_info.bin'])).toBe('tapo');
    expect(detectDeviceKind(['snapshot/20260913/15/1789271600_1789271617_02.jpg'])).toBe('tapo');
    expect(detectDeviceKind(['DVR_ROOT/2026/09/11/dav/00.dav'])).toBe('dahua');
    expect(detectDeviceKind(['datadir0/hiv00001.mp4'])).toBe('hikvision');
    expect(detectDeviceKind(['clip.mp4'])).toBe('single_file');
    expect(detectDeviceKind(['a.mp4', 'b.mov'])).toBe('generic_folder');
    expect(detectDeviceKind(['readme.txt'])).toBe('unknown');
    expect(detectDeviceKind([])).toBe('unknown');
  });

  it('tells a hidden-partition camera card apart from a folder that simply has no video', () => {
    const systemFiles = (names: string[]) => names.map((name) => ({ kind: 'other' as const, name, relativePath: name, sizeBytes: 4096 }));
    // A drive root holding a dozen small device files is what a Dahua card looks like from Windows.
    const root = assessHiddenPartitionCard(systemFiles(['sys00.bin', 'log01.dat', 'cfg.ini']), '\\');
    expect(root.likely).toBe(true);
    expect(root.reason).toContain('hidden partition');
    expect(assessHiddenPartitionCard(systemFiles(['dhfs.idx']), 'card').reason).toContain('Dahua');
    // Ordinary folders with no video are not accused of hiding anything.
    expect(assessHiddenPartitionCard(systemFiles(['notes.txt']), 'Holiday photos').likely).toBe(false);
    // Anything usable means the browser can see the recordings; no hand-off needed.
    expect(assessHiddenPartitionCard([{ kind: 'video', name: 'a.mp4', relativePath: 'a.mp4', sizeBytes: 10 }], '\\').likely).toBe(false);
    expect(assessHiddenPartitionCard([], '\\').likely).toBe(false);
  });
});

describe('classifyFolder', () => {
  const inputs = [
    { file: fileOf('20260911_143156_tp00000.mp4', ftyp()), relativePath: '20260911_143156_tp00000.mp4' },
    { file: fileOf('20260911_150000_tp00001.mp4', ftyp()), relativePath: '20260911_150000_tp00001.mp4' },
    { file: fileOf('20260915_141819_tp00004.mp4', ftyp()), relativePath: '20260915_141819_tp00004.mp4' },
    { file: fileOf('xxxxxxxx_000000_tp00002.mp4', zeros()), relativePath: 'xxxxxxxx_000000_tp00002.mp4' },
    { file: fileOf('20260912_000000_tp00003.mp4', zeros()), relativePath: '20260912_000000_tp00003.mp4' },
    { file: fileOf('1789271600_1789271617_02.jpg', 400, 'image/jpeg'), relativePath: 'snapshot/20260913/15/1789271600_1789271617_02.jpg' },
    { file: fileOf('15.index', 32, 'application/octet-stream'), relativePath: 'snapshot/20260913/15.index' },
    { file: fileOf('index_info.bin', 32, 'application/octet-stream'), relativePath: 'index_info.bin' },
    { file: fileOf('diagnose_log', 32, ''), relativePath: 'diagnose_log' },
    { file: fileOf('notes.pdf', 32, 'application/pdf'), relativePath: 'notes.pdf' },
  ];

  it('separates videos, unused slots, snapshots and device files', async () => {
    const scanned = await classifyFolder(inputs, 'Pacific/Auckland');
    const kinds = Object.fromEntries(scanned.map((item) => [item.relativePath, item.kind]));
    expect(kinds).toEqual({
      '20260911_143156_tp00000.mp4': 'video',
      '20260911_150000_tp00001.mp4': 'video',
      '20260915_141819_tp00004.mp4': 'video',
      'xxxxxxxx_000000_tp00002.mp4': 'skipped_empty',
      '20260912_000000_tp00003.mp4': 'skipped_empty',
      'snapshot/20260913/15/1789271600_1789271617_02.jpg': 'snapshot',
      'snapshot/20260913/15.index': 'index',
      'index_info.bin': 'index',
      diagnose_log: 'index',
      'notes.pdf': 'other',
    });
    const first = scanned.find((item) => item.relativePath === '20260911_143156_tp00000.mp4')!;
    const second = scanned.find((item) => item.relativePath === '20260911_150000_tp00001.mp4')!;
    const later = scanned.find((item) => item.relativePath === '20260915_141819_tp00004.mp4')!;
    expect(first.slotEndAt).toBe(second.slotStartAt);
    expect(second.slotEndAt).toBeUndefined();
    expect(later.slotEndAt).toBeUndefined();
    expect(scanned.find((item) => item.relativePath === '20260912_000000_tp00003.mp4')?.skipReason).toMatch(/no video container signature/);
  });

  it('summarises, builds the manifest and the device timeline without File objects', async () => {
    const scanned = await classifyFolder(inputs, 'Pacific/Auckland');
    const summary = summarize(scanned);
    expect(summary).toMatchObject({ videoCount: 3, skippedCount: 2, snapshotCount: 1, otherCount: 4, snapshotBytes: 400 });
    expect(summary.recordedFrom).toBe('2026-09-11T02:31:56.000Z');
    expect(summary.recordedTo).toBe('2026-09-15T02:18:19.000Z');
    const manifest = buildManifest(scanned);
    expect(manifest.every((row) => !('file' in row))).toBe(true);
    expect(manifest.find((row) => row.name === 'xxxxxxxx_000000_tp00002.mp4')).toMatchObject({ kind: 'skipped_empty', skip_reason: 'pre-allocated ring slot never recorded' });
    expect(manifest.find((row) => row.name === '20260911_143156_tp00000.mp4')).toMatchObject({ slot_start_at: '2026-09-11T02:31:56.000Z', slot_end_at: '2026-09-11T03:00:00.000Z' });
    const events = buildDeviceEvents(scanned, (item) => `org/o/cctv/i/${item.relativePath}`);
    expect(events).toEqual([{
      source: 'device_snapshot', source_ref: 'snapshot/20260913/15/1789271600_1789271617_02.jpg',
      event_start_at: '2026-09-13T03:53:20.000Z', event_end_at: '2026-09-13T03:53:37.000Z', severity: 'motion',
      thumbnail_path: 'org/o/cctv/i/snapshot/20260913/15/1789271600_1789271617_02.jpg', metadata: { code: '02', size_bytes: 400 },
    }]);
  });
});

describe('helpers', () => {
  it('validates time zones and formats sizes', () => {
    expect(isValidTimeZone('Pacific/Auckland')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(formatBytes(268435456)).toBe('256 MB');
    expect(formatBytes(4500)).toBe('4.4 KB');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('keeps uploads inside the import folder with safe segments', () => {
    expect(storagePathFor('org-1', 'imp-1', 'snapshot/2026 09/13/a b.jpg')).toBe('org/org-1/cctv/imp-1/snapshot/2026_09/13/a_b.jpg');
    expect(storagePathFor('org-1', 'imp-1', '../../etc/passwd')).toBe('org/org-1/cctv/imp-1/_/_/etc/passwd');
  });
});
