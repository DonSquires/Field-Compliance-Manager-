import { describe, expect, it } from 'vitest';

import { describeDrawdown, drawdownAdjustment, monthBounds, overrunJustificationProblem, parseFeeDrawdown, previousMonth, settlementLabel } from './feeDrawdown';

const raw = {
  service_agreement_id: 'a', commercial_model: 'fixed_price_with_extras', applies: true, fee: 13333, fee_source: 'accepted_quote', overrun_policy: 'bill_as_extra',
  months: [
    { month: '2026-09', label: 'September 2026', period_start: '2026-09-01', period_end: '2026-09-30', fee: 13333,
      contract_work: { imported: { amount: '9473.2', rows: 40, extra_amount: 120, unclassified_rows: 3, unclassified_amount: 80 }, callouts: { amount: 0, lines: 0 }, patrol_visits: { amount: 0, lines: 0 }, total: 9473.2 },
      balance: 3859.8, outcome: 'credit', blockers: [{ code: 'unclassified_imported_rows', message: '3 imported rows are not classified' }], settlement: null },
    { month: '2026-05', label: 'May 2026', fee: 13333, contract_work: { total: 14348.52 }, balance: -1015.52, outcome: 'overrun', blockers: [],
      settlement: { outcome: 'overrun_billed', adjustment_amount: 1015.52, invoice_id: 'i', invoice_number: 'INV-1', invoice_status: 'draft', justification: null } },
  ],
};

describe('monthly fee drawdown', () => {
  it('parses the RPC payload defensively', () => {
    const d = parseFeeDrawdown(raw);
    expect(d).toMatchObject({ applies: true, fee: 13333, overrunPolicy: 'bill_as_extra' });
    expect(d.months[0]).toMatchObject({ label: 'September 2026', balance: 3859.8, outcome: 'credit', settlement: null });
    expect(d.months[0].work).toMatchObject({ imported: 9473.2, importedExtra: 120, total: 9473.2 });
    expect(d.months[0].blockers[0].code).toBe('unclassified_imported_rows');
    expect(d.months[1].settlement).toMatchObject({ outcome: 'overrun_billed', invoiceNumber: 'INV-1', adjustmentAmount: 1015.52 });
    expect(parseFeeDrawdown(null)).toEqual({ applies: false, fee: null, overrunPolicy: null, months: [] });
    expect(parseFeeDrawdown({ applies: false, overrun_policy: 'bill_as_extra' }).overrunPolicy).toBeNull();
  });

  it('describes the month against the fee and the settlement in plain words', () => {
    expect(describeDrawdown({ fee: 13333, balance: 3859.8, work: { imported: 0, callouts: 0, patrolVisits: 0, total: 0, importedExtra: 0 } })).toMatch(/3,859\.80 of the fee not used/);
    expect(describeDrawdown({ fee: 13333, balance: -10, work: { imported: 0, callouts: 0, patrolVisits: 0, total: 0, importedExtra: 0 } })).toMatch(/10\.00 above the fee/);
    expect(describeDrawdown({ fee: 13333, balance: 0, work: { imported: 0, callouts: 0, patrolVisits: 0, total: 0, importedExtra: 0 } })).toBe('Fee fully used');
    expect(describeDrawdown({ fee: null, balance: null, work: { imported: 0, callouts: 0, patrolVisits: 0, total: 0, importedExtra: 0 } })).toBe('No monthly fee recorded');
    expect(settlementLabel({ outcome: 'credit', adjustmentAmount: -50, invoiceId: '', invoiceNumber: '', invoiceStatus: '', justification: null })).toMatch(/Credited .*50\.00/);
    expect(settlementLabel({ outcome: 'overrun_absorbed', adjustmentAmount: 0, invoiceId: '', invoiceNumber: '', invoiceStatus: '', justification: null })).toBe('Overrun absorbed');
  });

  it('mirrors the invoice: credit unused value, Extra above the fee only when agreed or decided', () => {
    expect(drawdownAdjustment({ balance: 100 }, 'justify', null)).toEqual({ kind: 'credit', amount: -100 });
    expect(drawdownAdjustment({ balance: 0 }, 'justify', null)).toEqual({ kind: 'none', amount: 0 });
    expect(drawdownAdjustment({ balance: -100 }, 'justify', null)).toEqual({ kind: 'decide', amount: 0 });
    expect(drawdownAdjustment({ balance: -100 }, 'bill_as_extra', null)).toEqual({ kind: 'extra', amount: 100 });
    expect(drawdownAdjustment({ balance: -100 }, 'bill_as_extra', 'absorb')).toEqual({ kind: 'none', amount: 0 });
    expect(drawdownAdjustment({ balance: -100 }, 'justify', 'bill_as_extra')).toEqual({ kind: 'extra', amount: 100 });
  });

  it('needs a justification only for an overrun billed without a pre-agreement', () => {
    expect(overrunJustificationProblem('justify', 'bill_as_extra', 'short')).toMatch(/Say why/);
    expect(overrunJustificationProblem('justify', 'bill_as_extra', 'Storm damage call-outs requested by client')).toBeNull();
    expect(overrunJustificationProblem('bill_as_extra', null, '')).toBeNull();
    expect(overrunJustificationProblem('bill_as_extra', 'bill_as_extra', 'x')).toMatch(/10 to 500/);
    expect(overrunJustificationProblem('justify', 'absorb', '')).toBeNull();
  });

  it('works out whole calendar months without time-zone drift', () => {
    expect(previousMonth(new Date(2026, 0, 15))).toBe('2025-12');
    expect(previousMonth(new Date(2026, 9, 1))).toBe('2026-09');
    expect(monthBounds('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(monthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(monthBounds('2026-12')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });
});
