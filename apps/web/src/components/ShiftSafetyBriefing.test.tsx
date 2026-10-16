import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SafetyBriefing } from '../lib/safetyBriefing';

const { mockRpc, mockInvoke } = vi.hoisted(() => ({ mockRpc: vi.fn(), mockInvoke: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mockRpc, functions: { invoke: mockInvoke } } }));

import { OfficerSafetyBriefingBanner, SafetyBriefingDialog, SafetyBriefingList } from './ShiftSafetyBriefing';
import { briefingNeedsAcknowledgement, fetchShiftSafetyBriefing } from '../lib/safetyBriefing';

const hazard = (overrides: Partial<SafetyBriefing['hazards'][number]>): SafetyBriefing['hazards'][number] => ({
  id: 'h1', title: 'Aggressive visitors in waiting room', hazard_class: 'violence_or_aggression', risk_level: 'high', controls: ['Stay in pairs'],
  details: null, status: 'active', origin: 'bob_extracted', version: 1, place_name: 'Emergency Department', place_kind: 'site',
  source_name: 'ED security plan', source_locator: 'Section 4.2', source_as_of: '2026-09-01', has_source_document: true,
  recorded_by: 'Bob', updated_at: '2026-10-01T00:00:00Z', ...overrides,
});

const briefing = (overrides: Partial<SafetyBriefing> = {}): SafetyBriefing => ({
  shift_id: 's1', stop_id: null, shift_status: 'accepted',
  places: [{ kind: 'site', id: 'site1', location_id: 'loc1', name: 'Emergency Department' }],
  hazards: [hazard({}), hazard({ id: 'h2', title: 'Broken glass by loading dock', risk_level: 'critical', status: 'reported', origin: 'officer_reported', has_source_document: false, source_name: null, source_locator: null, source_as_of: null })],
  warnings: [], item_count: 2, briefing_hash: 'abc', acknowledgement_required: true, acknowledged: false,
  acknowledged_at: null, changed_since_acknowledgement: false, is_assigned_officer: true, ...overrides,
});

describe('ShiftSafetyBriefing', () => {
  beforeEach(() => { mockRpc.mockReset(); mockInvoke.mockReset(); });

  it('lists critical risks first, flags unreviewed officer reports and links the exact source section', () => {
    render(<SafetyBriefingList briefing={briefing()} />);
    const titles = screen.getAllByRole('article').map((node) => node.querySelector('strong')?.textContent);
    expect(titles).toEqual(['Broken glass by loading dock', 'Aggressive visitors in waiting room']);
    expect(screen.getByText('Reported — not yet reviewed')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open source — Section 4.2/ })).toBeTruthy();
    expect(screen.getAllByText('Stay in pairs').length).toBeGreaterThan(0);
  });

  it('only asks the assigned officer to acknowledge an unacknowledged briefing', () => {
    expect(briefingNeedsAcknowledgement(briefing())).toBe(true);
    expect(briefingNeedsAcknowledgement(briefing({ acknowledged: true }))).toBe(false);
    expect(briefingNeedsAcknowledgement(briefing({ is_assigned_officer: false }))).toBe(false);
    expect(briefingNeedsAcknowledgement(briefing({ acknowledgement_required: false, item_count: 0, hazards: [] }))).toBe(false);
  });

  it('acknowledges with the hash that was read, then continues', async () => {
    mockRpc.mockResolvedValue({ data: { acknowledged_at: '2026-10-18T09:00:00Z', briefing_hash: 'abc' }, error: null });
    const onAcknowledged = vi.fn();
    render(<SafetyBriefingDialog briefing={briefing()} acknowledgeLabel="I've read these risks – start shift" onAcknowledged={onAcknowledged} onClose={vi.fn()} onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /I've read these risks – start shift/ }));
    await waitFor(() => expect(onAcknowledged).toHaveBeenCalled());
    expect(mockRpc).toHaveBeenCalledWith('acknowledge_safety_briefing', expect.objectContaining({ p_shift_id: 's1', p_briefing_hash: 'abc' }));
  });

  it('reloads and asks again when the briefing changed while being read', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'The safety briefing changed', hint: 'briefing_changed' } });
    const next = briefing({ briefing_hash: 'def', hazards: [hazard({ title: 'New dog on site', hazard_class: 'dangerous_dog' })], item_count: 1 });
    const onReload = vi.fn().mockResolvedValue(next);
    const onAcknowledged = vi.fn();
    render(<SafetyBriefingDialog briefing={briefing()} acknowledgeLabel="Confirm" onAcknowledged={onAcknowledged} onClose={vi.fn()} onReload={onReload} />);
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await screen.findByText(/updated while you were reading/);
    expect(onReload).toHaveBeenCalled();
    expect(onAcknowledged).not.toHaveBeenCalled();
    expect(screen.getByText('New dog on site')).toBeTruthy();
  });

  it('does not acknowledge stale content when the changed briefing cannot be reloaded', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'The safety briefing changed', hint: 'briefing_changed' } });
    const onReload = vi.fn().mockResolvedValue(null);
    const onAcknowledged = vi.fn();
    render(<SafetyBriefingDialog briefing={briefing()} acknowledgeLabel="Confirm" onAcknowledged={onAcknowledged} onClose={vi.fn()} onReload={onReload} />);
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await screen.findByText(/updated safety briefing could not be loaded/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading briefing' }));
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(2));
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(onAcknowledged).not.toHaveBeenCalled();
  });

  it('shows a recoverable error instead of hiding an unavailable mid-shift briefing', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'Network unavailable' } });
    render(<OfficerSafetyBriefingBanner shift={{ id: 's1', status: 'in_progress' }} />);
    await screen.findByText(/Safety briefing unavailable: Network unavailable/);
    mockRpc.mockResolvedValueOnce({ data: briefing({ shift_status: 'in_progress' }), error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Retry safety briefing' }));
    await screen.findByRole('button', { name: 'Read now' });
  });

  it('never continues on a missing acknowledgement receipt', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const onAcknowledged = vi.fn();
    render(<SafetyBriefingDialog briefing={briefing()} acknowledgeLabel="Confirm" onAcknowledged={onAcknowledged} onClose={vi.fn()} onReload={vi.fn().mockResolvedValue(briefing())} />);
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await screen.findByText(/updated while you were reading/);
    expect(onAcknowledged).not.toHaveBeenCalled();
  });

  it('rejects incomplete briefings or a response for the wrong shift/stop', async () => {
    for (const data of [
      null, [], { ...briefing(), warnings: undefined }, briefing({ item_count: 0 }),
      briefing({ shift_id: 'another-shift' }), briefing({ stop_id: 'another-stop' }),
    ]) {
      mockRpc.mockResolvedValueOnce({ data, error: null });
      await expect(fetchShiftSafetyBriefing('s1')).rejects.toThrow('server did not return a safety briefing');
    }
  });
});
