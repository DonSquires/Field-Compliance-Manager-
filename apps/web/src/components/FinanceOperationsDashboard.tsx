import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BarChart3, CheckCircle2, CircleDollarSign, Clock3, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './FinanceOperationsDashboard.css';

type Period = { id: string; name: string; period_start: string; period_end: string; status: string };
type Snapshot = { total_revenue: number; total_cost: number; gross_profit: number | null; gross_margin_pct: number | null; cost_line_count: number };
type TaxPeriod = { period_end: string; filing_due_date: string; status: string; net_tax_due: number };
type Variance = { status: 'on_track' | 'watch' | 'over_budget' | 'no_budget'; variance_amount: number; variance_pct: number | null };
type Receipt = { payment_amount: number; reconciliation_status: 'pending' | 'matched' | 'unmatched' | 'disputed' };

const money = (value: number | null | undefined) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD', maximumFractionDigits: 0 }).format(Number(value ?? 0));
const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T00:00:00`)) : 'Not set';

export function FinanceOperationsDashboard() {
  const { profile } = useAuth();
  const [period, setPeriod] = useState<Period | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [taxPeriod, setTaxPeriod] = useState<TaxPeriod | null>(null);
  const [variances, setVariances] = useState<Variance[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true);
    setError(null);
    const [periodResponse, snapshotResponse, taxResponse, varianceResponse, receiptResponse] = await Promise.all([
      supabase.from('finance_pl_periods').select('id,name,period_start,period_end,status').eq('organization_id', profile.organizationId).order('period_end', { ascending: false }).limit(1),
      supabase.from('finance_pl_snapshots').select('total_revenue,total_cost,gross_profit,gross_margin_pct,cost_line_count').eq('organization_id', profile.organizationId).order('snapshot_at', { ascending: false }).limit(1),
      supabase.from('finance_tax_periods').select('period_end,filing_due_date,status,net_tax_due').eq('organization_id', profile.organizationId).order('filing_due_date', { ascending: true }).limit(1),
      supabase.from('finance_budget_variances').select('status,variance_amount,variance_pct').eq('organization_id', profile.organizationId).order('calculated_at', { ascending: false }).limit(50),
      supabase.from('payment_receipts').select('payment_amount,reconciliation_status').eq('organization_id', profile.organizationId).order('created_at', { ascending: false }).limit(100),
    ]);
    const failed = [periodResponse, snapshotResponse, taxResponse, varianceResponse, receiptResponse].find((response) => response.error);
    if (failed?.error) {
      setError(failed.error.message);
    } else {
      setPeriod((periodResponse.data?.[0] as Period | undefined) ?? null);
      setSnapshot((snapshotResponse.data?.[0] as Snapshot | undefined) ?? null);
      setTaxPeriod((taxResponse.data?.[0] as TaxPeriod | undefined) ?? null);
      setVariances((varianceResponse.data as Variance[]) ?? []);
      setReceipts((receiptResponse.data as Receipt[]) ?? []);
    }
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);

  const overBudget = variances.filter((variance) => variance.status === 'over_budget' || variance.status === 'no_budget');
  const watchBudget = variances.filter((variance) => variance.status === 'watch');
  const unmatchedReceipts = receipts.filter((receipt) => receipt.reconciliation_status !== 'matched');
  const collected = receipts.reduce((sum, receipt) => sum + Number(receipt.payment_amount || 0), 0);

  if (loading) return <section className="finance-ops-dashboard" aria-busy="true"><div className="loading-state"><div className="spinner" /><p>Loading finance operations</p></div></section>;
  if (error) return <section className="finance-ops-dashboard finance-ops-dashboard-error" role="alert"><AlertTriangle size={18} /><div><strong>Finance dashboard unavailable</strong><p>{error}</p></div><button type="button" className="btn btn-secondary" onClick={() => void load()}><RefreshCw size={15} />Retry</button></section>;

  return <section className="finance-ops-dashboard" aria-labelledby="finance-ops-heading">
    <header className="finance-ops-header"><div><p className="finance-ops-eyebrow">Control centre</p><h2 id="finance-ops-heading">Finance operations</h2><p>One view of current performance, tax obligations, budget drift, and cash reconciliation.</p></div><button type="button" className="btn btn-secondary" onClick={() => void load()} title="Refresh finance operations"><RefreshCw size={15} />Refresh</button></header>
    <div className="finance-ops-kpis">
      <article><span><BarChart3 size={14} />Latest P&amp;L</span><strong>{snapshot ? money(snapshot.gross_profit) : 'No snapshot'}</strong><small>{snapshot ? `${snapshot.gross_margin_pct ?? 0}% gross margin` : 'Close a period to calculate'}</small></article>
      <article><span><CircleDollarSign size={14} />Revenue captured</span><strong>{money(snapshot?.total_revenue)}</strong><small>{snapshot ? `${snapshot.cost_line_count} cost lines` : 'No period activity yet'}</small></article>
      <article className={overBudget.length ? 'is-warning' : ''}><span><ShieldAlert size={14} />Budget attention</span><strong>{overBudget.length}</strong><small>{watchBudget.length} items on watch</small></article>
      <article><span><CheckCircle2 size={14} />Receipts recorded</span><strong>{money(collected)}</strong><small>{unmatchedReceipts.length} awaiting reconciliation</small></article>
    </div>
    <div className="finance-ops-grid">
      <div className="finance-ops-panel"><div className="finance-ops-panel-heading"><div><h3>Current P&amp;L period</h3><p>{period?.name ?? 'No P&L period configured'}</p></div><span className={`finance-ops-status status-${period?.status ?? 'empty'}`}>{period?.status ?? 'empty'}</span></div>{period ? <dl><div><dt>Period</dt><dd>{date(period.period_start)} to {date(period.period_end)}</dd></div><div><dt>Gross profit</dt><dd>{money(snapshot?.gross_profit)}</dd></div></dl> : <div className="finance-ops-empty">Create a period to start collecting actual costs.</div>}</div>
      <div className="finance-ops-panel"><div className="finance-ops-panel-heading"><div><h3>GST filing</h3><p>{taxPeriod ? `Due ${date(taxPeriod.filing_due_date)}` : 'No tax period configured'}</p></div><span className={`finance-ops-status status-${taxPeriod?.status ?? 'empty'}`}>{taxPeriod?.status ?? 'empty'}</span></div>{taxPeriod ? <dl><div><dt>Period end</dt><dd>{date(taxPeriod.period_end)}</dd></div><div><dt>Net tax due</dt><dd>{money(taxPeriod.net_tax_due)}</dd></div></dl> : <div className="finance-ops-empty">Open a GST period to track filing readiness.</div>}</div>
      <div className="finance-ops-panel"><div className="finance-ops-panel-heading"><div><h3>Reconciliation queue</h3><p>Receipts requiring review</p></div><Clock3 size={18} /></div>{unmatchedReceipts.length ? <ul className="finance-ops-list">{unmatchedReceipts.slice(0, 4).map((receipt, index) => <li key={`${receipt.reconciliation_status}-${index}`}><span>{money(receipt.payment_amount)}</span><strong>{receipt.reconciliation_status}</strong></li>)}</ul> : <div className="finance-ops-empty is-good"><CheckCircle2 size={16} />All recent receipts matched</div>}</div>
    </div>
  </section>;
}
