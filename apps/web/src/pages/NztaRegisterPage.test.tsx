import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NztaRegisterContent } from './NztaRegisterPage';

const { rpc, from, auth } = vi.hoisted(() => {
  const query = { select: () => query, eq: () => query, order: () => query, limit: () => Promise.resolve({ data: [], error: null }) };
  return {
    rpc: vi.fn(),
    from: vi.fn(() => query),
    auth: { operatingOrganizationId: 'org' as string | null, profile: { id: 'admin-1', role: 'admin' } },
  };
});
vi.mock('../lib/supabase', () => ({ supabase: { rpc, from } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));

const historical = {
  entry_kind: 'historical_check', entry_id: 'check-1', looked_up_at: '2026-10-01T01:00:00Z', plate_number: 'ABC123', vin: null,
  motochek_user: null, purpose: null, explanation: null, place_name: null, notice_number: null, outcome: null,
  outcome_notes: null, recorded_by_name: 'Import', can_edit: false,
};

describe('NZTA register page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.operatingOrganizationId = 'org';
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_nzta_register_lookups') return { data: [historical], error: null };
      return { data: [], error: null };
    });
  });
  afterEach(cleanup);

  it('asks for an operating organisation before loading anything', () => {
    auth.operatingOrganizationId = null;
    render(<NztaRegisterContent />);
    expect(screen.getByText(/Choose an operating organisation/)).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('lists historical checks without a purpose and flags them', async () => {
    render(<NztaRegisterContent />);
    expect(await screen.findByText('ABC123')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('1 historical NZTA check in this period has no recorded purpose');
    expect(rpc).toHaveBeenCalledWith('list_nzta_register_lookups', expect.objectContaining({ p_organization_id: 'org', p_limit: 2001 }));
  });

  it('validates a lookup before recording it', async () => {
    render(<NztaRegisterContent />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record a lookup' }));
    fireEvent.submit(screen.getByRole('form', { name: 'Record a Motochek lookup' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Enter the plate or the VIN');
    expect(alert.textContent).toContain('Choose the Gazette purpose.');
    expect(rpc.mock.calls.some(([name]) => name === 'record_nzta_register_lookup')).toBe(false);
  });

  it('shows a load failure without inventing rows', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    render(<NztaRegisterContent />);
    await waitFor(() => expect(screen.getByText(/lookup register could not be loaded|boom/i)).toBeTruthy());
    expect(screen.queryByText('ABC123')).toBeNull();
  });

  it('switches tabs and loads each section from its own RPC', async () => {
    render(<NztaRegisterContent />);
    fireEvent.click(screen.getByRole('tab', { name: /Quarterly reviews/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('list_nzta_access_reviews', { p_organization_id: 'org' }));
    fireEvent.click(screen.getByRole('tab', { name: /Access log/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('list_nzta_register_access_log', expect.objectContaining({ p_organization_id: 'org' })));
    expect(screen.getByRole('tab', { name: /Access log/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('lets an administrator record training for staff who do not hold access yet', async () => {
    const readiness = {
      training_current: false, training_expires_on: null, training_completed_on: null,
      confidentiality_current: false, confidentiality_expires_on: null, confidentiality_completed_on: null,
      direct: false, via_preset: false, granted_at: null, home_organization: true,
    };
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_nzta_access_holders') {
        return { data: [
          { ...readiness, user_id: 'admin-2', display_name: 'Ana Admin', role: 'admin', via_role: true, holds_access: true },
          { ...readiness, user_id: 'officer-1', display_name: 'Oli Officer', role: 'field_officer', via_role: false, holds_access: false },
        ], error: null };
      }
      return { data: [], error: null };
    });
    render(<NztaRegisterContent />);
    fireEvent.click(screen.getByRole('tab', { name: /People & training/ }));
    expect(await screen.findByText('Ana Admin')).toBeTruthy();
    expect(screen.queryByText('Oli Officer')).toBeNull();
    expect(screen.getByRole('note').textContent).toContain('1 of 1 authorised person is not NZTA-ready');
    fireEvent.change(screen.getByLabelText(/Show/), { target: { value: 'without_access' } });
    expect(await screen.findByText('Oli Officer')).toBeTruthy();
    expect(screen.getByText('No access yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Record training for Oli Officer' }));
    fireEvent.submit(screen.getByRole('form', { name: /Record NZTA register training/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('record_nzta_access_attestation', expect.objectContaining({
      p_user_id: 'officer-1', p_attestation_type: 'training', p_organization_id: 'org',
    })));
  });

  it('flags a capped lookup list and blocks the export', async () => {
    const rows = Array.from({ length: 2001 }, (_, index) => ({ ...historical, entry_id: `check-${index}` }));
    rpc.mockImplementation(async (name: string) => (name === 'list_nzta_register_lookups' ? { data: rows, error: null } : { data: [], error: null }));
    render(<NztaRegisterContent />);
    expect(await screen.findByText(/More than 2,000 entries fall in this period/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Export CSV/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/2,000 of 2,000 entries shown/)).toBeTruthy();
  });

  it('links a historical check to a recorded lookup for the same plate', async () => {
    const lookup = { ...historical, entry_kind: 'lookup', entry_id: 'lookup-1', plate_number: 'abc-123', purpose: 'parking_enforcement',
      explanation: 'Seen in bay 4', motochek_user: 'MC01', outcome: 'pending', can_edit: true, vehicle_identity_check_id: null };
    rpc.mockImplementation(async (name: string) => (name === 'list_nzta_register_lookups'
      ? { data: [historical, lookup], error: null } : { data: [], error: null }));
    render(<NztaRegisterContent />);
    fireEvent.click(await screen.findByRole('button', { name: /Link the check for ABC123 to its recorded lookup/ }));
    fireEvent.change(screen.getByLabelText('Recorded lookup'), { target: { value: 'lookup-1' } });
    fireEvent.change(screen.getByLabelText('Reason for linking'), { target: { value: 'Same Motochek search on 1 Oct' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('link_nzta_register_lookup_check', {
      p_lookup_id: 'lookup-1', p_check_id: 'check-1', p_reason: 'Same Motochek search on 1 Oct',
    }));
  });

  it('only prints or exports a summary for the period on screen', async () => {
    const summary = {
      period: { from: '2000-01-01', to: '2000-12-31' },
      lookups: { total: 0, by_purpose: {}, by_outcome: {}, historical_checks_without_purpose: 0 },
      reveals: { total: 0, by_purpose: {}, without_current_training: 0 },
      holders: { total: 0, training_current: 0, confidentiality_current: 0 },
      reviews: { in_period: 0 }, signage: [],
      retention: {},
    };
    rpc.mockImplementation(async (name: string) => (name === 'get_nzta_s241_summary' ? { data: summary, error: null } : { data: [], error: null }));
    render(<NztaRegisterContent />);
    fireEvent.click(screen.getByRole('tab', { name: /Annual summary/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_nzta_s241_summary', expect.objectContaining({ p_organization_id: 'org' })));
    await waitFor(() => expect(screen.getByRole('button', { name: /Print/ }).hasAttribute('disabled')).toBe(true));
    expect(screen.getByRole('button', { name: /Export CSV/ }).hasAttribute('disabled')).toBe(true);
  });
});
