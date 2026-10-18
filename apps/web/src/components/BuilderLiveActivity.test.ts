import { describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { deriveLiveActivity, isLiveJob, STALL_AFTER_MS, type LiveJob, type LiveSnapshot } from './BuilderLiveActivity';
import { BuilderLiveActivity, modelRunExplanation } from './BuilderLiveActivity';
import { modelFailure, inferenceUsage } from '../../../../supabase/functions/_shared/builder-run-telemetry';

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

describe('model failure and throughput evidence', () => {
  it('renders a rejected response and measured speed without claiming billing failure or deployment', () => {
    const evidence = snapshot({ modelRuns: [{
      id: 'm', step_id: 'b', provider: 'gpu_workstation', model_name: 'qwen2.5-coder:7b',
      status: 'failed', started_at: iso(30000), completed_at: iso(5000), created_at: iso(30000),
      input_tokens: 30, output_tokens: 10, total_tokens: 40, turns: null, phase: null,
      failure_kind: 'validation', output_validated: false, output_tokens_per_second: 10, load_ms: 2000,
    }] });
    try {
      render(React.createElement(BuilderLiveActivity, { job: job(), snapshot: evidence, now, pollState: 'idle', observedAt: iso(0), changedFiles: null }));
      expect(screen.getByRole('region', { name: 'Bob live activity' })).toBeTruthy();
      expect(screen.getByText(/Response received, but rejected by validation/)).toBeTruthy();
      expect(screen.getByText(/10.0 output tokens\/s.*generation speed, not task success/)).toBeTruthy();
      expect(screen.queryByText('no usage')).toBeNull();
    } finally {
      cleanup();
    }
  });
  it('distinguishes rejected output from billing, connectivity, busy, timeout and unknown errors', () => {
    expect(modelFailure({ status: 'failed', error: 'model output failed validation: source scope' })).toBe('validation');
    expect(modelFailure({ status: 'failed', error: 'model gateway unavailable' })).toBe('connection');
    expect(modelFailure({ status: 'failed', usage_metadata: { failure: { code: 'provider_busy' } } })).toBe('busy');
    expect(modelFailure({ status: 'timeout' })).toBe('timeout');
    expect(modelFailure({ status: 'failed', error: 'insufficient_quota' })).toBe('quota');
    expect(modelFailure({ status: 'failed', error: 'something unclassified' })).toBe('unknown');
    expect(modelFailure({ status: 'completed', error: 'historical error' })).toBeNull();
  });
  it('only publishes finite measured throughput and explicit validation outcomes', () => {
    expect(inferenceUsage({ output_validated: false, inference: { output_tokens_per_second: 10, load_ms: 2000 } }))
      .toEqual({ output_validated: false, output_tokens_per_second: 10, load_ms: 2000 });
    expect(inferenceUsage({ inference: { output_tokens_per_second: Infinity, load_ms: -1 } }))
      .toEqual({ output_validated: null, output_tokens_per_second: null, load_ms: null });
  });
  it('explains validation failure without presenting it as an empty balance', () => {
    expect(modelRunExplanation({ status: 'failed', failure_kind: 'validation' })).toContain('Not a connection or billing failure');
  });
});

describe('deriveLiveActivity', () => {
  it('uses the model heartbeat and step while the job still names completed design work', () => {
    const evidence = snapshot({
      steps: snapshot().steps.map(step => step.id === 'b' ? { ...step, status: 'pending', started_at: null } : step),
      modelRuns: [{
        id: 'model', step_id: 'b', provider: 'ollama', model_name: 'qwen2.5-coder:7b',
        status: 'running', started_at: iso(15 * 60_000), created_at: iso(15 * 60_000), updated_at: iso(30_000),
        completed_at: null, input_tokens: null, output_tokens: null, total_tokens: null, turns: 4, phase: 'authoring',
      }],
    });
    const staleJob = job({ current_step_name: 'product_analysis', updated_at: iso(15 * 60_000) });
    const live = deriveLiveActivity(staleJob, evidence, now);
    expect(live.tone).toBe('working');
    expect(live.stepLabel).toBe('frontend implementation');
    expect(live.stepPosition).toBe(2);
    expect(live.lastActivityAt).toBe(iso(30_000));
    expect(live.doneCount).toBe(1);
    const quiet = { ...evidence, modelRuns: evidence.modelRuns?.map(run => ({ ...run, updated_at: iso(15 * 60_000) })) };
    expect(deriveLiveActivity(staleJob, quiet, now).tone).toBe('stalled');
    const legacy = { ...evidence, modelRuns: evidence.modelRuns?.map(run => ({ ...run, updated_at: undefined })) };
    expect(deriveLiveActivity(staleJob, legacy, now).tone).toBe('stalled');
    expect(deriveLiveActivity({ ...staleJob, status: 'cancelled' }, evidence, now).tone).toBe('idle');
  });

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

  it('shows the successor for a superseded attempt, not a promise to resume', () => {
    const old = job({ autopilot_state: 'done', autopilot_requested_by: 'owner', current_step_name: 'product_analysis',
      autopilot_report: { resumed_as_job_id: '0c388688-c566-42b0-b700-d8267f602ddb' } });
    const failed = snapshot({ steps: snapshot().steps.map(step => step.id === 'b' ? { ...step, status: 'failed', error: 'generation: source checkout does not match the target SHA' } : step) });
    const activity = deriveLiveActivity(old, failed, now);
    expect(activity.headline).toBe('Continued in a newer job');
    expect(activity.detail).toContain('0c388688');
    expect(activity.detail).toContain('not proof of success');
    expect(activity.stepLabel).toBe('frontend implementation');
    expect(isLiveJob(old, snapshot())).toBe(false);
  });

  it('shows the real failed step and cause instead of the last completed design step', () => {
    const failed = snapshot({ steps: snapshot().steps.map(step => step.id === 'b' ? { ...step, status: 'failed', error: 'generation: turn budget exhausted' } : step) });
    const activity = deriveLiveActivity(job({ current_step_name: 'product_analysis', autopilot_state: 'blocked' }), failed, now);
    expect(activity.stepLabel).toBe('frontend implementation');
    expect(activity.detail).toBe('generation: turn budget exhausted');
  });

  it('never promises an automatic resume based only on a recorded requester', () => {
    const activity = deriveLiveActivity(job({ autopilot_requested_by: 'owner' }), snapshot({ steps: [] }), now);
    expect(activity.tone).toBe('idle');
    expect(activity.detail).not.toMatch(/will resume/);
    expect(deriveLiveActivity(job({ autopilot_state: 'done' }), snapshot(), now).tone).toBe('idle');
    expect(isLiveJob(job({ autopilot_state: 'done' }), snapshot())).toBe(false);
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
