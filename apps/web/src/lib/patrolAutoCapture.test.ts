import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { createPatrolAutoCapture } from './patrolAutoCapture';
import { PATROL_CHECKPOINT_RECORDED } from './patrolCheckpointEvents';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('./supabase', () => ({ supabase: { rpc } }));

function fix(timestamp = Date.now(), accuracy = 5): GeolocationPosition {
  return {
    timestamp,
    coords: { latitude: -41, longitude: 174, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) },
    toJSON: () => ({}),
  };
}

const response = (status: string, ids: string[] = []) => ({
  data: { shift_id: 'shift', status: 'processed', patrol_id: 'patrol', recorded_checkpoint_ids: ids, checkpoints: [{ checkpoint_id: 'checkpoint', status }] }, error: null,
});

afterEach(() => { vi.clearAllMocks(); });

describe('automatic patrol checkpoint capture', () => {
  it('submits the fresh fix and announces only newly recorded checkpoints', async () => {
    rpc.mockResolvedValueOnce(response('recorded', ['checkpoint'])).mockResolvedValueOnce(response('already_recorded'));
    const status = vi.fn();
    const recorded = vi.fn();
    window.addEventListener(PATROL_CHECKPOINT_RECORDED, recorded);
    const capture = createPatrolAutoCapture('shift', status);
    const position = fix();
    capture.capture(position);
    await waitFor(() => expect(recorded).toHaveBeenCalledTimes(1));
    expect(rpc).toHaveBeenCalledWith('auto_record_patrol_checkpoints', {
      p_shift_id: 'shift', p_gps_lat: -41, p_gps_lng: 174, p_gps_accuracy: 5, p_captured_at: new Date(position.timestamp).toISOString(),
    });
    capture.capture(fix());
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(recorded).toHaveBeenCalledTimes(1);
    capture.stop();
    window.removeEventListener(PATROL_CHECKPOINT_RECORDED, recorded);
  });

  it('does not send stale or inaccurate fixes', () => {
    const status = vi.fn();
    const capture = createPatrolAutoCapture('shift', status);
    capture.capture(fix(Date.now() - 31_000));
    capture.capture(fix(Date.now(), 51));
    expect(rpc).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'warning' }));
    capture.stop();
  });

  it('announces recorded evidence with unresolved stop attribution', async () => {
    rpc.mockResolvedValue(response('recorded_unattributed', ['checkpoint']));
    const status = vi.fn();
    const recorded = vi.fn();
    window.addEventListener(PATROL_CHECKPOINT_RECORDED, recorded);
    const capture = createPatrolAutoCapture('shift', status);
    capture.capture(fix());
    await waitFor(() => expect(status).toHaveBeenLastCalledWith({
      kind: 'warning', message: 'Checkpoint verified and recorded without a stop link. Operations must resolve the matching planned visit.',
    }));
    expect(recorded).toHaveBeenCalledOnce();
    capture.stop();
    window.removeEventListener(PATROL_CHECKPOINT_RECORDED, recorded);
  });

  it('reports absent sessions and ineligible geofences without claiming verification', async () => {
    rpc.mockResolvedValueOnce({ data: { shift_id: 'shift', status: 'no_session', patrol_id: null, recorded_checkpoint_ids: [], checkpoints: [] }, error: null })
      .mockResolvedValueOnce(response('unverified'));
    const status = vi.fn();
    const capture = createPatrolAutoCapture('shift', status);
    capture.capture(fix());
    await waitFor(() => expect(status).toHaveBeenCalledWith(expect.objectContaining({ kind: 'waiting' })));
    capture.capture(fix());
    await waitFor(() => expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'warning' })));
    capture.stop();
  });

  it('preserves fixes arriving while a request is in flight', async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(response('recorded', ['checkpoint']));
    const capture = createPatrolAutoCapture('shift', vi.fn());
    capture.capture(fix());
    capture.capture(fix());
    expect(rpc).toHaveBeenCalledTimes(1);
    finish(response('outside_geofence'));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    capture.stop();
  });

  it('refreshes an existing visit after a lost response without repeating refreshes', async () => {
    rpc.mockResolvedValue(response('already_recorded'));
    const recorded = vi.fn();
    window.addEventListener(PATROL_CHECKPOINT_RECORDED, recorded);
    const capture = createPatrolAutoCapture('shift', vi.fn());
    capture.capture(fix());
    await waitFor(() => expect(recorded).toHaveBeenCalledTimes(1));
    capture.capture(fix());
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(recorded).toHaveBeenCalledTimes(1);
    capture.stop();
    window.removeEventListener(PATROL_CHECKPOINT_RECORDED, recorded);
  });

  it('requests a fresh fix after database lock contention', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rpc.mockResolvedValueOnce({ data: null, error: { code: '40001', message: 'retry' } });
    const retry = vi.fn();
    const capture = createPatrolAutoCapture('shift', vi.fn(), retry);
    capture.capture(fix());
    await waitFor(() => expect(retry).toHaveBeenCalledOnce());
    capture.stop();
    log.mockRestore();
  });
});
