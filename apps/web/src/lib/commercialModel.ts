/**
 * commercialModel.ts — how a client is billed under a service agreement
 * (owner ruling 2026-10-26). Mirrors crm_commercial_settings.commercial_model
 * and public.agreement_uses_contract_extra(): only fixed price plus Extra, or
 * a model that has not been set yet, uses the Contracted work / Extra decision.
 *
 * Do and invoice is not pay as you go: it is standing authority to do what is needed and invoice the
 * actual time, travel and materials. An optional per-job standing authority limit
 * (crm_commercial_settings.standing_authority_limit) holds a job above it until the client's approval
 * reference is recorded; no limit means nothing is held back.
 */

import { useEffect, useState } from 'react';

export const COMMERCIAL_MODELS = ['fixed_price_with_extras', 'pay_as_you_go', 'do_and_invoice', 'per_request'] as const;
export type CommercialModel = (typeof COMMERCIAL_MODELS)[number];

export const COMMERCIAL_MODEL_LABEL: Record<CommercialModel, string> = {
  fixed_price_with_extras: 'Fixed price + Extra',
  pay_as_you_go: 'Pay as you go',
  do_and_invoice: 'Do and invoice',
  per_request: 'Per request',
};

export const COMMERCIAL_MODEL_HELP: Record<CommercialModel, string> = {
  fixed_price_with_extras: 'A fixed contract price covers the agreed service. Work outside it is Extra and billed on top, so each callout is marked Contracted work or Extra.',
  pay_as_you_go: 'Every job is charged at the agreed rates and invoiced each billing cycle. There is no Contracted work / Extra decision.',
  do_and_invoice: 'Standing authority: R&M does what is needed without asking first, then invoices the actual time, travel and materials. A job over the agreed standing authority limit (if one is set) needs the client\'s approval reference before it is invoiced.',
  per_request: 'The client asks for each job. Each callout needs the client\'s request or purchase-order reference before it can be invoiced.',
};

export function asCommercialModel(value: unknown): CommercialModel | null {
  return typeof value === 'string' && (COMMERCIAL_MODELS as readonly string[]).includes(value) ? (value as CommercialModel) : null;
}

/** True when callouts on the agreement need a Contracted work / Extra decision. */
export function usesContractExtra(model: CommercialModel | null | undefined): boolean {
  return model == null || model === 'fixed_price_with_extras';
}

export function commercialModelLabel(model: CommercialModel | null | undefined): string {
  return model ? COMMERCIAL_MODEL_LABEL[model] : 'Billing model not set';
}

/** How the work on a job is priced on the invoice, in the dispatcher's words. */
export const COMMERCIAL_MODEL_PRICING: Record<Exclude<CommercialModel, 'fixed_price_with_extras'>, string> = {
  pay_as_you_go: 'billed at agreed rates',
  do_and_invoice: 'standing authority · invoiced at actuals',
  per_request: 'billed against the client request',
};

export const formatLimit = (limit: number) => limit.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' });

/** Do and invoice: true when the job costs more than the standing authority limit. No limit = never over. */
export function overStandingAuthority(limit: number | null | undefined, jobTotal: number): boolean {
  return limit != null && jobTotal > limit;
}

export type AgreementCommercialModels = { models: Map<string, CommercialModel | null>; limits: Map<string, number | null> };

/** Commercial model (and do-and-invoice standing authority limit) per agreement id. Agreements with no settings row are absent (treated as not set). */
export function useAgreementCommercialModels(agreementIds: ReadonlyArray<string>): AgreementCommercialModels & { loading: boolean; error: string | null } {
  const key = Array.from(new Set(agreementIds.filter(Boolean))).sort().join(',');
  const [state, setState] = useState<AgreementCommercialModels & { loading: boolean; error: string | null }>({ models: new Map(), limits: new Map(), loading: false, error: null });

  useEffect(() => {
    if (!key) { setState({ models: new Map(), limits: new Map(), loading: false, error: null }); return; }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    void loadCommercialModels(key.split(',')).then((result) => {
      if (!cancelled) setState({ ...result, loading: false });
    });
    return () => { cancelled = true; };
  }, [key]);

  return state;
}

