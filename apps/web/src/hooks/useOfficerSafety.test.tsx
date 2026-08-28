import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useOfficerSafety } from './useOfficerSafety';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
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
    let updateCalled = false;
    mockTable({
      welfare_alerts: () => ({
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: 'alert-2' }, error: null }),
          }),
        }),
        update: () => {
          updateCalled = true;
          return { eq: () => Promise.resolve({ error: null }) };
        },
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
    expect(updateCalled).toBe(true);
    expect(result.current.activeAlert).toBeNull();
    expect(result.current.status).toBe('ok');
  });

  it('does not clear the active alert if the resolve write fails', async () => {
    mockTable({
      welfare_alerts: () => ({
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: 'alert-3' }, error: null }),
          }),
        }),
        update: () => ({ eq: () => Promise.resolve({ error: { message: 'network error' } }) }),
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
    let alertsUpdateCalled = false;
    mockTable({
      welfare_alerts: () => ({
        insert: () => ({
          select: () => ({ single: () => Promise.resolve({ data: { id: 'alert-4' }, error: null }) }),
        }),
        update: () => {
          alertsUpdateCalled = true;
          return { eq: () => Promise.resolve({ error: null }) };
        },
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
    expect(alertsUpdateCalled).toBe(true); // check-in is a valid, explicit acknowledgement
    expect(result.current.activeAlert).toBeNull();
    expect(result.current.status).toBe('ok');
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
});
