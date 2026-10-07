import { describe, expect, it } from 'vitest';
import { ACTIVITY_PAGE_SIZE, sanitiseSearchTerm } from '../lib/activitySearch';

describe('activity record search', () => {
  it('strips characters that would break or widen a PostgREST filter', () => {
    expect(sanitiseSearchTerm('abc,zone_id.eq.1)')).toBe('abc zone_id.eq.1');
    expect(sanitiseSearchTerm('  50%  *wild* ')).toBe('50 wild');
    expect(sanitiseSearchTerm('("x")')).toBe('x');
  });

  it('pages in a human-readable size', () => {
    expect(ACTIVITY_PAGE_SIZE).toBeGreaterThanOrEqual(10);
    expect(ACTIVITY_PAGE_SIZE).toBeLessThanOrEqual(100);
  });
});
