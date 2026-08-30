import { NZ_NATIONAL_HOLIDAYS, NZ_REGIONAL_HOLIDAYS } from './nzHolidays.generated';

export type RosterHorizon = 'week' | 'fortnight' | 'month';
export interface RosterHoliday { date: string; name: string; scope: 'national' | 'regional'; }

export const NZ_HOLIDAY_REGIONS = [
  ['AUK', 'Auckland Province'], ['BOP', 'Bay of Plenty'], ['CAN', 'Canterbury'], ['CIT', 'Chatham Islands'],
  ['GIS', 'Gisborne'], ['HKB', "Hawke's Bay"], ['MBH', 'Marlborough'], ['MWT', 'Manawatu-Wanganui'],
  ['NSN', 'Nelson'], ['NTL', 'Northland'], ['OTA', 'Otago Province'], ['STL', 'Southland'], ['TAS', 'Tasman'],
  ['TKI', 'Taranaki'], ['WKO', 'Waikato'], ['WGN', 'Wellington Province'], ['WTC', 'Westland'],
] as const;

const startOfWeek = (date: Date) => { const value = new Date(date); value.setDate(value.getDate() - ((value.getDay() + 6) % 7)); value.setHours(0, 0, 0, 0); return value; };
const addDays = (date: Date, days: number) => { const value = new Date(date); value.setDate(value.getDate() + days); return value; };
export const calendarDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

export function rosterPeriod(anchor: Date, horizon: RosterHorizon) {
  if (horizon === 'month') {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    return { start, end, days: Array.from({ length: Math.round((end.getTime() - start.getTime()) / 86_400_000) }, (_, index) => addDays(start, index)) };
  }
  const start = startOfWeek(anchor); const length = horizon === 'fortnight' ? 14 : 7;
  return { start, end: addDays(start, length), days: Array.from({ length }, (_, index) => addDays(start, index)) };
}

export function moveRosterPeriod(anchor: Date, horizon: RosterHorizon, direction: -1 | 1) {
  if (horizon === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
  return addDays(anchor, direction * (horizon === 'fortnight' ? 14 : 7));
}

export function nzRosterHolidays(start: Date, end: Date, regionCode: string | null): RosterHoliday[] {
  const years = Array.from(new Set([start.getFullYear(), end.getFullYear()]));
  const startDate = calendarDate(start); const endDate = calendarDate(end);
  return years.flatMap((year) => [
    ...(NZ_NATIONAL_HOLIDAYS[year] ?? []).map(([date, name]) => ({ date, name, scope: 'national' as const })),
    ...(regionCode ? (NZ_REGIONAL_HOLIDAYS[regionCode]?.[year] ?? []) : []).map(([date, name]) => ({ date, name, scope: 'regional' as const })),
  ])
    .filter((holiday) => holiday.date >= startDate && holiday.date < endDate)
    .filter((holiday, index, rows) => rows.findIndex((row) => row.date === holiday.date && row.name === holiday.name) === index)
    .sort((left, right) => left.date.localeCompare(right.date));
}