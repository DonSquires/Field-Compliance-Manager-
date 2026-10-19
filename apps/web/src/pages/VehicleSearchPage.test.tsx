import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import VehicleSearchPage from './VehicleSearchPage';

const { from, rpc, ilike, eq, historyOr, historyResult } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), ilike: vi.fn(), eq: vi.fn(), historyOr: vi.fn(), historyResult: vi.fn(),
}));
vi.mock('../lib/supabase', () => ({ supabase: { from, rpc } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { organizationId: 'org', id: 'user' } }) }));
vi.mock('../components/SafetyWarningsPanel', () => ({ SafetyWarningsPanel: () => null }));

describe('vehicle search candidate selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    historyResult.mockReturnValue({ data: [], error: null });
    rpc.mockResolvedValue({ data: [
      { id: 'vehicle-1', plate_number: 'RJ198', make: 'Toyota' },
      { id: 'vehicle-2', plate_number: 'RJ298', make: 'Ford' },
    ], error: null });
    from.mockImplementation((table: string) => {
      const query = {
        select: () => query, eq: (...args: unknown[]) => { eq(...args); return query; },
        ilike: (...args: unknown[]) => { ilike(table, ...args); return query; },
        order: () => query, contains: () => query,
        or: (filter: string) => { historyOr(table, filter); return query; }, is: () => query,
        limit: async () => table === 'observations' ? historyResult() : ({ data: table === 'canonical_vehicle_public' ? [
          { id: 'vehicle-1', plate_number: 'RJ198', make: 'Toyota' },
          { id: 'vehicle-2', plate_number: 'RJ298', make: 'Ford' },
        ] : [], error: null }),
        maybeSingle: async () => ({ data: table === 'canonical_vehicle_public' ? { id: 'vehicle-2', plate_number: 'RJ298', make: 'Ford' } : null, error: null }),
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => resolve({ data: [], error: null }),
      };
      return query;
    });
  });
  afterEach(cleanup);

  it('passes the wildcard through and opens only the chosen identity', async () => {
    render(<MemoryRouter><VehicleSearchPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: 'rj%9%8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Plate' }));
    await screen.findByRole('region', { name: 'Matching vehicles' });
    expect(rpc).toHaveBeenCalledWith('search_vehicle_registrations', { p_pattern: 'RJ%9%8', p_limit: 51 });
    expect(from).not.toHaveBeenCalledWith('entity_flags');
    fireEvent.click(screen.getByRole('button', { name: 'RJ298' }));
    await screen.findByRole('button', { name: '+ Raise of-interest flag' });
    expect(eq).toHaveBeenCalledWith('id', 'vehicle-2');
    expect(eq).toHaveBeenCalledWith('entity_id', 'vehicle-2');
    expect(historyOr).toHaveBeenCalledWith('observations', 'canonical_vehicle_id.eq.vehicle-2,plate_number_upper.eq.RJ298');
    expect(ilike).toHaveBeenCalledWith('breach_alerts', 'plate_number', 'RJ298');
    expect(screen.queryByRole('region', { name: 'Matching vehicles' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: '%YG%4' } });
    expect(screen.getByText('RJ298', { selector: '.plate-banner' })).toBeTruthy();
  });

  it('searches a fragment anywhere and rejects wildcard-only input without querying', async () => {
    render(<MemoryRouter><VehicleSearchPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: 'yg4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Plate' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('search_vehicle_registrations', { p_pattern: '%YG4%', p_limit: 51 }));
    await screen.findByRole('region', { name: 'Matching vehicles' });
    from.mockClear();
    rpc.mockClear();
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: '%%' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Plate' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('shows query failures rather than the previous vehicle', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('Search unavailable') });
    render(<MemoryRouter><VehicleSearchPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: 'ABC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Plate' }));
    expect((await screen.findByRole('alert')).textContent).toContain("We couldn't load matching registrations");
    expect(screen.queryByRole('button', { name: '+ Raise of-interest flag' })).toBeNull();
  });

  it('reports a PostgREST plain-object statement timeout explicitly', async () => {
    rpc.mockResolvedValue({ data: null, error: {
      code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null,
    } });
    render(<MemoryRouter><VehicleSearchPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: 'RJ%9%8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Plate' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Vehicle search timed out');
    expect(screen.queryByText('No matching registrations found.')).toBeNull();
  });
  it('identifies a selected-vehicle history timeout instead of hiding it as a search failure', async () => {
    historyResult.mockReturnValue({ data: null, error: {
      code: '57014', message: 'canceling statement due to statement timeout',
    } });
    render(<MemoryRouter><VehicleSearchPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: 'RJ%9%8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Plate' }));
    await screen.findByRole('region', { name: 'Matching vehicles' });
    fireEvent.click(screen.getByRole('button', { name: 'RJ298' }));
    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain("We couldn't load vehicle observation history");
    expect(error.textContent).toContain('timed out');
    expect(error.textContent).not.toContain('Failed to search vehicle');
    expect(screen.queryByRole('button', { name: '+ Raise of-interest flag' })).toBeNull();
  });
  it('bounds broad result lists and reports empty wildcard searches', async () => {
    rpc.mockResolvedValueOnce({ data: Array.from({ length: 51 }, (_, n) => ({
      id: `vehicle-${n}`, plate_number: `REG${n}`,
    })), error: null });
    render(<MemoryRouter><VehicleSearchPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: '%REG%' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Plate' }));
    await screen.findByText(/Showing the first 50/);
    expect(screen.getAllByRole('button', { name: /^REG\d+$/ })).toHaveLength(50);
    rpc.mockResolvedValueOnce({ data: [], error: null });
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: '%XYZ%' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Plate' }));
    await screen.findByText('No matching registrations found.');
    expect(screen.queryByRole('button', { name: /^REG\d+$/ })).toBeNull();
  });
});
