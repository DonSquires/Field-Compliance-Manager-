import { describe, expect, it } from 'vitest';
import { COMMERCIAL_READY_STATUSES, commercialIssueAreas, commercialStatusLabel } from './rosterWords';

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
  it('lists only the readiness areas that still need action', () => {
    expect(commercialIssueAreas({ slot_id: 's1', pay_status: 'ready', billing_status: 'source_verified', quote_status: 'source_verified', geofence_status: 'source_verified', cost_centre_status: 'ready' })).toEqual([]);
    expect(commercialIssueAreas({ slot_id: 's2', pay_status: 'ready', billing_status: 'pending_materialization', quote_status: 'accepted', geofence_status: 'not_applicable', cost_centre_status: 'missing' })).toEqual(['billing', 'cost centre']);
  });
});