const assert = require('node:assert/strict');
const test = require('node:test');

const load = () => import('../supabase/functions/_shared/roster-block-plan.mjs');

const sites = [
  { key: 'nelson', label: 'Nelson ED' },
  { key: 'wairau', label: 'Wairau ED, Blenheim Hospital' },
];
const holidays = ['2026-12-25', '2026-12-26', '2026-12-28', '2027-01-01', '2027-01-02', '2027-01-04'];
const blocks = [
  { name: 'ED days Dec-Jan', start_date: '2026-12-21', end_date: '2027-01-04', shift_start: '11:30', shift_end: '20:00', unpaid_break_minutes: 30 },
  { name: 'ED overnights', dates: ['2026-12-24', '2026-12-25', '2026-12-31', '2027-01-01'], shift_start: '20:00', shift_end: '06:30', unpaid_break_minutes: 30 },
  { name: 'ED days Feb', start_date: '2027-02-01', end_date: '2027-02-14', shift_start: '11:30', shift_end: '20:00', unpaid_break_minutes: 30 },
];
const rates = { pay_per_hour: 30, charge_per_hour: 52, holiday_multiplier: 1.5 };

test('plans the NZ Health request across windows longer than 31 days', async () => {
  const { planTentativeRosterBlock } = await load();
  const plan = planTentativeRosterBlock({ sites, blocks, rates, holidays });
  // 15 + 14 day shifts and 4 overnights, at two sites.
  assert.equal(plan.summary.shifts, (15 + 14 + 4) * 2);
  // Per site: day shifts 8h paid (6 holiday days), overnights split at NZ midnight.
  assert.equal(plan.summary.ordinary_hours, 2 * (23 * 8 + 7));
  assert.equal(plan.summary.holiday_hours, 2 * (6 * 8 + 33));
  const nelson = plan.quote.lines.filter((l) => l.site_key === 'nelson');
  assert.equal(nelson.length, 2);
  assert.equal(nelson[0].unit_charge, 52);
  assert.equal(nelson[0].unit_cost, 30);
  assert.equal(nelson[1].unit_charge, 78);
  assert.equal(nelson[1].unit_cost, 45);
  assert.equal(plan.quote.gst_amount, Math.round(plan.quote.subtotal_charge * 15) / 100);
});

test('converts New Zealand wall-clock times, including daylight saving', async () => {
  const { planTentativeRosterBlock } = await load();
  const plan = planTentativeRosterBlock({
    sites: [sites[0]],
    blocks: [{ dates: ['2026-12-21'], shift_start: '11:30', shift_end: '20:00', unpaid_break_minutes: 30 }],
    rates,
  });
  // NZDT is UTC+13 in December.
  assert.equal(plan.shifts[0].scheduled_start, '2026-12-20T22:30:00.000Z');
  assert.equal(plan.shifts[0].scheduled_end, '2026-12-21T07:00:00.000Z');
  assert.equal(plan.shifts[0].ordinary_hours, 8);
});

test('rejects invalid input instead of guessing', async () => {
  const { planTentativeRosterBlock } = await load();
  const base = { sites, blocks, rates };
  assert.throws(() => planTentativeRosterBlock({ ...base, blocks: [] }), /shift block/);
  assert.throws(() => planTentativeRosterBlock({ ...base, blocks: [{ ...blocks[0], start_date: '2027-02-30' }] }), /valid/);
  assert.throws(() => planTentativeRosterBlock({ ...base, blocks: [{ ...blocks[0], unpaid_break_minutes: 600 }] }), /0-240/);
  assert.throws(() => planTentativeRosterBlock({ ...base, blocks: [{ ...blocks[0], site_keys: ['nowhere'] }] }), /unknown site/);
  assert.throws(() => planTentativeRosterBlock({ ...base, rates: { ...rates, holiday_multiplier: 9 } }), /holiday_multiplier/);
});
