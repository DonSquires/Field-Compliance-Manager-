import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useActiveShift } from './useActiveShift';
import { supabase } from '../lib/supabase';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));

function shift(id: string, start: string, end: string, status = 'accepted') {
  return {
    id, organization_id: 'branch', officer_user_id: 'officer',
    service_type: 'static_guarding', scheduled_start: start, scheduled_end: end,
    status, created_at: start, updated_at: start, shift_stops: [],
  };
}

function mockShifts(rows: ReturnType<typeof shift>[]) {
  const query = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
  };
  vi.mocked(supabase.from).mockReturnValue(query as unknown as ReturnType<typeof supabase.from>);
  return query;
}

describe('useActiveShift roster context', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T00:30:00+13:00'));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('keeps a late start attached to the current overnight roster rather than the next evening', async () => {
    const original = shift('overnight', '2026-11-08T18:00:00+13:00', '2026-11-09T06:00:00+13:00');
    mockShifts([original, shift('next-evening', '2026-11-09T18:00:00+13:00', '2026-11-10T06:00:00+13:00')]);
    const { result } = renderHook(() => useActiveShift('officer', 'home-org'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.shift?.id).toBe('overnight');
    expect(result.current.shift?.start_time).toBe(original.scheduled_start);
    expect(result.current.shift?.end_time).toBe(original.scheduled_end);
    expect(result.current.shift?.organization_id).toBe('branch');
  });

  it('retains an unfinished in-progress shift even after its scheduled day ends', async () => {
    const query = mockShifts([
      shift('overdue', '2026-11-06T18:00:00+13:00', '2026-11-07T06:00:00+13:00', 'in_progress'),
      shift('current', '2026-11-08T18:00:00+13:00', '2026-11-09T06:00:00+13:00'),
    ]);
    const { result } = renderHook(() => useActiveShift('officer', 'home-org'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.shift?.id).toBe('overdue');
    expect(query.or).toHaveBeenCalledWith(expect.stringContaining('status.eq.in_progress,and('));
  });

  it('chooses the nearest upcoming assignment when no current shift exists', async () => {
    mockShifts([
      shift('next', '2026-11-09T18:00:00+13:00', '2026-11-10T06:00:00+13:00'),
      shift('later', '2026-11-10T18:00:00+13:00', '2026-11-11T06:00:00+13:00'),
    ]);
    const { result } = renderHook(() => useActiveShift('officer', 'home-org'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.shift?.id).toBe('next');
  });

  it('does not call an expired accepted assignment an active shift', async () => {
    mockShifts([shift('expired', '2026-11-08T08:00:00+13:00', '2026-11-08T16:00:00+13:00')]);
    const { result } = renderHook(() => useActiveShift('officer', 'home-org'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.shift).toBeNull();
    expect(result.current.error).toBeNull();
  });
});