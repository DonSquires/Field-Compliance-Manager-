import { beforeEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('./supabase', () => ({ supabase: { functions: { invoke } } }));
import { fetchOfficerStaticBriefing, fetchStaticShiftSafety, isStaticGuardingService } from './officerStaticBriefing';

const safety = { shift_id: 'chosen', stop_id: null, shift_status: 'accepted', places: [], hazards: [], warnings: [], item_count: 0, briefing_hash: 'hash', acknowledgement_required: false, acknowledged: false, acknowledged_at: null, changed_since_acknowledgement: false, is_assigned_officer: true };
const briefing = () => ({ post: { shift: { id: 'chosen' } }, safety, privacy: { status: 'checked' }, requirements: ['Induction'], roster_notes: null, work_unit_name: null, contacts: [{ id: 'contact', name: 'Authorised Contact', role: null, phone: '+64000000000', kind: 'Client primary contact' }] });
beforeEach(() => { invoke.mockReset(); invoke.mockResolvedValue({ data: briefing(), error: null }); });

it.each(['static_guarding', 'site_guard', 'static', ' STATIC_GUARDING '])('treats %s as a private static assignment', (serviceType) => {
  expect(isStaticGuardingService(serviceType)).toBe(true);
});

it('does not classify a patrol or a missing type as a static assignment', () => {
  expect(isStaticGuardingService('patrol')).toBe(false);
  expect(isStaticGuardingService(null)).toBe(false);
});

it('requests the selected assignment and preserves authorised structured contact names', async () => {
  const result = await fetchOfficerStaticBriefing('chosen');
  expect(invoke).toHaveBeenCalledWith('officer-shift-briefing', { body: { shift_id: 'chosen' } });
  expect(result.contacts[0].name).toBe('Authorised Contact');
  expect(await fetchStaticShiftSafety('chosen')).toEqual(safety);
});

it.each(['unavailable', 'partly_withheld'])('blocks start when private review is %s', async (status) => {
  invoke.mockResolvedValue({ data: { ...briefing(), privacy: { status }, safety: null }, error: null });
  await expect(fetchStaticShiftSafety('chosen')).rejects.toThrow(/withheld/);
});

it('rejects mismatched safety context and never calls the raw safety RPC', async () => {
  invoke.mockResolvedValue({ data: { ...briefing(), safety: { ...safety, shift_id: 'other' } }, error: null });
  await expect(fetchStaticShiftSafety('chosen')).rejects.toThrow(/safety briefing/);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('requests and validates the exact stop safety context', async () => {
  invoke.mockResolvedValue({ data: { ...briefing(), safety: { ...safety, stop_id: 'stop' } }, error: null });
  expect((await fetchStaticShiftSafety('chosen', 'stop')).stop_id).toBe('stop');
  expect(invoke).toHaveBeenCalledWith('officer-shift-briefing', { body: { shift_id: 'chosen', stop_id: 'stop' } });
  await expect(fetchStaticShiftSafety('chosen', 'other')).rejects.toThrow(/safety briefing/);
  invoke.mockResolvedValue({ data: { ...briefing(), safety: { ...safety, stop_id: 'stop', is_assigned_officer: false } }, error: null });
  await expect(fetchStaticShiftSafety('chosen', 'stop')).rejects.toThrow(/assigned officer/);
});

it('surfaces endpoint failures and malformed contacts instead of returning a clean briefing', async () => {
  invoke.mockResolvedValue({ data: null, error: { message: 'Unavailable' } });
  await expect(fetchOfficerStaticBriefing('chosen')).rejects.toThrow('Unavailable');
  invoke.mockResolvedValue({ data: { ...briefing(), contacts: [null] }, error: null });
  await expect(fetchOfficerStaticBriefing('chosen')).rejects.toThrow(/incomplete/);
});
