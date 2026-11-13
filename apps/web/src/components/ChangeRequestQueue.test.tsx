import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChangeRequestQueue } from './ChangeRequestQueue';
import { listChangeRequests, setChangeRequestDisposition } from '../lib/bobChangeRequest';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ profile: { role: 'admin' } }) }));
vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../lib/bobChangeRequest', async (load) => ({
  ...await load<typeof import('../lib/bobChangeRequest')>(),
  listChangeRequests: vi.fn(),
  setChangeRequestDisposition: vi.fn(),
}));
afterEach(cleanup);
it('hands off for evaluation only and surfaces denied review writes', async () => {
  vi.mocked(listChangeRequests).mockResolvedValue([{
    id: 'request-1', organization_id: 'org-1', user_id: 'officer-1', kind: 'workflow_snag',
    created_at: '2026-10-17T00:00:00Z', triage: 'ux_gap', repair_risk: 'significant',
    automation_status: 'awaiting_grandmaster', disposition: 'open', builder_job_id: null,
    reviewed_at: null, review_note: null, stop_line_hit: null, page: '/admin/roster',
    currentBehavior: 'Mixed shifts', desiredBehavior: 'Show unfilled shifts first', businessReason: 'Faster dispatch',
    viewTitle: 'Roster', headings: ['Roster board'],
  }]);
  vi.mocked(setChangeRequestDisposition).mockRejectedValue(new Error('Review permission denied'));
  const open = vi.fn();
  render(<ChangeRequestQueue onOpenBob={open} />);
  await screen.findByText('Show unfilled shifts first');
  expect(screen.getByText(/go to Bob Builder chat automatically/)).toBeTruthy();
  expect(screen.getByText(/Queued for Bob Builder chat/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Evaluate with Bob' }));
  expect(open.mock.calls[0][0]).toContain('Do not open a job');
  fireEvent.click(screen.getByRole('button', { name: 'Mark reviewing' }));
  await screen.findByText('Review permission denied');
  expect(setChangeRequestDisposition).toHaveBeenCalledWith('request-1', 'reviewing', '');
});
