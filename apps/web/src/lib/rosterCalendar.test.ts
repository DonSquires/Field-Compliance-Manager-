import { describe, expect, it } from 'vitest';
import { moveRosterPeriod, nzRosterHolidays, rosterPeriod } from './rosterCalendar';

describe('roster calendar horizons', () => {
  it('creates exact week, fortnight, and calendar-month periods', () => {
    const anchor = new Date(2026, 7, 30);
    expect(rosterPeriod(anchor, 'week').days).toHaveLength(7);
    expect(rosterPeriod(anchor, 'fortnight').days).toHaveLength(14);
    expect(rosterPeriod(anchor, 'month').days).toHaveLength(31);
    expect(rosterPeriod(anchor, 'month').start.getDate()).toBe(1);
  });

  it('moves by the selected horizon', () => {
    const anchor = new Date(2026, 7, 30);
    expect(moveRosterPeriod(anchor, 'week', 1).getDate()).toBe(6);
    expect(moveRosterPeriod(anchor, 'fortnight', -1).getDate()).toBe(16);
    expect(moveRosterPeriod(anchor, 'month', 1).getMonth()).toBe(8);
  });
});

describe('New Zealand roster holidays', () => {
  it('automatically includes national and substitute public holidays', () => {
    const holidays = nzRosterHolidays(new Date(2026, 0, 1), new Date(2027, 0, 1), null);
    expect(holidays.some((holiday) => holiday.name === 'Matariki' && holiday.date === '2026-07-10')).toBe(true);
    expect(holidays.some((holiday) => holiday.name.includes('ANZAC Day (substitute day)'))).toBe(true);
    expect(holidays.every((holiday) => holiday.scope === 'national')).toBe(true);
  });

  it('adds the configured regional anniversary day', () => {
    const holidays = nzRosterHolidays(new Date(2026, 0, 1), new Date(2026, 1, 1), 'AUK');
    expect(holidays).toContainEqual({ date: '2026-01-26', name: 'Provincial anniversary day', scope: 'regional' });
  });
});