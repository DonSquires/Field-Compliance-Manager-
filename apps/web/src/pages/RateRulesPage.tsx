import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface RateRule {
  id: string;
  rule_kind: 'pay' | 'billing';
  name: string;
  rate_type: string;
  amount: number;
  pay_code: string | null;
  service_type: string | null;
  job_type: string | null;
  day_category: string | null;
  priority: number;
  active: boolean;
  updated_at: string;
}

interface CompletedDispatchJob {
  id: string;
  job_type: string;
  completed_at: string;
  client_site_id: string | null;
}

const RATE_TYPES = ['hourly', 'flat', 'daily', 'per_km', 'per_unit', 'percentage', 'per_hour_travel', 'per_hour_allowance', 'oncall_flat', 'callout', 'higher_duties_flat', 'per_visit', 'per_notice'];

export default function RateRulesPage() {
  const { profile } = useAuth();
  const [rules, setRules] = useState<RateRule[]>([]);
  const [completedJobs, setCompletedJobs] = useState<CompletedDispatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState<RateRule | null>(null);
  const [form, setForm] = useState({ kind: 'pay' as 'pay' | 'billing', name: '', rateType: 'hourly', amount: '', payCode: '', serviceType: '', jobType: '', dayCategory: '', priority: '0' });

  const load = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true); setError(null);
    const [rulesResponse, jobsResponse, payLinesResponse] = await Promise.all([
      supabase.from('rate_rules').select('id,rule_kind,name,rate_type,amount,pay_code,service_type,job_type,day_category,priority,active,updated_at').eq('organization_id', profile.organizationId).order('active', { ascending: false }).order('priority', { ascending: false }).order('name'),
      supabase.from('dispatch_jobs').select('id,job_type,completed_at,client_site_id').eq('organization_id', profile.organizationId).eq('status', 'completed').order('completed_at', { ascending: false }).limit(50),
      supabase.from('dispatch_job_pay_lines').select('source_dispatch_id').eq('organization_id', profile.organizationId).limit(500),
    ]);
    const loadError = rulesResponse.error ?? jobsResponse.error ?? payLinesResponse.error;
    if (loadError) setError(loadError.message); else {
      setRules((rulesResponse.data as RateRule[]) ?? []);
      const resolved = new Set((payLinesResponse.data ?? []).map((line: { source_dispatch_id: string }) => line.source_dispatch_id));
      setCompletedJobs(((jobsResponse.data as CompletedDispatchJob[]) ?? []).filter((job) => !resolved.has(job.id)));
    }
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!showForm) setEditingRule(null); }, [showForm]);

  const createRule = async (event: React.FormEvent) => {
    event.preventDefault();
    if (editingRule) { await updateRule(event); return; }
    setSaving(true); setError(null); setNotice(null);
    const { error: createError } = await supabase.rpc('manage_rate_rule', { p_client_request_id: crypto.randomUUID(), p_action: 'create', p_rate_rule_id: null, p_expected_updated_at: null, p_rule_kind: form.kind, p_name: form.name.trim(), p_rate_type: form.rateType, p_amount: Number(form.amount), p_pay_code: form.payCode.trim() || null, p_service_type: form.serviceType.trim() || null, p_job_type: form.jobType.trim() || null, p_client_org_id: null, p_site_id: null, p_zone_id: null, p_day_category: form.dayCategory || null, p_effective_from: null, p_effective_to: null, p_priority: Number(form.priority) });
    if (createError) setError(createError.message);
    else { setNotice('Rate rule created and available to the resolver.'); setForm({ kind: 'pay', name: '', rateType: 'hourly', amount: '', payCode: '', serviceType: '', jobType: '', dayCategory: '', priority: '0' }); setShowForm(false); await load(); }
    setSaving(false);
  };

  const openEdit = (rule: RateRule) => {
    setEditingRule(rule);
    setForm({ kind: rule.rule_kind, name: rule.name, rateType: rule.rate_type, amount: String(rule.amount), payCode: rule.pay_code ?? '', serviceType: rule.service_type ?? '', jobType: rule.job_type ?? '', dayCategory: rule.day_category ?? '', priority: String(rule.priority) });
    setShowForm(true); setError(null); setNotice(null);
  };

  const updateRule = async (event: React.FormEvent) => {
    event.preventDefault(); if (!editingRule) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: updateError } = await supabase.rpc('manage_rate_rule', { p_client_request_id: crypto.randomUUID(), p_action: 'update', p_rate_rule_id: editingRule.id, p_expected_updated_at: editingRule.updated_at, p_rule_kind: form.kind, p_name: form.name.trim(), p_rate_type: form.rateType, p_amount: Number(form.amount), p_pay_code: form.payCode.trim() || null, p_service_type: form.serviceType.trim() || null, p_job_type: form.jobType.trim() || null, p_client_org_id: null, p_site_id: null, p_zone_id: null, p_day_category: form.dayCategory || null, p_effective_from: null, p_effective_to: null, p_priority: Number(form.priority) });
    if (updateError) setError(updateError.message);
    else { setNotice('Rate rule updated with a new audit revision.'); setEditingRule(null); setShowForm(false); await load(); }
    setSaving(false);
  };

  const toggle = async (rule: RateRule) => {
    setSaving(true); setError(null); setNotice(null);
    const { error: actionError } = await supabase.rpc('manage_rate_rule', { p_client_request_id: crypto.randomUUID(), p_action: rule.active ? 'deactivate' : 'reactivate', p_rate_rule_id: rule.id, p_expected_updated_at: rule.updated_at, p_rule_kind: null, p_name: null, p_rate_type: null, p_amount: null, p_pay_code: null, p_service_type: null, p_job_type: null, p_client_org_id: null, p_site_id: null, p_zone_id: null, p_day_category: null, p_effective_from: null, p_effective_to: null, p_priority: 0 });
    if (actionError) setError(actionError.message); else { setNotice(`Rate rule ${rule.active ? 'deactivated' : 'reactivated'}.`); await load(); }
    setSaving(false);
  };

  const resolveCompletedJob = async (job: CompletedDispatchJob) => {
    setSaving(true); setError(null); setNotice(null);
    const { data, error: resolveError } = await supabase.rpc('resolve_dispatch_job_pay_lines', { p_client_request_id: crypto.randomUUID(), p_dispatch_job_id: job.id, p_day_category: null });
    const receipt = Array.isArray(data) ? data[0] : data;
    if (resolveError || !receipt) setError(resolveError?.message ?? 'Pay-line resolution was not confirmed.');
    else { setNotice(`${receipt.lines_written} pay line(s) resolved; ${receipt.unresolved_count} exception(s) retained for finance review.`); await load(); }
    setSaving(false);
  };

  return <div className="page-container">
    <header className="page-header"><div><h1>Rate Rules</h1><p className="subtitle">Governed pay and billing inputs for roster forecasts, dispatch pay lines, callouts, court time, and CRM billing.</p></div><div><button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /></button><button type="button" className="btn btn-primary" onClick={() => setShowForm((value) => !value)}><Plus size={16} />{showForm ? 'Cancel' : 'New rate rule'}</button></div></header>
    {error && <div className="alert alert-error" role="alert"><AlertTriangle size={16} />{error}</div>}
    {notice && <div className="alert alert-success" role="status"><CheckCircle2 size={16} />{notice}</div>}
    {!loading && rules.length > 0 && <section className="reports-section"><h2>Rate Rule Maintenance</h2><div className="contacts-list">{rules.map((rule) => <div key={`edit-${rule.id}`} className="contact-card"><div className="contact-header"><h3>{rule.name}</h3><span className={`status-badge status-${rule.active ? 'active' : 'inactive'}`}>{rule.active ? 'Active' : 'Inactive'}</span></div><div className="contact-details"><p>{rule.rule_kind} · {rule.rate_type.replaceAll('_', ' ')} · {Number(rule.amount).toFixed(2)}</p></div><button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => openEdit(rule)}>Edit rule</button></div>)}</div></section>}
    {!loading && <section className="reports-section"><h2>Completed Jobs Awaiting Rate Resolution ({completedJobs.length})</h2>{completedJobs.length === 0 ? <div className="empty-state"><p>Every visible completed job has a retained pay-line snapshot.</p></div> : <div className="contacts-list">{completedJobs.map((job) => <div className="contact-card" key={job.id}><div className="contact-header"><h3>{job.job_type.replaceAll('_', ' ')}</h3><span className="contact-type-badge">Completed</span></div><div className="contact-details"><p>Completed {job.completed_at ? new Date(job.completed_at).toLocaleString() : 'time unavailable'}</p><p className="contact-meta">Unmatched rules or missing coordinates are retained as finance exceptions, not zero-value claims.</p></div><button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void resolveCompletedJob(job)}>{saving ? 'Resolving' : 'Resolve pay lines'}</button></div>)}</div>}</section>}
    {showForm && <form className="assessment-form" onSubmit={createRule}><div className="form-row"><label><span>Rule kind</span><select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as 'pay' | 'billing' })}><option value="pay">Pay</option><option value="billing">Billing</option></select></label><label><span>Name</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label></div><div className="form-row"><label><span>Rate type</span><select value={form.rateType} onChange={(event) => setForm({ ...form, rateType: event.target.value })}>{RATE_TYPES.map((type) => <option value={type} key={type}>{type.replaceAll('_', ' ')}</option>)}</select></label><label><span>Amount</span><input type="number" min="0" step="0.0001" required value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label><label><span>Priority</span><input type="number" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })} /></label></div><div className="form-row"><label><span>Pay or billing code</span><input value={form.payCode} onChange={(event) => setForm({ ...form, payCode: event.target.value })} /></label><label><span>Service type</span><input value={form.serviceType} onChange={(event) => setForm({ ...form, serviceType: event.target.value })} /></label><label><span>Job type</span><input value={form.jobType} onChange={(event) => setForm({ ...form, jobType: event.target.value })} /></label></div><label><span>Day category</span><select value={form.dayCategory} onChange={(event) => setForm({ ...form, dayCategory: event.target.value })}><option value="">Any day</option><option value="weekday">Weekday</option><option value="weekend">Weekend</option><option value="public_holiday">Public holiday</option><option value="night">Night</option></select></label><button type="submit" className="btn btn-primary" disabled={saving || !form.name.trim() || !form.amount}>{saving ? 'Saving' : 'Create rate rule'}</button></form>}
    {loading ? <div className="loading-state"><div className="spinner" /><p>Loading rate rules</p></div> : <div className="reports-table-wrapper"><table className="reports-table"><thead><tr><th>Name</th><th>Kind</th><th>Rate</th><th>Scope</th><th>Priority</th><th>Status</th><th /></tr></thead><tbody>{rules.length === 0 ? <tr><td colSpan={7} className="text-center">No rate rules configured</td></tr> : rules.map((rule) => <tr key={rule.id}><td>{rule.name}<small>{rule.pay_code ? ` · ${rule.pay_code}` : ''}</small></td><td>{rule.rule_kind}</td><td>{rule.rate_type.replaceAll('_', ' ')} · {Number(rule.amount).toFixed(2)}</td><td>{[rule.service_type, rule.job_type, rule.day_category?.replaceAll('_', ' ')].filter(Boolean).join(' · ') || 'Organization default'}</td><td>{rule.priority}</td><td><span className={`status-badge status-${rule.active ? 'active' : 'inactive'}`}>{rule.active ? 'Active' : 'Inactive'}</span></td><td><button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => void toggle(rule)}>{rule.active ? 'Deactivate' : 'Reactivate'}</button></td></tr>)}</tbody></table></div>}
  </div>;
}
