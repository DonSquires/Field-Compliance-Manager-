import { describe, expect, it } from 'vitest';
import { formatHours, formatMinutes, shiftHoursFigures, shiftHoursTotals } from './shiftHoursTotals';

const shift = (overrides: Record<string, unknown> = {}) => ({
  scheduled_start: '2026-11-10T19:00:00Z', scheduled_end: '2026-11-11T03:30:00Z',
  actual_start: '2026-11-10T19:02:00Z', actual_end: '2026-11-11T03:31:00Z',
  payable_start: '2026-11-10T19:00:00Z', payable_end: '2026-11-11T03:30:00Z',
  unpaid_minutes: 30, recorded_unpaid_minutes: 29,
  pay_rate: 30, charge_rate: 45,
  ...overrides,
});

describe('shift hours figures', () => {
  it('reads rostered 8.5 hours, 30 minutes unpaid and 8 paid hours', () => {
    expect(shiftHoursFigures(shift())).toEqual({ rosteredHours: 8.5, workedHours: 8, payHours: 8, unpaidMinutes: 30 });
    expect(formatHours(8.5)).toBe('8.5 hours');
    expect(formatHours(8)).toBe('8 hours');
    expect(formatHours(1)).toBe('1 hour');
    expect(formatMinutes(30)).toBe('30 minutes');
  });

  it('leaves worked and pay unknown until the shift has recorded times', () => {
    expect(shiftHoursFigures(shift({ actual_start: null, actual_end: null, payable_start: null, payable_end: null })))
      .toEqual({ rosteredHours: 8.5, workedHours: null, payHours: null, unpaidMinutes: 30 });
    expect(formatHours(null)).toBe('—');
  });
});

describe('filtered shift totals', () => {
  it('adds hours and money only for shifts that have the figure, and counts the gaps', () => {
    const totals = shiftHoursTotals([shift(), shift({ pay_rate: null, charge_rate: null }), shift({ actual_start: null, actual_end: null, payable_start: null, payable_end: null })]);
    expect(totals).toEqual({
      shifts: 3, rosteredHours: 25.5, workedHours: 16, payHours: 16,
      payAmount: 240, chargeAmount: 360, missingPayRate: 1, missingChargeRate: 1, ratesVisible: true,
    });
  });

  it('hides money when the reviewer is not given rates', () => {
    const totals = shiftHoursTotals([shift({ pay_rate: undefined, charge_rate: undefined })]);
    expect(totals.ratesVisible).toBe(false);
    expect(totals.payAmount).toBe(0);
  });
});
