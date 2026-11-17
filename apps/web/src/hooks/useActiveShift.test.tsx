import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useActiveShift } from './useActiveShift';
import { supabase } from '../lib/supabase';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

function shift(id: string, start: string, end: string, status = 'accepted') {
  return {
    id, organization_id: 'branch', officer_user_id: 'officer',
    service_type: 'static_guarding', scheduled_start: start, scheduled_end: end,
    status, created_at: start, updated_at: start, shift_stops: [],
  };
}

function mockShifts(rows: ReturnType<typeof shift>[]) {
  const makeQuery = (result: typeof rows) => ({
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(), gt: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: result, error: null }).then(resolve),
  });
  const recovery = makeQuery(rows.filter((item) => item.status === 'in_progress' && Date.parse(item.scheduled_end) <= Date.now()));
  const regular = makeQuery(rows.filter((item) => Date.parse(item.scheduled_end) > Date.now()));
  vi.mocked(supabase.from).mockReturnValueOnce(recovery as never).mockReturnValue(regular as never);
  return { recovery, regular };
}

describe('useActiveShift roster context', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T00:30:00+13:00'));
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as never);
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
    const { recovery } = mockShifts([
      shift('overdue', '2026-11-06T18:00:00+13:00', '2026-11-07T06:00:00+13:00', 'in_progress'),
      shift('current', '2026-11-08T18:00:00+13:00', '2026-11-09T06:00:00+13:00'),
    ]);
    const { result } = renderHook(() => useActiveShift('officer', 'home-org'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.shift?.id).toBe('overdue');
    expect(recovery.select).toHaveBeenCalledWith('id, organization_id, officer_user_id, scheduled_start, scheduled_end, status');
    expect(result.current.shift?.recovery_only).toBe(true);
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

  it('uses the assignment projection when branch RLS cannot see the active shift', async () => {
    mockShifts([]);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [
      shift('cross-branch', '2026-11-08T18:00:00+13:00', '2026-11-09T06:00:00+13:00', 'in_progress'),
    ], error: null } as never);
    const { result } = renderHook(() => useActiveShift('officer', 'home-org'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.shift?.id).toBe('cross-branch');
    expect(result.current.shift?.organization_id).toBe('branch');
  });

  it('retains the visible overdue recovery shift if the projection is unavailable', async () => {
    mockShifts([shift('overdue', '2026-11-06T18:00:00+13:00', '2026-11-07T06:00:00+13:00', 'in_progress')]);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: { message: 'unavailable' } } as never);
    const { result } = renderHook(() => useActiveShift('officer', 'home-org'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.shift?.id).toBe('overdue');
    expect(result.current.error?.message).toContain('overdue');
    expect(supabase.rpc).toHaveBeenCalledWith('get_assigned_officer_shift_context');
  });

  it('keeps an RLS-invisible overdue assignment as minimal recovery context', async () => {
    mockShifts([]);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [{
      id: 'overdue-branch', organization_id: 'branch', officer_user_id: 'officer',
      scheduled_start: '2026-11-06T18:00:00+13:00', scheduled_end: '2026-11-07T06:00:00+13:00',
      status: 'in_progress', context_status: 'recovery_only',
    }], error: null } as never);
    const { result } = renderHook(() => useActiveShift('officer', 'home-org'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.shift?.id).toBe('overdue-branch');
    expect(result.current.shift?.recovery_only).toBe(true);
    expect(result.current.shift?.stops).toEqual([]);
    expect(result.current.shift?.service_agreement_module_key).toBeNull();
    expect(result.current.error?.message).toContain('overdue');
  });

  it('keeps a valid active shift and warns about an inconsistent future shift', async () => {
    const active = { ...shift('active', '2026-11-08T18:00:00+13:00', '2026-11-09T06:00:00+13:00', 'in_progress'),
      service_agreement_module: { module_key: 'unproven' }, service_agreement_location_id: 'link' };
    const future = shift('bad-future', '2026-11-09T18:00:00+13:00', '2026-11-10T06:00:00+13:00');
    mockShifts([active, future]);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [
      { ...active, context_status: 'available' }, { ...future, context_status: 'requires_review' },
    ], error: null } as never);
    const { result } = renderHook(() => useActiveShift('officer', 'home-org'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.shift?.id).toBe('active');
    expect(result.current.error?.message).toContain('operations review');
    expect(result.current.shift?.service_agreement_module_key).toBeNull();
    expect(result.current.shift?.service_agreement_location_id).toBeNull();
  });

  it('clears assigned context when the identity is removed', async () => {
    mockShifts([shift('active', '2026-11-08T18:00:00+13:00', '2026-11-09T06:00:00+13:00', 'in_progress')]);
    const { result, rerender } = renderHook(({ user }) => useActiveShift(user, 'home-org'), { initialProps: { user: 'officer' } });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.shift?.id).toBe('active');
    rerender({ user: '' });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.shift).toBeNull();
  });

  it('does not restore a previous identity when an old request finishes late', async () => {
    let resolveRows!: (value: unknown) => void;
    const pending = new Promise((resolve) => { resolveRows = resolve; });
    const query = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), lte: vi.fn().mockReturnThis(),
      then: (resolve: (value: unknown) => unknown) => pending.then(resolve),
    };
    vi.mocked(supabase.from).mockReturnValue(query as never);
    const { result, rerender } = renderHook(({ user }) => useActiveShift(user, 'home-org'), { initialProps: { user: 'officer' } });
    rerender({ user: '' });
    await act(async () => {
      resolveRows({ data: [shift('stale', '2026-11-08T18:00:00+13:00', '2026-11-09T06:00:00+13:00', 'in_progress')], error: null });
      await Promise.resolve();
    });
    expect(result.current.shift).toBeNull();
  });
});