export async function loadCommercialModels(agreementIds: ReadonlyArray<string>): Promise<AgreementCommercialModels & { error: string | null }> {
  const ids = Array.from(new Set(agreementIds.filter(Boolean)));
  if (ids.length === 0) return { models: new Map(), limits: new Map(), error: null };
  // Imported lazily so the pure helpers above stay usable without a configured client (unit tests).
  const { supabase } = await import('./supabase');
  // ATLAS READS: crm_commercial_settings (commercial_model and standing_authority_limit per service agreement)
  const { data, error } = await supabase.from('crm_commercial_settings').select('service_agreement_id,commercial_model,standing_authority_limit').in('service_agreement_id', ids);
  if (error) return { models: new Map(), limits: new Map(), error: error.message };
  const models = new Map<string, CommercialModel | null>();
  const limits = new Map<string, number | null>();
  for (const row of (data as Array<{ service_agreement_id: string; commercial_model: string | null; standing_authority_limit: number | string | null }>) ?? []) {
    models.set(row.service_agreement_id, asCommercialModel(row.commercial_model));
    limits.set(row.service_agreement_id, row.standing_authority_limit == null ? null : Number(row.standing_authority_limit));
  }
  return { models, limits, error: null };
}

export const BILLING_CYCLES = ['weekly', 'fortnightly', 'monthly', 'quarterly'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const RATE_FIELDS = [
  { key: 'base_rate_per_hour', label: 'Base rate per hour' },
  { key: 'overtime_rate_per_hour', label: 'Overtime rate per hour' },
  { key: 'callout_rate_per_hour', label: 'Callout rate per hour' },
  { key: 'callout_minimum_hours', label: 'Callout minimum hours' },
  { key: 'travel_rate_per_km', label: 'Travel rate per km' },
] as const;
export type RateKey = (typeof RATE_FIELDS)[number]['key'];

/** How the due date is set: a day of the month after the work (R&M: the 20th), or days after the invoice date. */
export type PaymentDueMode = 'day_of_next_month' | 'days_after_invoice';

export const DEFAULT_PAYMENT_DUE_DAY = 20;

export function ordinalDay(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th'}`;
}

/** Plain words for the saved payment terms, matching invoice_due_date. */
export function describePaymentTerms(row: { payment_due_day_of_month?: number | null; payment_terms_days?: number | null } | null | undefined): string {
  if (row?.payment_due_day_of_month != null) return `Due on the ${ordinalDay(row.payment_due_day_of_month)} of the month after the work`;
  if (row?.payment_terms_days != null) return `Due ${row.payment_terms_days} days after the invoice date`;
  return 'Not set';
}

export interface CommercialTermsForm {
  model: CommercialModel | '';
  billingCycle: BillingCycle;
  paymentDueMode: PaymentDueMode;
  paymentDueDay: string;
  paymentTermsDays: string;
  invoiceEmail: string;
  purchaseOrderNumber: string;
  notes: string;
  rates: Record<RateKey, string>;
  /** Do and invoice only; blank = no cap. */
  standingAuthorityLimit: string;
  /** Fixed price plus Extra only: what happens to contracted work above the monthly fee. */
  feeOverrunPolicy: FeeOverrunPolicy;
}

/** Owner ruling 2026-10-25: contracted work above a fixed monthly fee is Extra; billed only when pre-agreed or justified. */
export const FEE_OVERRUN_POLICIES = ['justify', 'bill_as_extra'] as const;
export type FeeOverrunPolicy = (typeof FEE_OVERRUN_POLICIES)[number];
export const FEE_OVERRUN_POLICY_LABEL: Record<FeeOverrunPolicy, string> = {
  justify: 'Needs a justification each month (otherwise R&M absorbs it)',
  bill_as_extra: 'Already agreed with the client: bill it as Extra',
};
export function asFeeOverrunPolicy(value: unknown): FeeOverrunPolicy {
  return value === 'bill_as_extra' ? 'bill_as_extra' : 'justify';
}

export interface CommercialSettingsRow {
  commercial_model: string | null;
  billing_cycle: string | null;
  payment_terms_days: number | null;
  payment_due_day_of_month?: number | null;
  invoice_email: string | null;
  purchase_order_number: string | null;
  notes: string | null;
  base_rate_per_hour: number | null;
  overtime_rate_per_hour: number | null;
  callout_rate_per_hour: number | null;
  callout_minimum_hours: number | null;
  travel_rate_per_km: number | null;
  standing_authority_limit?: number | null;
  fee_overrun_policy?: string | null;
  updated_at?: string | null;
}

const text = (value: number | string | null | undefined) => (value == null ? '' : String(value));

export function commercialTermsFormFrom(row: CommercialSettingsRow | null): CommercialTermsForm {
  const cycle = row?.billing_cycle;
  // New terms start on the usual NZ basis (20th of the month after the work); saved day-count terms are kept.
  const dueByDays = row != null && row.payment_due_day_of_month == null;
  return {
    model: asCommercialModel(row?.commercial_model) ?? '',
    billingCycle: (BILLING_CYCLES as readonly string[]).includes(cycle ?? '') ? (cycle as BillingCycle) : 'monthly',
    paymentDueMode: dueByDays ? 'days_after_invoice' : 'day_of_next_month',
    paymentDueDay: text(row?.payment_due_day_of_month ?? DEFAULT_PAYMENT_DUE_DAY),
    paymentTermsDays: text(row?.payment_terms_days ?? 14),
    invoiceEmail: row?.invoice_email ?? '',
    purchaseOrderNumber: row?.purchase_order_number ?? '',
    notes: row?.notes ?? '',
    rates: Object.fromEntries(RATE_FIELDS.map(({ key }) => [key, text(row?.[key])])) as Record<RateKey, string>,
    standingAuthorityLimit: text(row?.standing_authority_limit),
    feeOverrunPolicy: asFeeOverrunPolicy(row?.fee_overrun_policy),
  };
}

const RATE_PATTERN = /^\d{1,7}(\.\d{1,4})?$/;
const LIMIT_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Mirrors set_agreement_commercial_terms validation so the form explains problems before saving. */
export function commercialTermsProblem(form: CommercialTermsForm, savedModel: CommercialModel | null, reason: string): string | null {
  if (!form.model) return 'Choose how this client is billed.';
  if (form.paymentDueMode === 'day_of_next_month') {
    const day = form.paymentDueDay.trim();
    if (!/^\d{1,2}$/.test(day) || Number(day) < 1 || Number(day) > 28) return 'The payment due day must be a day of the month from 1 to 28.';
  }
  if (!/^\d{1,3}$/.test(form.paymentTermsDays.trim()) || Number(form.paymentTermsDays) > 120) return 'Payment terms must be a whole number of days from 0 to 120.';
  const email = form.invoiceEmail.trim();
  if (email && !EMAIL_PATTERN.test(email)) return 'The invoice email is not a valid email address.';
  for (const { key, label } of RATE_FIELDS) {
    const value = form.rates[key].trim();
    if (value && !RATE_PATTERN.test(value)) return `${label} must be zero or a positive number (up to 4 decimals).`;
  }
  const limit = form.standingAuthorityLimit.trim();
  if (form.model === 'do_and_invoice' && limit && !LIMIT_PATTERN.test(limit)) return 'The standing authority limit must be zero or a positive amount (up to 2 decimals), or blank for no limit.';
  if (form.notes.length > 2000) return 'Notes are limited to 2000 characters.';
  if (savedModel && savedModel !== form.model && reason.trim().length < 3) return 'Say why the billing model is changing.';
  return null;
}

/** The p_terms object: every editable key is sent; blank rates and text clear the stored value. Other models always clear the standing authority limit and the fee overrun policy. */
export function commercialTermsPayload(form: CommercialTermsForm): Record<string, string | number | null> {
  const blankToNull = (value: string) => (value.trim() ? value.trim() : null);
  const limit = form.standingAuthorityLimit.trim();
  return {
    standing_authority_limit: form.model === 'do_and_invoice' && limit ? Number(limit) : null,
    fee_overrun_policy: form.model === 'fixed_price_with_extras' ? form.feeOverrunPolicy : null,
    billing_cycle: form.billingCycle,
    payment_terms_days: Number(form.paymentTermsDays.trim()),
    payment_due_day_of_month: form.paymentDueMode === 'day_of_next_month' ? Number(form.paymentDueDay.trim()) : null,
    invoice_email: blankToNull(form.invoiceEmail),
    purchase_order_number: blankToNull(form.purchaseOrderNumber),
    notes: blankToNull(form.notes),
    ...Object.fromEntries(RATE_FIELDS.map(({ key }) => [key, form.rates[key].trim() ? Number(form.rates[key].trim()) : null])),
  };
}
