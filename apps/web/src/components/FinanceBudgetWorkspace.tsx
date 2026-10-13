import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDollarSign, Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './FinanceBudgetWorkspace.css';

type Budget = { id: string; name: string; fiscal_year: number; status: string; version: number; approved_at: string | null };
type BudgetLine = { id: string; budget_id: string; pl_period_id: string; cost_type: string; budget_amount: number; notes: string | null };
type Period = { id: string; name: string; period_start: string; period_end: string; status: string };

const financeRoles = new Set(['grand_master', 'master', 'admin', 'admin_officer']);
const money = (value: number) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(value);

export function FinanceBudgetWorkspace() {
  const { profile } = useAuth();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [lines, setLines] = useState<BudgetLine[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [selectedBudgetId, setSelectedBudgetId] = useState('');
  const [budgetName, setBudgetName] = useState('');
  const [fiscalYear, setFiscalYear] = useState(new Date().getFullYear());
  const [periodId, setPeriodId] = useState('');
  const [costType, setCostType] = useState('operating');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [confirmApproval, setConfirmApproval] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canManage = Boolean(profile?.organizationId && financeRoles.has(profile.role));

  const load = useCallback(async () => {
    if (!profile?.organizationId || !canManage) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const [budgetResult, lineResult, periodResult] = await Promise.all([
      supabase.from('finance_budgets').select('id,name,fiscal_year,status,version,approved_at').eq('organization_id', profile.organizationId).order('fiscal_year', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('finance_budget_lines').select('id,budget_id,pl_period_id,cost_type,budget_amount,notes').eq('organization_id', profile.organizationId).order('created_at'),
      supabase.from('finance_pl_periods').select('id,name,period_start,period_end,status').eq('organization_id', profile.organizationId).not('status', 'in', '("closed","archived")').order('period_start', { ascending: false }),
    ]);
    const failure = budgetResult.error ?? lineResult.error ?? periodResult.error;
    if (failure) {
      setError(failure.message);
    } else {
      const nextBudgets = (budgetResult.data as Budget[]) ?? [];
      setBudgets(nextBudgets);
      setLines((lineResult.data as BudgetLine[]) ?? []);
      setPeriods((periodResult.data as Period[]) ?? []);
      setSelectedBudgetId((current) => current && nextBudgets.some((budget) => budget.id === current) ? current : nextBudgets[0]?.id ?? '');
      setPeriodId((current) => current && (periodResult.data ?? []).some((period) => period.id === current) ? current : periodResult.data?.[0]?.id ?? '');
    }
    setLoading(false);
  }, [canManage, profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);

  const selectedBudget = budgets.find((budget) => budget.id === selectedBudgetId) ?? null;
  const selectedLines = useMemo(() => lines.filter((line) => line.budget_id === selectedBudgetId), [lines, selectedBudgetId]);
  const selectedTotal = selectedLines.reduce((sum, line) => sum + Number(line.budget_amount), 0);

  const createBudget = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    const { data, error: rpcError } = await supabase.rpc('create_finance_budget', { p_name: budgetName.trim(), p_fiscal_year: fiscalYear });
    if (rpcError || !data) {
      setError(rpcError?.message ?? 'Budget creation receipt was not confirmed.');
    } else {
      const created = data as Budget;
      setBudgetName('');
      setSelectedBudgetId(created.id);
      setNotice(`${created.name} created as a draft budget.`);
      await load();
      setSelectedBudgetId(created.id);
    }
    setSaving(false);
  };

  const addLine = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedBudget || !periodId) return;
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 0) {
      setError('Enter a budget amount of zero or more.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: rpcError } = await supabase.rpc('add_finance_budget_line', {
      p_budget_id: selectedBudget.id,
      p_pl_period_id: periodId,
      p_cost_type: costType.trim(),
      p_budget_amount: numericAmount,
      p_cost_centre_id: null,
      p_service_agreement_id: null,
      p_notes: notes.trim() || null,
    });
    if (rpcError) {
      setError(rpcError.message);
    } else {
      setAmount('');
      setNotes('');
      setNotice('Budget line saved. Reusing the same period and cost type updates that line.');
      await load();
    }
    setSaving(false);
  };

  const approveBudget = async () => {
    if (!selectedBudget) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: rpcError } = await supabase.rpc('approve_finance_budget', { p_budget_id: selectedBudget.id });
    if (rpcError) {
      setError(rpcError.message);
    } else {
      setConfirmApproval(false);
      setNotice(`${selectedBudget.name} approved and locked for operational comparison.`);
      await load();
    }
    setSaving(false);
  };

  const calculateVariance = async () => {
    if (!selectedBudget || !periodId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { data: varianceRows, error: varianceError } = await supabase.rpc('calculate_finance_budget_variance', {
      p_budget_id: selectedBudget.id,
      p_pl_period_id: periodId,
    });
    if (varianceError) {
      setError(varianceError.message);
      setSaving(false);
      return;
    }
    const varianceCount = Array.isArray(varianceRows) ? varianceRows.length : 0;
    const { data: rollRows, error: rollError } = await supabase.rpc('calculate_cost_centre_roll', {
      p_pl_period_id: periodId,
    });
    if (rollError) {
      setError(`Variance was saved, but cost-centre totals could not be refreshed: ${rollError.message}`);
      setNotice(`Variance calculation saved ${varianceCount} comparison row${varianceCount === 1 ? '' : 's'}.`);
      setSaving(false);
      return;
    }
    const rollCount = Array.isArray(rollRows) ? rollRows.length : 0;
    setNotice(`Saved ${varianceCount} variance comparison row${varianceCount === 1 ? '' : 's'} and refreshed ${rollCount} cost-centre roll${rollCount === 1 ? '' : 's'} for the selected reporting period.`);
    setSaving(false);
  };

  if (!profile?.organizationId) return <section className="finance-budget-workspace" role="alert">Organisation access could not be confirmed. Budget management is unavailable.</section>;
  if (!canManage) return <section className="finance-budget-workspace"><h2>Budgets</h2><p>Finance administrator access is required to manage budgets.</p></section>;
  if (loading) return <section className="finance-budget-workspace" aria-busy="true"><p>Loading finance budgets...</p></section>;

  return <section className="finance-budget-workspace" aria-labelledby="finance-budget-heading">
    <header><div><p>Planning and variance control</p><h2 id="finance-budget-heading">Finance budgets</h2><span>Create a draft, allocate amounts to reporting periods, then approve it for variance monitoring.</span></div><button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={saving}><RefreshCw size={15} />Refresh</button></header>
    {error && <p className="finance-budget-message is-error" role="alert"><AlertTriangle size={15} />{error}</p>}
    {notice && <p className="finance-budget-message is-success" role="status"><CheckCircle2 size={15} />{notice}</p>}
    <div className="finance-budget-grid">
      <form onSubmit={createBudget} className="finance-budget-panel">
        <h3>Create a draft budget</h3>
        <label><span>Budget name</span><input required maxLength={160} value={budgetName} onChange={(event) => setBudgetName(event.target.value)} placeholder="FY operating budget" /></label>
        <label><span>Fiscal year</span><input required type="number" min={2000} max={2200} value={fiscalYear} onChange={(event) => setFiscalYear(Number(event.target.value))} /></label>
        <button type="submit" className="btn btn-primary" disabled={saving || !budgetName.trim()}><Plus size={15} />{saving ? 'Saving...' : 'Create draft'}</button>
      </form>
      <div className="finance-budget-panel">
        <h3>Budget register</h3>
        {budgets.length === 0 ? <p>No budgets exist yet.</p> : <div className="finance-budget-register">{budgets.map((budget) => <button type="button" className={budget.id === selectedBudgetId ? 'is-selected' : ''} key={budget.id} onClick={() => { setSelectedBudgetId(budget.id); setConfirmApproval(false); }}><span><strong>{budget.name}</strong><small>FY {budget.fiscal_year} · version {budget.version}</small></span><em>{budget.status}</em></button>)}</div>}
      </div>
    </div>
    {selectedBudget && <div className="finance-budget-detail">
      <div className="finance-budget-detail-heading"><div><h3>{selectedBudget.name}</h3><p>{selectedLines.length} line(s) · {money(selectedTotal)}</p></div><span>{selectedBudget.status}</span></div>
      {selectedLines.length > 0 && <div className="finance-budget-lines" role="table" aria-label={`${selectedBudget.name} budget lines`}>{selectedLines.map((line) => <div role="row" key={line.id}><span>{periods.find((period) => period.id === line.pl_period_id)?.name ?? 'Reporting period'}</span><strong>{line.cost_type}</strong><span>{money(Number(line.budget_amount))}</span><small>{line.notes ?? 'No note'}</small></div>)}</div>}
      {selectedBudget.status === 'draft' && <>
        <form onSubmit={addLine} className="finance-budget-line-form">
          <label><span>Reporting period</span><select required value={periodId} onChange={(event) => setPeriodId(event.target.value)}><option value="">Choose a period</option>{periods.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label><span>Cost type</span><input required maxLength={80} value={costType} onChange={(event) => setCostType(event.target.value)} /></label>
          <label><span>Budget amount</span><input required type="number" min={0} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
          <label><span>Note</span><input maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
          <button type="submit" className="btn btn-secondary" disabled={saving || !periodId || !amount}><CircleDollarSign size={15} />{saving ? 'Saving...' : 'Save line'}</button>
        </form>
        {!confirmApproval ? <button type="button" className="btn btn-primary" disabled={saving || selectedLines.length === 0} onClick={() => setConfirmApproval(true)}>Review and approve budget</button> : <div className="finance-budget-confirm" role="alert"><strong>Approve {selectedBudget.name}?</strong><p>Approval locks this draft for operational variance comparison. Confirm the {money(selectedTotal)} total first.</p><div><button type="button" className="btn btn-secondary" onClick={() => setConfirmApproval(false)}>Keep editing</button><button type="button" className="btn btn-primary" disabled={saving} onClick={() => void approveBudget()}>{saving ? 'Approving...' : 'Approve budget'}</button></div></div>}
      </>}
      {['approved', 'locked'].includes(selectedBudget.status) && <div className="finance-budget-variance"><div><strong>Refresh actual-versus-budget results</strong><p>Choose a reporting period. Existing variance and cost-centre roll rows are updated rather than duplicated.</p></div><select value={periodId} onChange={(event) => setPeriodId(event.target.value)} aria-label="Variance reporting period"><option value="">Choose a period</option>{periods.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button type="button" className="btn btn-primary" disabled={saving || !periodId} onClick={() => void calculateVariance()}>{saving ? 'Calculating...' : 'Refresh finance results'}</button></div>}
    </div>}
  </section>;
}
