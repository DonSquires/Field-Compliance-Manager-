type Instant = string | null | undefined;
type Rate = number | string | null | undefined;

export interface ShiftHoursSource {
  scheduled_start: Instant;
  scheduled_end: Instant;
  actual_start: Instant;
  actual_end: Instant;
  payable_start: Instant;
  payable_end: Instant;
  unpaid_minutes: number | null | undefined;
  recorded_unpaid_minutes: number | null | undefined;
  /** Resolved hourly pay rate; absent when the reviewer may not see rates, null when no rule matches. */
  pay_rate?: Rate;
  charge_rate?: Rate;
}

export interface ShiftHoursFigures { rosteredHours: number | null; workedHours: number | null; payHours: number | null; unpaidMinutes: number }

const round2 = (value: number) => Math.round(value * 100) / 100;
const spanMinutes = (start: Instant, end: Instant): number | null => {
  if (!start || !end) return null;
  const minutes = (Date.parse(end) - Date.parse(start)) / 60000;
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
};
const toHours = (minutes: number | null) => minutes === null ? null : round2(Math.max(0, minutes) / 60);
const toRate = (value: Rate) => value === null || value === undefined || value === '' ? null : Number(value);

export function shiftHoursFigures(row: ShiftHoursSource): ShiftHoursFigures {
  const unpaid = Number(row.unpaid_minutes ?? 0);
  const recordedUnpaid = Number(row.recorded_unpaid_minutes ?? 0);
  const worked = spanMinutes(row.actual_start, row.actual_end);
  const payable = spanMinutes(row.payable_start, row.payable_end);
  return {
    rosteredHours: toHours(spanMinutes(row.scheduled_start, row.scheduled_end)),
    workedHours: toHours(worked === null ? null : worked - recordedUnpaid),
    payHours: toHours(payable === null ? null : payable - unpaid),
    unpaidMinutes: Math.round(unpaid),
  };
}

export interface ShiftHoursTotals {
  shifts: number;
  rosteredHours: number;
  workedHours: number;
  payHours: number;
  payAmount: number;
  chargeAmount: number;
  missingPayRate: number;
  missingChargeRate: number;
  ratesVisible: boolean;
}

/** Totals for the rows currently shown; money is pay hours × each shift's resolved rate. */
export function shiftHoursTotals(rows: ShiftHoursSource[]): ShiftHoursTotals {
  const totals: ShiftHoursTotals = { shifts: rows.length, rosteredHours: 0, workedHours: 0, payHours: 0, payAmount: 0, chargeAmount: 0, missingPayRate: 0, missingChargeRate: 0, ratesVisible: false };
  for (const row of rows) {
    const figures = shiftHoursFigures(row);
    totals.rosteredHours += figures.rosteredHours ?? 0;
    totals.workedHours += figures.workedHours ?? 0;
    totals.payHours += figures.payHours ?? 0;
    if (row.pay_rate !== undefined || row.charge_rate !== undefined) totals.ratesVisible = true;
    if (figures.payHours === null) continue;
    const pay = toRate(row.pay_rate);
    const charge = toRate(row.charge_rate);
    if (pay === null) totals.missingPayRate += 1; else totals.payAmount += figures.payHours * pay;
    if (charge === null) totals.missingChargeRate += 1; else totals.chargeAmount += figures.payHours * charge;
  }
  for (const key of ['rosteredHours', 'workedHours', 'payHours', 'payAmount', 'chargeAmount'] as const) totals[key] = round2(totals[key]);
  if (!totals.ratesVisible) { totals.missingPayRate = 0; totals.missingChargeRate = 0; }
  return totals;
}

export const formatHours = (hours: number | null | undefined) => hours === null || hours === undefined ? '—' : `${round2(hours)} ${hours === 1 ? 'hour' : 'hours'}`;
export const formatMinutes = (minutes: number) => `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
export const formatMoney = (amount: number) => amount.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' });
