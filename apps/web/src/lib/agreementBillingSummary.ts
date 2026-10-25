/**
 * agreementBillingSummary.ts — shapes get_agreement_billing_basis_summary for
 * the agreement Billing view: contracted vs Extra vs unclassified per month,
 * callouts by billing decision, Extra works orders, and the recorded price.
 */

import { usesContractExtra, type CommercialModel } from './commercialModel';

export interface BillingMonth {
  month: string;
  contract_cost: number;
  extra_cost: number;
  unclassified_cost: number;
  unclassified_rows: number;
  conflict_rows: number;
}

export interface BillingDispatchBasis {
  basis: 'contract' | 'extra' | 'unclassified';
  lines: number;
  total: number;
  uninvoiced_total: number;
}

export interface BillingExtraOrder {
  id: string;
  reference: string;
  title: string;
  starts_on: string;
  ends_on: string | null;
  charge_lines: number;
  charge_total: number;
}

export interface AgreementBillingSummary {
  agreementPrice: { lines: number; total: number } | null;
  months: BillingMonth[];
  totals: { contract_cost: number; extra_cost: number; unclassified_cost: number; unclassified_rows: number; conflict_rows: number };
  dispatch: BillingDispatchBasis[];
  extraOrders: BillingExtraOrder[];
  /** Do and invoice: the per-job standing authority limit (null = no limit) and jobs over it still waiting for the client's approval (null when no limit applies). */
  standingAuthority: { limit: number | null; jobsWithoutApproval: number | null };
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Recorded work whatever its basis: on agreements billed at agreed rates every row is billable. */
export function recordedWorkTotal(row: { contract_cost: number; extra_cost: number; unclassified_cost: number }): number {
  return row.contract_cost + row.extra_cost + row.unclassified_cost;
}

export function parseAgreementBillingSummary(raw: unknown): AgreementBillingSummary {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const price = data.agreement_price as Record<string, unknown> | null | undefined;
  const totals = (data.imported_cost_totals ?? {}) as Record<string, unknown>;
  const list = (value: unknown) => (Array.isArray(value) ? value as Array<Record<string, unknown>> : []);
  const commercial = (data.commercial && typeof data.commercial === 'object' ? data.commercial : {}) as Record<string, unknown>;
  const orNull = (value: unknown) => (value === null || value === undefined ? null : num(value));
  return {
    standingAuthority: { limit: orNull(commercial.standing_authority_limit), jobsWithoutApproval: orNull(commercial.jobs_over_standing_authority_without_approval) },
    agreementPrice: price ? { lines: num(price.lines), total: num(price.total) } : null,
    months: list(data.imported_cost_months).map((row) => ({
      month: String(row.month),
      contract_cost: num(row.contract_cost),
      extra_cost: num(row.extra_cost),
      unclassified_cost: num(row.unclassified_cost),
      unclassified_rows: num(row.unclassified_rows),
      conflict_rows: num(row.conflict_rows),
    })),
    totals: {
      contract_cost: num(totals.contract_cost),
      extra_cost: num(totals.extra_cost),
      unclassified_cost: num(totals.unclassified_cost),
      unclassified_rows: num(totals.unclassified_rows),
      conflict_rows: num(totals.conflict_rows),
    },
    dispatch: list(data.dispatch_charge_lines).map((row) => ({
      basis: row.basis === 'contract' || row.basis === 'extra' ? row.basis : 'unclassified',
      lines: num(row.lines),
      total: num(row.total),
      uninvoiced_total: num(row.uninvoiced_total),
    })),
    extraOrders: list(data.extra_work_orders).map((row) => ({
      id: String(row.id),
      reference: String(row.reference),
      title: String(row.title ?? ''),
      starts_on: String(row.starts_on),
      ends_on: row.ends_on ? String(row.ends_on) : null,
      charge_lines: num(row.charge_lines),
      charge_total: num(row.charge_total),
    })),
  };
}

export type BillingPeriod = '12m' | 'year' | 'all';

/** Inclusive date bounds for a period choice, as YYYY-MM-DD (null = open). */
export function billingPeriodBounds(period: BillingPeriod, today: Date = new Date()): { from: string | null; to: string | null } {
  if (period === 'all') return { from: null, to: null };
  const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  if (period === 'year') return { from: `${today.getFullYear()}-01-01`, to: iso(today) };
  return { from: iso(new Date(today.getFullYear(), today.getMonth() - 11, 1)), to: iso(today) };
}

/** "2026-03" → "Mar 2026". */
export function monthLabel(month: string): string {
  const [year, mm] = month.split('-').map(Number);
  if (!year || !mm) return month;
  return new Date(year, mm - 1, 1).toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' });
}

/** Plain-language warnings, in the order a finance person should act on them. Agreements not billed fixed price + Extra have no Contract/Extra decision, so only the do-and-invoice standing authority check applies to them. */
export function billingAttention(summary: AgreementBillingSummary, model: CommercialModel | null = null): string[] {
  const notes: string[] = [];
  if (!usesContractExtra(model)) {
    const waiting = model === 'do_and_invoice' ? summary.standingAuthority.jobsWithoutApproval ?? 0 : 0;
    if (waiting > 0) notes.push(`${waiting} job${waiting === 1 ? ' costs' : 's cost'} more than the standing authority limit and ${waiting === 1 ? 'has' : 'have'} no client approval reference. Record the approval in Dispatch — invoicing is blocked until then.`);
    return notes;
  }
  const unsetCallouts = summary.dispatch.find((row) => row.basis === 'unclassified');
  if (unsetCallouts && unsetCallouts.lines > 0) {
    notes.push(`${unsetCallouts.lines} callout charge line${unsetCallouts.lines === 1 ? ' has' : 's have'} no billing decision. Set them in Dispatch before invoicing — invoicing is blocked until then.`);
  }
  if (!summary.agreementPrice) {
    notes.push('No contract price is recorded for this agreement. Contracted work is covered by a fixed price, so record it as an accepted quote before invoicing the agreement.');
  }
  if (summary.totals.unclassified_rows > 0) {
    notes.push(`${summary.totals.unclassified_rows} imported log row${summary.totals.unclassified_rows === 1 ? '' : 's'} could not be classified (no TYPE in the workbook and the charge code is not in the catalog).`);
  }
  if (summary.totals.conflict_rows > 0) {
    notes.push(`${summary.totals.conflict_rows} imported row${summary.totals.conflict_rows === 1 ? ' says' : 's say'} one thing in the workbook TYPE column and another in the charge-code catalog. The workbook wins here; check the code basis.`);
  }
  return notes;
}
