import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { FinanceOperationsDashboard } from '../components/FinanceOperationsDashboard';
import { FinanceReconciliationWorkspace } from '../components/FinanceReconciliationWorkspace';
import { FinanceLabourCostWorkspace } from '../components/FinanceLabourCostWorkspace';
import { FinanceBudgetWorkspace } from '../components/FinanceBudgetWorkspace';
import { FinanceControlPanel } from '../components/FinanceControlPanel';
import { CompletedWorkToInvoicePanel } from '../components/CompletedWorkToInvoicePanel';
import { FinanceOwnerGuide } from '../components/FinanceOwnerGuide';
import '../components/FinanceControlPanel.css';
import './FinanceHome.css';

type Workflow = 'overview' | 'invoices' | 'reconciliation' | 'labour' | 'budgets' | 'cost' | 'tax' | 'close' | 'periods' | 'guide';
type Destination = 'finance-connections' | 'finance-money' | 'finance-costing' | 'finance-pricing';
type Period = { id: string; name: string; status: string; period_start: string; period_end: string };
type Summary = { total_revenue: number; total_cost: number; gross_profit: number | null };
const money = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD', maximumFractionDigits: 0 }).format(value);
const workflows: { id: Workflow; name: string; detail: string }[] = [
  { id: 'overview', name: 'At a glance', detail: 'See how the business is doing' },
  { id: 'invoices', name: 'Completed work', detail: 'Review work waiting to be billed' },
  { id: 'reconciliation', name: 'Bank reconciliation', detail: 'Match bank activity and receipts' },
  { id: 'labour', name: 'Actual labour', detail: 'Post approved shift hours' },
  { id: 'cost', name: 'Job BOM / cost entry', detail: 'Record evidenced job costs' },
  { id: 'tax', name: 'Tax preparation', detail: 'Separate filing periods; nothing filed' },
  { id: 'budgets', name: 'Budgets', detail: 'Fiscal plans and period variances' },
  { id: 'close', name: 'Period controls', detail: 'Compare, finish and lock' },
  { id: 'periods', name: 'Create accounting period', detail: 'Open a draft money check' },
  { id: 'guide', name: 'Finance guidance', detail: 'Bob’s readiness and approval checks' },
];

export default function FinanceMoneyPage({ onBack, onNavigate, onOpenBob, initialWorkflow = 'overview' }: {
  onBack?: () => void;
  onNavigate?: (destination: Destination) => void;
  onOpenBob?: (prompt: string) => void;
  initialWorkflow?: Workflow;
}) {
  const { profile, operatingOrganizationId } = useAuth();
  const [workflow, setWorkflow] = useState<Workflow>(initialWorkflow);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const organizationId = profile?.organizationId;
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    setPeriods([]); setSummary(null); setLoading(true); setError(null);
    if (!organizationId) { setPeriodId(''); setError('Organisation access could not be confirmed.'); setLoading(false); return; }
    void supabase.from('finance_pl_periods').select('id,name,status,period_start,period_end').eq('organization_id', organizationId).order('period_end', { ascending: false }).then(({ data, error: failure }) => {
      if (cancelled) return;
      if (failure) { setError(failure.message); setLoading(false); return; }
      const rows = (data as Period[]) ?? [];
      setPeriods(rows);
      setPeriodId((current) => rows.some((row) => row.id === current) ? current : rows[0]?.id ?? '');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [organizationId, revision]);
  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    if (!periodId || !organizationId) return;
    void supabase.rpc('get_finance_pl_period_summary', { p_pl_period_id: periodId }).then(({ data, error: failure }) => {
      if (cancelled) return;
      if (failure) setError(failure.message);
      else setSummary((data?.[0] as Summary | undefined) ?? null);
    });
    return () => { cancelled = true; };
  }, [organizationId, periodId, revision]);
  const period = periods.find((row) => row.id === periodId);
  const selectPeriod = (id: string) => { setSummary(null); setError(null); setPeriodId(id); };

  return <div className="page-container finance-control-centre finance-workbench">
    <header className="finance-period-bar" aria-label="Active accounting period and profit and loss">
      <h1>Finance</h1>
      <label><span className="finance-sr-only">Active accounting period</span><select aria-label="Active accounting period" value={periodId} disabled={loading} onChange={(event) => selectPeriod(event.target.value)}><option value="">{loading ? 'Loading periods…' : 'Choose accounting period'}</option>{periods.map((row) => <option key={row.id} value={row.id}>{row.name} · {row.status}</option>)}</select></label>
      <dl><div><dt>Net</dt><dd>{money(summary?.gross_profit)}</dd></div><div><dt>Earned</dt><dd>{money(summary?.total_revenue)}</dd></div><div><dt>Costs</dt><dd>{money(summary?.total_cost)}</dd></div></dl>
      <button type="button" className="btn btn-secondary" aria-label="Refresh finance" onClick={refresh}><RefreshCw size={15} /></button>
    </header>
    <div className="finance-workbench-body">
      <nav className="finance-workflow-switcher" aria-label="Finance workflows">
        {onBack && <button type="button" className="btn btn-secondary" onClick={onBack}><ArrowLeft size={15} />Finance home</button>}
        {workflows.map((item) => <button type="button" key={item.id} aria-label={`${item.name} ${item.detail}`} aria-current={workflow === item.id ? 'page' : undefined} aria-controls="finance-selected-tool" onClick={() => setWorkflow(item.id)}><strong>{item.name}</strong><span>{item.detail}</span></button>)}
        {onNavigate && <div className="finance-workflow-destinations">
          <button type="button" onClick={() => onNavigate('finance-connections')}>Connect ANZ or IRD</button>
          <button type="button" onClick={() => onNavigate('finance-costing')}>Work out what a job should cost</button>
          <button type="button" onClick={() => onNavigate('finance-pricing')}>Set prices and discounts</button>
        </div>}
      </nav>
      <section id="finance-selected-tool" className="finance-selected-tool" aria-label={workflows.find((item) => item.id === workflow)?.name}>
        {error && <div className="alert alert-error" role="alert">{error}<button type="button" className="btn btn-secondary" onClick={refresh}>Retry</button></div>}
        {!loading && !period && <p className="finance-workbench-note">No accounting period selected. Create a draft period to start P&amp;L and job costs.</p>}
        {workflow === 'overview' && <FinanceOperationsDashboard key={`${periodId}-${revision}`} activePeriodId={periodId} compact />}
        {workflow === 'invoices' && <><p className="finance-workbench-note">Completed-work billing follows the operating organisation. This queue is not filtered by the accounting period.</p><CompletedWorkToInvoicePanel organizationId={operatingOrganizationId ?? organizationId ?? null} onOpenInvoices={onNavigate ? () => onNavigate('finance-money') : undefined} /></>}
        {workflow === 'reconciliation' && <><p className="finance-workbench-note">Bank matching is an independent queue, not filtered by the accounting period.</p><FinanceReconciliationWorkspace /></>}
        {workflow === 'labour' && <FinanceLabourCostWorkspace activePeriodId={periodId} onChanged={refresh} />}
        {workflow === 'budgets' && <FinanceBudgetWorkspace activePeriodId={periodId} />}
        {(['cost', 'tax', 'close', 'periods'] as Workflow[]).includes(workflow) && <FinanceControlPanel key={workflow} mode={workflow as 'cost' | 'tax' | 'close' | 'periods'} activePeriodId={periodId} onPeriodChange={selectPeriod} onChanged={refresh} />}
        {workflow === 'guide' && <FinanceOwnerGuide onOpenBob={onOpenBob} />}
      </section>
    </div>
  </div>;
}
