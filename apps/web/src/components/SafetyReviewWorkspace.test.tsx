import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SafetyReviewWorkspace } from './SafetyReviewWorkspace';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
const fixture = {
  owners: [{ id: 'owner-1', name: 'Synthetic supervisor' }],
  hazards: [{ id: 'h1', title: 'Wet walkway', version: 3, controls: ['Use dry path'], control_levels: {}, risk_owner_id: null, review_due: null, location_id: 'place-1' }],
  reviews: [{ id: 'r1', title: 'STOP WORK - dynamic assessment', status: 'open', created_at: '2026-10-16T12:00:00Z',
    location_id: 'place-1', field_report_id: null, incident_id: null, assessment: null, investigation_id: null, outcome: null }],
  incidents: [{ id: 'incident-1', name: 'Synthetic incident' }], investigations: [{ id: 'inv-1', name: 'Existing safety investigation' }],
};

describe('supervisor safety review workspace', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation(async (name: string) => ({ data: name === 'get_safety_review_workspace' ? fixture : 'receipt-1', error: null }));
  });
  it('records ownership, hierarchy and next review using an expected-version check', async () => {
    render(<SafetyReviewWorkspace organizationId="org-1" locationId="place-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review owner and controls' }));
    fireEvent.change(screen.getByLabelText('Risk owner'), { target: { value: 'owner-1' } });
    fireEvent.change(screen.getByLabelText('Use dry path'), { target: { value: 'administrative' } });
    fireEvent.change(screen.getByLabelText('Next review date'), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByLabelText('Review findings'), { target: { value: 'Controls checked and responsible person confirmed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record risk review' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('review_place_hazard', expect.objectContaining({
      p_hazard_id: 'h1', p_expected_version: 3, p_owner_id: 'owner-1', p_control_levels: { 'Use dry path': 'administrative' }, p_review_due: '2027-01-01',
    })));
    await screen.findByText(/Risk review recorded/);
  });
  it('links findings to existing hazard and investigation without rewriting officer evidence', async () => {
    render(<SafetyReviewWorkspace organizationId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record corrective action' }));
    fireEvent.change(screen.getByLabelText('Findings, corrective action and closure reason'), { target: { value: 'Walkway isolated and alternate route agreed; reassess the task.' } });
    fireEvent.change(screen.getByLabelText('Related place hazard'), { target: { value: 'h1' } });
    fireEvent.change(screen.getByLabelText('Existing investigation'), { target: { value: 'inv-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete safety review' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('complete_safety_review', expect.objectContaining({
      p_review_id: 'r1', p_hazard_id: 'h1', p_investigation_id: 'inv-1',
    })));
    await screen.findByText(/unsafe assessment remains unsafe evidence/);
  });
  it('shows a denied workspace and does not offer writes', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Safety review workspace access denied' } });
    render(<SafetyReviewWorkspace organizationId="unrelated-org" />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Record corrective action' })).toBeNull();
  });
});
