import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async () => ({ error: null }));
const pending = vi.fn(() => false);
vi.mock('./supabase', () => ({ supabase: { functions: { invoke } } }));
vi.mock('./staleBuildRecovery', () => ({ isStaleBuildReloadPending: pending }));

const { reportMonitoredError } = await import('./bobFrictionMonitor');

describe('Bob friction monitor', () => {
  beforeEach(() => {
    invoke.mockClear();
    window.sessionStorage.clear();
  });

  it('reports a runtime error as a friction packet', async () => {
    pending.mockReturnValue(false);
    await reportMonitoredError({ kind: 'exception', name: 'TypeError', message: 'boom' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('stays silent while the page is reloading onto a new build, so a deploy cannot open repair jobs', async () => {
    pending.mockReturnValue(true);
    await reportMonitoredError({ kind: 'render_failure', name: 'TypeError', message: 'Failed to fetch dynamically imported module' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
