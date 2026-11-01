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
vi.mock('./RecordUpdatesPanel', () => ({ RecordUpdatesPanel: () => null }));
vi.mock('./VehicleOwnerPanel', () => ({ VehicleOwnerPanel: () => null }));
vi.mock('./ObservationIndicators', () => ({ ObservationIndicators: () => null, useObservationAnnotations: () => ({ annotations: {}, reload: vi.fn() }) }));

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

  it('offers person links only for organisations whose R&M identity scope answers exactly true', async () => {
    const sighting = (id: string, organizationId: string) => ({
      source: 'patrol', record_id: id, organization_id: organizationId, observed_at: '2026-10-01T00:00:00Z', place_id: null,
      officer_id: null, note: null, canonical_vehicle_id: 'vehicle-1', evidence_item_id: null, compliance_status: null,
      compliance_reason: null, photo_url: null,
    });
    const scopes: Record<string, unknown> = { 'org-allowed': true, 'org-denied': false, 'org-truthy': 'true' };
    rpc.mockImplementation(async (name: string, args?: { p_organization_id?: string }) => {
      if (name === 'can_manage_r_and_m_identity') return { data: true, error: null };
      if (name === 'list_repeat_vehicle_subjects_for_agreement') return { data: [{ plate: 'TST123', sightings: 3, places: 1, officers: 0, patrol_sightings: 3, cctv_sightings: 0, first_seen: '2026-10-01T00:00:00Z', last_seen: '2026-10-02T00:00:00Z', owner_identified: false, total_count: 1 }], error: null };
      if (name === 'list_vehicle_subject_history_for_agreement') return { data: [sighting('obs-allowed', 'org-allowed'), sighting('obs-denied', 'org-denied'), sighting('obs-truthy', 'org-truthy')], error: null };
      if (name === 'can_view_rnm_identity_for_organization') return { data: scopes[args?.p_organization_id ?? ''], error: null };
      return { data: [], error: null };
    });
    render(<RepeatSubjectsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open sighting history for TST123' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Link a verified person to this sighting' })).toHaveLength(1));
    for (const organizationId of Object.keys(scopes)) {
      expect(rpc).toHaveBeenCalledWith('can_view_rnm_identity_for_organization', { p_organization_id: organizationId });
    }
    expect(rpc).not.toHaveBeenCalledWith('list_verified_person_projections_for_organization', expect.anything());
  });
});
