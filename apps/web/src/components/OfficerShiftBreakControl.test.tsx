import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), current: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: {
  rpc: mocks.rpc,
  from: () => ({ select: () => ({ eq: () => ({ is: () => ({ maybeSingle: mocks.current }) }) }) }),
} }));
import { OfficerShiftBreakControl } from './OfficerShiftBreakControl';
const receipt = { id: 'break-1', shift_id: 'shift-1', break_type: 'meal', is_paid: false, started_at: '2026-11-06T00:00:00Z', ended_at: null };
describe('one-button shift breaks', () => {
  beforeEach(() => {
    mocks.current.mockReset().mockResolvedValue({ data: null, error: null });
    mocks.rpc.mockReset().mockImplementation(async (name: string) => {
      if (name === 'get_officer_break_plan') return { data: { shift_id: 'shift-1', planned_minutes: 30, unpaid: true, taken_minutes: 0 }, error: null };
      return { data: name === 'end_shift_break' ? { ...receipt, ended_at: '2026-11-06T00:30:00Z' } : receipt, error: null };
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it('changes Start break to Finish break and confirms the actual end', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-06T00:05:00Z'));
    render(<OfficerShiftBreakControl shiftId="shift-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start break' }));
    expect(await screen.findByRole('button', { name: 'Finish break' })).toBeTruthy();
    expect(screen.getByRole('timer').textContent).toBe('25:00 remaining');
    fireEvent.click(screen.getByRole('button', { name: 'Finish break' }));
    expect(await screen.findByText('Break finished. Actual duration recorded.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Start break' })).toBeTruthy();
    expect(mocks.rpc).toHaveBeenCalledWith('end_shift_break', { p_break_id: 'break-1', p_notes: null });
  });
  it('restores an open break and remaining allowance on remount', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-06T00:10:00Z'));
    mocks.current.mockResolvedValue({ data: receipt, error: null });
    render(<OfficerShiftBreakControl shiftId="shift-1" />);
    expect(await screen.findByRole('button', { name: 'Finish break' })).toBeTruthy();
    expect(screen.getByRole('timer').textContent).toBe('20:00 remaining');
  });
  it('retains the request ID across an uncertain start and never fakes a receipt', async () => {
    const handler = mocks.rpc.getMockImplementation()!;
    let attempts = 0;
    mocks.rpc.mockImplementation(async (name: string, args: unknown) => {
      if (name === 'start_shift_break' && ++attempts === 1) return { data: null, error: { message: 'Synthetic disconnected response' } };
      return handler(name, args);
    });
    render(<OfficerShiftBreakControl shiftId="shift-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start break' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Synthetic disconnected response');
    expect(screen.queryByRole('button', { name: 'Finish break' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start break' }));
    await screen.findByRole('button', { name: 'Finish break' });
    const calls = mocks.rpc.mock.calls.filter(([name]) => name === 'start_shift_break');
    expect(calls[0][1].p_client_request_id).toBe(calls[1][1].p_client_request_id);
  });
  it('fails closed on unavailable break status', async () => {
    mocks.current.mockResolvedValue({ data: null, error: { message: 'Synthetic unavailable status' } });
    render(<OfficerShiftBreakControl shiftId="shift-1" />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Synthetic unavailable status');
    expect(screen.queryByRole('button', { name: 'Start break' })).toBeNull();
  });
});
