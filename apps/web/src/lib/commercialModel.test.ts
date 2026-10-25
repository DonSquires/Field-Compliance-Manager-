import { describe, expect, it } from 'vitest';

import { billingAttention, type AgreementBillingSummary } from './agreementBillingSummary';
import { asCommercialModel, commercialTermsFormFrom, commercialTermsPayload, commercialTermsProblem, usesContractExtra } from './commercialModel';

describe('commercial model', () => {
  it('only fixed price + Extra, or no model yet, uses the Contracted work / Extra decision', () => {
    expect(usesContractExtra(null)).toBe(true);
    expect(usesContractExtra('fixed_price_with_extras')).toBe(true);
    expect(usesContractExtra('pay_as_you_go')).toBe(false);
    expect(usesContractExtra('do_and_invoice')).toBe(false);
    expect(usesContractExtra('per_request')).toBe(false);
    expect(asCommercialModel('retainer')).toBeNull();
  });

  it('starts an empty form with monthly billing and 14-day terms, and needs a model', () => {
    const form = commercialTermsFormFrom(null);
    expect(form).toMatchObject({ model: '', billingCycle: 'monthly', paymentTermsDays: '14' });
    expect(commercialTermsProblem(form, null, '')).toBe('Choose how this client is billed.');
  });

  it('mirrors the server validation and asks for a reason only when an existing model changes', () => {
    const form = { ...commercialTermsFormFrom(null), model: 'per_request' as const };
    expect(commercialTermsProblem(form, null, '')).toBeNull();
    expect(commercialTermsProblem({ ...form, paymentTermsDays: '121' }, null, '')).toMatch(/0 to 120/);
    expect(commercialTermsProblem({ ...form, invoiceEmail: 'accounts' }, null, '')).toMatch(/email/);
    expect(commercialTermsProblem({ ...form, rates: { ...form.rates, travel_rate_per_km: '-1' } }, null, '')).toMatch(/Travel rate per km/);
    expect(commercialTermsProblem(form, 'pay_as_you_go', '')).toBe('Say why the billing model is changing.');
    expect(commercialTermsProblem(form, 'pay_as_you_go', 'New contract')).toBeNull();
    expect(commercialTermsProblem(form, 'per_request', '')).toBeNull();
  });

  it('sends only the keys the RPC accepts, clearing blanks', () => {
    const form = { ...commercialTermsFormFrom(null), model: 'pay_as_you_go' as const, paymentTermsDays: ' 20 ', invoiceEmail: ' ', rates: { ...commercialTermsFormFrom(null).rates, base_rate_per_hour: '45.5' } };
    const payload = commercialTermsPayload(form);
    expect(Object.keys(payload).sort()).toEqual(['base_rate_per_hour', 'billing_cycle', 'callout_minimum_hours', 'callout_rate_per_hour', 'invoice_email', 'notes', 'overtime_rate_per_hour', 'payment_terms_days', 'purchase_order_number', 'travel_rate_per_km']);
    expect(payload).toMatchObject({ billing_cycle: 'monthly', payment_terms_days: 20, invoice_email: null, base_rate_per_hour: 45.5, travel_rate_per_km: null });
  });

  it('raises no Contract/Extra warnings on agreements billed at agreed rates', () => {
    const summary: AgreementBillingSummary = {
      agreementPrice: null,
      months: [],
      totals: { contract_cost: 0, extra_cost: 0, unclassified_cost: 50, unclassified_rows: 2, conflict_rows: 1 },
      dispatch: [{ basis: 'unclassified', lines: 3, total: 300, uninvoiced_total: 300 }],
      extraOrders: [],
    };
    expect(billingAttention(summary).length).toBe(4);
    expect(billingAttention(summary, 'fixed_price_with_extras').length).toBe(4);
    expect(billingAttention(summary, 'per_request')).toEqual([]);
  });
});
