import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ServiceDeliverySummary } from './ServiceDeliverySummary';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
const counts = {
  reviewedReports: { recorded: 1, alreadyInActivity: 1, additional: 0 },
  completedDispatch: { recorded: 1, alreadyInActivity: 0, additional: 1 },
  completedStatic: { recorded: 1, alreadyInActivity: 0, additional: 1 },
};
const response = { data: [{ client: { version: 1, counts }, internal: { awaitingReview: 2, handoversReceived: 1, summary: 'PRIVATE' } }], error: null };
afterEach(cleanup);
beforeEach(() => { rpc.mockReset(); });

describe('Reports & Accountability service evidence', () => {
  it('uses the agreement RPC with inclusive end day, not the client/provider custody column', async () => {
    rpc.mockResolvedValue(response);
    render(<ServiceDeliverySummary agreementIds={['agreement-2', 'agreement-1', 'agreement-2']} start="2026-11-01" end="2026-11-07" />);
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('get_agreement_service_delivery_summary', {
      p_agreement_ids: ['agreement-1', 'agreement-2'], p_from: '2026-11-01T00:00:00.000Z', p_to: '2026-11-08T00:00:00.000Z',
    });
    expect(screen.getByText(/2 officer incident or site hazard reports awaiting review/)).toBeTruthy();
    expect(screen.getByText(/1 shift handovers received/)).toBeTruthy();
    expect(screen.queryByText('PRIVATE')).toBeNull();
  });
  it('shows missing RPC as unavailable, not zero, and supports retry', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'missing function' } }).mockResolvedValue(response);
    render(<ServiceDeliverySummary agreementIds={['agreement-1']} start="2026-11-01" end="2026-11-07" />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Missing counts are not zero'));
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry service evidence' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });
  it('clears stale evidence as soon as the agreement changes', async () => {
    rpc.mockResolvedValueOnce(response).mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<ServiceDeliverySummary agreementIds={['agreement-1']} start="2026-11-01" end="2026-11-07" />);
    await screen.findByRole('table');
    rerender(<ServiceDeliverySummary agreementIds={['agreement-2']} start="2026-11-01" end="2026-11-07" />);
    expect(screen.queryByRole('table')).toBeNull();
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  });
  it('does not query without an agreement', () => {
    render(<ServiceDeliverySummary agreementIds={[]} start="2026-11-01" end="2026-11-07" />);
    expect(screen.getByRole('status').textContent).toContain('Choose an agreement');
    expect(rpc).not.toHaveBeenCalled();
  });
});
