/**
 * Zone activation schedule (location_zones.active_schedule) — plain words and the wire shape.
 * Days are ISO (1 = Monday … 7 = Sunday; a legacy 0 is Sunday); months 1–12; times "HH:MM" (start > end wraps overnight).
 * Null / {} means the zone is always active. Evaluated server-side by _geofence_active_at.
 */
import { contractedDaysWords } from './rosterWords';

export interface ZoneSchedule { days: number[]; months: number[]; start: string; end: string }
export const ALWAYS_ACTIVE: ZoneSchedule = { days: [1, 2, 3, 4, 5, 6, 7], months: [], start: '', end: '' };
export const MONTH_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const hhmm = (value: unknown): string => (typeof value === 'string' && /^\d{1,2}:\d{2}/.test(value) ? value.slice(0, 5).padStart(5, '0') : '');
const numbers = (value: unknown, min: number, max: number): number[] =>
  Array.isArray(value) ? Array.from(new Set(value.map(Number).filter((n) => Number.isInteger(n) && n >= min && n <= max))).sort((a, b) => a - b) : [];

/** Stored JSON -> editor state. A legacy day 0 becomes Sunday (7). */
export const parseZoneSchedule = (raw: Record<string, unknown> | null | undefined): ZoneSchedule => {
  if (!raw || typeof raw !== 'object') return ALWAYS_ACTIVE;
  const rawDays = Array.isArray(raw.days) ? raw.days.map((d) => (Number(d) === 0 ? 7 : Number(d))) : [];
  const days = numbers(rawDays, 1, 7);
  return { days: days.length ? days : [1, 2, 3, 4, 5, 6, 7], months: numbers(raw.months, 1, 12), start: hhmm(raw.start), end: hhmm(raw.end) };
};

/** Months (1–12) -> "all year", "Dec–Feb" (wrapping runs included), or "Jan, Mar, Jun". */
export const monthsWords = (months: number[]): string => {
  const set = numbers(months, 1, 12);
  if (set.length === 0 || set.length === 12) return 'all year';
  // A run that wraps the year end (e.g. 12,1,2) reads as Dec–Feb; a two-month wrap keeps calendar order (Dec, Jan).
  for (let startIndex = 0; startIndex < set.length; startIndex += 1) {
    const rotated = [...set.slice(startIndex), ...set.slice(0, startIndex)];
    const contiguous = rotated.every((m, i) => i === 0 || m === (rotated[i - 1] % 12) + 1);
    if (contiguous && set.length >= 3) return `${MONTH_SHORT[rotated[0]]}\u2013${MONTH_SHORT[rotated[rotated.length - 1]]}`;
    if (contiguous) return rotated.map((m) => MONTH_SHORT[m]).join(', ');
  }
  return set.map((m) => MONTH_SHORT[m]).join(', ');
};

/** "Always active" | "Mon–Fri, 08:00–18:00" | "every day, 22:00–06:00 (overnight), Dec–Feb". */
export const zoneScheduleWords = (schedule: ZoneSchedule): string => {
  const days = contractedDaysWords(schedule.days);
  const months = monthsWords(schedule.months);
  const timed = Boolean(schedule.start && schedule.end);
  if (days === 'every day' && months === 'all year' && !timed) return 'Always active';
  const parts = [days];
  if (timed) parts.push(`${schedule.start}\u2013${schedule.end}${schedule.start > schedule.end ? ' (overnight)' : ''}`);
  else parts.push('any time of day');
  if (months !== 'all year') parts.push(months);
  return parts.join(', ');
};

/** Editor state -> RPC arguments for manage_zone_active_schedule. */
export const zoneScheduleArgs = (schedule: ZoneSchedule) => ({
  p_days: schedule.days.length ? schedule.days : [1, 2, 3, 4, 5, 6, 7],
  p_start: schedule.start && schedule.end ? schedule.start : null,
  p_end: schedule.start && schedule.end ? schedule.end : null,
  p_months: schedule.months.length ? schedule.months : null,
});

/** What the editor must say before it lets a person save. */
export const zoneScheduleProblem = (schedule: ZoneSchedule): string | null => {
  if (schedule.days.length === 0) return 'Pick at least one day, or choose every day.';
  if (Boolean(schedule.start) !== Boolean(schedule.end)) return 'Give both a start and an end time, or clear both for any time of day.';
  if (schedule.start && schedule.start === schedule.end) return 'Start and end times must differ (clear both for any time of day).';
  return null;
};
