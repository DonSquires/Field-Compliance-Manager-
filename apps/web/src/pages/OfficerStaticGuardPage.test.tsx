import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ fetch: vi.fn(), rpc: vi.fn() }));
vi.mock('../context/ServiceRelationshipContext', () => ({ useServiceRelationships: () => ({ selectedAgreementZones: [] }) }));
vi.mock('../hooks/useActiveModuleContext', () => ({ useActiveModuleContext: () => ({ governingJurisdictionName: null }) }));
vi.mock('../lib/officerStaticBriefing', () => ({ fetchOfficerStaticBriefing: mocked.fetch }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mocked.rpc } }));
vi.mock('../components/OfficerShiftBreakControl', () => ({ OfficerShiftBreakControl: () => null }));
vi.mock('../components/EndShiftDialog', () => ({ EndShiftDialog: () => <div role="dialog" aria-label="End shift" /> }));
import OfficerStaticGuardPage from './OfficerStaticGuardPage';

function data(status = 'accepted') {
  return {
    post: {
      shift: { id: 'chosen', status, scheduled_start: '2026-11-06T17:00:00Z', scheduled_end: '2026-11-07T05:00:00Z', notes: 'Check the badge.' },
      stop: { id: 'stop', status: 'pending', sla_arrive_by: '2026-11-06T17:00:00Z', actual_arrived_at: null, actual_departed_at: null, officer_notes: null },
      module: { id: 'module', status: 'pending', started_at: null, completed_at: null },
      place: { id: 'place', name: 'Synthetic Hospital', address: '1 Test Street', gps_lat: -41, gps_lng: 173, boundary_verified: true, risk_level: 'high', site_brief: 'Check the exit.', access_instructions: 'Use reception.', hs_notes: 'Check radio.' },
      attendance_evidence: { arrival: null, departure: null },
    },
    safety: null, privacy: { status: 'checked' }, requirements: ['Hospital induction'], roster_notes: 'Cover reception.', work_unit_name: 'Hospital post',
    contacts: [{ id: 'contact', name: 'Authorised Contact', role: 'Duty manager', phone: '+64000000000', kind: 'Shift contact' }],
  };
}
beforeEach(() => { vi.resetAllMocks(); mocked.fetch.mockResolvedValue(data()); });
afterEach(() => { cleanup(); });
const open = () => render(<MemoryRouter initialEntries={['/officer/site_guard?shift=chosen']}><OfficerStaticGuardPage /></MemoryRouter>);

it('shows exact shift details, navigation, contact and requirements before start without starting work', async () => {
  open();
  await screen.findByText('Synthetic Hospital');
  expect(mocked.fetch).toHaveBeenCalledWith('chosen');
  expect(screen.getByText('Hospital induction')).toBeTruthy();
  expect(screen.getByText('Authorised Contact')).toBeTruthy();
  expect(screen.getByText('Check the exit.')).toBeTruthy();
  expect(screen.getByText('Check the badge.')).toBeTruthy();
  expect(screen.getByText('Cover reception.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Navigate to site' }).getAttribute('target')).toBe('_blank');
  expect(screen.getByRole('button', { name: 'Open this shift in my schedule' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'End shift and debrief' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm arrival' })).toBeNull();
  expect(mocked.rpc).not.toHaveBeenCalled();
});

it('distinguishes unconfirmed roster requirements from an empty list', async () => {
  mocked.fetch.mockResolvedValue({ ...data(), requirements: null, roster_notes: null, work_unit_name: null });
  open();
  expect(await screen.findByText('Roster requirements could not be confirmed. Contact operations.')).toBeTruthy();
  expect(screen.getByText('Roster instructions could not be confirmed. Contact operations.')).toBeTruthy();
  expect(screen.queryByText('No additional skill requirements are recorded.')).toBeNull();
});

it('shows only the designated shift contact and safely dials extensions', async () => {
  const next = data();
  next.contacts[0].phone = '+64 (0)3 555 1234 ext. 21';
  mocked.fetch.mockResolvedValue(next);
  open();
  const phone = await screen.findByRole('link', { name: '+64 (0)3 555 1234 ext. 21' });
  expect(phone.getAttribute('href')).toBe('tel:+6435551234;ext=21');
});

it('explains when no contact was designated, without inventing account contacts', async () => {
  const next = data();
  next.contacts = [];
  mocked.fetch.mockResolvedValue(next);
  open();
  expect(await screen.findByText('No contact is designated for this shift. Ask operations if you need one.')).toBeTruthy();
  expect(screen.queryByText('Authorised Contact')).toBeNull();
});

it('shows an unrecognised contact phone without creating an unsafe dial link', async () => {
  const next = data();
  next.contacts[0].phone = 'not-a-phone';
  mocked.fetch.mockResolvedValue(next);
  open();
  expect(await screen.findByText(/number format not recognised/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: /not-a-phone/ })).toBeNull();
});

it('does not describe an unconfirmed selected shift as an empty assignment', async () => {
  mocked.fetch.mockResolvedValue({ post: null, safety: null, privacy: { status: 'unavailable' }, requirements: [], contacts: [] });
  open();
  await screen.findByText('The selected shift could not be confirmed. Refresh or contact operations.');
  expect(screen.queryByText('No active static post')).toBeNull();
});

it('offers in-shift reporting and end flow with the same shift context', async () => {
  mocked.fetch.mockResolvedValue(data('in_progress')); open();
  expect(await screen.findByRole('button', { name: 'Report an observation or incident' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'End shift and debrief' }));
  expect(await screen.findByRole('dialog', { name: 'End shift' })).toBeTruthy();
  expect(mocked.rpc).not.toHaveBeenCalled();
});

it('makes withheld briefings explicit instead of describing them as empty', async () => {
  const next = data('in_progress'); next.privacy.status = 'unavailable';
  next.post.place.site_brief = ''; next.post.shift.notes = ''; next.post.place.access_instructions = ''; next.post.place.hs_notes = ''; next.roster_notes = '';
  mocked.fetch.mockResolvedValue(next); open();
  await screen.findByText(/Some briefing content is withheld/);
  expect(screen.getAllByText(/Unavailable or withheld pending private review/)).toHaveLength(5);
  expect(screen.queryByText('No specific safety notes supplied.')).toBeNull();
  expect(screen.getByText(/Safety details are withheld pending private review/)).toBeTruthy();
});

it('rejects a response for a different assignment', async () => {
  const next = data(); next.post.shift.id = 'other';
  mocked.fetch.mockResolvedValue(next); open();
  await screen.findByText('The selected shift could not be confirmed. Refresh or contact operations.');
  expect(screen.queryByText('Synthetic Hospital')).toBeNull();
});
