import { describe, expect, it } from 'vitest';
import {
  ACTIVE_DISPATCH_JOB_STATUSES,
  schemaDispatchJobPriority,
  schemaDispatchJobStatus,
  schemaDispatchResourceStatus,
  schemaShiftHealth,
  shiftHealthBadge,
  canTransitionDispatchStatus,
} from './dispatchStatus';

describe('dispatch status schema mapping', () => {
  it('maps legacy UI statuses to the canonical database lifecycle', () => {
    expect(schemaDispatchJobStatus('open')).toBe('pending');
    expect(schemaDispatchJobStatus('assigned')).toBe('dispatched');
    expect(schemaDispatchJobStatus('in_progress')).toBe('en_route');
    expect(schemaDispatchJobStatus('completed')).toBe('completed');
  });

  it('keeps the active dispatch query aligned to valid database values', () => {
    expect(ACTIVE_DISPATCH_JOB_STATUSES).toContain('pending');
    expect(ACTIVE_DISPATCH_JOB_STATUSES).toContain('en_route');
    expect(ACTIVE_DISPATCH_JOB_STATUSES).not.toContain('open');
    expect(ACTIVE_DISPATCH_JOB_STATUSES).not.toContain('in_progress');
  });

  it('maps legacy UI priorities to the canonical database enum', () => {
    expect(schemaDispatchJobPriority('medium')).toBe('normal');
    expect(schemaDispatchJobPriority('critical')).toBe('urgent');
    expect(schemaDispatchJobPriority('high')).toBe('high');
    expect(schemaDispatchJobPriority('urgent')).toBe('urgent');
  });

  it('normalizes shift health to canonical schema values and safe UI badges', () => {
    expect(schemaShiftHealth('healthy')).toBe('on_track');
    expect(schemaShiftHealth('degraded')).toBe('at_risk');
    expect(schemaShiftHealth('critical')).toBe('critical');
    expect(schemaShiftHealth('on_track')).toBe('on_track');

    expect(shiftHealthBadge('on_track')).toMatchObject({ label: 'On Track', tone: 'healthy' });
    expect(shiftHealthBadge('at_risk')).toMatchObject({ label: 'At Risk', tone: 'degraded' });
    expect(shiftHealthBadge('breached')).toMatchObject({ label: 'Breached', tone: 'critical' });
  });

  it('normalizes dispatch resource states to the canonical schema enum', () => {
    expect(schemaDispatchResourceStatus('available')).toBe('available');
    expect(schemaDispatchResourceStatus('assigned')).toBe('busy');
    expect(schemaDispatchResourceStatus('busy')).toBe('busy');
    expect(schemaDispatchResourceStatus('offline')).toBe('offline');
  });
});
  it('enforces forward dispatch lifecycle transitions', () => {
    expect(canTransitionDispatchStatus('pending', 'dispatched')).toBe(true);
    expect(canTransitionDispatchStatus('dispatched', 'en_route')).toBe(true);
    expect(canTransitionDispatchStatus('en_route', 'on_scene')).toBe(true);
    expect(canTransitionDispatchStatus('on_scene', 'completed')).toBe(true);
    expect(canTransitionDispatchStatus('completed', 'en_route')).toBe(false);
    expect(canTransitionDispatchStatus('pending', 'completed')).toBe(false);
  });
