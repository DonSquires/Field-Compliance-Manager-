import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PatrolPage from './PatrolPage';
import { supabase } from '../lib/supabase';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'officer', organizationId: 'home' } }) }));
vi.mock('../context/OfficerUnsavedWorkContext', () => ({ useOfficerUnsavedWork: vi.fn() }));
vi.mock('../components/OfficerPatrolStops', () => ({
  OfficerPatrolStops: ({ shiftId, onDirtyChange }: { shiftId: string; onDirtyChange: (dirty: boolean) => void }) => (
    <div>Assigned stops: {shiftId}<button onClick={() => onDirtyChange(true)}>Make stop work dirty</button></div>
  ),
}));
vi.mock('../components/PatrolCheckpointList', () => ({
  PatrolCheckpointList: ({ visits }: { visits: unknown[] }) => <div>Recorded visits: {visits.length}</div>,
}));
vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('assigned cross-branch patrol reads', () => {
  function setup(sessionAvailable: boolean, inconsistentFuture = false, secondShift = false) {
    const now = Date.now();
    const shift = {
      id: 'shift', officer_user_id: 'officer', organization_id: 'branch', service_type: 'patrol',
      scheduled_start: new Date(now - 600000).toISOString(), scheduled_end: new Date(now + 3600000).toISOString(),
      status: 'in_progress', zone_id: null, patrol_route_id: null, zone_name: null, route_name: 'First route', route_code: null,
    };
    const future = { ...shift, id: 'bad-future', status: 'accepted', context_status: 'requires_review' };
    const second = { ...shift, id: 'second-shift', status: 'accepted', route_name: 'Second route' };
    const query = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), lte: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: inconsistentFuture ? [future] : [], error: null }),
    };
    vi.mocked(supabase.from).mockReturnValue(query as never);
    vi.mocked(supabase.rpc).mockImplementation(((name: string, args?: { p_shift_id?: string }) => {
      if (name === 'get_assigned_officer_shift_context') return Promise.resolve({ data: [shift, ...(inconsistentFuture ? [future] : []), ...(secondShift ? [second] : [])], error: null });
      if (name === 'get_assigned_patrol_session') return Promise.resolve({
        data: sessionAvailable ? {
          shift_id: args?.p_shift_id, session: { id: 'patrol', status: 'in_progress', started_at: shift.scheduled_start, ended_at: null },
          visits: [{ id: 'visit', checkpoint_id: 'checkpoint', route_checkpoint_id: null,
            visited_at: shift.scheduled_start, scan_method: 'gps', notes: null }],
        } : null, error: null,
      });
      if (name === 'get_officer_patrol_journey') return Promise.resolve({
        data: { shift_id: args?.p_shift_id, patrol_id: 'patrol', checkpoint_requirement: 'site_zone',
          route_geometry: null, route_geometry_status: 'unavailable', stops: [],
          checkpoints: [{ id: 'checkpoint', kind: 'site', name: 'Gate', required: true,
            visited: true, site_id: null, zone_id: null, sequence_order: null,
            auto_geofence_status: 'verified', stop_ids: [] }] }, error: null,
      });
      return Promise.resolve({ data: null, error: new Error('unexpected RPC') });
    }) as never);
    render(<MemoryRouter><PatrolPage /></MemoryRouter>);
  }

  it('loads the assigned shift, session and visits without raw patrol table reads', async () => {
    setup(true);
    expect(await screen.findByText('Recorded visits: 1')).toBeTruthy();
    expect(supabase.from).toHaveBeenCalledWith('shifts');
    expect(supabase.from).not.toHaveBeenCalledWith('patrols');
    expect(supabase.from).not.toHaveBeenCalledWith('patrol_checkpoint_visits');
    expect(supabase.rpc).toHaveBeenCalledWith('get_assigned_patrol_session', { p_shift_id: 'shift' });
  });

  it('does not present an unavailable assignment as a new patrol session', async () => {
    setup(false);
    await waitFor(() => expect(screen.getByText('Patrol session or checkpoints could not be loaded. Try again or contact operations.')).toBeTruthy());
    expect(screen.queryByText('Start Patrol')).toBeNull();
  });

  it('keeps the active patrol available while warning about an inconsistent future assignment', async () => {
    setup(true, true);
    expect(await screen.findByText('Recorded visits: 1')).toBeTruthy();
    expect(screen.getByText('Some assigned shifts need operations review; their details are unavailable.')).toBeTruthy();
    expect(screen.getByText("Today's and active overnight shifts (1)")).toBeTruthy();
  });

  it('keeps dirty stop work on the current shift until switching is confirmed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    try {
      setup(true, false, true);
      expect(await screen.findByText('Assigned stops: shift')).toBeTruthy();
      await screen.findByText('Recorded visits: 1');
      fireEvent.click(screen.getByRole('button', { name: 'Make stop work dirty' }));
      fireEvent.click(screen.getByRole('button', { name: /Second route/ }));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Assigned stops: shift')).toBeTruthy();
      expect(supabase.rpc).not.toHaveBeenCalledWith('get_assigned_patrol_session', { p_shift_id: 'second-shift' });
      fireEvent.click(screen.getByRole('button', { name: /Second route/ }));
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(await screen.findByText('Assigned stops: second-shift')).toBeTruthy();
      await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('get_assigned_patrol_session', { p_shift_id: 'second-shift' }));
    } finally {
      confirm.mockRestore();
    }
  });
});
