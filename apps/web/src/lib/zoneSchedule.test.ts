import { describe, expect, it } from 'vitest';
import { ALWAYS_ACTIVE, monthsWords, parseZoneSchedule, zoneScheduleArgs, zoneScheduleProblem, zoneScheduleWords } from './zoneSchedule';

describe('zone activation schedule words (ISO days, Monday first; 24-hour by default)', () => {
  it('reads stored JSON, treating a legacy 0 as Sunday and nothing as always active', () => {
    expect(parseZoneSchedule(null)).toEqual(ALWAYS_ACTIVE);
    expect(parseZoneSchedule({})).toEqual(ALWAYS_ACTIVE);
    expect(parseZoneSchedule({ days: [0, 6], start: '22:00', end: '06:00' })).toEqual({ days: [6, 7], months: [], start: '22:00', end: '06:00' });
    expect(parseZoneSchedule({ days: [1, 2, 3, 4, 5], start: '08:00:00', end: '18:00:00', months: [12, 1, 2] })).toEqual({ days: [1, 2, 3, 4, 5], months: [1, 2, 12], start: '08:00', end: '18:00' });
  });

  it('says the schedule in plain words', () => {
    expect(zoneScheduleWords(ALWAYS_ACTIVE)).toBe('Always active');
    expect(zoneScheduleWords({ days: [1, 2, 3, 4, 5], months: [], start: '08:00', end: '18:00' })).toBe('Mon\u2013Fri, 08:00\u201318:00');
    expect(zoneScheduleWords({ days: [1, 2, 3, 4, 5, 6, 7], months: [12, 1, 2], start: '22:00', end: '06:00' })).toBe('every day, 22:00\u201306:00 (overnight), Dec\u2013Feb');
    expect(zoneScheduleWords({ days: [6, 7], months: [], start: '', end: '' })).toBe('Sat, Sun, any time of day');
  });

  it('names months including runs that wrap the year end', () => {
    expect(monthsWords([])).toBe('all year');
    expect(monthsWords([12, 1, 2])).toBe('Dec\u2013Feb');
    expect(monthsWords([10, 11, 12, 1, 2, 3, 4])).toBe('Oct\u2013Apr');
    expect(monthsWords([1, 12])).toBe('Dec, Jan');
    expect(monthsWords([1, 3, 6])).toBe('Jan, Mar, Jun');
  });

  it('turns editor state into RPC arguments and refuses half a window', () => {
    expect(zoneScheduleArgs({ days: [1, 2], months: [], start: '', end: '' })).toEqual({ p_days: [1, 2], p_start: null, p_end: null, p_months: null });
    expect(zoneScheduleArgs({ days: [], months: [6], start: '07:00', end: '19:00' })).toEqual({ p_days: [1, 2, 3, 4, 5, 6, 7], p_start: '07:00', p_end: '19:00', p_months: [6] });
    expect(zoneScheduleProblem({ days: [1], months: [], start: '07:00', end: '' })).toMatch(/both a start and an end/);
    expect(zoneScheduleProblem({ days: [], months: [], start: '', end: '' })).toMatch(/at least one day/);
    expect(zoneScheduleProblem({ days: [1], months: [], start: '07:00', end: '07:00' })).toMatch(/must differ/);
    expect(zoneScheduleProblem(ALWAYS_ACTIVE)).toBeNull();
  });
});
