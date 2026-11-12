import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), address: vi.fn(), rows: {} as Record<string, unknown[]>, gate: null as Promise<void> | null }));
vi.mock('./AuthContext', () => ({ useAuth: () => ({ profile: { id: 'officer', organizationId: 'org', role: 'officer' } }) }));
vi.mock('../lib/locationAddress', () => ({ resolveAddressForCoordinates: mocks.address }));
vi.mock('../lib/supabase', () => ({ supabase: {
  rpc: mocks.rpc,
  from: (table: string) => {
    const query = {
      select: () => query, or: () => query, order: () => query, in: () => query, eq: () => query,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(table === 'service_agreements' ? mocks.gate : null).then(() => ({ data: mocks.rows[table] ?? [], error: null })).then(resolve),
      maybeSingle: () => Promise.resolve({ data: mocks.rows[table]?.[0] ?? null, error: null }),
    };
    return query;
  },
} }));

import { ServiceRelationshipProvider, useServiceRelationships } from './ServiceRelationshipContext';

function LocationProbe() {
  const context = useServiceRelationships();
  return <><button onClick={() => context.setLocationMode('gps')}>GPS</button><button onClick={() => context.setLocationMode('manual')}>Manual</button><button onClick={() => context.setActiveShiftLocationContext({ organizationId: 'provider-branch', moduleKey: 'static_guarding', locationId: 'location', serviceAgreementLocationId: 'shift-site-link', siteIds: ['site'], zoneIds: [] })}>Set active shift context</button><output aria-label="Location status">{context.loading ? 'loading' : context.locationStatus}</output><output aria-label="Selected agreement">{context.selectedAgreementId}</output><output aria-label="Selected site">{context.selectedSiteId}</output><output aria-label="Selected zone">{context.selectedZoneId}</output><span>{context.currentAddress}</span></>;
}

