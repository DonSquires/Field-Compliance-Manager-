import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ rpc: vi.fn(), saveError: false }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mocked.rpc } }));
vi.mock('../lib/safetyBriefing', () => ({ briefingNeedsAcknowledgement: () => false, fetchShiftSafetyBriefing: vi.fn() }));
vi.mock('./ShiftSafetyBriefing', () => ({ SafetyBriefingDialog: () => null }));

import { OfficerPatrolStops } from './OfficerPatrolStops';

const stop = (id: string, name: string, order: number, arrival: string, departure: string) => ({
  id, stop_order: order, visit_number: 1, visits_total: 1, status: 'completed', sla_status: 'on_track',
  sla_window_open: null, sla_arrive_by: arrival, sla_depart_by: null, required_dwell_minutes: 0,
  officer_instructions: null, actual_arrived_at: arrival, actual_departed_at: departure,
  arrival_verification: 'no_geofence', arrival_distance_m: null, officer_notes: null,
  module_key: 'general_patrol', place: { kind: 'zone', name, address: null, access_instructions: null, hs_notes: null },
  actual_travel_distance_km: null, travel_distance_version: 0,
});
const bundle = { shift: { id: 'shift', status: 'completed', scheduled_start: '2026-10-19T08:00:00Z', scheduled_end: '2026-10-19T16:00:00Z', route_name: 'Nelson Forestry Patrol' },
  stops: [stop('from', 'First place', 1, '2026-10-19T09:00:00Z', '2026-10-19T09:10:00Z'), stop('to', 'Next place', 2, '2026-10-19T09:30:00Z', '2026-10-19T09:40:00Z')] };

afterEach(cleanup);
beforeEach(() => {
  mocked.saveError = false;
  mocked.rpc.mockReset();
  mocked.rpc.mockImplementation(async (name: string) => name === 'get_officer_patrol_stops'
    ? { data: bundle, error: null }
    : { data: mocked.saveError ? null : { distance_km: 12.5, reference: 'travel-receipt' }, error: mocked.saveError ? { message: 'Travel changed; refresh before retrying.' } : null });
});

describe('actual between-place patrol travel', () => {
  it('saves measured kilometres against the actual previous departure and shows its receipt', async () => {
    render(<OfficerPatrolStops shiftId="shift" />);
    fireEvent.click(await screen.findByText('Record travel from First place'));
    fireEvent.change(screen.getByLabelText('Kilometres travelled'), { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record travel' }));
    await waitFor(() => expect(mocked.rpc).toHaveBeenCalledWith('record_patrol_travel_distance', expect.objectContaining({
      p_from_stop_id: 'from', p_to_stop_id: 'to', p_distance_km: 12.5, p_odometer_start_km: null, p_odometer_end_km: null, p_expected_version: 0,
    })));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '12.5 km travel recorded · receipt travel-receipt');
    expect(mocked.rpc.mock.calls.some(([name]) => name === 'manage_officer_patrol_stop')).toBe(false);
  });

  it('submits odometer readings without treating a cumulative reading as distance', async () => {
    render(<OfficerPatrolStops shiftId="shift" />);
    fireEvent.click(await screen.findByText('Record travel from First place'));
    fireEvent.click(screen.getByLabelText('Use odometer readings'));
    fireEvent.change(screen.getByLabelText('Odometer at departure (km)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Odometer at arrival (km)'), { target: { value: '112.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record travel' }));
    await waitFor(() => expect(mocked.rpc).toHaveBeenCalledWith('record_patrol_travel_distance', expect.objectContaining({
      p_distance_km: null, p_odometer_start_km: 100, p_odometer_end_km: 112.5,
    })));
  });

  it('keeps failed travel saves visible without a false success receipt', async () => {
    mocked.saveError = true;
    render(<OfficerPatrolStops shiftId="shift" />);
    fireEvent.click(await screen.findByText('Record travel from First place'));
    fireEvent.change(screen.getByLabelText('Kilometres travelled'), { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record travel' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Travel changed; refresh before retrying.');
    expect(screen.queryByRole('status')).toBeNull();
  });
});