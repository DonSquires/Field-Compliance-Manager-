
// Pure planner for a tentative roster block plus its quote. Shared by the Bob
// proposal edge function and node tests; it performs no I/O.

const NZ_TZ = 'Pacific/Auckland';
export const MAX_SHIFTS = 1500;
const MAX_BLOCK_DAYS = 400;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const nzFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: NZ_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function nzParts(ms) {
  const parts = {};
  for (const p of nzFormatter.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return parts;
}

function nzDateOf(ms) {
  const p = nzParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

// Converts a New Zealand wall-clock date and time to a UTC epoch (handles DST).
export function nzLocalToUtcMs(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm, 0);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const p = nzParts(guess);
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), 0);
    guess += wall - shown;
  }
  return guess;
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function assertDate(value, label) {
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function assertTime(value, label) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) throw new Error(`${label} must be HH:MM (24 hour, New Zealand time)`);
  return value;
}

function expandDates(block, label) {
  if (Array.isArray(block.dates) && block.dates.length) {
    return [...new Set(block.dates.map((d, i) => assertDate(d, `${label} dates[${i}]`)))].sort();
  }
  const start = assertDate(block.start_date, `${label} start_date`);
  const end = assertDate(block.end_date, `${label} end_date`);
  if (end < start) throw new Error(`${label} end_date is before start_date`);
  const dates = [];
  for (let d = start, n = 0; d <= end; d = addDays(d, 1), n += 1) {
    if (n >= MAX_BLOCK_DAYS) throw new Error(`${label} spans more than ${MAX_BLOCK_DAYS} days; split it`);
    dates.push(d);
  }
  return dates;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Paid time is split at New Zealand midnight so a night shift that crosses into
// a public holiday is charged for the holiday part only. The unpaid break comes
// off the first segment (the part of the shift that starts the day).
function paidSegments(startMs, endMs, breakMinutes, holidays) {
  const cuts = [startMs];
  let cursor = nzLocalToUtcMs(addDays(nzDateOf(startMs), 1), '00:00');
  while (cursor < endMs) {
    cuts.push(cursor);
    cursor = nzLocalToUtcMs(addDays(nzDateOf(cursor), 1), '00:00');
  }
  cuts.push(endMs);
  let remainingBreak = breakMinutes;
  const segments = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    let minutes = (cuts[i + 1] - cuts[i]) / 60000;
    const takeBreak = Math.min(remainingBreak, minutes);
    minutes -= takeBreak;
    remainingBreak -= takeBreak;
    segments.push({ date: nzDateOf(cuts[i]), minutes, holiday: holidays.has(nzDateOf(cuts[i])) });
  }
  return segments;
}

