import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ fetch: vi.fn(), rpc: vi.fn() }));
vi.mock('../context/ServiceRelationshipContext', () => ({ useServiceRelationships: () => ({ selectedAgreementZones: [] }) }));
vi.mock('../hooks/useActiveModuleContext', () => ({ useActiveModuleContext: () => ({ governingJurisdictionName: null }) }));
vi.mock('../lib/officerStaticBriefing', () => ({ fetchOfficerStaticBriefing: mocked.fetch }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mocked.rpc } }));
import OfficerStaticGuardPage from './OfficerStaticGuardPage';

function data(status = 'accepted') {
  return {
    post: {
      shift: { id: 'chosen', status, scheduled_start: '2026-11-06T17:00:00Z', scheduled_end: '2026-11-07T05:00:00Z', notes: null },
      stop: { id: 'stop', status: 'pending', sla_arrive_by: '2026-11-06T17:00:00Z', actual_arrived_at: null, actual_departed_at: null, officer_notes: null },
      module: { id: 'module', status: 'pending', started_at: null, completed_at: null },
      place: { id: 'place', name: 'Synthetic Hospital', address: '1 Test Street', gps_lat: -41, gps_lng: 173, boundary_verified: true, risk_level: 'high', site_brief: 'Check the exit.', access_instructions: 'Use reception.', hs_notes: 'Check radio.' },
      attendance_evidence: { arrival: null, departure: null },
    },
    safety: null, privacy: { status: 'checked' }, requirements: ['Hospital induction'],
    contacts: [{ id: 'contact', name: 'Authorised Contact', role: 'Duty manager', phone: '+64000000000', kind: 'Client primary contact' }],
  };
}
beforeEach(() => { vi.clearAllMocks(); mocked.fetch.mockResolvedValue(data()); });
afterEach(cleanup);
const open = () => render(<MemoryRouter initialEntries={['/officer/site_guard?shift=chosen']}><OfficerStaticGuardPage /></MemoryRouter>);

it('shows exact shift details, navigation, contact and requirements before start without starting work', async () => {
  open();
  await screen.findByText('Synthetic Hospital');
  expect(mocked.fetch).toHaveBeenCalledWith('chosen');
  expect(screen.getByText('Hospital induction')).toBeTruthy();
  expect(screen.getByText('Authorised Contact')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Navigate to site' }).getAttribute('target')).toBe('_blank');
  expect(screen.getByRole('link', { name: 'Start shift from schedule' }).getAttribute('href')).toBe('/officer/schedule?shift=chosen');
  expect((screen.getByRole('button', { name: 'Confirm arrival' }) as HTMLButtonElement).disabled).toBe(true);
  expect(mocked.rpc).not.toHaveBeenCalled();
});

it('offers in-shift reporting and end flow with the same shift context', async () => {
  mocked.fetch.mockResolvedValue(data('in_progress')); open();
  expect((await screen.findByRole('link', { name: 'Record incident or report' })).getAttribute('href')).toBe('/officer/report?shift=chosen');
  expect(screen.getByRole('link', { name: 'Breaks or end shift' }).getAttribute('href')).toBe('/officer/schedule?shift=chosen');
  expect((screen.getByRole('button', { name: 'Confirm arrival' }) as HTMLButtonElement).disabled).toBe(false);
});

it('makes unverified boundaries and withheld briefings explicit and blocks attendance', async () => {
  const next = data('in_progress'); next.post.place.boundary_verified = false; next.privacy.status = 'unavailable'; next.post.place.site_brief = '';
  mocked.fetch.mockResolvedValue(next); open();
  await screen.findByText(/Operations must verify this site boundary/);
  expect(screen.getByText(/Some briefing content is withheld/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Confirm arrival' }) as HTMLButtonElement).disabled).toBe(true);
});

it('preserves unsaved handover text across a briefing refresh', async () => {
  const next = data('in_progress'); next.post.stop.status = 'on_scene';
  mocked.fetch.mockResolvedValue(next); open();
  const notes = await screen.findByRole('textbox', { name: 'Departure handover notes' });
  fireEvent.change(notes, { target: { value: 'Exit checked; keys handed over.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh static post' }));
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Departure handover notes' }) as HTMLTextAreaElement).value).toBe('Exit checked; keys handed over.'));
});

it('rejects a response for a different assignment', async () => {
  const next = data(); next.post.shift.id = 'other';
  mocked.fetch.mockResolvedValue(next); open();
  await screen.findByText('The selected shift could not be confirmed.');
  expect(screen.queryByText('Synthetic Hospital')).toBeNull();
});
