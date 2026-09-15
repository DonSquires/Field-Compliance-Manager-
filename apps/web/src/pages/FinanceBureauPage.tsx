import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';
import './FinanceHome.css';
import { FinanceOwnerGuide } from '../components/FinanceOwnerGuide';
import { FinanceCard } from '../components/FinanceCard';

interface Schedule { id: string; name: string; status: 'draft' | 'active' | 'retired'; effective_from: string; effective_to: string | null; version: number; }
interface DiscountRule { id: string; schedule_id: string; module_key: string | null; discount_kind: 'percentage' | 'fixed_amount'; discount_value: number; minimum_subtotal: number | null; priority: number; }
interface ModuleCatalogRow { module_key: string; }
type FinanceView = 'home' | 'pricing';
type FinanceDestination = 'finance-connections' | 'finance-money' | 'finance-costing' | 'finance-pricing';
type FinanceBobLauncher = (prompt: string) => void;

function FinanceHomeCards({ onOpenBob, onNavigate }: { onOpenBob?: FinanceBobLauncher; onNavigate?: (destination: FinanceDestination) => void }) {
  const openPlainLanguageCheck = () => onOpenBob?.('Check the finance records and guide me through the next useful action in plain language. Do the record-checking first, explain what matters, and ask me only for missing decisions.');
  return <div className="page-container finance-home-page">
    <header className="page-header"><div><p className="finance-owner-eyebrow">Finance, made simple</p><h1>What would you like to do?</h1><p className="subtitle">Bob checks the records and prepares the work. You review the important decisions.</p></div></header>
    <FinanceOwnerGuide onOpenBob={onOpenBob} />
    <section className="finance-task-grid" aria-label="Finance tasks">
      <FinanceCard eyebrow="Daily overview" title="See how the business is doing" description="Money earned, money left after costs, tax to plan for, and payments to sort." action="Open money check" tone="primary" onClick={() => onNavigate?.('finance-money')} />
      <FinanceCard eyebrow="Connections" title="Connect ANZ or IRD" description="Bob prepares the secure connection. Your login stays with the provider." action="Open connections" tone="neutral" onClick={() => onNavigate?.('finance-connections')} />
      <FinanceCard eyebrow="Before quoting" title="Work out what a job should cost" description="Use the job facts to see wages, vehicles, gear, and what should be left over." action="Open job cost check" tone="attention" onClick={() => onNavigate?.('finance-costing')} />
      <FinanceCard eyebrow="Prices" title="Set prices and discounts" description="Keep customer prices and discount plans in one controlled workspace." action="Open prices" tone="good" onClick={() => onNavigate?.('finance-pricing')} />
    </section>
    <div className="finance-home-note"><strong>Not sure?</strong><span>Ask Bob "what needs my attention?" and he will start with the records, not accounting jargon.</span><button type="button" className="btn btn-secondary" onClick={openPlainLanguageCheck}>Ask Bob</button></div>
  </div>;
}

