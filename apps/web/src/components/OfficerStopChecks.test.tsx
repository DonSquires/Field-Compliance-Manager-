import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(), failChecks: 0 }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mocked.rpc, functions: { invoke: mocked.invoke } } }));
vi.mock('../lib/safetyBriefing', () => ({ briefingNeedsAcknowledgement: () => false, fetchShiftSafetyBriefing: vi.fn() }));
vi.mock('./ShiftSafetyBriefing', () => ({ SafetyBriefingDialog: () => null }));

import { OfficerPatrolStops } from './OfficerPatrolStops';
import { OfficerStopChecks, type StopCheck } from './OfficerStopChecks';

const check = (key: string, label: string, outcome: StopCheck['outcome'] = null): StopCheck => ({
  check_key: key, label, needs_photo: false, needs_note: false, outcome, notes: null, performed_at: null,
});
const onScene = (checks: StopCheck[]) => ({
  shift: { id: 'shift', status: 'in_progress', scheduled_start: '2026-11-17T08:00:00Z', scheduled_end: '2026-11-17T16:00:00Z', route_name: 'Night run' },
  stops: [{
    id: 'stop', stop_order: 1, visit_number: 1, visits_total: 1, status: 'on_scene', sla_status: 'on_track',
    sla_window_open: null, sla_arrive_by: '2026-11-17T09:00:00Z', sla_depart_by: null, required_dwell_minutes: 0,
    officer_instructions: null, actual_arrived_at: '2026-11-17T08:55:00Z', actual_departed_at: null,
    arrival_verification: 'verified_on_site', arrival_distance_m: 3, officer_notes: null, module_key: 'general_patrol',
    place: { kind: 'zone', name: 'Main gate', address: null, access_instructions: null, hs_notes: null }, checks,
  }],
});