export function planTentativeRosterBlock(input) {
  const sites = Array.isArray(input?.sites) ? input.sites : [];
  const blocks = Array.isArray(input?.blocks) ? input.blocks : [];
  if (!sites.length) throw new Error('At least one site is required');
  if (!blocks.length) throw new Error('At least one shift block is required');
  const siteByKey = new Map(sites.map((s) => [String(s.key), s]));

  const rates = input.rates ?? {};
  const pay = Number(rates.pay_per_hour);
  const charge = Number(rates.charge_per_hour);
  const multiplier = rates.holiday_multiplier === undefined ? 1 : Number(rates.holiday_multiplier);
  const gstRate = input.gst_rate === undefined ? 0.15 : Number(input.gst_rate);
  if (![pay, charge].every((n) => Number.isFinite(n) && n >= 0 && n <= 10000)) throw new Error('pay_per_hour and charge_per_hour must be valid non-negative numbers');
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 5) throw new Error('holiday_multiplier must be between 1 and 5');
  if (!Number.isFinite(gstRate) || gstRate < 0 || gstRate > 1) throw new Error('gst_rate must be between 0 and 1');
  const guards = input.guards_per_shift === undefined ? 1 : Number(input.guards_per_shift);
  if (!Number.isInteger(guards) || guards < 1 || guards > 50) throw new Error('guards_per_shift must be a whole number from 1 to 50');
  const holidays = new Set((input.holidays ?? []).map((d, i) => assertDate(d, `holidays[${i}]`)));

  const shifts = [];
  blocks.forEach((block, index) => {
    const label = `blocks[${index}]`;
    const siteKeys = Array.isArray(block.site_keys) && block.site_keys.length ? block.site_keys.map(String) : sites.map((s) => String(s.key));
    for (const key of siteKeys) if (!siteByKey.has(key)) throw new Error(`${label} references unknown site '${key}'`);
    const shiftStart = assertTime(block.shift_start, `${label} shift_start`);
    const shiftEnd = assertTime(block.shift_end, `${label} shift_end`);
    const breakMinutes = block.unpaid_break_minutes === undefined ? 0 : Number(block.unpaid_break_minutes);
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 240) throw new Error(`${label} unpaid_break_minutes must be 0-240`);
    for (const date of expandDates(block, label)) {
      const startMs = nzLocalToUtcMs(date, shiftStart);
      // An end at or before the start means the shift finishes the next day.
      let endMs = nzLocalToUtcMs(date, shiftEnd);
      if (endMs <= startMs) endMs = nzLocalToUtcMs(addDays(date, 1), shiftEnd);
      if (endMs - startMs > 24 * 3600000) throw new Error(`${label} shift is longer than 24 hours`);
      if (breakMinutes * 60000 >= endMs - startMs) throw new Error(`${label} unpaid break consumes the whole shift`);
      const segments = paidSegments(startMs, endMs, breakMinutes, holidays);
      const ordinaryHours = segments.filter((s) => !s.holiday).reduce((a, s) => a + s.minutes, 0) / 60;
      const holidayHours = segments.filter((s) => s.holiday).reduce((a, s) => a + s.minutes, 0) / 60;
      for (const siteKey of siteKeys) {
        for (let g = 0; g < guards; g += 1) {
          shifts.push({
            site_key: siteKey,
            block: String(block.name ?? `Block ${index + 1}`),
            local_date: date,
            scheduled_start: new Date(startMs).toISOString(),
            scheduled_end: new Date(endMs).toISOString(),
            unpaid_break_minutes: breakMinutes,
            ordinary_hours: round2(ordinaryHours),
            holiday_hours: round2(holidayHours),
          });
        }
      }
    }
  });
  if (!shifts.length) throw new Error('The request produced no shifts');
  if (shifts.length > MAX_SHIFTS) throw new Error(`The request produced ${shifts.length} shifts; the limit is ${MAX_SHIFTS}. Split it into separate proposals`);

  const quoteLines = [];
  for (const site of sites) {
    const own = shifts.filter((s) => s.site_key === String(site.key));
    if (!own.length) continue;
    const ordinary = round2(own.reduce((a, s) => a + s.ordinary_hours, 0));
    const holiday = round2(own.reduce((a, s) => a + s.holiday_hours, 0));
    if (ordinary > 0) {
      quoteLines.push({ site_key: String(site.key), kind: 'labour', description: `${site.label}: static guard, ordinary hours`, quantity: ordinary, unit_cost: pay, unit_charge: charge });
    }
    if (holiday > 0) {
      quoteLines.push({
        site_key: String(site.key), kind: 'labour',
        description: `${site.label}: static guard, public holiday hours (x${multiplier})`,
        quantity: holiday, unit_cost: round2(pay * multiplier), unit_charge: round2(charge * multiplier),
      });
    }
  }
  const totalCost = round2(quoteLines.reduce((a, l) => a + l.quantity * l.unit_cost, 0));
  const subtotal = round2(quoteLines.reduce((a, l) => a + l.quantity * l.unit_charge, 0));
  const gst = round2(subtotal * gstRate);
  return {
    shifts,
    quote: {
      lines: quoteLines, gst_rate: gstRate,
      total_cost: totalCost, subtotal_charge: subtotal, gst_amount: gst, total_charge: round2(subtotal + gst),
    },
    summary: {
      shifts: shifts.length,
      ordinary_hours: round2(shifts.reduce((a, s) => a + s.ordinary_hours, 0)),
      holiday_hours: round2(shifts.reduce((a, s) => a + s.holiday_hours, 0)),
      first_start: shifts.map((s) => s.scheduled_start).sort()[0],
      last_end: shifts.map((s) => s.scheduled_end).sort().slice(-1)[0],
    },
  };
}

