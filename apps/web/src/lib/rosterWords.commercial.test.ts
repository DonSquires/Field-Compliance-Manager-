import { describe, expect, it } from 'vitest';
import { COMMERCIAL_READY_STATUSES, commercialStatusLabel } from './rosterWords';

describe('commercial readiness words', () => {
  it('treats seeded source-of-record jobs as needing no action', () => {
    expect(COMMERCIAL_READY_STATUSES).toContain('source_verified');
    expect(commercialStatusLabel('source_verified')).toBe('Verified by source records');
  });
  it('keeps real gaps visible in plain words', () => {
    expect(COMMERCIAL_READY_STATUSES).not.toContain('pending_materialization');
    expect(commercialStatusLabel('mapped_unverified')).toBe('Mapped unverified');
    expect(commercialStatusLabel(null)).toBe('Not recorded');
  });
});