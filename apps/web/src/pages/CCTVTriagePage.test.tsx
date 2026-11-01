import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CCTVTriagePage from './CCTVTriagePage';

const { from, rpc, channel } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), channel: vi.fn() }));
vi.mock('../lib/supabase', () => ({
  supabase: {
    from,
    rpc,
    channel,
    removeChannel: vi.fn(),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) },
  },
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { organizationId: 'org-1', id: 'user-1', role: 'admin' } }) }));

const row = (id: string, label: string, observedAt: string, reviewState = 'unreviewed') => ({
  id, evidence_item_id: `evidence-${id}`, source_event_id: `event-${id}`, cctv_import_id: 'import-1', entity_kind: 'person',
  observed_at: observedAt, observed_to: null, candidate_label: label, candidate_plate: null, animal_type: null, model_confidence: 0.93,
  species_confidence: null, is_pest: null, quality_state: 'clear', attributes: { frame_count: 3 }, thumbnail: null, review_state: reviewState,
  portfolio_key: null, portfolio_state: 'unmatched', portfolio_candidates: [], person_record_id: null, canonical_vehicle_id: null,
  person_records: null, reviewed_at: null, review_notes: null,
});
const first = row('obs-1', 'Person at north gate', '2026-08-30T09:15:00.000Z');
const second = row('obs-2', 'Person at south gate', '2026-08-30T09:20:00.000Z');

function mockTables() {
  from.mockImplementation((table: string) => {
    const result = { data: table === 'cctv_entity_observations' ? [first, second] : [], error: null };
    const query = {
      select: () => query, eq: () => query, neq: () => query, order: () => query, limit: () => query,
      then: (resolve: (value: unknown) => unknown) => resolve(result),
    };
    return query;
  });
}

describe('CCTV observation triage decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockTables();
    const subscription = { on: () => subscription, subscribe: () => subscription };
    channel.mockReturnValue(subscription);
    rpc.mockImplementation(async (name: string, args: { p_observation_id: string; p_action: string }) => {
      if (name === 'review_cctv_entity_observation') {
        const source = args.p_observation_id === first.id ? first : second;
        return { data: { ...source, review_state: args.p_action === 'reject' ? 'rejected' : 'accepted' }, error: null };
      }
      return { data: null, error: null };
    });
  });
  afterEach(cleanup);

  it('moves to the next pending sighting after a decision by default', async () => {
    render(<MemoryRouter><CCTVTriagePage /></MemoryRouter>);
    await screen.findByRole('heading', { name: /Person at north gate/ });
    fireEvent.click(screen.getByRole('button', { name: /^Accept$/ }));
    await screen.findByRole('heading', { name: /Person at south gate/ });
  });

  it('keeps the decided sighting open when moving on after a decision is switched off', async () => {
    window.localStorage.setItem('fcm.cctvTriage.advanceAfterDecision', 'off');
    render(<MemoryRouter><CCTVTriagePage /></MemoryRouter>);
    await screen.findByRole('heading', { name: /Person at north gate/ });
    fireEvent.click(screen.getByRole('button', { name: /^Accept$/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('review_cctv_entity_observation', expect.objectContaining({ p_observation_id: first.id, p_action: 'accept' })));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Accept$/ })).toBeNull());
    expect(screen.getByRole('heading', { name: /Person at north gate/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Person at south gate/ })).toBeNull();
  });

  it('decides once per keystroke and not at all when single-key shortcuts are off', async () => {
    render(<MemoryRouter><CCTVTriagePage /></MemoryRouter>);
    await screen.findByRole('heading', { name: /Person at north gate/ });
    fireEvent.keyDown(window, { key: 'a', repeat: true });
    expect(rpc).not.toHaveBeenCalledWith('review_cctv_entity_observation', expect.anything());
    fireEvent.click(screen.getByLabelText('single-key shortcuts'));
    expect(window.localStorage.getItem('fcm.cctvTriage.characterShortcuts')).toBe('off');
    fireEvent.keyDown(window, { key: 'a' });
    expect(rpc).not.toHaveBeenCalledWith('review_cctv_entity_observation', expect.anything());
    expect((screen.getByRole('button', { name: /^Accept$/ }) as HTMLButtonElement).getAttribute('aria-keyshortcuts')).toBeNull();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    await screen.findByRole('heading', { name: /Person at south gate/ });
  });
});
