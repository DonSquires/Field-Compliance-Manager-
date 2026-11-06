import { describe, expect, it } from 'vitest';
import { reportReceiptMatchesShift, resolveReportShift } from './officerReportShift';

const first = '10000000-0000-4000-8000-000000000001';
const requested = '10000000-0000-4000-8000-000000000002';
const missing = '10000000-0000-4000-8000-000000000003';
describe('officer report shift context', () => {
  it('initializes the exact requested assigned shift, not the first result', () => {
    expect(resolveReportShift([first, requested], requested, null)).toEqual({ shiftId: requested, error: null });
  });
  it.each([missing, 'not-a-uuid', ''])('never falls back from unavailable/invalid request %s', (id) => {
    const result = resolveReportShift([first], id, null);
    expect(result.shiftId).not.toBe(first);
    expect(result.error).toContain(id === missing ? 'unavailable' : 'invalid');
  });
  it('preserves intentional changes, including No related shift, across refresh', () => {
    expect(resolveReportShift([first, requested], requested, first)).toEqual({ shiftId: first, error: null });
    expect(resolveReportShift([first, requested], requested, '')).toEqual({ shiftId: '', error: null });
  });
  it('fails explicitly when a selected shift disappears without silently replacing it', () => {
    expect(resolveReportShift([first], requested, requested)).toEqual({
      shiftId: requested, error: expect.stringContaining('unavailable'),
    });
  });
  it('keeps the existing first-shift default only when there was no request or selection', () => {
    expect(resolveReportShift([first], null, null)).toEqual({ shiftId: first, error: null });
  });
  it('requires an exact shift receipt, valid report UUID and receipt timestamp', () => {
    const receipt = { id: first, received_at: '2026-11-06T00:00:00Z', shift_id: requested };
    expect(reportReceiptMatchesShift(receipt, requested)).toBe(true);
    expect(reportReceiptMatchesShift(receipt, first)).toBe(false);
    expect(reportReceiptMatchesShift({ ...receipt, shift_id: null }, requested)).toBe(false);
    expect(reportReceiptMatchesShift({ ...receipt, id: 'report' }, requested)).toBe(false);
    expect(reportReceiptMatchesShift({ ...receipt, received_at: 'bad' }, requested)).toBe(false);
    expect(reportReceiptMatchesShift({ ...receipt, shift_id: null }, null)).toBe(true);
  });
});
