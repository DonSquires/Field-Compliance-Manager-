import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ fetch: vi.fn(), fetchSafety: vi.fn(), rpc: vi.fn() }));
vi.mock('../context/ServiceRelationshipContext', () => ({ useServiceRelationships: () => ({ selectedAgreementZones: [] }) }));
vi.mock('../hooks/useActiveModuleContext', () => ({ useActiveModuleContext: () => ({ governingJurisdictionName: null }) }));
vi.mock('../lib/officerStaticBriefing', () => ({ fetchOfficerStaticBriefing: mocked.fetch, fetchStaticShiftSafety: mocked.fetchSafety }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mocked.rpc } }));
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = () => render(<MemoryRouter initialEntries={['/officer/site_guard?shift=chosen']}><OfficerStaticGuardPage /></MemoryRouter>);

function stopSafety(hash = 'version-1') {
  return {
    shift_id: 'chosen', stop_id: 'stop', shift_status: 'in_progress',
    places: [{ kind: 'site', id: 'place', location_id: 'location', name: 'Synthetic Hospital' }],
    hazards: [{ id: 'hazard', title: 'Slippery entrance', hazard_class: 'slips_trips_falls', risk_level: 'medium', controls: ['Use the handrail'], details: null, status: 'active', origin: 'manual', version: 1, place_name: 'Synthetic Hospital', place_kind: 'site', source_name: null, source_locator: null, source_as_of: null, has_source_document: false, recorded_by: 'Your organisation', updated_at: '2026-11-06T00:00:00Z' }],
    warnings: [], item_count: 1, briefing_hash: hash, acknowledgement_required: true,
    acknowledged: false, acknowledged_at: null, changed_since_acknowledgement: false, is_assigned_officer: true,
  };
}

function allowLocation() {
  vi.stubGlobal('navigator', {
    geolocation: { getCurrentPosition: (success: (position: { coords: { latitude: number; longitude: number; accuracy: number } }) => void) => success({ coords: { latitude: -41, longitude: 173, accuracy: 5 } }) },
  });
}

const arrivalReceipt = { reference: 'SG-12345678', action: 'arrive', occurred_at: '2026-11-06T00:00:00Z', gps_result: 'verified_boundary', timing_status: 'on_time', dwell_minutes: null, handover_recorded: false };

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
  expect(screen.getByRole('link', { name: 'Start shift from schedule' }).getAttribute('href')).toBe('/officer/schedule?shift=chosen');
  expect((screen.getByRole('button', { name: 'Confirm arrival' }) as HTMLButtonElement).disabled).toBe(true);
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
  expect((await screen.findByRole('link', { name: 'Record incident or report' })).getAttribute('href')).toBe('/officer/report?shift=chosen');
  expect(screen.getByRole('link', { name: 'Breaks or end shift' }).getAttribute('href')).toBe('/officer/schedule?shift=chosen');
  expect((screen.getByRole('button', { name: 'Confirm arrival' }) as HTMLButtonElement).disabled).toBe(false);
});

it('makes unverified boundaries and withheld briefings explicit and blocks attendance', async () => {
  const next = data('in_progress'); next.post.place.boundary_verified = false; next.privacy.status = 'unavailable';
  next.post.place.site_brief = ''; next.post.shift.notes = ''; next.post.place.access_instructions = ''; next.post.place.hs_notes = ''; next.roster_notes = '';
  mocked.fetch.mockResolvedValue(next); open();
  await screen.findByText(/Operations must verify this site boundary/);
  expect(screen.getByText(/Some briefing content is withheld/)).toBeTruthy();
  expect(screen.getAllByText(/Unavailable or withheld pending private review/)).toHaveLength(5);
  expect(screen.queryByText('No specific safety notes supplied.')).toBeNull();
  expect((screen.getByRole('button', { name: 'Confirm arrival' }) as HTMLButtonElement).disabled).toBe(true);
});

it('requires a private stop-specific safety acknowledgement before arrival', async () => {
  allowLocation();
  mocked.fetch.mockResolvedValue(data('in_progress'));
  mocked.fetchSafety.mockResolvedValue(stopSafety());
  mocked.rpc.mockImplementation(async (name: string) => {
    if (name === 'acknowledge_safety_briefing') return { data: { acknowledged_at: '2026-11-06T00:00:00Z', briefing_hash: 'version-1' }, error: null };
    if (name === 'manage_officer_static_post') return { data: arrivalReceipt, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm arrival' }));
  const dialog = await screen.findByRole('dialog', { name: 'Risks at this post' });
  expect(dialog.textContent).toContain('Slippery entrance');
  expect(mocked.fetchSafety).toHaveBeenCalledWith('chosen', 'stop');
  expect(mocked.rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /I've read these risks/ }));
  await waitFor(() => expect(mocked.rpc).toHaveBeenCalledWith('manage_officer_static_post', expect.objectContaining({ p_stop_id: 'stop', p_action: 'arrive' })));
  expect(mocked.rpc).toHaveBeenCalledWith('acknowledge_safety_briefing', expect.objectContaining({ p_shift_id: 'chosen', p_stop_id: 'stop', p_briefing_hash: 'version-1' }));
  await screen.findByText('Arrival recorded');
});

it('reloads a changed stop briefing privately and requires confirmation again', async () => {
  allowLocation();
  mocked.fetch.mockResolvedValue(data('in_progress'));
  mocked.fetchSafety.mockResolvedValueOnce(stopSafety()).mockResolvedValueOnce(stopSafety('version-2'));
  mocked.rpc.mockImplementation(async (name: string, args: { p_briefing_hash?: string }) => {
    if (name === 'acknowledge_safety_briefing' && args.p_briefing_hash === 'version-1') return { data: null, error: { hint: 'briefing_changed', message: 'Briefing changed' } };
    if (name === 'acknowledge_safety_briefing') return { data: { acknowledged_at: '2026-11-06T00:00:00Z', briefing_hash: 'version-2' }, error: null };
    if (name === 'manage_officer_static_post') return { data: arrivalReceipt, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm arrival' }));
  await screen.findByRole('dialog', { name: 'Risks at this post' });
  fireEvent.click(screen.getByRole('button', { name: /I've read these risks/ }));
  await screen.findByText(/updated while you were reading/);
  expect(mocked.fetchSafety).toHaveBeenCalledTimes(2);
  expect(mocked.fetchSafety).toHaveBeenLastCalledWith('chosen', 'stop');
  expect(mocked.rpc.mock.calls.some(([name]) => name === 'manage_officer_static_post')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /I've read these risks/ }));
  await waitFor(() => expect(mocked.rpc).toHaveBeenCalledWith('manage_officer_static_post', expect.objectContaining({ p_stop_id: 'stop' })));
});

it('blocks arrival when the private stop briefing is unavailable', async () => {
  mocked.fetch.mockResolvedValue(data('in_progress'));
  mocked.fetchSafety.mockRejectedValue(new Error('Private stop briefing unavailable. Contact operations.'));
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm arrival' }));
  await screen.findByText('Private stop briefing unavailable. Contact operations.');
  expect(mocked.rpc).not.toHaveBeenCalled();
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
  await screen.findByText('The selected shift could not be confirmed. Refresh or contact operations.');
  expect(screen.queryByText('Synthetic Hospital')).toBeNull();
});
