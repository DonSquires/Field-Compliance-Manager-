import { describe, expect, it } from 'vitest';
import { defaultFieldReportShift } from './fieldReportShift';

const now = Date.parse('2026-11-05T05:00:00Z');
const shift = (id: string, status: string, scheduled_start: string) => ({ id, status, scheduled_start });

describe('field report shift context', () => {
  it('prefers the active shift over later scheduled work and completed shifts', () => {
    expect(defaultFieldReportShift([
      shift('future', 'accepted', '2026-11-06T05:00:00Z'),
      shift('completed', 'completed', '2026-11-05T02:00:00Z'),
      shift('active', 'in_progress', '2026-11-04T20:00:00Z'),
    ], now)).toBe('active');
  });

  it('does not silently link a report to a future shift', () => {
    expect(defaultFieldReportShift([shift('future', 'accepted', '2026-11-06T05:00:00Z')], now)).toBe('');
  });

  it('selects the most recent started shift when none is active', () => {
    expect(defaultFieldReportShift([
      shift('older', 'completed', '2026-11-04T05:00:00Z'),
      shift('recent', 'completed', '2026-11-05T02:00:00Z'),
    ], now)).toBe('recent');
  });
});
