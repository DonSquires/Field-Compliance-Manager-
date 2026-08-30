import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useOfficerSafety } from './useOfficerSafety';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
import { supabase } from '../lib/supabase';

function mockTable(handlers: Record<string, (...args: unknown[]) => unknown>) {
  (supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    const impl = handlers[table];
    if (!impl) throw new Error(`No mock configured for table "${table}"`);
    return impl();
  });
}

function baseOptions(overrides: Partial<Parameters<typeof useOfficerSafety>[0]> = {}) {
  return {
    officerId: 'officer-1',
    organizationId: 'org-1',
    orgManDownEnabled: true,
    getGps: async () => null,
    ...overrides,
  };
}

describe('useOfficerSafety', () => {
  it('never resolves an active alert from recordMovement alone — the core P0 fix', async () => {
    mockTable({
      welfare_alerts: () => ({
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: 'alert-1' }, error: null }),
          }),
        }),
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { status: 'acknowledged' }, error: null }) }) }),
      }),
    });
    const { result } = renderHook(() => useOfficerSafety(baseOptions()));

    await act(async () => {
      const ok = await result.current.triggerSOS();
      expect(ok).toBe(true);
    });
    expect(result.current.activeAlert?.id).toBe('alert-1');
    expect(result.current.status).toBe('alerting');

    act(() => {
      result.current.recordMovement(-36.8, 174.7);
    });

    // Movement must NEVER clear the alert on its own.
    expect(result.current.activeAlert?.id).toBe('alert-1');
    expect(result.current.status).toBe('alerting');
  });

  it('acknowledgeAlert requires an explicit call and clears the alert only on a successful write', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [{ alert_id: 'alert-2', alert_status: 'resolved' }], error: null });
    mockTable({
      welfare_alerts: () => ({
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: 'alert-2' }, error: null }),
          }),
        }),
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { status: 'acknowledged' }, error: null }) }) }),
      }),
    });
    const { result } = renderHook(() => useOfficerSafety(baseOptions()));
    await act(async () => {
      await result.current.triggerSOS();
    });
    expect(result.current.activeAlert).not.toBeNull();

    await act(async () => {
      const ok = await result.current.acknowledgeAlert();
      expect(ok).toBe(true);
    });
    expect(supabase.rpc).toHaveBeenCalledWith('manage_welfare_alert', expect.objectContaining({ p_alert_id: 'alert-2', p_expected_status: 'acknowledged', p_action: 'resolve' }));
    expect(result.current.activeAlert).toBeNull();
    expect(result.current.status).toBe('ok');
  });

  it('does not clear the active alert if the resolve write fails', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: { message: 'network error' } });
    mockTable({
      welfare_alerts: () => ({
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: 'alert-3' }, error: null }),
          }),
        }),
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { status: 'pending' }, error: null }) }) }),
      }),
    });
    const { result } = renderHook(() => useOfficerSafety(baseOptions()));
    await act(async () => {
      await result.current.triggerSOS();
    });

    await act(async () => {
      const ok = await result.current.acknowledgeAlert();
      expect(ok).toBe(false);
    });
    expect(result.current.activeAlert).not.toBeNull(); // alert stays active
    expect(result.current.writeStatus).toBe('error');
  });

  it('triggerSOS surfaces a write failure instead of silently appearing to succeed', async () => {
    mockTable({
      welfare_alerts: () => ({
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: null, error: { message: 'insert failed' } }),
          }),
        }),
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { status: 'pending' }, error: null }) }) }),
      }),
    });
    const { result } = renderHook(() => useOfficerSafety(baseOptions()));
    await act(async () => {
      const ok = await result.current.triggerSOS();
      expect(ok).toBe(false);
    });
    expect(result.current.activeAlert).toBeNull();
    expect(result.current.writeStatus).toBe('error');
    expect(result.current.lastError).toMatch(/insert failed/);
  });

  it('checkIn checks errors on both writes and only clears an active alert on full success', async () => {
    let checksInsertCalled = false;
    let settingsUpsertCalled = false;
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [{ alert_id: 'alert-4', alert_status: 'resolved' }], error: null });
    mockTable({
      welfare_alerts: () => ({
        insert: () => ({
          select: () => ({ single: () => Promise.resolve({ data: { id: 'alert-4' }, error: null }) }),
        }),
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { status: 'pending' }, error: null }) }) }),
      }),
      welfare_checks: () => ({
        insert: () => {
          checksInsertCalled = true;
          return Promise.resolve({ error: null });
        },
      }),
      officer_welfare_settings: () => ({
        upsert: () => {
          settingsUpsertCalled = true;
          return Promise.resolve({ error: null });
        },
      }),
    });
    const { result } = renderHook(() => useOfficerSafety(baseOptions()));
    await act(async () => {
      await result.current.triggerSOS();
    });

    await act(async () => {
      const ok = await result.current.checkIn();
      expect(ok).toBe(true);
    });
    expect(checksInsertCalled).toBe(true);
    expect(settingsUpsertCalled).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('manage_welfare_alert', expect.objectContaining({ p_alert_id: 'alert-4', p_action: 'resolve' }));
    expect(result.current.activeAlert).toBeNull();
    expect(result.current.status).toBe('ok');
  });

  it('checkIn keeps an active alert when its resolution write fails', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: { message: 'alert update failed' } });
    mockTable({
      welfare_alerts: () => ({
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: 'alert-4b' }, error: null }),
          }),
        }),
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { status: 'pending' }, error: null }) }) }),
      }),
      welfare_checks: () => ({
        insert: () => Promise.resolve({ error: null }),
      }),
      officer_welfare_settings: () => ({
        upsert: () => Promise.resolve({ error: null }),
      }),
    });
    const { result } = renderHook(() => useOfficerSafety(baseOptions()));
    await act(async () => {
      await result.current.triggerSOS();
    });

    await act(async () => {
      const ok = await result.current.checkIn();
      expect(ok).toBe(false);
    });
    expect(result.current.activeAlert?.id).toBe('alert-4b');
    expect(result.current.status).toBe('alerting');
    expect(result.current.writeStatus).toBe('error');
    expect(result.current.lastError).toMatch(/alert update failed/);
  });

  it('checkIn fails visibly (does not silently succeed) when the check-in insert errors', async () => {
    mockTable({
      welfare_checks: () => ({
        insert: () => Promise.resolve({ error: { message: 'rls denied' } }),
      }),
    });
    const { result } = renderHook(() => useOfficerSafety(baseOptions()));
    await act(async () => {
      const ok = await result.current.checkIn();
      expect(ok).toBe(false);
    });
    expect(result.current.writeStatus).toBe('error');
    expect(result.current.lastError).toMatch(/rls denied/);
  });

  it('exposes detectionState in plain terms for org-disabled, officer-disabled, and active', () => {
    const { result: orgDisabled } = renderHook(() => useOfficerSafety(baseOptions({ orgManDownEnabled: false })));
    expect(orgDisabled.current.detectionState).toBe('disabled_by_org');

    const { result: officerDisabled } = renderHook(() =>
      useOfficerSafety(baseOptions({ officerManDownEnabled: false })),
    );
    expect(officerDisabled.current.detectionState).toBe('disabled_by_officer');

    const { result: active } = renderHook(() => useOfficerSafety(baseOptions()));
    expect(active.current.detectionState).toBe('active');
  });

  it('reports detectionState unknown when officer/organization identity is not yet available', () => {
    const { result } = renderHook(() => useOfficerSafety(baseOptions({ officerId: null })));
    expect(result.current.detectionState).toBe('unknown');
  });

  it('duplicate-fire guard: a second trigger while an alert is already active does not fire again', async () => {
    let insertCallCount = 0;
    mockTable({
      welfare_alerts: () => ({
        insert: () => {
          insertCallCount += 1;
          return { select: () => ({ single: () => Promise.resolve({ data: { id: `alert-${insertCallCount}` }, error: null }) }) };
        },
      }),
    });
    const { result } = renderHook(() => useOfficerSafety(baseOptions()));
    await act(async () => {
      await result.current.triggerSOS();
    });
    await act(async () => {
      const ok = await result.current.triggerSOS();
      expect(ok).toBe(false);
    });
    expect(insertCallCount).toBe(1);
  });

  it('gps_lost fires automatically when no GPS fix arrives within the inactivity threshold', async () => {
    vi.useFakeTimers();
    try {
      let insertedType: string | undefined;
      mockTable({
        welfare_alerts: () => ({
          insert: (payload: { alert_type: string }) => {
            insertedType = payload.alert_type;
            return { select: () => ({ single: () => Promise.resolve({ data: { id: 'alert-gl' }, error: null }) }) };
          },
        }),
      });
      const { result } = renderHook(() =>
        useOfficerSafety(baseOptions({ stationaryMinutes: 1000, inactivityMinutes: 0.2 })),
      );
      // One fix establishes a baseline (matches the original hook's own
      // behaviour: gps_lost is measured from the last fix received, not from
      // hook-mount time), then no further fixes ever arrive.
      act(() => {
        result.current.recordMovement(-36.8, 174.7);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(result.current.activeAlert?.kind).toBe('gps_lost');
      expect(insertedType).toBe('gps_lost');
    } finally {
      vi.useRealTimers();
    }
  });

  it('inactivity fires when fixes keep arriving but show no real movement, and is distinct from gps_lost', async () => {
    vi.useFakeTimers();
    try {
      let insertedType: string | undefined;
      mockTable({
        welfare_alerts: () => ({
          insert: (payload: { alert_type: string }) => {
            insertedType = payload.alert_type;
            return { select: () => ({ single: () => Promise.resolve({ data: { id: 'alert-ia' }, error: null }) }) };
          },
        }),
      });
      const { result } = renderHook(() =>
        useOfficerSafety(baseOptions({ stationaryMinutes: 1000, inactivityMinutes: 0.2 })),
      );
      act(() => {
        result.current.recordMovement(-36.8, 174.7);
      });
      // Fresh fixes keep arriving at the exact same spot — refreshes lastFixAtRef
      // (so gps_lost never fires) but never moves far enough to refresh lastMovementRef.
      await act(async () => {
        for (let i = 0; i < 3; i += 1) {
          await vi.advanceTimersByTimeAsync(10_000);
          result.current.recordMovement(-36.8, 174.7);
        }
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(result.current.activeAlert?.kind).toBe('inactivity');
      expect(insertedType).toBe('inactivity');
    } finally {
      vi.useRealTimers();
    }
  });

  it('recordMovement below MOVEMENT_THRESHOLD_M does not reset the stationary timer (fixes the original unused-threshold bug)', async () => {
    vi.useFakeTimers();
    try {
      mockTable({
        welfare_alerts: () => ({
          insert: () => ({
            select: () => ({ single: () => Promise.resolve({ data: { id: 'alert-mv' }, error: null }) }),
          }),
        }),
      });
      const { result } = renderHook(() =>
        useOfficerSafety(baseOptions({ stationaryMinutes: 0.2, inactivityMinutes: 1000 })),
      );
      act(() => {
        result.current.recordMovement(-36.8, 174.7);
      });
      // Tiny jitter well under the 25m threshold — must NOT count as real movement.
      await act(async () => {
        for (let i = 0; i < 3; i += 1) {
          await vi.advanceTimersByTimeAsync(10_000);
          result.current.recordMovement(-36.800001, 174.700001);
        }
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(result.current.activeAlert?.kind).toBe('motion');
    } finally {
      vi.useRealTimers();
    }
  });
});
