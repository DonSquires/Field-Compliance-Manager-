import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OfficerPatrolBriefing } from './OfficerPatrolBriefing';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke } } }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows only reviewed briefing text and identifies withheld details', async () => {
  invoke.mockResolvedValue({ data: {
    shift_id: 'shift', stop_id: 'stop', officer_instructions: 'Reviewed instruction',
    access_instructions: null, hs_notes: null, privacy: { status: 'partly_withheld' },
  }, error: null });
  render(<OfficerPatrolBriefing shiftId="shift" stopId="stop" />);
  expect(await screen.findByText('Reviewed instruction')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('withheld');
  fireEvent.click(screen.getByRole('button', { name: 'Retry stop briefing' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
});

it('fails closed on a malformed or failed response and retries', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  invoke.mockResolvedValueOnce({ data: {
    shift_id: 'shift', stop_id: 'stop', officer_instructions: 'Unreviewed text',
    access_instructions: null, hs_notes: null, privacy: { status: 'unavailable' },
  }, error: null }).mockResolvedValueOnce({ data: null, error: new Error('offline') });
  render(<OfficerPatrolBriefing shiftId="shift" stopId="stop" />);
  expect((await screen.findByRole('alert')).textContent).toContain('could not be confirmed');
  expect(screen.queryByText('Unreviewed text')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry stop briefing' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect((await screen.findByRole('alert')).textContent).toContain('could not be confirmed');
  log.mockRestore();
});
