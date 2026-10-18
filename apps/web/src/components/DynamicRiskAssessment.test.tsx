import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DynamicRiskAssessment } from './DynamicRiskAssessment';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
const places = [{ kind: 'site' as const, id: 'site-1', location_id: 'place-1', name: 'Synthetic workplace' }];

describe('dynamic officer task assessment', () => {
  beforeEach(() => rpc.mockReset());
  it('requires a deliberate work decision and attestation, and preserves the signed unsafe receipt', async () => {
    let submitted = false;
    rpc.mockImplementation(async (name: string) => ({ data: name === 'submit_dynamic_risk_assessment'
      ? (submitted = true, { id: 'assessment-1', signed_at: '2026-10-16T12:00:00Z' })
      : submitted ? [{ id: 'assessment-1', task: 'Check rear gate', hazards: 'Loose materials', controls: ['Isolate the path'],
        decision: 'stop_work', likelihood: 2, consequence: 3, signed_at: '2026-10-16T12:00:00Z', review_status: 'open' }] : [], error: null }));
    render(<DynamicRiskAssessment shiftId="shift-1" places={places} />);
    fireEvent.click(screen.getByRole('button', { name: 'Assess a task' }));
    expect(screen.getByLabelText('Work decision')).toHaveProperty('value', '');
    expect(screen.getByLabelText(/I assessed this task/)).toHaveProperty('checked', false);
    fireEvent.change(screen.getByLabelText('Task to be done'), { target: { value: 'Check rear gate' } });
    fireEvent.change(screen.getByLabelText('Hazards observed'), { target: { value: 'Loose materials' } });
    fireEvent.change(screen.getByLabelText('Task controls, one per line'), { target: { value: 'Isolate the path' } });
    fireEvent.change(screen.getByLabelText('Task likelihood (1-5)'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Task consequence (1-5)'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Work decision'), { target: { value: 'stop_work' } });
    expect(screen.getByRole('alert').textContent).toContain('Do not begin or resume');
    fireEvent.click(screen.getByLabelText(/I assessed this task/));
    fireEvent.click(screen.getByRole('button', { name: 'Sign and submit assessment' }));
    await screen.findByText(/Your signed assessment is recorded/);
    await screen.findByText(/STOP WORK - reassess before resuming this task/);
    expect(rpc).toHaveBeenCalledWith('submit_dynamic_risk_assessment', expect.objectContaining({
      p_shift_id: 'shift-1', p_place_kind: 'site', p_place_id: 'site-1', p_decision: 'stop_work', p_understood: true,
      p_controls: ['Isolate the path'], p_likelihood: 2, p_consequence: 3,
    }));
  });
  it('shows load failures and a recovery action instead of silently hiding assessments', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Connection lost' } });
    render(<DynamicRiskAssessment shiftId="shift-2" places={[]} />);
    await screen.findByText('Connection lost');
    expect(screen.getByText('No place is linked to this shift. Contact your supervisor.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh task assessments' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  });
});
