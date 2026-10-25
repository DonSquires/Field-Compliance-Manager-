/**
 * Monthly fee drawdown (owner ruling 2026-10-25). On a fixed price plus Extra agreement each contracted
 * job draws down the monthly fee, so a fully delivered month nets to $0. Unused value is credited; work
 * above the fee is Extra, billed only when pre-agreed (fee_overrun_policy bill_as_extra) or justified,
 * otherwise absorbed. The figures come from get_agreement_fee_drawdown; the invoice from
 * generate_crm_invoice_from_agreement settles one whole calendar month.
 */
import { asFeeOverrunPolicy, type FeeOverrunPolicy } from './commercialModel';

export type DrawdownOutcome = 'credit' | 'overrun' | 'balanced';
export type SettlementOutcome = 'credit' | 'overrun_billed' | 'overrun_absorbed' | 'balanced';
export type OverrunDecision = 'bill_as_extra' | 'absorb';

export interface DrawdownBlocker { code: string; message: string }

export interface DrawdownSettlement {
  outcome: SettlementOutcome;
  adjustmentAmount: number;
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  justification: string | null;
}

export interface DrawdownMonth {
  month: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  fee: number | null;
  work: { imported: number; callouts: number; patrolVisits: number; total: number; importedExtra: number };
  balance: number | null;
  outcome: DrawdownOutcome | null;
  blockers: DrawdownBlocker[];
  settlement: DrawdownSettlement | null;
}

export interface FeeDrawdown {
  applies: boolean;
  fee: number | null;
  overrunPolicy: FeeOverrunPolicy | null;
  months: DrawdownMonth[];
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {});
const num = (value: unknown): number => (value == null || value === '' || Number.isNaN(Number(value)) ? 0 : Number(value));
const numOrNull = (value: unknown): number | null => (value == null || value === '' || Number.isNaN(Number(value)) ? null : Number(value));
const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));
const SETTLEMENT_OUTCOMES: readonly SettlementOutcome[] = ['credit', 'overrun_billed', 'overrun_absorbed', 'balanced'];

function parseMonth(raw: unknown): DrawdownMonth {
  const row = obj(raw);
  const work = obj(row.contract_work);
  const settlement = row.settlement && typeof row.settlement === 'object' ? obj(row.settlement) : null;
  const outcome = str(row.outcome);
  return {
    month: str(row.month),
    label: str(row.label) || str(row.month),
    periodStart: str(row.period_start),
    periodEnd: str(row.period_end),
    fee: numOrNull(row.fee),
    work: {
      imported: num(obj(work.imported).amount),
      callouts: num(obj(work.callouts).amount),
      patrolVisits: num(obj(work.patrol_visits).amount),
      total: num(work.total),
      importedExtra: num(obj(work.imported).extra_amount),
    },
    balance: numOrNull(row.balance),
    outcome: outcome === 'credit' || outcome === 'overrun' || outcome === 'balanced' ? outcome : null,
    blockers: Array.isArray(row.blockers) ? row.blockers.map((b) => ({ code: str(obj(b).code), message: str(obj(b).message) })) : [],
    settlement: settlement ? {
      outcome: (SETTLEMENT_OUTCOMES as readonly string[]).includes(str(settlement.outcome)) ? (str(settlement.outcome) as SettlementOutcome) : 'balanced',
      adjustmentAmount: num(settlement.adjustment_amount),
      invoiceId: str(settlement.invoice_id),
      invoiceNumber: str(settlement.invoice_number),
      invoiceStatus: str(settlement.invoice_status),
      justification: settlement.justification == null ? null : str(settlement.justification),
    } : null,
  };
}

export function parseFeeDrawdown(raw: unknown): FeeDrawdown {
  const row = obj(raw);
  const applies = row.applies === true;
  return {
    applies,
    fee: numOrNull(row.fee),
    overrunPolicy: applies ? asFeeOverrunPolicy(row.overrun_policy) : null,
    months: Array.isArray(row.months) ? row.months.map(parseMonth) : [],
  };
}

const nzd = (value: number) => value.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' });

/** One plain sentence for a month's position against the fee. */
export function describeDrawdown(month: Pick<DrawdownMonth, 'fee' | 'balance' | 'work'>): string {
  if (month.fee == null || month.balance == null) return 'No monthly fee recorded';
  if (month.balance > 0) return `${nzd(month.balance)} of the fee not used`;
  if (month.balance < 0) return `${nzd(-month.balance)} above the fee`;
  return 'Fee fully used';
}

export function settlementLabel(settlement: DrawdownSettlement): string {
  switch (settlement.outcome) {
    case 'credit': return `Credited ${nzd(-settlement.adjustmentAmount)}`;
    case 'overrun_billed': return `Extra billed ${nzd(settlement.adjustmentAmount)}`;
    case 'overrun_absorbed': return 'Overrun absorbed';
    default: return 'Settled, nothing to adjust';
  }
}

/** What the invoice will add for this month, given the decision taken. Mirrors generate_crm_invoice_from_agreement. */
export function drawdownAdjustment(month: Pick<DrawdownMonth, 'balance'>, policy: FeeOverrunPolicy | null, decision: OverrunDecision | null): { kind: 'credit' | 'extra' | 'none' | 'decide'; amount: number } {
  if (month.balance == null || month.balance === 0) return { kind: 'none', amount: 0 };
  if (month.balance > 0) return { kind: 'credit', amount: -month.balance };
  const chosen = decision ?? (policy === 'bill_as_extra' ? 'bill_as_extra' : null);
  if (!chosen) return { kind: 'decide', amount: 0 };
  return chosen === 'bill_as_extra' ? { kind: 'extra', amount: -month.balance } : { kind: 'none', amount: 0 };
}

/** Justification is needed only when the overrun is billed without a pre-agreement; 10 to 500 characters. */
export function overrunJustificationProblem(policy: FeeOverrunPolicy | null, decision: OverrunDecision | null, justification: string): string | null {
  const text = justification.trim();
  if (decision === 'bill_as_extra' && policy !== 'bill_as_extra' && (text.length < 10 || text.length > 500)) {
    return 'Say why the client should pay for work above the monthly fee (10 to 500 characters).';
  }
  if (text && (text.length < 10 || text.length > 500)) return 'A justification is 10 to 500 characters.';
  return null;
}

/** The calendar month before the given date, as YYYY-MM (the month normally invoiced early the next month). */
export function previousMonth(today: Date = new Date()): string {
  const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** First and last day of a YYYY-MM month as ISO dates, without time-zone drift. */
export function monthBounds(month: string): { start: string; end: string } {
  const [year, mon] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}
