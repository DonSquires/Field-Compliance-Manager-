import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useOfficerSafety } from './useOfficerSafety';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
import { supabase } from '../lib/supabase';

const safetySource = readFileSync(resolve(process.cwd(), 'src/hooks/useOfficerSafety.ts'), 'utf8');

function mockTable(handlers: Record<string, (...args: unknown[]) => unknown>) {
  (supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    const impl = handlers[table];
    if (!impl) throw new Error(`No mock configured for table "${table}"`);
    return impl();
  });
}

function mockRpc(handlers: Record<string, (params: unknown) => { data: unknown; error: unknown }>) {
  (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockImplementation((fn: string, params: unknown) => {
    const impl = handlers[fn];
    if (!impl) throw new Error(`No mock configured for rpc "${fn}"`);
    return Promise.resolve(impl(params));
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
  it('rehydrates and polls canonical active-alert state for supervisor outcomes', () => {
    expect(safetySource).toContain('loadCanonicalAlert');
    expect(safetySource).toContain(".in('status', ['pending', 'acknowledged'])");
    expect(safetySource).toContain('syncActiveAlert');
    expect(safetySource).toContain("currentAlert?.status === 'resolved'");
    expect(safetySource).toContain('setResolutionOutcome');
  });
  it('clears a hydrated alert when the supervisor resolution reaches canonical state', async () => {
    vi.useFakeTimers();
    const hydrationResult = Promise.resolve({ data: { id: 'alert-supervisor', alert_type: 'sos', triggered_at: '2026-09-01T08:00:00.000Z', status: 'pending' }, error: null });
    const hydrationQuery = { eq: () => ({ eq: () => ({ in: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => hydrationResult }) }) }) }) }) };
    const resolutionQuery = { eq: () => ({ single: () => Promise.resolve({ data: { status: 'resolved', resolution_notes: 'Supervisor confirmed the officer is safe.', resolved_at: '2026-09-01T08:05:00.000Z' }, error: null }) }) };
    (supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      select: (columns: string) => columns.includes('alert_type') ? hydrationQuery : resolutionQuery,
    }));
    const { result } = renderHook(() => useOfficerSafety(baseOptions()));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.activeAlert?.id).toBe('alert-supervisor');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.activeAlert).toBeNull();
    expect(result.current.status).toBe('ok');
    expect(result.current.resolutionOutcome).toContain('Supervisor confirmed the officer is safe.');
    vi.useRealTimers();
  });
  it('never resolves an active alert from recordMovement alone — the core P0 fix', async () => {
    mockRpc({
      raise_officer_welfare_alert: () => ({ data: [{ alert_id: 'alert-1', triggered_at: '2026-09-01T08:00:00.000Z', created: true }], error: null }),
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
    mockRpc({
      raise_officer_welfare_alert: () => ({ data: [{ alert_id: 'alert-3', triggered_at: '2026-09-01T08:00:00.000Z', created: true }], error: null }),
      manage_welfare_alert: () => ({ data: null, error: { message: 'network error' } }),
    });
    mockTable({
      welfare_alerts: () => ({
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
    mockRpc({
      raise_officer_welfare_alert: () => ({ data: null, error: { message: 'insert failed' } }),
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

  it('checkIn checks the check-in write and only clears an active alert on full success', async () => {
    let checkinRpcCalled = false;
    mockRpc({
      raise_officer_welfare_alert: () => ({ data: [{ alert_id: 'alert-4', triggered_at: '2026-09-01T08:00:00.000Z', created: true }], error: null }),
      record_officer_welfare_checkin: () => {
        checkinRpcCalled = true;
        return { data: [{ check_id: 'check-1', checked_in_at: '2026-09-01T08:05:00.000Z', created: true }], error: null };
      },
      manage_welfare_alert: () => ({ data: [{ alert_id: 'alert-4', alert_status: 'resolved' }], error: null }),
    });
    mockTable({
      welfare_alerts: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { status: 'pending' }, error: null }) }) }),
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
    expect(checkinRpcCalled).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('manage_welfare_alert', expect.objectContaining({ p_alert_id: 'alert-4', p_action: 'resolve' }));
    expect(result.current.activeAlert).toBeNull();
    expect(result.current.status).toBe('ok');
  });

  it('checkIn keeps an active alert when its resolution write fails', async () => {
    mockRpc({
      raise_officer_welfare_alert: () => ({ data: [{ alert_id: 'alert-4b', triggered_at: '2026-09-01T08:00:00.000Z', created: true }], error: null }),
      record_officer_welfare_checkin: () => ({ data: [{ check_id: 'check-2', checked_in_at: '2026-09-01T08:05:00.000Z', created: true }], error: null }),
      manage_welfare_alert: () => ({ data: null, error: { message: 'alert update failed' } }),
    });
    mockTable({
      welfare_alerts: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { status: 'pending' }, error: null }) }) }),
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

  it('checkIn fails visibly (does not silently succeed) when the check-in write errors', async () => {
    mockRpc({
      record_officer_welfare_checkin: () => ({ data: null, error: { message: 'rls denied' } }),
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
    let rpcCallCount = 0;
    mockRpc({
      raise_officer_welfare_alert: () => {
        rpcCallCount += 1;
        return { data: [{ alert_id: `alert-${rpcCallCount}`, triggered_at: '2026-09-01T08:00:00.000Z', created: true }], error: null };
      },
    });
    const { result } = renderHook(() => useOfficerSafety(baseOptions()));
    await act(async () => {
      await result.current.triggerSOS();
    });
    await act(async () => {
      const ok = await result.current.triggerSOS();
      expect(ok).toBe(false);
    });
    expect(rpcCallCount).toBe(1);
  });

  it('gps_lost fires automatically when no GPS fix arrives within the inactivity threshold', async () => {
    vi.useFakeTimers();
    try {
      let insertedType: string | undefined;
      mockRpc({
        raise_officer_welfare_alert: (params: unknown) => {
          insertedType = (params as { p_alert_type: string }).p_alert_type;
          return { data: [{ alert_id: 'alert-gl', triggered_at: '2026-09-01T08:00:00.000Z', created: true }], error: null };
        },
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
      mockRpc({
        raise_officer_welfare_alert: (params: unknown) => {
          insertedType = (params as { p_alert_type: string }).p_alert_type;
          return { data: [{ alert_id: 'alert-ia', triggered_at: '2026-09-01T08:00:00.000Z', created: true }], error: null };
        },
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
      mockRpc({
        raise_officer_welfare_alert: () => ({ data: [{ alert_id: 'alert-mv', triggered_at: '2026-09-01T08:00:00.000Z', created: true }], error: null }),
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
