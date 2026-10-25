import { describe, expect, it } from 'vitest';
import { billingAttention, billingPeriodBounds, monthLabel, parseAgreementBillingSummary } from './agreementBillingSummary';

const raw = {
  agreement_price: null,
  imported_cost_months: [{ month: '2026-03', contract_cost: '12966.00', extra_cost: 4905.53, unclassified_cost: 0, unclassified_rows: 0, conflict_rows: 2 }],
  imported_cost_totals: { contract_cost: 12966, extra_cost: 4905.53, unclassified_cost: 120, unclassified_rows: 3, conflict_rows: 2 },
  dispatch_charge_lines: [{ basis: 'unclassified', lines: 1, total: 120, uninvoiced_total: 120 }, { basis: 'extra', lines: 2, total: 110, uninvoiced_total: 0 }],
  extra_work_orders: [{ id: 'o1', reference: 'EW-001', title: 'Hunter weekend lock access', starts_on: '2026-10-01', ends_on: null, charge_lines: 2, charge_total: 110 }],
};

describe('agreement billing summary', () => {
  it('parses the RPC payload into numbers and known bases', () => {
    const summary = parseAgreementBillingSummary(raw);
    expect(summary.agreementPrice).toBeNull();
    expect(summary.months[0]).toEqual({ month: '2026-03', contract_cost: 12966, extra_cost: 4905.53, unclassified_cost: 0, unclassified_rows: 0, conflict_rows: 2 });
    expect(summary.dispatch.map((row) => row.basis)).toEqual(['unclassified', 'extra']);
    expect(summary.extraOrders[0].reference).toBe('EW-001');
  });

  it('survives an empty or malformed payload', () => {
    const summary = parseAgreementBillingSummary(null);
    expect(summary).toEqual({ agreementPrice: null, months: [], totals: { contract_cost: 0, extra_cost: 0, unclassified_cost: 0, unclassified_rows: 0, conflict_rows: 0 }, dispatch: [], extraOrders: [], standingAuthority: { limit: null, jobsWithoutApproval: null } });
  });

  it('reads the do-and-invoice standing authority and warns only about jobs over it without approval', () => {
    const summary = parseAgreementBillingSummary({ commercial: { commercial_model: 'do_and_invoice', standing_authority_limit: '500.00', jobs_over_standing_authority_without_approval: 2 } });
    expect(summary.standingAuthority).toEqual({ limit: 500, jobsWithoutApproval: 2 });
    expect(billingAttention(summary, 'do_and_invoice')).toEqual(['2 jobs cost more than the standing authority limit and have no client approval reference. Record the approval in Dispatch — invoicing is blocked until then.']);
    expect(billingAttention(summary, 'pay_as_you_go')).toEqual([]);
    expect(billingAttention(parseAgreementBillingSummary({ commercial: { standing_authority_limit: null, jobs_over_standing_authority_without_approval: null } }), 'do_and_invoice')).toEqual([]);
  });

  it('lists what needs attention, blocking items first', () => {
    const notes = billingAttention(parseAgreementBillingSummary(raw));
    expect(notes).toHaveLength(4);
    expect(notes[0]).toMatch(/^1 callout charge line has no billing decision/);
    expect(notes[1]).toMatch(/No contract price is recorded/);
    expect(notes[2]).toMatch(/^3 imported log rows could not be classified/);
    expect(notes[3]).toMatch(/^2 imported rows say one thing/);
    expect(billingAttention(parseAgreementBillingSummary({ agreement_price: { lines: 1, total: 13333 } }))).toEqual([]);
  });

  it('computes period bounds and month labels', () => {
    const today = new Date(2026, 9, 25);
    expect(billingPeriodBounds('all', today)).toEqual({ from: null, to: null });
    expect(billingPeriodBounds('year', today)).toEqual({ from: '2026-01-01', to: '2026-10-25' });
    expect(billingPeriodBounds('12m', today)).toEqual({ from: '2025-11-01', to: '2026-10-25' });
    expect(monthLabel('2026-03')).toMatch(/Mar/);
    expect(monthLabel('bad')).toBe('bad');
  });
});
