import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { money } from '../lib/workshop';
import { billingAttention, billingPeriodBounds, monthLabel, parseAgreementBillingSummary, recordedWorkTotal, type AgreementBillingSummary, type BillingPeriod } from '../lib/agreementBillingSummary';
import { commercialModelLabel, usesContractExtra, type CommercialModel } from '../lib/commercialModel';
import { describeDrawdown, parseFeeDrawdown, settlementLabel, type FeeDrawdown } from '../lib/feeDrawdown';
import './CrmAgreementObligationsPanel.css';
import './CrmAgreementExtraWorksPanel.css';
import './CrmAgreementBillingPanel.css';

const periodLabels: Record<BillingPeriod, string> = { '12m': 'Last 12 months', year: 'This calendar year', all: 'All recorded work' };
const basisLabels = { contract: 'Contracted work', extra: 'Extra', unclassified: 'Billing not set' } as const;

export function CrmAgreementBillingPanel({ agreementId, commercialModel = null }: { agreementId: string; commercialModel?: CommercialModel | null }) {
  const contractExtra = usesContractExtra(commercialModel);
  const [period, setPeriod] = useState<BillingPeriod>('12m');
  const [summary, setSummary] = useState<AgreementBillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { from, to } = billingPeriodBounds(period);
    // ATLAS CALLS: get_agreement_billing_basis_summary (read-only, provider finance admin)
    const { data, error: rpcError } = await supabase.rpc('get_agreement_billing_basis_summary', { p_service_agreement_id: agreementId, p_from: from, p_to: to });
    if (rpcError) {
      setSummary(null);
      setError(rpcError.message.includes('Finance administrator') ? 'Only finance administrators for the provider can see contract and Extra totals.' : rpcError.message);
    } else {
      setSummary(parseAgreementBillingSummary(data));
    }
    setLoading(false);
  }, [agreementId, period]);

  useEffect(() => { void load(); }, [load]);

  const notes = summary ? billingAttention(summary, commercialModel) : [];
  const callouts = summary ? summary.dispatch.reduce((sum, row) => ({ lines: sum.lines + row.lines, total: sum.total + row.total, uninvoiced: sum.uninvoiced + row.uninvoiced_total }), { lines: 0, total: 0, uninvoiced: 0 }) : null;
  const hasActivity = summary ? summary.months.length > 0 || summary.dispatch.length > 0 || summary.extraOrders.length > 0 : false;

  return <section className="agreement-obligations agreement-billing" aria-labelledby="agreement-billing-title" aria-busy={loading}>
    <div className="agreement-section-heading">
      <div>
        <h3 id="agreement-billing-title">{contractExtra ? 'Contract and Extra' : commercialModel === 'do_and_invoice' ? 'Work invoiced at actuals' : 'Work billed at agreed rates'}</h3>
        <p>{contractExtra ? 'What was done under the fixed contract and what was Extra, month by month.' : commercialModel === 'do_and_invoice' ? 'This client has given standing authority: R&M does what is needed and invoices the actual time, travel and materials.' : `This client is billed ${commercialModelLabel(commercialModel).toLowerCase()}, so all recorded work is billable at the agreed rates.`} Log rows show recorded service cost (job time and travel), not invoiced amounts.</p>
      </div>
      <label className="agreement-billing-period"><span>Period</span>
        <select value={period} onChange={(event) => setPeriod(event.target.value as BillingPeriod)} disabled={loading}>
          {Object.entries(periodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </div>

    {error && <div className="agreement-obligation-message is-error" role="alert"><AlertTriangle size={15} />{error}<button type="button" className="agreement-extra-retry" onClick={() => void load()}>Retry</button></div>}
    {loading && !summary && !error && <div className="agreement-setup-loading"><RefreshCw size={18} className="is-spinning" />Loading contract and Extra totals</div>}

    {summary && !contractExtra && callouts && <>
      <div className="agreement-billing-cards" role="list">
        <div role="listitem" className="agreement-billing-card is-rated">
          <span>Billing model</span>
          <strong>{commercialModelLabel(commercialModel)}</strong>
          <small>No Contracted work / Extra decision</small>
        </div>
        <div role="listitem" className="agreement-billing-card is-rated">
          <span>Recorded work</span>
          <strong>{money(recordedWorkTotal(summary.totals))}</strong>
          <small>From the imported patrol log</small>
        </div>
        <div role="listitem" className="agreement-billing-card is-rated">
          <span>Callouts not yet invoiced</span>
          <strong>{money(callouts.uninvoiced)}</strong>
          <small>{callouts.lines} charge line{callouts.lines === 1 ? '' : 's'} in total</small>
        </div>
      </div>
      {!hasActivity && <div className="agreement-setup-empty">No work recorded for {periodLabels[period].toLowerCase()}.</div>}
      {summary.months.length > 0 && <table className="agreement-billing-table">
        <caption>Imported patrol log, by month</caption>
        <thead><tr><th scope="col">Month</th><th scope="col">Recorded work</th></tr></thead>
        <tbody>{[...summary.months].reverse().map((row) => <tr key={row.month}><th scope="row">{monthLabel(row.month)}</th><td>{money(recordedWorkTotal(row))}</td></tr>)}</tbody>
      </table>}
    </>}

    {summary && contractExtra && <>
      <div className="agreement-billing-cards" role="list">
        <div role="listitem" className="agreement-billing-card">
          <span>Contract price</span>
          <strong>{summary.agreementPrice ? money(summary.agreementPrice.total) : 'Not recorded'}</strong>
          <small>{summary.agreementPrice ? `${summary.agreementPrice.lines} accepted quote line${summary.agreementPrice.lines === 1 ? '' : 's'}` : 'Add an accepted quote'}</small>
        </div>
        <div role="listitem" className="agreement-billing-card is-contract">
          <span>Contracted work</span>
          <strong>{money(summary.totals.contract_cost)}</strong>
          <small>{commercialModel === 'fixed_price_with_extras' ? 'Draws down the monthly fee' : 'Covered by the contract price'}</small>
        </div>
        <div role="listitem" className="agreement-billing-card is-extra">
          <span>Extra</span>
          <strong>{money(summary.totals.extra_cost)}</strong>
          <small>Billed on top</small>
        </div>
        {summary.totals.unclassified_cost > 0 && <div role="listitem" className="agreement-billing-card is-unset">
          <span>Not classified</span>
          <strong>{money(summary.totals.unclassified_cost)}</strong>
          <small>{summary.totals.unclassified_rows} log rows</small>
        </div>}
      </div>

      {notes.length > 0 && <ul className="agreement-billing-attention" aria-label="Needs attention">
        {notes.map((note) => <li key={note}><AlertTriangle size={14} aria-hidden="true" />{note}</li>)}
      </ul>}
      {notes.length === 0 && hasActivity && <div className="agreement-obligation-message is-success" role="status"><CheckCircle2 size={15} />Every callout has a billing decision and the contract price is recorded.</div>}
      {!hasActivity && <div className="agreement-setup-empty">No contracted or Extra work recorded for {periodLabels[period].toLowerCase()}.</div>}

      {summary.dispatch.length > 0 && <table className="agreement-billing-table">
        <caption>Callouts from Dispatch</caption>
        <thead><tr><th scope="col">Billing</th><th scope="col">Charge lines</th><th scope="col">Total</th><th scope="col">Not yet invoiced</th></tr></thead>
        <tbody>{summary.dispatch.map((row) => <tr key={row.basis} className={`is-${row.basis}`}><th scope="row">{basisLabels[row.basis]}</th><td>{row.lines}</td><td>{money(row.total)}</td><td>{row.basis === 'contract' ? '—' : money(row.uninvoiced_total)}</td></tr>)}</tbody>
      </table>}

      {summary.extraOrders.length > 0 && <table className="agreement-billing-table">
        <caption>Extra works orders</caption>
        <thead><tr><th scope="col">Order</th><th scope="col">In force</th><th scope="col">Charge lines</th><th scope="col">Charged</th></tr></thead>
        <tbody>{summary.extraOrders.map((order) => <tr key={order.id}><th scope="row">{order.reference} · {order.title}</th><td>{new Date(order.starts_on).toLocaleDateString('en-NZ')} – {order.ends_on ? new Date(order.ends_on).toLocaleDateString('en-NZ') : 'ongoing'}</td><td>{order.charge_lines}</td><td>{money(order.charge_total)}</td></tr>)}</tbody>
      </table>}

      {summary.months.length > 0 && <table className="agreement-billing-table">
        <caption>Imported patrol log, by month</caption>
        <thead><tr><th scope="col">Month</th><th scope="col">Contracted</th><th scope="col">Extra</th><th scope="col">Not classified</th></tr></thead>
        <tbody>{[...summary.months].reverse().map((row) => <tr key={row.month}><th scope="row">{monthLabel(row.month)}</th><td>{money(row.contract_cost)}</td><td>{money(row.extra_cost)}</td><td>{row.unclassified_cost > 0 ? money(row.unclassified_cost) : '—'}</td></tr>)}</tbody>
      </table>}
      {commercialModel === 'fixed_price_with_extras' && <FeeDrawdownTable agreementId={agreementId} />}
    </>}
  </section>;
}

/** Fixed price plus Extra: each month's contracted work against the monthly fee, and how the month was settled. */
function FeeDrawdownTable({ agreementId }: { agreementId: string }) {
  const [drawdown, setDrawdown] = useState<FeeDrawdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // ATLAS CALLS: get_agreement_fee_drawdown (read-only, provider finance admin)
    const { data, error: rpcError } = await supabase.rpc('get_agreement_fee_drawdown', { p_service_agreement_id: agreementId });
    if (rpcError) { setDrawdown(null); setError(`The monthly fee drawdown could not be loaded: ${rpcError.message}`); }
    else setDrawdown(parseFeeDrawdown(data));
    setLoading(false);
  }, [agreementId]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="agreement-obligation-message is-error" role="alert"><AlertTriangle size={15} />{error}<button type="button" className="agreement-extra-retry" onClick={() => void load()}>Retry</button></div>;
  if (loading && !drawdown) return <div className="agreement-setup-loading"><RefreshCw size={18} className="is-spinning" />Loading the monthly fee drawdown</div>;
  if (!drawdown?.applies) return null;
  if (drawdown.fee == null) return <div className="agreement-setup-empty">No monthly fee is recorded, so contracted work cannot be drawn down. Record the fee as an accepted quote line.</div>;

  return <table className="agreement-billing-table agreement-fee-drawdown" aria-describedby="agreement-fee-drawdown-help">
    <caption>Monthly fee drawdown<small id="agreement-fee-drawdown-help">Each contracted job draws down the {money(drawdown.fee)} monthly fee. A fully delivered month nets to $0. Unused value is credited; work above the fee is Extra{drawdown.overrunPolicy === 'bill_as_extra' ? ', billed as already agreed with the client' : ', billed only with a justification'}.</small></caption>
    <thead><tr><th scope="col">Month</th><th scope="col">Contracted work</th><th scope="col">Against the fee</th><th scope="col">Invoice</th></tr></thead>
    <tbody>{drawdown.months.map((month) => <tr key={month.month} className={month.outcome ? `is-${month.outcome}` : undefined}>
      <th scope="row">{month.label}</th>
      <td>{money(month.work.total)}{(month.work.callouts > 0 || month.work.patrolVisits > 0) && <small>Log {money(month.work.imported)} · callouts {money(month.work.callouts)} · visits {money(month.work.patrolVisits)}</small>}</td>
      <td>{describeDrawdown(month)}</td>
      <td>{month.settlement
        ? <>{settlementLabel(month.settlement)}<small>{month.settlement.invoiceNumber} · {month.settlement.invoiceStatus}</small></>
        : month.blockers.length > 0 ? <>Not ready<small>{month.blockers[0].message}</small></> : 'Ready to invoice'}</td>
    </tr>)}</tbody>
  </table>;
}
