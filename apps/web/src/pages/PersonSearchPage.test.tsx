import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, type InitialEntry } from 'react-router-dom';
import PersonSearchPage from './PersonSearchPage';
import { describeDaysRemaining, noticeStillBarsEntry, noticeTypeLabel, personSearchQueryIsValid } from '../lib/personSearch';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../components/SafetyWarningsPanel', () => ({ SafetyWarningsPanel: ({ entityId }: { entityId: string }) => <div data-testid="safety">{entityId}</div> }));

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
};

const renderPage = (entry: InitialEntry = '/admin/field-ops?area=person-search') => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes><Route path="*" element={<><PersonSearchPage /><LocationProbe /></>} /></Routes>
  </MemoryRouter>,
);

const person = (overrides: Record<string, unknown> = {}) => ({
  canonical_person_id: 'person-1',
  display_name: 'Test Person',
  review_state: 'verified',
  homeless_status: null,
  has_notice_in_force: true,
  aliases: [],
  organizations: ['Client Forest'],
  notices: [{
    notice_id: 'notice-1', organization_id: 'org', organization_name: 'Client Forest', notice_type: 'trespass',
    notice_number: 'T-1', status: 'issued', issued_at: '2025-11-01T00:00:00Z', expires_at: '2027-11-01T00:00:00Z',
    expiry_state: 'in_force', location_name: 'North Block',
  }],
  vehicles: [{
    canonical_vehicle_id: 'vehicle-1', plate_number: 'ABC123', make: 'Toyota', model: 'Hilux', colour: 'White',
    relationship: 'observed_with', since: null, source: null, source_checked_at: null,
  }],
  nzta_authorised: false,
  nzta: null,
  ...overrides,
});

