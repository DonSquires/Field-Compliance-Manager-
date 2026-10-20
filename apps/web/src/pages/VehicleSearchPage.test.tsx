import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import VehicleSearchPage from './VehicleSearchPage';

const { from, rpc, ilike, eq, historyOr, historyResult, photoIn, storageFrom, createSignedUrls } = vi.hoisted(() => ({
  photoIn: vi.fn(), storageFrom: vi.fn(), createSignedUrls: vi.fn(),
  from: vi.fn(), rpc: vi.fn(), ilike: vi.fn(), eq: vi.fn(), historyOr: vi.fn(), historyResult: vi.fn(),
}));
vi.mock('../lib/supabase', () => ({ supabase: { from, rpc, storage: { from: storageFrom } } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { organizationId: 'org', id: 'user' } }) }));
vi.mock('../components/SafetyWarningsPanel', () => ({ SafetyWarningsPanel: () => null }));
vi.mock('../components/VehicleProfile', () => ({ default: ({ summary, children }: { summary?: React.ReactNode; children?: React.ReactNode }) => <section aria-label="Vehicle profile">{summary}{children}</section> }));

describe('vehicle search candidate selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    historyResult.mockReturnValue({ data: [], error: null });
    createSignedUrls.mockResolvedValue({ data: [{ path: 'org/user/photo.jpg', signedUrl: 'https://signed.test/photo.jpg', error: null }], error: null });
    storageFrom.mockReturnValue({ createSignedUrls });
    rpc.mockResolvedValue({ data: [
      { id: 'vehicle-1', plate_number: 'RJ198', make: 'Toyota' },
      { id: 'vehicle-2', plate_number: 'RJ298', make: 'Ford' },
    ], error: null });
    from.mockImplementation((table: string) => {
      const query = {
        select: () => query, eq: (...args: unknown[]) => { eq(...args); return query; },
        ilike: (...args: unknown[]) => { ilike(table, ...args); return query; },
        order: () => query, contains: () => query,
        in: (...args: unknown[]) => { photoIn(table, ...args); return Promise.resolve(table === 'vehicle_profile_photos' ? { data: [{ canonical_vehicle_id: 'vehicle-2', storage_path: 'org/user/photo.jpg' }], error: null } : { data: [], error: null }); },
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
    fireEvent.click(screen.getByRole('button', { name: 'Back to search results' }));
    expect(screen.getByLabelText('Registration search')).toHaveProperty('value', 'RJ%9%8');
    expect(screen.getByRole('region', { name: 'Matching vehicles' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'RJ198' })).toBeTruthy();
    expect(screen.queryByText('RJ298', { selector: '.plate-banner' })).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
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
    fireEvent.click(screen.getByRole('button', { name: 'Back to search results' }));
    expect(screen.getByRole('region', { name: 'Matching vehicles' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
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

  it('opens the selected vehicle in a separate movable window and reports a blocked pop-up', async () => {
    const popup = { opener: {} as unknown, focus: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    render(<MemoryRouter><VehicleSearchPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: 'rj%9%8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Plate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'RJ298' }));
    await screen.findByRole('button', { name: '+ Raise of-interest flag' });
    fireEvent.click(screen.getByRole('button', { name: 'Open in new window' }));
    expect(open).toHaveBeenCalledWith('/admin/field-ops?area=vehicle-search&popout=1&plate=RJ298', 'fcm-vehicle-search', expect.stringContaining('popup=yes'));
    expect(popup.opener).toBeNull();
    expect(popup.focus).toHaveBeenCalled();
    open.mockReturnValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Open in new window' }));
    expect((await screen.findByRole('alert')).textContent).toContain('blocked the pop-up');
    open.mockRestore();
  });

  it('marks the pop-out window and does not offer to pop out again', () => {
    render(<MemoryRouter initialEntries={['/admin/field-ops?area=vehicle-search&popout=1']}><VehicleSearchPage /></MemoryRouter>);
    expect(screen.getByText('Separate window')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open in new window' })).toBeNull();
  });

  it('shows a vehicle profile photo thumbnail in the result list when one exists', async () => {
    render(<MemoryRouter><VehicleSearchPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: 'rj%9%8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Plate' }));
    const photo = await screen.findByRole('img', { name: 'Profile photo of RJ298' });
    expect(photo.getAttribute('src')).toBe('https://signed.test/photo.jpg');
    expect(screen.queryByRole('img', { name: 'Profile photo of RJ198' })).toBeNull();
    expect(photoIn).toHaveBeenCalledWith('vehicle_profile_photos', 'canonical_vehicle_id', ['vehicle-1', 'vehicle-2']);
    expect(storageFrom).toHaveBeenCalledWith('vehicle-profile-photos');
    expect(createSignedUrls).toHaveBeenCalledWith(['org/user/photo.jpg'], 3600);
  });

  it('keeps the result list when photo lookup fails', async () => {
    createSignedUrls.mockResolvedValue({ data: null, error: { message: 'denied' } });
    render(<MemoryRouter><VehicleSearchPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: 'rj%9%8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Plate' }));
    expect(await screen.findByRole('button', { name: 'RJ298' })).toBeTruthy();
    await waitFor(() => expect(createSignedUrls).toHaveBeenCalled());
    expect(screen.queryByRole('img', { name: /Profile photo/ })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists observations as a table with signed photos and keeps identity and status inside the profile card', async () => {
    historyResult.mockReturnValue({ data: [
      { id: 'obs-1', observed_at: '2026-05-23T05:45:00Z', is_compliant: null, compliance_status: null, compliance_reason: null, nights_this_zone: 2, plate_number: 'RJ298', module_key: 'freedom_camping', vehicle_make: 'Ford', vehicle_model: 'Ranger', vehicle_colour: 'Silver', photo_url: 'org/org-1/obs-1.jpg', zone: { name: 'Kaiuma Forest Block' } },
      { id: 'obs-2', observed_at: '2026-05-22T05:45:00Z', is_compliant: false, compliance_status: null, compliance_reason: 'Overstayed', nights_this_zone: null, plate_number: 'RJ298', module_key: 'parking_enforcement', vehicle_make: null, vehicle_model: null, vehicle_colour: null, photo_url: null, zone: null },
    ], error: null });
    createSignedUrls.mockImplementation(async (paths: string[]) => ({ data: paths.map((path) => ({ path, signedUrl: `https://signed.test/${path}`, error: null })), error: null }));
    render(<MemoryRouter><VehicleSearchPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Registration search'), { target: { value: 'rj%9%8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Plate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'RJ298' }));
    const table = await screen.findByRole('table', { name: 'Observation history' });
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Kaiuma Forest Block');
    expect(rows[0].textContent).toContain('freedom camping');
    expect(rows[0].textContent).toContain('Silver Ford Ranger');
    expect(rows[1].textContent).toContain('NON-COMPLIANT');
    expect(rows[1].textContent).toContain('Overstayed');
    await waitFor(() => expect(table.querySelector('img')?.getAttribute('src')).toBe('https://signed.test/org/org-1/obs-1.jpg'));
    expect(storageFrom).toHaveBeenCalledWith('scans');
    expect(createSignedUrls).toHaveBeenCalledWith(['org/org-1/obs-1.jpg'], 900);
    const card = screen.getByRole('region', { name: 'Vehicle profile' });
    expect(card.querySelector('.plate-banner')?.textContent).toBe('RJ298');
    expect(card.textContent).toContain('Warrant & Certification Status');
    expect(card.querySelector('button')?.textContent).toBe('+ Raise of-interest flag');
  });
});
