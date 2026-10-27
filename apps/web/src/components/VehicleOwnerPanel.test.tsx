import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { VehicleOwnerPanel, type VehiclePersonLink } from './VehicleOwnerPanel';

const { rpc, auth } = vi.hoisted(() => ({
  rpc: vi.fn(),
  auth: { profile: { id: 'user-1', role: 'admin' as string | undefined, organizationId: 'org' } },
}));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));

const link = (overrides: Partial<VehiclePersonLink> = {}): VehiclePersonLink => ({
  link_id: 'link-1',
  relationship: 'registered_owner',
  active: true,
  source: 'nzta_mvr',
  basis: null,
  nzta_restricted: true,
  person_record_id: 'record-1',
  canonical_person_id: 'person-1',
  display_name: 'Test Owner',
  phone: null,
  email: null,
  address: null,
  locality: 'Example Town',
  observation_ids: [],
  details_visible: true,
  recorded_at: '2026-01-02T00:00:00Z',
  recorded_by_name: 'Import',
  ended_at: null,
  source_checked_at: '2026-01-02T00:00:00Z',
  ...overrides,
});

const LocationProbe = () => {
  const location = useLocation();
  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      <output data-testid="state">{JSON.stringify(location.state)}</output>
    </>
  );
};

const renderPanel = (links: VehiclePersonLink[]) => {
  rpc.mockImplementation(async (name: string) => {
    if (name === 'can_access_vehicle_owner_identity') return { data: true, error: null };
    if (name === 'get_vehicle_owner_links') return { data: links, error: null };
    if (name === 'can_search_people') return { data: false, error: null };
    return { data: [], error: null };
  });
  return render(
    <MemoryRouter initialEntries={['/admin/field-ops?area=vehicle-search']}>
      <Routes><Route path="*" element={<><VehicleOwnerPanel vehicleId="vehicle-1" organizationId="org" /><LocationProbe /></>} /></Routes>
    </MemoryRouter>,
  );
};

describe('vehicle owner panel person hand-off', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.profile.role = 'admin';
  });
  afterEach(cleanup);

  it('opens the owner in person search with the name in router state, not the URL', async () => {
    renderPanel([link()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open notices and person record for Test Owner' }));
    expect(screen.getByTestId('location').textContent).toBe('/admin/field-ops?area=person-search&person=person-1');
    expect(JSON.parse(screen.getByTestId('state').textContent ?? 'null')).toEqual({ personQuery: 'Test Owner' });
  });

  it('does not offer person search to roles that cannot open it', async () => {
    auth.profile.role = 'officer';
    renderPanel([link()]);
    expect(await screen.findByText('Test Owner')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Open notices and person record/ })).toBeNull();
  });

  it('does not offer person search from a redacted owner card', async () => {
    renderPanel([link({ details_visible: false, display_name: null, nzta_restricted: false })]);
    expect(await screen.findByText('Owner identified')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Open notices and person record/ })).toBeNull();
  });

  it('hides an NZTA registered person until a purpose-stated reveal', async () => {
    renderPanel([link({ details_visible: false, display_name: null })]);
    fireEvent.click(await screen.findByRole('button', { name: /Reveal with a stated purpose/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Open notices and person record/ })).toBeNull();
    expect(rpc.mock.calls.some(([name]) => name === 'reveal_nzta_registered_person')).toBe(false);
  });

  it('opens the officer person route only after explicit person authorization', async () => {
    auth.profile.role = 'officer';
    renderPanel([link()]);
    const original = rpc.getMockImplementation();
    rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'can_search_people'
      ? Promise.resolve({ data: true, error: null }) : original?.(name, ...args));
    fireEvent(window, new Event('focus'));
    fireEvent.click(await screen.findByRole('button', { name: 'Open notices and person record for Test Owner' }));
    expect(screen.getByTestId('location').textContent).toBe('/officer/person_search?person=person-1');
  });
});
