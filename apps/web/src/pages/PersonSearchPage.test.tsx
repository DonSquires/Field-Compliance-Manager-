import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PersonSearchPage from './PersonSearchPage';
import { describeDaysRemaining, noticeStillBarsEntry, noticeTypeLabel, personSearchQueryIsValid } from '../lib/personSearch';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../components/SafetyWarningsPanel', () => ({ SafetyWarningsPanel: ({ entityId }: { entityId: string }) => <div data-testid="safety">{entityId}</div> }));

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
  vehicles: [{ canonical_vehicle_id: 'vehicle-1', plate_number: 'ABC123', make: 'Toyota', model: 'Hilux', colour: 'White', relationship: 'registered_owner', since: null }],
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
    render(<PersonSearchPage />);
    expect(await screen.findByText('Expiring soon')).toBeTruthy();
    expect(screen.getByText(/6 days left/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Test Person' }));
    expect(await screen.findByRole('heading', { name: 'Test Person' })).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('search_people', { p_query: 'Test Person', p_limit: 25 });
    expect(screen.getByTestId('safety').textContent).toBe('person-1');
    expect(screen.getByText('ABC123')).toBeTruthy();
    expect(screen.queryByText(/NZTA register details/)).toBeNull();
  });

  it('only shows NZTA details to authorised users and validates short queries', async () => {
    rpc.mockImplementation(async (name: string) => name === 'get_notice_expiry_register'
      ? { data: [], error: null }
      : { data: [person({ nzta_authorised: true, nzta: { address: '1 Example Road', last_checked_at: '2026-01-02T00:00:00Z', checks: [] } })], error: null });
    render(<PersonSearchPage />);
    fireEvent.change(screen.getByLabelText('Name search'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Enter at least two letters or numbers of a name.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name search'), { target: { value: 'test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('NZTA register details (restricted)')).toBeTruthy();
    expect(screen.getByText(/1 Example Road/)).toBeTruthy();
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
});
