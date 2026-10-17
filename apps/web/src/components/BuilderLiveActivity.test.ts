import { describe, expect, it } from 'vitest';
import { deriveLiveActivity, isLiveJob, STALL_AFTER_MS, type LiveJob, type LiveSnapshot } from './BuilderLiveActivity';

const now = Date.parse('2026-10-18T10:00:00Z');
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const job = (over: Partial<LiveJob> = {}): LiveJob => ({ id: 'j', status: 'implementation_pending', current_step_name: 'frontend_implementation', updated_at: iso(60_000), ...over });
const snapshot = (over: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  steps: [
    { id: 'a', step_id: 'product_analysis', ordinal_position: 1, status: 'completed', attempt_count: 1 },
    { id: 'b', step_id: 'frontend_implementation', ordinal_position: 2, status: 'running', attempt_count: 1, started_at: iso(30_000) },
    { id: 'c', step_id: 'backend_implementation', ordinal_position: 3, status: 'skipped', attempt_count: 0 },
  ],
  workerRuns: [], modelRuns: [], events: [], approvals: [], ...over,
});

describe('deriveLiveActivity', () => {
  it('reports the running step as working, excluding skipped steps from the count', () => {
    const live = deriveLiveActivity(job(), snapshot(), now);
    expect(live.tone).toBe('working');
    expect(live.headline).toMatch(/Frontend implementation/i);
    expect(live.stepPosition).toBe(2);
    expect(live.stepTotal).toBe(2);
    expect(live.doneCount).toBe(1);
  });

  it('never calls a quiet job working: no progress past the stall window is shown as stalled', () => {
    const quiet = snapshot({ steps: snapshot().steps.map(step => step.status === 'running' ? { ...step, started_at: iso(STALL_AFTER_MS + 60_000) } : step) });
    const live = deriveLiveActivity(job({ updated_at: iso(STALL_AFTER_MS + 60_000) }), quiet, now);
    expect(live.tone).toBe('stalled');
  });

  it('shows failed, human-gate and blocked states rather than a spinner', () => {
    expect(deriveLiveActivity(job({ status: 'failed' }), snapshot(), now).tone).toBe('failed');
    expect(deriveLiveActivity(job(), snapshot({ approvals: [{ status: 'pending' }] }), now).tone).toBe('waiting');
    expect(deriveLiveActivity(job({ autopilot_state: 'blocked' }), snapshot(), now).tone).toBe('blocked');
  });
});

describe('isLiveJob', () => {
  it('polls only while something can change', () => {
    expect(isLiveJob(job({ status: 'deployed' }), snapshot())).toBe(false);
    expect(isLiveJob(job({ autopilot_state: 'driving' }), null)).toBe(true);
    expect(isLiveJob(job(), snapshot())).toBe(true);
    expect(isLiveJob(job(), snapshot({ steps: [] }))).toBe(false);
  });
});
