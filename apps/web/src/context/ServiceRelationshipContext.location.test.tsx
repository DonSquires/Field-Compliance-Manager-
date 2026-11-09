import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), address: vi.fn() }));
vi.mock('./AuthContext', () => ({ useAuth: () => ({ profile: { id: 'officer', organizationId: 'org', role: 'officer' } }) }));
vi.mock('../lib/locationAddress', () => ({ resolveAddressForCoordinates: mocks.address }));
vi.mock('../lib/supabase', () => ({ supabase: {
  rpc: mocks.rpc,
  from: (table: string) => {
    const rows: Record<string, unknown[]> = {
      service_agreements: [{ id: 'agreement', name: 'Test agreement', provider_organization_id: 'org', created_at: '2026-01-01', invitation_status: 'accepted' }],
      service_agreement_locations: [{ service_agreement_id: 'agreement', site_id: 'site', zone_id: null }],
      client_sites: [{ id: 'site', name: 'Test site', active: true }],
    };
    const query = {
      select: () => query, or: () => query, order: () => query, in: () => query, eq: () => query,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve),
    };
    return query;
  },
} }));

import { ServiceRelationshipProvider, useServiceRelationships } from './ServiceRelationshipContext';

function LocationProbe() {
  const context = useServiceRelationships();
  return <><button onClick={() => context.setLocationMode('gps')}>GPS</button><output>{context.loading ? 'loading' : context.locationStatus}</output><span>{context.currentAddress}</span></>;
}

describe('service location resolution', () => {
  let success: PositionCallback;
  let failure: PositionErrorCallback;
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.address.mockReset();
    mocks.rpc.mockImplementation((name: string) => Promise.resolve({ data: name === 'get_descendant_organizations' ? [] : [{ resolution_status: 'resolved', site_id: 'site' }], error: null }));
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      watchPosition: vi.fn((callback: PositionCallback, error: PositionErrorCallback) => { success = callback; failure = error; return 1; }),
      clearWatch: vi.fn(),
    } });
  });
  afterEach(cleanup);

  async function start() {
    render(<ServiceRelationshipProvider><LocationProbe /></ServiceRelationshipProvider>);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('idle'));
    fireEvent.click(screen.getByText('GPS'));
    await act(async () => { success({ coords: { latitude: -41, longitude: 173 }, timestamp: Date.now() } as GeolocationPosition); });
  }

  it('settles a verified geofence without waiting for reverse geocoding', async () => {
    mocks.address.mockReturnValue(new Promise(() => undefined));
    await start();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('resolved'));
  });

  it('keeps a valid geofence when address lookup fails', async () => {
    mocks.address.mockRejectedValue(new Error('Address lookup unavailable'));
    await start();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('resolved'));
  });

  it('does not call an absent resolver result outside a geofence', async () => {
    mocks.address.mockResolvedValue(null);
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    await start();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('unavailable'));
  });

  it('does not restore a pending fix after the device reports a GPS error', async () => {
    let resolveGeofence!: (value: unknown) => void;
    mocks.address.mockReturnValue(new Promise(() => undefined));
    mocks.rpc.mockImplementation((name: string) => name === 'get_descendant_organizations'
      ? Promise.resolve({ data: [], error: null })
      : new Promise((resolve) => { resolveGeofence = resolve; }));
    await start();
    act(() => failure({ message: 'Position unavailable', code: 2 } as GeolocationPositionError));
    await act(async () => { resolveGeofence({ data: [{ resolution_status: 'resolved', site_id: 'site' }], error: null }); });
    expect(screen.getByRole('status').textContent).toBe('unavailable');
  });
});