import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BarChart3, CheckCircle2, CircleDollarSign, Clock3, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './FinanceOperationsDashboard.css';

type Period = { id: string; name: string; period_start: string; period_end: string; status: string };
type Snapshot = { total_revenue: number; total_cost: number; gross_profit: number | null; gross_margin_pct: number | null; cost_line_count: number };
type PeriodSummary = Snapshot & { pl_period_id: string; period_status: string; invoice_count: number };
type TaxPeriod = { period_end: string; filing_due_date: string; status: string; net_tax_due: number };
type Variance = { status: 'on_track' | 'watch' | 'over_budget' | 'no_budget'; variance_amount: number; variance_pct: number | null };
type Receipt = { payment_amount: number; reconciliation_status: 'pending' | 'matched' | 'unmatched' | 'disputed' };
type ExternalTransaction = { id: string; amount: number; description: string | null; reconciliation_status: 'unmatched' | 'matched' | 'review' | 'excluded' };

const money = (value: number | null | undefined) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD', maximumFractionDigits: 0 }).format(Number(value ?? 0));
const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T00:00:00`)) : 'Not set';

export function FinanceOperationsDashboard() {
  const { profile } = useAuth();
  const [period, setPeriod] = useState<Period | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [periodSummary, setPeriodSummary] = useState<PeriodSummary | null>(null);
  const [taxPeriod, setTaxPeriod] = useState<TaxPeriod | null>(null);
  const [variances, setVariances] = useState<Variance[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [externalTransactions, setExternalTransactions] = useState<ExternalTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organizationId) {
      setError('Organisation access could not be confirmed. Finance operations are unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const periodResponse = await supabase.from('finance_pl_periods').select('id,name,period_start,period_end,status').eq('organization_id', profile.organizationId).order('period_end', { ascending: false }).limit(1);
    if (periodResponse.error) {
      setError(periodResponse.error.message);
      setLoading(false);
      return;
    }
    const latestPeriod = (periodResponse.data?.[0] as Period | undefined) ?? null;
    const [snapshotResponse, summaryResponse, taxResponse, varianceResponse, receiptResponse, transactionResponse] = await Promise.all([
      latestPeriod
        ? supabase.from('finance_pl_snapshots').select('total_revenue,total_cost,gross_profit,gross_margin_pct,cost_line_count').eq('organization_id', profile.organizationId).eq('pl_period_id', latestPeriod.id).limit(1)
        : Promise.resolve({ data: [], error: null }),
      latestPeriod
        ? supabase.rpc('get_finance_pl_period_summary', { p_pl_period_id: latestPeriod.id })
        : Promise.resolve({ data: [], error: null }),
      supabase.from('finance_tax_periods').select('period_end,filing_due_date,status,net_tax_due').eq('organization_id', profile.organizationId).order('filing_due_date', { ascending: true }).limit(1),
      supabase.from('finance_budget_variances').select('status,variance_amount,variance_pct').eq('organization_id', profile.organizationId).order('calculated_at', { ascending: false }).limit(50),
      supabase.from('payment_receipts').select('payment_amount,reconciliation_status').eq('organization_id', profile.organizationId).order('created_at', { ascending: false }).limit(100),
      supabase.from('finance_external_bank_transactions').select('id,amount,description,reconciliation_status').eq('organization_id', profile.organizationId).order('transaction_date', { ascending: false }).limit(100),
    ]);
    const failed = [snapshotResponse, summaryResponse, taxResponse, varianceResponse, receiptResponse, transactionResponse].find((response) => response.error);
    if (failed?.error) {
      setError(failed.error.message);
    } else {
      setPeriod(latestPeriod);
      setSnapshot((snapshotResponse.data?.[0] as Snapshot | undefined) ?? null);
      setPeriodSummary((summaryResponse.data?.[0] as PeriodSummary | undefined) ?? null);
      setTaxPeriod((taxResponse.data?.[0] as TaxPeriod | undefined) ?? null);
      setVariances((varianceResponse.data as Variance[]) ?? []);
      setReceipts((receiptResponse.data as Receipt[]) ?? []);
      setExternalTransactions((transactionResponse.data as ExternalTransaction[]) ?? []);
    }
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);

  const overBudget = variances.filter((variance) => variance.status === 'over_budget' || variance.status === 'no_budget');
  const watchBudget = variances.filter((variance) => variance.status === 'watch');
  const unmatchedReceipts = receipts.filter((receipt) => receipt.reconciliation_status !== 'matched');
  const unmatchedTransactions = externalTransactions.filter((transaction) => transaction.reconciliation_status === 'unmatched' || transaction.reconciliation_status === 'review');
  const collected = receipts.reduce((sum, receipt) => sum + Number(receipt.payment_amount || 0), 0);
  const currentFinancials = snapshot ?? periodSummary;
  const isDraft = period?.status === 'draft' || period?.status === 'locked';

  if (loading) return <section className="finance-ops-dashboard" aria-busy="true"><div className="loading-state"><div className="spinner" /><p>Loading finance operations</p></div></section>;
  if (error) return <section className="finance-ops-dashboard finance-ops-dashboard-error" role="alert"><AlertTriangle size={18} /><div><strong>Finance dashboard unavailable</strong><p>{error}</p></div><button type="button" className="btn btn-secondary" onClick={() => void load()}><RefreshCw size={15} />Retry</button></section>;

  return <section className="finance-ops-dashboard" aria-labelledby="finance-ops-heading">
    <header className="finance-ops-header"><div><p className="finance-ops-eyebrow">Your business at a glance</p><h2 id="finance-ops-heading">What is happening with my money?</h2><p>Bob has checked your records and turned them into a short list of things worth knowing.</p></div><button type="button" className="btn btn-secondary" onClick={() => void load()} title="Refresh finance operations"><RefreshCw size={15} />Refresh</button></header>
    <div className="finance-ops-kpis">
      <article><span><BarChart3 size={14} />Money left after costs</span><strong>{currentFinancials ? money(currentFinancials.gross_profit) : 'Not ready'}</strong><small>{currentFinancials ? (isDraft ? 'Draft result — this changes as invoices and costs are recorded' : `${currentFinancials.gross_margin_pct ?? 0}% of sales left after direct costs`) : 'Bob needs a money check period'}</small></article>
      <article><span><CircleDollarSign size={14} />Money earned</span><strong>{money(currentFinancials?.total_revenue)}</strong><small>{currentFinancials ? `${currentFinancials.cost_line_count} costs checked · ${money(currentFinancials.total_cost)} recorded` : 'No activity checked yet'}</small></article>
      <article className={overBudget.length ? 'is-warning' : ''}><span><ShieldAlert size={14} />Needs attention</span><strong>{overBudget.length}</strong><small>{watchBudget.length} other items to watch</small></article>
      <article><span><CheckCircle2 size={14} />Customer payments</span><strong>{money(collected)}</strong><small>{unmatchedTransactions.length || unmatchedReceipts.length} still need to be matched to a job or invoice</small></article>
    </div>
    <div className="finance-ops-grid">
      <div className="finance-ops-panel"><div className="finance-ops-panel-heading"><div><h3>Current money check</h3><p>{period?.name ?? 'No money check configured'}</p></div><span className={`finance-ops-status status-${period?.status ?? 'empty'}`}>{period?.status ?? 'empty'}</span></div>{period ? <dl><div><dt>Dates checked</dt><dd>{date(period.period_start)} to {date(period.period_end)}</dd></div><div><dt>Revenue recorded</dt><dd>{money(currentFinancials?.total_revenue)}</dd></div><div><dt>Costs recorded</dt><dd>{money(currentFinancials?.total_cost)}</dd></div><div><dt>{isDraft ? 'Current draft result' : 'Left after costs'}</dt><dd>{money(currentFinancials?.gross_profit)}</dd></div></dl> : <div className="finance-ops-empty">Bob needs a period to start checking your numbers.</div>}</div>
      <div className="finance-ops-panel"><div className="finance-ops-panel-heading"><div><h3>Tax money to plan for</h3><p>{taxPeriod ? `Bob says it is due ${date(taxPeriod.filing_due_date)}` : 'No tax check configured'}</p></div><span className={`finance-ops-status status-${taxPeriod?.status ?? 'empty'}`}>{taxPeriod?.status ?? 'empty'}</span></div>{taxPeriod ? <dl><div><dt>Dates covered</dt><dd>Until {date(taxPeriod.period_end)}</dd></div><div><dt>Set aside</dt><dd>{money(taxPeriod.net_tax_due)}</dd></div></dl> : <div className="finance-ops-empty">Bob can prepare a tax checklist once a tax period is open.</div>}</div>
      <div className="finance-ops-panel"><div className="finance-ops-panel-heading"><div><h3>Payments to sort</h3><p>Bob found bank activity that still needs to be matched to the right job or invoice</p></div><Clock3 size={18} /></div>{unmatchedTransactions.length ? <ul className="finance-ops-list">{unmatchedTransactions.slice(0, 4).map((transaction) => <li key={transaction.id}><span>{money(transaction.amount)}{transaction.description ? ` · ${transaction.description}` : ''}</span><strong>{transaction.reconciliation_status.replaceAll('_', ' ')}</strong></li>)}</ul> : unmatchedReceipts.length ? <ul className="finance-ops-list">{unmatchedReceipts.slice(0, 4).map((receipt, index) => <li key={`${receipt.reconciliation_status}-${index}`}><span>{money(receipt.payment_amount)}</span><strong>{receipt.reconciliation_status.replaceAll('_', ' ')}</strong></li>)}</ul> : <div className="finance-ops-empty is-good"><CheckCircle2 size={16} />Nothing needs sorting</div>}</div>
    </div>
  </section>;
}
