import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, Scale } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './FinancePeriodBillingBasisPanel.css';

type BasisTotals = {
  contract_cost: number;
  extra_cost: number;
  unclassified_cost: number;
  other_cost: number;
  total_cost: number;
  unclassified_rows: number;
  conflict_rows: number;
};
type AgreementSplit = BasisTotals & {
  service_agreement_id: string;
  agreement_name: string;
  client_name: string | null;
  agreement_price: number | null;
};
type PeriodSplit = {
  pl_period_id: string;
  period_name: string;
  totals: BasisTotals & { unlinked_cost: number };
  by_agreement: AgreementSplit[];
};

const AGREEMENT_PREVIEW = 6;
const money = (value: number | null | undefined) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD', maximumFractionDigits: 0 }).format(Number(value ?? 0));
const share = (part: number, total: number) => (total > 0 ? Math.max(0, (Number(part) / Number(total)) * 100) : 0);

const SEGMENTS = [
  { key: 'contract_cost', label: 'Contract', hint: 'Covered by the agreement price', className: 'is-contract' },
  { key: 'extra_cost', label: 'Extra', hint: 'Outside the contract — billable', className: 'is-extra' },
  { key: 'unclassified_cost', label: 'Not classified', hint: 'Needs a Contract or Extra decision', className: 'is-unclassified' },
  { key: 'other_cost', label: 'Other cost', hint: 'Timesheets, overheads and manual cost', className: 'is-other' },
] as const;

export function FinancePeriodBillingBasisPanel({ periodId }: { periodId: string | null }) {
  const [split, setSplit] = useState<PeriodSplit | null>(null);
  const [loading, setLoading] = useState(Boolean(periodId));
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    if (!periodId) {
      setSplit(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('get_finance_pl_period_billing_basis', { p_pl_period_id: periodId });
    if (rpcError) setError(rpcError.message);
    else setSplit((data as PeriodSplit | null) ?? null);
    setLoading(false);
  }, [periodId]);

  useEffect(() => { setShowAll(false); void load(); }, [load]);

  const heading = <div className="finance-ops-panel-heading"><div><h3 id="finance-billing-basis-title">Contract and Extra this period</h3><p>Recorded service cost split by what the agreement covers and what is billable as Extra</p></div><Scale size={18} aria-hidden="true" /></div>;

  if (!periodId) {
    return <section className="finance-ops-panel finance-basis-panel" aria-labelledby="finance-billing-basis-title">{heading}<div className="finance-ops-empty">Choose a money check period to see the Contract and Extra split.</div></section>;
  }
  if (loading) {
    return <section className="finance-ops-panel finance-basis-panel" aria-labelledby="finance-billing-basis-title" aria-busy="true">{heading}<div className="finance-ops-empty"><div className="spinner" />Loading the Contract and Extra split</div></section>;
  }
  if (error) {
    return <section className="finance-ops-panel finance-basis-panel" aria-labelledby="finance-billing-basis-title">{heading}<div className="finance-basis-error" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div><strong>Contract and Extra split unavailable</strong><p>{error}</p></div><button type="button" className="btn btn-secondary" onClick={() => void load()}><RefreshCw size={14} />Retry</button></div></section>;
  }
  if (!split || Number(split.totals.total_cost) === 0) {
    return <section className="finance-ops-panel finance-basis-panel" aria-labelledby="finance-billing-basis-title">{heading}<div className="finance-ops-empty">No service cost has been recorded in this period yet.</div></section>;
  }

  const { totals } = split;
  const agreements = showAll ? split.by_agreement : split.by_agreement.slice(0, AGREEMENT_PREVIEW);
  const missingPrices = split.by_agreement.filter((row) => row.agreement_price === null && Number(row.contract_cost) > 0).length;

  return <section className="finance-ops-panel finance-basis-panel" aria-labelledby="finance-billing-basis-title">
    {heading}
    <div className="finance-basis-bar" role="img" aria-label={SEGMENTS.map((segment) => `${segment.label} ${money(totals[segment.key])}`).join(', ')}>
      {SEGMENTS.map((segment) => <span key={segment.key} className={segment.className} style={{ width: `${share(totals[segment.key], totals.total_cost)}%` }} />)}
    </div>
    <dl className="finance-basis-totals">
      {SEGMENTS.map((segment) => <div key={segment.key} className={segment.className}><dt>{segment.label}</dt><dd>{money(totals[segment.key])}</dd><small>{segment.hint}</small></div>)}
    </dl>
    {(Number(totals.unclassified_cost) > 0 || totals.conflict_rows > 0 || missingPrices > 0) && <ul className="finance-basis-notes">
      {Number(totals.unclassified_cost) > 0 && <li>{money(totals.unclassified_cost)} is not classified{totals.unclassified_rows ? ` — ${totals.unclassified_rows} workbook row(s) have no TYPE and no known charge code` : ''}{Number(totals.unlinked_cost) > 0 ? `, and ${money(totals.unlinked_cost)} of imported cost has no source row` : ''}. Set the charge-code basis or the job billing choice to classify it.</li>}
      {totals.conflict_rows > 0 && <li>{totals.conflict_rows} workbook row(s) have a TYPE that disagrees with the charge-code basis. The workbook TYPE was used — review them in the agreement.</li>}
      {missingPrices > 0 && <li>{missingPrices} agreement(s) with Contract cost have no agreement price recorded, so the contract margin cannot be checked yet.</li>}
    </ul>}
    <div className="finance-basis-table-wrap">
      <table className="finance-basis-table">
        <caption>Contract and Extra by agreement — {split.period_name}</caption>
        <thead><tr><th scope="col">Agreement</th><th scope="col">Contract</th><th scope="col">Extra</th><th scope="col">Not classified</th><th scope="col">Other</th><th scope="col">Total</th><th scope="col">Agreement price</th></tr></thead>
        <tbody>{agreements.map((row) => <tr key={row.service_agreement_id}>
          <th scope="row"><span>{row.agreement_name}</span>{row.client_name && <small>{row.client_name}</small>}</th>
          <td data-label="Contract">{money(row.contract_cost)}</td>
          <td data-label="Extra">{money(row.extra_cost)}</td>
          <td data-label="Not classified" className={Number(row.unclassified_cost) > 0 ? 'is-attention' : ''}>{money(row.unclassified_cost)}{row.conflict_rows > 0 && <small>{row.conflict_rows} to review</small>}</td>
          <td data-label="Other">{money(row.other_cost)}</td>
          <td data-label="Total"><strong>{money(row.total_cost)}</strong></td>
          <td data-label="Agreement price">{row.agreement_price === null ? <span className="finance-basis-muted">Not recorded</span> : money(row.agreement_price)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {split.by_agreement.length > AGREEMENT_PREVIEW && <button type="button" className="btn btn-secondary finance-basis-more" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>{showAll ? 'Show fewer agreements' : `Show all ${split.by_agreement.length} agreements`}</button>}
    <p className="finance-basis-footnote">Amounts are recorded service cost, not invoiced revenue, and add up to the period's costs recorded. To check an agreement row by row, open Agreements &amp; services, set up the agreement, then choose Contract and Extra.</p>
  </section>;
}
