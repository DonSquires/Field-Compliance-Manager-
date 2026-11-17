import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ rpc: vi.fn(), failChecks: 0 }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mocked.rpc } }));
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
  it('keeps Leaving disabled until every check has an outcome', async () => {
    mocked.rpc.mockImplementation(async (name: string) => name === 'get_officer_patrol_stops'
      ? { data: onScene([check('gate_check', 'Gate check', 'done'), check('lock_up', 'Lock up')]), error: null }
      : { data: null, error: null });
    render(<OfficerPatrolStops shiftId="shift" />);
    const leave = await screen.findByRole('button', { name: 'Leaving Main gate' });
    expect((leave as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Record every check first')).toBeTruthy();
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