export default function FinanceBureauPage({ onOpenBob, onNavigate, view = 'home' }: { onOpenBob?: FinanceBobLauncher; onNavigate?: (destination: FinanceDestination) => void; view?: FinanceView }) {
  const { profile } = useAuth();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [rules, setRules] = useState<DiscountRule[]>([]);
  const [modules, setModules] = useState<ModuleCatalogRow[]>([]);
  const [selectedScheduleId, setSelectedScheduleId] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({ name: '', effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: '', notes: '' });
  const [ruleForm, setRuleForm] = useState({ moduleKey: '', kind: 'percentage' as 'percentage' | 'fixed_amount', value: '', minimumSubtotal: '', priority: '0' });
  const selectedSchedule = schedules.find((schedule) => schedule.id === selectedScheduleId) ?? null;
  const selectedRules = rules.filter((rule) => rule.schedule_id === selectedScheduleId);

  const load = useCallback(async () => {
    if (!profile?.organizationId) {
      setError('Organisation access could not be confirmed. Pricing data is unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    const [scheduleResponse, moduleResponse] = await Promise.all([
      supabase.from('commercial_discount_schedules').select('id,name,status,effective_from,effective_to,version').eq('provider_organization_id', profile.organizationId).order('status').order('name'),
      supabase.from('module_catalog').select('module_key').eq('active', true).order('module_key'),
    ]);
    if (scheduleResponse.error || moduleResponse.error) { setError(scheduleResponse.error?.message ?? moduleResponse.error?.message ?? 'Pricing bureau could not be loaded.'); setLoading(false); return; }
    const scheduleRows = (scheduleResponse.data as Schedule[]) ?? [];
    setSchedules(scheduleRows); setModules((moduleResponse.data as ModuleCatalogRow[]) ?? []);
    setSelectedScheduleId((current) => current && scheduleRows.some((schedule) => schedule.id === current) ? current : (scheduleRows[0]?.id ?? ''));
    if (scheduleRows.length) { const { data, error: rulesError } = await supabase.from('commercial_discount_schedule_rules').select('id,schedule_id,module_key,discount_kind,discount_value,minimum_subtotal,priority').in('schedule_id', scheduleRows.map((schedule) => schedule.id)).order('priority', { ascending: false }); if (rulesError) setError(rulesError.message); else setRules((data as DiscountRule[]) ?? []); } else setRules([]);
    setLoading(false);
  }, [profile?.organizationId]);
  useEffect(() => { void load(); }, [load]);
  const createSchedule = async (event: React.FormEvent) => { event.preventDefault(); setSaving(true); setError(null); setNotice(null); const { data, error: createError } = await supabase.rpc('manage_commercial_discount_schedule', { p_client_request_id: crypto.randomUUID(), p_action: 'create', p_schedule_id: null, p_name: scheduleForm.name.trim(), p_effective_from: scheduleForm.effectiveFrom, p_effective_to: scheduleForm.effectiveTo || null, p_notes: scheduleForm.notes.trim() || null }); if (createError || !data) setError(createError?.message ?? 'Discount schedule was not confirmed.'); else { setNotice(`${data.name} created as a draft schedule.`); setSelectedScheduleId(data.id); setShowScheduleForm(false); setScheduleForm({ name: '', effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: '', notes: '' }); await load(); } setSaving(false); };
  const addRule = async (event: React.FormEvent) => { event.preventDefault(); if (!selectedSchedule) return; setSaving(true); setError(null); setNotice(null); const { error: createError } = await supabase.rpc('manage_commercial_discount_schedule_rule', { p_schedule_id: selectedSchedule.id, p_module_key: ruleForm.moduleKey || null, p_client_organization_id: null, p_site_id: null, p_zone_id: null, p_discount_kind: ruleForm.kind, p_discount_value: Number(ruleForm.value), p_minimum_subtotal: ruleForm.minimumSubtotal ? Number(ruleForm.minimumSubtotal) : null, p_priority: Number(ruleForm.priority) }); if (createError) setError(createError.message); else { setNotice('Discount rule added to the draft schedule.'); setRuleForm({ moduleKey: '', kind: 'percentage', value: '', minimumSubtotal: '', priority: '0' }); await load(); } setSaving(false); };
  const manageSchedule = async (action: 'activate' | 'retire') => { if (!selectedSchedule) return; setSaving(true); setError(null); setNotice(null); const { error: actionError } = await supabase.rpc('manage_commercial_discount_schedule', { p_client_request_id: crypto.randomUUID(), p_action: action, p_schedule_id: selectedSchedule.id, p_name: null, p_effective_from: null, p_effective_to: null, p_notes: null }); if (actionError) setError(actionError.message); else { setNotice(`${selectedSchedule.name} ${action === 'activate' ? 'activated' : 'retired'}.`); await load(); } setSaving(false); };
  if (view === 'home') return <FinanceHomeCards onOpenBob={onOpenBob} onNavigate={onNavigate} />;

  return <div className="page-container">
    <header className="page-header"><div><h1>Prices and discounts</h1><p className="subtitle">Create the discount plans customers actually see. Staff pay rates live in Pay and charge rules; accepted quotes keep a locked copy of the prices used.</p></div><div><button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /></button><button type="button" className="btn btn-primary" onClick={() => setShowScheduleForm((value) => !value)}><Plus size={16} />{showScheduleForm ? 'Cancel' : 'New discount plan'}</button></div></header>
    {error && <div className="alert alert-error" role="alert"><AlertTriangle size={16} />{error}</div>}{notice && <div className="alert alert-success" role="status"><CheckCircle2 size={16} />{notice}</div>}
    {showScheduleForm && <form className="assessment-form" onSubmit={createSchedule}><div className="form-row"><label><span>Name</span><input required value={scheduleForm.name} onChange={(event) => setScheduleForm({ ...scheduleForm, name: event.target.value })} /></label><label><span>Starts on</span><input required type="date" value={scheduleForm.effectiveFrom} onChange={(event) => setScheduleForm({ ...scheduleForm, effectiveFrom: event.target.value })} /></label><label><span>Ends on</span><input type="date" value={scheduleForm.effectiveTo} onChange={(event) => setScheduleForm({ ...scheduleForm, effectiveTo: event.target.value })} /></label></div><label><span>Notes for your team</span><textarea rows={3} value={scheduleForm.notes} onChange={(event) => setScheduleForm({ ...scheduleForm, notes: event.target.value })} /></label><button type="submit" className="btn btn-primary" disabled={saving || !scheduleForm.name.trim()}>{saving ? 'Creating' : 'Create draft plan'}</button></form>}
    {loading ? <div className="loading-state"><div className="spinner" /><p>Loading price plans</p></div> : <div className="reports-table-wrapper"><table className="reports-table"><thead><tr><th>Plan</th><th>Dates used</th><th>Discounts</th><th>Status</th></tr></thead><tbody>{schedules.length === 0 ? <tr><td colSpan={4} className="text-center">No discount plans set up yet</td></tr> : schedules.map((schedule) => <tr key={schedule.id} onClick={() => setSelectedScheduleId(schedule.id)} style={{ cursor: 'pointer' }} aria-selected={schedule.id === selectedScheduleId}><td><strong>{schedule.name}</strong><small> Version {schedule.version}</small></td><td>{schedule.effective_from}{schedule.effective_to ? ` to ${schedule.effective_to}` : ' onward'}</td><td>{rules.filter((rule) => rule.schedule_id === schedule.id).length}</td><td><span className={`status-badge status-${schedule.status === 'active' ? 'active' : schedule.status === 'retired' ? 'inactive' : 'pending'}`}>{schedule.status}</span></td></tr>)}</tbody></table></div>}
    {selectedSchedule && <section className="reports-section"><header className="page-header"><div><h2>{selectedSchedule.name}</h2><p className="subtitle">{selectedSchedule.status === 'draft' ? 'Draft rules can be adjusted before activation.' : 'Active and retired schedules are preserved as commercial history.'}</p></div><div>{selectedSchedule.status === 'draft' && <button type="button" className="btn btn-primary" disabled={saving || selectedRules.length === 0} onClick={() => void manageSchedule('activate')}>Activate schedule</button>}{selectedSchedule.status === 'active' && <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => void manageSchedule('retire')}>Retire schedule</button>}</div></header><div className="reports-table-wrapper"><table className="reports-table"><thead><tr><th>Module</th><th>Discount</th><th>Minimum subtotal</th><th>Priority</th></tr></thead><tbody>{selectedRules.length === 0 ? <tr><td colSpan={4} className="text-center">No rules in this schedule</td></tr> : selectedRules.map((rule) => <tr key={rule.id}><td>{rule.module_key ?? 'All modules'}</td><td>{rule.discount_kind === 'percentage' ? `${rule.discount_value}%` : `$${Number(rule.discount_value).toFixed(2)}`}</td><td>{rule.minimum_subtotal == null ? 'None' : `$${Number(rule.minimum_subtotal).toFixed(2)}`}</td><td>{rule.priority}</td></tr>)}</tbody></table></div>{selectedSchedule.status === 'draft' && <form className="assessment-form" onSubmit={addRule}><h3>Add discount rule</h3><div className="form-row"><label><span>Module scope</span><select value={ruleForm.moduleKey} onChange={(event) => setRuleForm({ ...ruleForm, moduleKey: event.target.value })}><option value="">All modules</option>{modules.map((module) => <option key={module.module_key} value={module.module_key}>{module.module_key}</option>)}</select></label><label><span>Discount kind</span><select value={ruleForm.kind} onChange={(event) => setRuleForm({ ...ruleForm, kind: event.target.value as DiscountRule['discount_kind'] })}><option value="percentage">Percentage</option><option value="fixed_amount">Fixed amount</option></select></label><label><span>Value</span><input required type="number" min="0" max={ruleForm.kind === 'percentage' ? '100' : undefined} step="0.01" value={ruleForm.value} onChange={(event) => setRuleForm({ ...ruleForm, value: event.target.value })} /></label><label><span>Minimum subtotal</span><input type="number" min="0" step="0.01" value={ruleForm.minimumSubtotal} onChange={(event) => setRuleForm({ ...ruleForm, minimumSubtotal: event.target.value })} /></label><label><span>Priority</span><input type="number" value={ruleForm.priority} onChange={(event) => setRuleForm({ ...ruleForm, priority: event.target.value })} /></label></div><button type="submit" className="btn btn-primary" disabled={saving || !ruleForm.value}>Add rule</button></form>}</section>}
  </div>;
}
