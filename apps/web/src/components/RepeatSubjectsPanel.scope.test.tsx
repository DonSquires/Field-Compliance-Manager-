import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RepeatSubjectsPanel } from './RepeatSubjectsPanel';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { organizationId: 'rnm' } }) }));
vi.mock('../context/ServiceRelationshipContext', () => ({
  useServiceRelationships: () => ({
    agreements: [{ id: 'agreement-a', name: 'Agreement A', client_name: 'Client', agreement_type: 'operational', invitation_status: 'accepted', client_organization_id: 'client' }],
    zones: [], sites: [],
  }),
}));
vi.mock('./RecordEvidencePanel', () => ({ RecordEvidencePanel: () => null }));

describe('all-authorised repeat subject scope', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation(async (name: string) => ({ data: name === 'can_manage_r_and_m_identity' ? true : [], error: null }));
  });
  afterEach(cleanup);

  it('loads both subject types without an agreement and can return to one agreement', async () => {
    render(<RepeatSubjectsPanel />);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('list_repeat_vehicle_subjects_for_agreement', expect.objectContaining({ p_service_agreement_id: null })));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('list_repeat_person_subjects_for_agreement', expect.objectContaining({ p_service_agreement_id: null })));
    expect(rpc).toHaveBeenCalledWith('list_unlinked_plate_mentions_for_agreement', expect.objectContaining({ p_service_agreement_id: null }));
    const scope = screen.getByRole('option', { name: 'All authorised agreements and observations' }).parentElement!;
    fireEvent.change(scope, { target: { value: 'agreement-a' } });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('list_repeat_vehicle_subjects_for_agreement', expect.objectContaining({ p_service_agreement_id: 'agreement-a' })));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('list_repeat_person_subjects_for_agreement', expect.objectContaining({ p_service_agreement_id: 'agreement-a' })));
    fireEvent.change(screen.getAllByLabelText('Seen at least')[0], { target: { value: '1' } });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('list_repeat_vehicle_subjects_for_agreement', expect.objectContaining({ p_min_sightings: 1 })));
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '2' } });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('list_repeat_person_subjects_for_agreement', expect.objectContaining({ p_from: null })));
  });

  it('does not fetch subject lists when access is denied', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    render(<RepeatSubjectsPanel />);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('can_manage_r_and_m_identity'));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Repeat vehicles')).toBeNull();
  });
});
