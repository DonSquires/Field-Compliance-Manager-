import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ rpc: vi.fn(), routeError: false }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { organizationId: 'provider', role: 'admin' }, operatingOrganizationId: 'provider' }) }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/crm', search: '?account=client' }), useNavigate: () => vi.fn() }));
vi.mock('../components/LocationHouseMap', () => ({ LocationHouseMap: () => null }));
vi.mock('../lib/supabase', () => {
  const dataFor = (table: string) => {
    if (table === 'organizations') return { id: 'client', name: 'Client', contact_email: null, contact_phone: null };
    if (table === 'client_sites') return [{ id: 'site', name: 'Depot', address: 'Verified address', site_type: 'industrial', boundary_verification: 'verified', gps_lat: null, gps_lng: null, boundary: null }];
    if (table === 'service_agreements') return [{ id: 'agreement', ends_on: null }];
    if (table === 'crm_contacts') return [{ id: 'contact' }];
    if (table === 'patrol_routes') return mocked.routeError ? null : [{ id: 'nelson', name: 'Nelson Patrol' }];
    if (table === 'module_catalog') return [{ module_key: 'patrol' }, { module_key: 'dispatch' }, { module_key: 'access_control' }];
    return [];
  };
  const queryFor = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in']) query[method] = () => query;
    query.order = async () => ({ data: dataFor(table), error: mocked.routeError && table === 'patrol_routes' ? { message: 'Denied' } : null });
    query.limit = async () => ({ data: dataFor(table), error: null });
    query.single = async () => ({ data: dataFor(table), error: null });
    query.maybeSingle = async () => ({ data: dataFor(table), error: null });
    query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve({
      data: dataFor(table),
      error: mocked.routeError && table === 'patrol_routes' ? { message: 'Denied' } : null,
    }).then(resolve, reject);
    return query;
  };
  return { supabase: { rpc: mocked.rpc, from: queryFor } };
});

import ClientSetupPage, { serviceWords } from './ClientSetupPage';

afterEach(cleanup);
beforeEach(() => {
  mocked.routeError = false;
  mocked.rpc.mockReset();
  mocked.rpc.mockImplementation(async (name: string) => ({
    data: name === 'manage_crm_as_attended_patrol' ? { schedule_id: 'schedule', attendance_mode: 'as_attended' } : { agreement_id: 'agreement' },
    error: null,
  }));
});

describe('CRM per-site attendance setup', () => {
  it('renders the embedded workspace and saves as-attended patrol through the governed RPC', async () => {
    render(<ClientSetupPage embedded accountId="client" providerOrganizationId="provider" />);
    expect(await screen.findByRole('region', { name: 'Child sites and inline services' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Set up a new client' })).toBeNull();

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Patrol visits' }));
    fireEvent.change(screen.getByLabelText('Attendance mode · Patrol visits'), { target: { value: 'as_attended' } });
    fireEvent.change(screen.getByLabelText('Patrol route · Patrol visits'), { target: { value: 'nelson' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mocked.rpc).toHaveBeenCalledWith('manage_crm_as_attended_patrol', expect.objectContaining({
      p_agreement_id: 'agreement',
      p_patrol_route_id: 'nelson',
      p_site_id: 'site',
      p_zone_id: null,
      p_operating_organization_id: 'provider',
    })));
    expect(mocked.rpc).not.toHaveBeenCalledWith('manage_crm_agreement_delivery_schedule', expect.anything());
    expect(await screen.findByText('As-attended patrol saved')).toBeTruthy();
  });

  it('does not claim a planned visit count for as-attended patrols', () => {
    expect(serviceWords('Patrol visits', 'visits', {
      days: [], anyTime: true, start: '', end: '', visits: '1', stay: '10', slaMinutes: '30', attendanceMode: 'as_attended',
    })).toBe('Patrol visits · As attended');
  });

  it('keeps saving blocked and explains the route read failure', async () => {
    mocked.routeError = true;
    render(<ClientSetupPage embedded accountId="client" providerOrganizationId="provider" />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Patrol visits' }));
    fireEvent.change(screen.getByLabelText('Attendance mode · Patrol visits'), { target: { value: 'as_attended' } });
    await waitFor(() => expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('Patrols could not be loaded'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('Choose an active patrol before saving'))).toBe(true));
    expect(mocked.rpc).not.toHaveBeenCalledWith('manage_crm_as_attended_patrol', expect.anything());
  });
});
