import { describe, expect, it } from 'vitest';
import { describeJobFailure, summariseFailures } from './cctvJobFailure';

describe('describeJobFailure', () => {
  it('recognises a raw Dahua fragment with no readable header and says retry will not help', () => {
    const failure = describeJobFailure('motion extractor exited 1: {"error":"Unable to read video headers: /opt/fcm/storage/x/clip.dhfs"}', 'clip.dhfs');
    expect(failure.kind).toBe('unreadable_source');
    expect(failure.retryLikelyHelps).toBe(false);
    expect(failure.title).toContain('Raw camera fragment');
    expect(failure.nextStep).toContain('FCM Desktop reader');
  });

  it('treats an unreadable header on an ordinary file as a file problem, not a camera-format problem', () => {
    const failure = describeJobFailure('motion extractor exited 1: {"error":"Unable to read video headers: /x/20260901_000000_tp00001.mp4"}', '20260901_000000_tp00001.mp4');
    expect(failure.kind).toBe('unreadable_source');
    expect(failure.title).not.toContain('Raw camera fragment');
    expect(failure.nextStep).toContain('media player');
  });

  it('recognises decoder corruption at a ring-slot boundary and keeps the evidential value in view', () => {
    const failure = describeJobFailure('motion extractor exited 1: [h264 @ 0x2ea29680] log2_max_poc_lsb (15) is out of range\n[h264 @ 0x2ea29680] missing picture in access unit');
    expect(failure.kind).toBe('corrupt_stream');
    expect(failure.retryLikelyHelps).toBe(false);
    expect(failure.nextStep).toContain('lock it if needed');
    expect(describeJobFailure('motion extractor exited 1: [h264 @ 0x1] illegal POC type 32').kind).toBe('corrupt_stream');
  });

  it('marks database timeouts and unreachable services as retryable, with the checkpoint reassurance', () => {
    const timeout = describeJobFailure('job heartbeat failed: canceling statement due to statement timeout');
    expect(timeout.kind).toBe('timeout');
    expect(timeout.retryLikelyHelps).toBe(true);
    expect(timeout.nextStep).toContain('checkpointed');
    const ingestion = describeJobFailure('motion ingestion returned HTTP 502: {"ok":false,"error":"motion persistence failed: canceling statement due to statement timeout"}');
    expect(ingestion.kind).toBe('timeout');
    expect(describeJobFailure('fetch failed').kind).toBe('transient_infrastructure');
    expect(describeJobFailure('CCTV job lease was lost').kind).toBe('lease_lost');
  });

  it('does not pretend to understand an unfamiliar error, and never hides an empty one', () => {
    const unknown = describeJobFailure('something odd happened in stage 7');
    expect(unknown.kind).toBe('unknown');
    expect(unknown.retryLikelyHelps).toBe(true);
    const empty = describeJobFailure(null);
    expect(empty.title).toContain('without a recorded reason');
    expect(empty.explanation).toContain('out of memory');
  });

  it('summarises a queue into fixable and permanent failures', () => {
    const summary = summariseFailures([
      describeJobFailure('fetch failed'),
      describeJobFailure('Unable to read video headers: x.dhfs', 'x.dhfs'),
      describeJobFailure('illegal POC type 32'),
    ]);
    expect(summary).toEqual({ retryable: 1, permanent: 2 });
  });
});