describe('service location resolution', () => {
  let positionSuccess: PositionCallback;
  let positionFailure: PositionErrorCallback;
  let refreshGeofence: () => void;
  let refreshAddress: () => void;
  let timeoutGeofence: () => void;
  const geolocationPosition = { coords: { latitude: -41, longitude: 173 }, timestamp: Date.now() } as GeolocationPosition;
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.address.mockReset();
    mocks.rows = {
      service_agreements: [{ id: 'agreement', name: 'Test agreement', provider_organization_id: 'org', created_at: '2026-01-01', invitation_status: 'accepted' }],
      service_agreement_locations: [{ id: 'shift-zone-link', service_agreement_id: 'agreement', site_id: null, zone_id: 'zone' }],
      client_sites: [{ id: 'site', name: 'Test site', active: true }],
      location_zones: [{ id: 'zone', name: 'Test work zone', location_id: 'location', is_active: true }],
    };
    mocks.rpc.mockImplementation((name: string) => Promise.resolve({ data: name === 'get_descendant_organizations' ? [] : [{ resolution_status: 'resolved', matched_zone_id: 'zone', site_id: null }], error: null }));
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition: vi.fn((success: PositionCallback, failure: PositionErrorCallback) => {
        positionSuccess = success;
        positionFailure = failure;
      }),
    } });
    const nativeInterval = window.setInterval.bind(window);
    const nativeTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 30_000 && typeof handler === 'function') refreshGeofence = () => { void handler(...args); };
      return nativeInterval(handler, delay, ...args);
    }) as typeof window.setInterval);
    vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 30_000 && typeof handler === 'function') refreshAddress = () => { void handler(...args); };
      if (delay === 15_000 && typeof handler === 'function') timeoutGeofence = () => { void handler(...args); };
      return nativeTimeout(handler, delay, ...args);
    }) as typeof window.setTimeout);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); mocks.gate = null; });

  it('uses a fresh fix that arrived while service context was loading instead of asking the device again', async () => {
    let releaseContext!: () => void;
    mocks.gate = new Promise<void>((resolve) => { releaseContext = resolve; });
    render(<ServiceRelationshipProvider><LocationProbe /></ServiceRelationshipProvider>);
    fireEvent.click(screen.getByText('GPS'));
    await waitFor(() => expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Location status').textContent).toBe('loading');
    act(() => positionSuccess({ ...geolocationPosition, timestamp: Date.now() } as GeolocationPosition));
    expect(mocks.rpc).not.toHaveBeenCalledWith('resolve_operational_context_authorized', expect.anything());
    await act(async () => releaseContext());
    await waitFor(() => expect(screen.getByLabelText('Location status').textContent).toBe('resolved'));
    expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  async function start(waitForResolution = true) {
    render(<ServiceRelationshipProvider><LocationProbe /></ServiceRelationshipProvider>);
    await waitFor(() => expect(screen.getByLabelText('Location status').textContent).toBe('idle'));
    fireEvent.click(screen.getByText('GPS'));
    await waitFor(() => expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    act(() => positionSuccess(geolocationPosition));
    if (waitForResolution) {
      await waitFor(() => expect(['resolved', 'unavailable', 'outside_geofence']).toContain(screen.getByLabelText('Location status').textContent));
    }
  }

  it('resolves immediately, does not overlap refreshes, and delays address lookup', async () => {
    let resolveGeofence!: (value: unknown) => void;
    mocks.rpc.mockImplementation((name: string) => name === 'get_descendant_organizations'
      ? Promise.resolve({ data: [], error: null })
      : new Promise((resolve) => { resolveGeofence = resolve; }));
    mocks.address.mockReturnValue(new Promise(() => undefined));
    await start(false);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('resolve_operational_context_authorized', expect.anything()));
    expect(mocks.address).not.toHaveBeenCalled();
    act(() => refreshGeofence());
    expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    await act(async () => resolveGeofence({ data: [{ resolution_status: 'resolved', matched_zone_id: 'zone', site_id: null }], error: null }));
    await waitFor(() => expect(screen.getByLabelText('Location status').textContent).toBe('resolved'));
    act(() => refreshGeofence());
    await waitFor(() => expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalledTimes(2));
    act(() => refreshAddress());
    await waitFor(() => expect(mocks.address).toHaveBeenCalledTimes(1));
  });

  it('times out a stalled resolver and retries on the next cadence', async () => {
    const pendingResolutions: Array<(value: unknown) => void> = [];
    mocks.address.mockReturnValue(new Promise(() => undefined));
    mocks.rpc.mockImplementation((name: string) => name === 'get_descendant_organizations'
      ? Promise.resolve({ data: [], error: null })
      : new Promise((resolve) => pendingResolutions.push(resolve)));
    await start(false);
    await waitFor(() => expect(pendingResolutions).toHaveLength(1));
    act(() => timeoutGeofence());
    await waitFor(() => expect(screen.getByLabelText('Location status').textContent).toBe('unavailable'));

    act(() => refreshGeofence());
    await waitFor(() => expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalledTimes(2));
    act(() => positionSuccess(geolocationPosition));
    await waitFor(() => expect(pendingResolutions).toHaveLength(2));
    await act(async () => { pendingResolutions[1]({ data: [{ resolution_status: 'resolved', matched_zone_id: 'zone', site_id: null }], error: null }); });
    await waitFor(() => expect(screen.getByLabelText('Location status').textContent).toBe('resolved'));
  });

  it('keeps a valid geofence when address lookup fails', async () => {
    mocks.address.mockRejectedValue(new Error('Address lookup unavailable'));
    await start();
    await waitFor(() => expect(screen.getByLabelText('Location status').textContent).toBe('resolved'));
    act(() => refreshAddress());
    await waitFor(() => expect(mocks.address).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Location status').textContent).toBe('resolved');
  });

  it('does not call an absent resolver result outside a geofence', async () => {
    let resolveGeofence!: (value: unknown) => void;
    mocks.address.mockResolvedValue(null);
    mocks.rpc.mockImplementation((name: string) => name === 'get_descendant_organizations'
      ? Promise.resolve({ data: [], error: null })
      : new Promise((resolve) => { resolveGeofence = resolve; }));
    await start(false);
    await act(async () => { resolveGeofence({ data: [], error: null }); });
    await waitFor(() => expect(screen.getByLabelText('Location status').textContent).toBe('unavailable'));
  });

  it('shows an explicit unavailable state when one-shot GPS acquisition fails', async () => {
    render(<ServiceRelationshipProvider><LocationProbe /></ServiceRelationshipProvider>);
    await waitFor(() => expect(screen.getByLabelText('Location status').textContent).toBe('idle'));
    fireEvent.click(screen.getByText('GPS'));
    await waitFor(() => expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    act(() => positionFailure({ message: 'Position unavailable', code: 2 } as GeolocationPositionError));
    await waitFor(() => expect(screen.getByLabelText('Location status').textContent).toBe('unavailable'));
  });

  it('discards an in-flight geofence result after leaving GPS mode', async () => {
    let resolveGeofence!: (value: unknown) => void;
    mocks.address.mockReturnValue(new Promise(() => undefined));
    mocks.rpc.mockImplementation((name: string) => name === 'get_descendant_organizations'
      ? Promise.resolve({ data: [], error: null })
      : new Promise((resolve) => { resolveGeofence = resolve; }));
    await start(false);
    fireEvent.click(screen.getByText('Manual'));
    await act(async () => { resolveGeofence({ data: [{ resolution_status: 'resolved', site_id: 'site' }], error: null }); });
    expect(screen.getByLabelText('Location status').textContent).toBe('idle');
  });

  it('selects the active shift contract place instead of the newest default agreement', async () => {
    mocks.rows.service_agreements = [
      { id: 'shift-agreement', name: 'Shift agreement', provider_organization_id: 'org', created_at: '2025-01-01', invitation_status: 'accepted' },
      { id: 'newer-agreement', name: 'Newer agreement', provider_organization_id: 'org', created_at: '2026-01-01', invitation_status: 'accepted' },
    ];
    mocks.rows.service_agreement_locations = [
      { id: 'shift-site-link', service_agreement_id: 'shift-agreement', site_id: 'site', zone_id: null },
      { id: 'newer-site-link', service_agreement_id: 'newer-agreement', site_id: 'newer-site', zone_id: null },
    ];
    mocks.rows.client_sites = [
      { id: 'site', name: 'IPC site', location_id: 'location', active: true },
      { id: 'newer-site', name: 'Newer site', location_id: 'other-location', active: true },
    ];
    mocks.rows.location_zones = [{ id: 'zone', name: 'IPC static working zone', location_id: 'location', organization_id: 'provider-branch', module_key: 'static_guarding', is_active: true }];
    mocks.rpc.mockImplementation((name: string) => name === 'get_descendant_organizations'
      ? Promise.resolve({ data: [], error: null })
      : Promise.resolve({ data: [{ resolution_status: 'resolved', matched_zone_id: 'zone', site_id: 'site' }], error: null }));
    const { getByLabelText, getByText } = render(<ServiceRelationshipProvider><LocationProbe /></ServiceRelationshipProvider>);
    await waitFor(() => expect(screen.getByLabelText('Location status').textContent).toBe('idle'));
    expect(getByLabelText('Selected agreement').textContent).toBe('newer-agreement');
    fireEvent.click(getByText('Set active shift context'));
    await waitFor(() => expect(getByLabelText('Selected agreement').textContent).toBe('shift-agreement'));
    fireEvent.click(getByText('GPS'));
    await waitFor(() => expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    await act(async () => { positionSuccess(geolocationPosition); });
    await waitFor(() => expect(screen.getByLabelText('Location status').textContent).toBe('resolved'));
    expect(mocks.rpc).toHaveBeenCalledWith('resolve_operational_context_authorized', {
      p_lat: -41, p_lng: 173, p_org_id: 'provider-branch', p_module_key: 'static_guarding',
    });
    await waitFor(() => expect(getByLabelText('Selected zone').textContent).toBe('zone'));
    expect(getByLabelText('Selected site').textContent).toBe('site');
  });
});