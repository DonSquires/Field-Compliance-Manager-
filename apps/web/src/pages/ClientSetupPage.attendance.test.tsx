import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ rpc: vi.fn(), routeError: false }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { organizationId: 'provider' }, operatingOrganizationId: 'provider' }) }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/client-setup', search: '?account=client' }), useNavigate: () => vi.fn() }));
vi.mock('../components/LocationHouseMap', () => ({ LocationHouseMap: () => null }));
vi.mock('../lib/supabase', () => ({ supabase: {
  rpc: mocked.rpc,
  from: (table: string) => {
    const query = {
      select: () => query, eq: () => query, is: () => query,
      maybeSingle: async () => ({ data: { id: 'client', name: 'Client', contact_email: null, contact_phone: null, status: 'active' } }),
      limit: async () => ({ data: [] }),
      order: async () => table === 'patrol_routes'
        ? { data: mocked.routeError ? null : [{ id: 'nelson', name: 'Nelson Forestry Patrol' }], error: mocked.routeError ? { message: 'Denied' } : null }
        : { data: [{ id: 'site', name: 'Depot', address: 'Verified address', site_type: 'industrial', boundary_verification: 'verified', gps_lat: null, gps_lng: null, boundary: null }] },
    };
    return query;
  },
} }));

import ClientSetupPage, { serviceWords } from './ClientSetupPage';

afterEach(cleanup);
beforeEach(() => {
  mocked.routeError = false;
  mocked.rpc.mockReset();
  mocked.rpc.mockImplementation(async (name: string) => ({ data: name === 'ensure_crm_client_agreement' ? { agreement_id: 'agreement' } : { schedule_id: 'schedule' }, error: null }));
});

describe('as-attended patrol setup', () => {
  it('saves an existing patrol without timing or visit-quota parameters', async () => {
    render(<ClientSetupPage />);
    const mode = await screen.findByRole('radio', { name: 'As attended' });
    fireEvent.click(mode);
    const route = screen.getByLabelText('Patrol');
    await screen.findByRole('option', { name: 'Nelson Forestry Patrol' });
    expect(screen.queryByLabelText('Visits each shift')).toBeNull();
    expect(screen.queryByText('What hours')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save this service' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(route, { target: { value: 'nelson' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save this service' }));
    await waitFor(() => expect(mocked.rpc).toHaveBeenCalledWith('manage_crm_as_attended_patrol', expect.objectContaining({ p_patrol_route_id: 'nelson', p_site_id: 'site', p_agreement_id: 'agreement' })));
    const call = mocked.rpc.mock.calls.find(([name]) => name === 'manage_crm_as_attended_patrol');
    expect(call?.[1]).not.toHaveProperty('p_visits_per_shift');
    expect(call?.[1]).not.toHaveProperty('p_window_start');
    expect(mocked.rpc.mock.calls.some(([name]) => name === 'manage_crm_agreement_delivery_schedule')).toBe(false);
    await screen.findByText(/Saved: Patrol visits · As attended at Depot/);
  });

  it('keeps scheduled timing controls as the default and blocks save if patrol loading fails', async () => {
    mocked.routeError = true;
    render(<ClientSetupPage />);
    await screen.findByLabelText('Visits each shift');
    fireEvent.click(screen.getByRole('radio', { name: 'As attended' }));
    await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: 'Save this service' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Scheduled visits' }));
    expect(screen.getByLabelText('Visits each shift')).toBeTruthy();
  });

  it('reads back attendance mode without inventing a visit count', () => {
    expect(serviceWords('Patrol visits', 'visits', { days: [], anyTime: true, start: '', end: '', visits: '1', stay: '10', slaMinutes: '30', attendanceMode: 'as_attended' })).toBe('Patrol visits · As attended');
  });
});