import { describe, expect, it } from 'vitest';
import { ACTIVE_DISPATCH_JOB_STATUSES, schemaDispatchJobPriority, schemaDispatchJobStatus } from './dispatchStatus';

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
});