describe('person search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_notice_expiry_register') return { data: [{
        notice_id: 'notice-2', organization_id: 'org', organization_name: 'Client Forest', notice_type: 'warning', notice_number: null,
        issued_at: '2024-11-01T00:00:00Z', expires_at: '2026-11-01T00:00:00Z', expiry_state: 'expiring_soon', days_remaining: 6,
        canonical_person_id: 'person-1', person_display_name: 'Test Person', location_name: null,
      }], error: null };
      return { data: [person()], error: null };
    });
  });
  afterEach(cleanup);

  it('shows the expiry register and opens the person behind an alert', async () => {
    renderPage();
    expect(await screen.findByText('Expiring soon')).toBeTruthy();
    expect(screen.getByText(/6 days left/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Test Person' }));
    expect(await screen.findByRole('heading', { name: 'Test Person' })).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('search_people', { p_query: 'Test Person', p_limit: 25 });
    expect(screen.getByTestId('safety').textContent).toBe('person-1');
    expect(screen.getByText('ABC123')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'NZTA register details' })).toBeNull();
    expect(screen.getByText(/NZTA register details are restricted/)).toBeTruthy();
  });

  it('only shows NZTA details to authorised users and validates short queries', async () => {
    rpc.mockImplementation(async (name: string) => name === 'get_notice_expiry_register'
      ? { data: [], error: null }
      : { data: [person({ nzta_authorised: true, nzta: { address: '1 Example Road', last_checked_at: '2026-01-02T00:00:00Z', checks: [] } })], error: null });
    renderPage();
    fireEvent.change(screen.getByLabelText('Name, alias or permit number'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Enter at least two letters or numbers of a name, alias or permit number.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name, alias or permit number'), { target: { value: 'test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('heading', { name: 'NZTA register details' })).toBeTruthy();
    expect(screen.getByText(/lawful purposes/)).toBeTruthy();
    expect(screen.getByText(/1 Example Road/)).toBeTruthy();
  });

  it('blocks register lookups while a person search is in flight', async () => {
    let completeSearch!: (value: { data: ReturnType<typeof person>[]; error: null }) => void;
    const pending = new Promise<{ data: ReturnType<typeof person>[]; error: null }>((resolve) => { completeSearch = resolve; });
    const defaultRpc = rpc.getMockImplementation();
    rpc.mockImplementation((name: string) => name === 'search_people' ? pending : defaultRpc?.(name));
    renderPage();
    const button = await screen.findByRole('button', { name: 'Test Person' });
    fireEvent.click(button);
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(rpc.mock.calls.filter(([name]) => name === 'search_people')).toHaveLength(1);
    await act(async () => { completeSearch({ data: [person()], error: null }); });
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('describes expiry consistently', () => {
    expect(noticeStillBarsEntry('expiring_soon')).toBe(true);
    expect(noticeStillBarsEntry('expired')).toBe(false);
    expect(describeDaysRemaining(-1)).toBe('expired 1 day ago');
    expect(describeDaysRemaining(0)).toBe('expires today');
    expect(personSearchQueryIsValid(' a ')).toBe(false);
  });

  it('labels imported letters as letters rather than notices', () => {
    expect(noticeTypeLabel('trespass')).toBe('Trespass notice');
    expect(noticeTypeLabel('permit_refusal')).toBe('Permit refusal letter');
    expect(noticeTypeLabel('contact_request')).toBe('Contact request letter');
  });

  it('filters matches and labels NZTA owner dates as observations, not transfer dates', async () => {
    rpc.mockImplementation(async (name: string) => name === 'get_notice_expiry_register'
      ? { data: [], error: null }
      : { data: [
        person({ vehicles: [{
          canonical_vehicle_id: 'vehicle-1', plate_number: 'ABC123', make: 'Toyota', model: 'Hilux',
          colour: 'White', relationship: 'registered_owner', since: '2025-01-01T00:00:00Z',
          source: 'nzta_mvr', source_checked_at: '2026-01-02T00:00:00Z',
        }] }),
        person({
          canonical_person_id: 'person-2',
          display_name: 'Second Person',
          notices: [],
          vehicles: [],
          has_notice_in_force: false,
        }),
      ], error: null });
    renderPage();
    fireEvent.change(screen.getByLabelText('Name, alias or permit number'), { target: { value: 'test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('button', { name: /Second Person/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Linked vehicle/ }));
    expect(screen.getByRole('button', { name: /Test Person/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Second Person/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Test Person/ }));
    expect(await screen.findByText(/NZTA observation 02 Jan 2026 \(not a legal transfer date\)/)).toBeTruthy();
  });

  it('keeps the last successful expiry queue visible after a refresh failure', async () => {
    const defaultRpc = rpc.getMockImplementation();
    let registerCalls = 0;
    rpc.mockImplementation(async (name: string, args?: unknown) => {
      if (name === 'get_notice_expiry_register') {
        registerCalls += 1;
        if (registerCalls > 1) return { data: null, error: { message: 'Unavailable' } };
      }
      return defaultRpc?.(name, args);
    });
    renderPage();
    expect(await screen.findByText('Expiring soon')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh queue' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Test Person')).toBeTruthy();
    expect(screen.getByText(/Showing the last successful results/)).toBeTruthy();
  });

  it('opens the exact person handed over from a vehicle owner card without the name in the URL', async () => {
    const defaultRpc = rpc.getMockImplementation();
    rpc.mockImplementation(async (name: string, args?: unknown) => name === 'search_people'
      ? { data: [person({ canonical_person_id: 'person-0', organizations: ['Other Client'] }), person()], error: null }
      : defaultRpc?.(name, args));
    renderPage({ pathname: '/admin/field-ops', search: '?area=person-search&person=person-1', state: { personQuery: 'Test Person' } });
    expect(await screen.findByText('Recorded in Client Forest')).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('search_people', { p_query: 'Test Person', p_limit: 25 });
    expect((screen.getByLabelText('Name, alias or permit number') as HTMLInputElement).value).toBe('Test Person');
    expect(screen.getByTestId('location').textContent).not.toContain('Test');
  });

  it('explains a person link that arrives without a name instead of guessing', async () => {
    renderPage('/admin/field-ops?area=person-search&person=person-1');
    expect(await screen.findByText(/the name was not passed with it/)).toBeTruthy();
    expect(rpc.mock.calls.some(([name]) => name === 'search_people')).toBe(false);
  });

  it('opens a linked vehicle in vehicle search by its canonical id', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Test Person' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open vehicle ABC123 in vehicle search' }));
    expect(screen.getByTestId('location').textContent).toBe('/admin/field-ops?area=vehicle-search&vehicle=vehicle-1');
  });

  it('finds a permit holder by permit number and shows the permit, its vehicles and validity', async () => {
    const permit = {
      permit_id: 'permit-1', organization_name: 'Field Services', client_organization_name: 'Client Forest',
      permit_number: '10001', permit_type: 'Recreational', applicant_type: 'Individual', company_name: null,
      status: 'active', validity_state: 'valid', date_from: '2025-07-01', date_to: '2099-06-30',
      forest_areas: ['North Block'], activities: ['Hunting', 'Walking'], hunting_season: 'Roar',
      firearm_licence_valid: false, chainsaw_safety_equipment: null, keys_issued: true,
      conditions: 'Stay on formed roads.', contact_email: 'holder@example.test', contact_phone: null,
      address_text: '1 Example Road', compliance_checked_at: '2025-11-17T21:32:59Z', source_document: 'Permit Extract.xlsx',
      vehicles: [{ canonical_vehicle_id: 'vehicle-9', plate_number: 'PRM123', make: 'Ford', model: 'Ranger', colour: 'Grey' }],
    };
    rpc.mockImplementation(async (name: string) => name === 'get_notice_expiry_register'
      ? { data: [], error: null }
      : { data: [
        person({ canonical_person_id: 'person-3', display_name: 'Pat Holder', notices: [], vehicles: [], has_notice_in_force: false, permits: [permit] }),
        person({ canonical_person_id: 'person-4', display_name: 'Older Server Row', notices: [], vehicles: [], has_notice_in_force: false }),
      ], error: null });
    renderPage();
    fireEvent.change(screen.getByLabelText('Name, alias or permit number'), { target: { value: '10001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const holder = await screen.findByRole('button', { name: /Pat Holder/ });
    expect(holder.textContent).toContain('Current permit');
    expect(holder.textContent).toContain('1 permit');
    expect(rpc).toHaveBeenCalledWith('search_people', { p_query: '10001', p_limit: 25 });

    fireEvent.click(screen.getByRole('button', { name: /^Permit holder/ }));
    expect(screen.queryByRole('button', { name: /Older Server Row/ })).toBeNull();
    fireEvent.click(holder);
    const card = await screen.findByRole('article', { name: 'Permit 10001' });
    expect(within(card).getByText('Valid')).toBeTruthy();
    expect(card.textContent).toContain('Recreational');
    expect(card.textContent).toContain('for Client Forest');
    expect(card.textContent).toContain('No valid firearms licence');
    expect(card.textContent).toContain('North Block');
    expect(card.textContent).toContain('Hunting, Walking');
    expect(card.textContent).toContain('Stay on formed roads.');
    expect(card.textContent).toContain('Captured on the application');
    expect(card.textContent).toContain('holder@example.test');
    expect(card.textContent).toContain('Source: Permit Extract.xlsx, checked 18 Nov 2025');
    expect(screen.queryByText(/No access permits are recorded/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open vehicle PRM123' }));
    expect(screen.getByTestId('location').textContent).toBe('/admin/field-ops?area=vehicle-search&vehicle=vehicle-9');
  });

  it('treats a search response without permits as having none', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Test Person' }));
    expect(await screen.findByText('No access permits are recorded in your authorised organisations.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Permit holder/ }).hasAttribute('disabled')).toBe(true);
  });
});