let fix = 0;
beforeEach(() => {
  fix = 0;
  mocked.failChecks = 0;
  mocked.rpc.mockReset();
  mocked.invoke.mockReset();
  mocked.rpc.mockImplementation(async (name: string) => {
    if (name === 'record_patrol_stop_check') {
      if (mocked.failChecks > 0) { mocked.failChecks -= 1; return { data: null, error: { message: 'Connection lost' } }; }
      return { data: { outcome: 'done' }, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: (ok: PositionCallback) => { fix += 1; ok({ coords: { latitude: -41 - fix, longitude: 173, accuracy: 5 + fix } } as GeolocationPosition); } },
  });
});
afterEach(cleanup);

describe('checks at a patrol stop', () => {
  it('withholds the failed briefing with retry without blocking arrival evidence', async () => {
    const pending = onScene([]);
    pending.stops[0].status = 'pending';
    mocked.rpc.mockResolvedValue({ data: pending, error: null });
    mocked.invoke.mockResolvedValueOnce({ data: {
      shift_id: 'shift', stop_id: 'stop', officer_instructions: null, access_instructions: null,
      hs_notes: null, privacy: { status: 'unavailable' },
    }, error: null }).mockResolvedValueOnce({ data: {
      shift_id: 'shift', stop_id: 'stop', officer_instructions: null, access_instructions: 'Reviewed access',
      hs_notes: 'Reviewed safety', privacy: { status: 'checked' },
    }, error: null });
    render(<OfficerPatrolStops shiftId="shift" />);
    const arrive = await screen.findByRole('button', { name: 'Arrived at Main gate' });
    expect((arrive as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry stop briefing' }));
    expect(await screen.findByText('Reviewed safety')).toBeTruthy();
    await waitFor(() => expect((arrive as HTMLButtonElement).disabled).toBe(false));
  });

  it.each([
    { state: 'missing', checks: undefined },
    { state: 'invalid', checks: [{ ...check('gate', 'Gate'), outcome: 'invented' }] },
  ])('does not present departure when the check projection is $state', async ({ checks }) => {
    const bundle = onScene([]);
    mocked.rpc.mockResolvedValueOnce({ data: { ...bundle, stops: [{ ...bundle.stops[0], checks }] }, error: null });
    render(<OfficerPatrolStops shiftId="shift" />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('assigned stop details could not be confirmed'));
    expect(screen.queryByRole('button', { name: 'Leaving Main gate' })).toBeNull();
  });

  it('keeps Leaving disabled until every check has an outcome', async () => {
    mocked.rpc.mockImplementation(async (name: string) => name === 'get_officer_patrol_stops_sanitized'
      ? { data: onScene([check('gate_check', 'Gate check', 'done'), check('lock_up', 'Lock up')]), error: null }
      : { data: null, error: null });
    render(<OfficerPatrolStops shiftId="shift" />);
    const leave = await screen.findByRole('button', { name: 'Leaving Main gate' });
    expect((leave as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Record every check first')).toBeTruthy();
  });

  it('reports a departure draft so changing shifts cannot silently discard it', async () => {
    mocked.rpc.mockResolvedValue({ data: onScene([]), error: null });
    const onDirtyChange = vi.fn();
    const { unmount } = render(<OfficerPatrolStops shiftId="shift" onDirtyChange={onDirtyChange} />);
    fireEvent.change(await screen.findByPlaceholderText(/Gates locked/), { target: { value: 'Gate checked' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('preserves departure and check drafts when a refresh fails', async () => {
    mocked.rpc.mockResolvedValueOnce({ data: onScene([check('gate_check', 'Gate check')]), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'Connection lost' } });
    const onDirtyChange = vi.fn();
    render(<OfficerPatrolStops shiftId="shift" onDirtyChange={onDirtyChange} />);
    const notes = await screen.findByPlaceholderText(/Gates locked/);
    fireEvent.change(notes, { target: { value: 'Gate checked' } });
    fireEvent.click(screen.getByRole('button', { name: "Couldn't complete Gate check" }));
    fireEvent.change(screen.getByLabelText('Why it could not be completed'), { target: { value: 'Locked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh contracted stops' }));
    expect((await screen.findByRole('alert')).textContent).toContain('out of date');
    expect(screen.getByDisplayValue('Gate checked')).toBeTruthy();
    expect(screen.getByDisplayValue('Locked')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Leaving Main gate' })).toBeTruthy();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('requires a reason when a check could not be completed', async () => {
    render(<OfficerStopChecks stopId="stop" checks={[check('gate_check', 'Gate check')]} onRecorded={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: "Couldn't complete Gate check" }));
    expect((screen.getByRole('button', { name: 'Save Gate check' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Why it could not be completed'), { target: { value: 'Gate chained by council' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Gate check' }));
    await waitFor(() => expect(mocked.rpc).toHaveBeenCalledWith('record_patrol_stop_check', expect.objectContaining({
      p_stop_id: 'stop', p_check_key: 'gate_check', p_outcome: 'could_not_complete', p_notes: 'Gate chained by council',
    })));
  });

  it('presents a sanitized check key in readable words', () => {
    render(<OfficerStopChecks stopId="stop" checks={[check('gate_check', 'gate_check')]} onRecorded={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Done Gate check' })).toBeTruthy();
  });

  it('reports an unsaved check until its save succeeds', async () => {
    const onDirtyChange = vi.fn();
    render(<OfficerStopChecks stopId="stop" checks={[check('gate_check', 'Gate check')]}
      onRecorded={() => undefined} onDirtyChange={onDirtyChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Done Gate check' }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Save Gate check' }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it('resends the identical request and GPS values after a failed save', async () => {
    mocked.failChecks = 1;
    const onRecorded = vi.fn();
    render(<OfficerStopChecks stopId="stop" checks={[check('gate_check', 'Gate check')]} onRecorded={onRecorded} />);
    fireEvent.click(screen.getByRole('button', { name: 'Done Gate check' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Gate check' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Connection lost');
    fireEvent.click(screen.getByRole('button', { name: 'Save Gate check' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    const calls = mocked.rpc.mock.calls.filter(([name]) => name === 'record_patrol_stop_check').map(([, args]) => args);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(fix).toBe(1);
  });
});
