import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { agreementTermState } from '../lib/agreementTerm';
import { supabase } from '../lib/supabase';
import { FuelPriceMedianPanel } from '../components/FuelPriceMedianPanel';
import './PageStyles.css';

interface RateRule {
  id: string;
  rule_kind: 'pay' | 'billing';
  name: string;
  rate_type: string;
  amount: number;
  pay_code: string | null;
  role_code: string | null;
  service_type: string | null;
  job_type: string | null;
  client_org_id: string | null;
  site_id: string | null;
  zone_id: string | null;
  day_category: string | null;
  effective_from: string | null;
  effective_to: string | null;
  priority: number;
  active: boolean;
  updated_at: string;
}

interface PayrollRoleCode { code: string; name: string; }

interface CompletedDispatchJob {
  id: string;
  job_type: string;
  completed_at: string;
  client_site_id: string | null;
  missing: Array<'pay' | 'charge'>;
}

interface PatrolDiscountBand {
  id: string;
  service_type: string | null;
  over_by_minutes_min: number;
  over_by_minutes_max: number | null;
  discount_pct: number;
  active: boolean;
  updated_at: string;
}

interface UnresolvedPatrolCharge {
  id: string;
  shift_stop_id: string;
  client_organization_id: string | null;
  service_type: string;
  module_key: string;
  status: 'unresolved_rate' | 'unresolved_agreement';
  created_at: string;
}

type RuleKindFilter = 'all' | 'pay' | 'billing';
type RuleStatusFilter = 'all' | 'active' | 'inactive';

const RATE_TYPES = ['hourly', 'flat', 'daily', 'per_km', 'per_unit', 'percentage', 'per_hour_travel', 'per_hour_allowance', 'oncall_flat', 'callout', 'higher_duties_flat', 'per_visit', 'per_notice'];
const EMPTY_FORM = { kind: 'pay' as 'pay' | 'billing', name: '', rateType: 'hourly', amount: '', payCode: '', roleCode: '', serviceType: '', jobType: '', clientOrgId: '', siteId: '', zoneId: '', dayCategory: '', effectiveFrom: '', effectiveTo: '', priority: '0' };
const EMPTY_BAND_FORM = { id: '', serviceType: '', minimum: '', maximum: '', discountPercent: '', updatedAt: '' };

export default function RateRulesPage() {
  const { profile, operatingOrganizationId } = useAuth();
  const { agreements, sites, zones } = useServiceRelationships();
  const [rules, setRules] = useState<RateRule[]>([]);
  const [payrollRoleCodes, setPayrollRoleCodes] = useState<PayrollRoleCode[]>([]);
  const [patrolBands, setPatrolBands] = useState<PatrolDiscountBand[]>([]);
  const [unresolvedPatrol, setUnresolvedPatrol] = useState<UnresolvedPatrolCharge[]>([]);
  const [agreementLocations, setAgreementLocations] = useState<Array<{ service_agreement_id: string; site_id: string | null; zone_id: string | null }>>([]);
  const [completedJobs, setCompletedJobs] = useState<CompletedDispatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState<RateRule | null>(null);
  const [ruleSearch, setRuleSearch] = useState('');
  const [ruleKindFilter, setRuleKindFilter] = useState<RuleKindFilter>('all');
  const [ruleStatusFilter, setRuleStatusFilter] = useState<RuleStatusFilter>('all');
  const [form, setForm] = useState(EMPTY_FORM);
  const [bandForm, setBandForm] = useState(EMPTY_BAND_FORM);
  const operatingBranchId = operatingOrganizationId ?? profile?.organizationId;
  const clientAgreements = useMemo(() => agreements.filter((agreement) =>
    agreement.provider_organization_id === operatingBranchId &&
    agreement.agreement_type === 'operational' &&
    !['ended', 'cancelled'].includes(agreementTermState(agreement)),
  ), [agreements, operatingBranchId]);
  const clientOptions = useMemo(() => [...new Map(clientAgreements.map((agreement) => [agreement.client_organization_id, {
    id: agreement.client_organization_id,
    name: agreement.client_name || 'Client account',
  }])).values()], [clientAgreements]);
  const clientAgreementIds = useMemo(() => new Set(clientAgreements.filter((agreement) => agreement.client_organization_id === form.clientOrgId).map((agreement) => agreement.id)), [clientAgreements, form.clientOrgId]);
  const clientSiteIds = useMemo(() => new Set(agreementLocations.filter((link) => clientAgreementIds.has(link.service_agreement_id) && link.site_id).map((link) => link.site_id as string)), [agreementLocations, clientAgreementIds]);
  const clientZoneIds = useMemo(() => new Set(agreementLocations.filter((link) => clientAgreementIds.has(link.service_agreement_id) && link.zone_id).map((link) => link.zone_id as string)), [agreementLocations, clientAgreementIds]);
  const clientSites = useMemo(() => sites.filter((site) => clientSiteIds.has(site.id)), [clientSiteIds, sites]);
  const clientZones = useMemo(() => zones.filter((zone) => clientZoneIds.has(zone.id)), [clientZoneIds, zones]);
  const clientNames = useMemo(() => new Map(clientOptions.map((client) => [client.id, client.name])), [clientOptions]);
  const siteNames = useMemo(() => new Map(sites.map((site) => [site.id, site.name])), [sites]);
  const zoneNames = useMemo(() => new Map(zones.map((zone) => [zone.id, zone.name])), [zones]);
  const normalizedRuleSearch = ruleSearch.trim().toLocaleLowerCase();
  const visibleRules = useMemo(() => rules.filter((rule) => {
    if (ruleKindFilter !== 'all' && rule.rule_kind !== ruleKindFilter) return false;
    if (ruleStatusFilter !== 'all' && (ruleStatusFilter === 'active') !== rule.active) return false;
    if (!normalizedRuleSearch) return true;
    const searchableFields = [
      rule.name,
      rule.rule_kind === 'pay' ? 'staff pay' : 'customer charge billing',
      rule.rate_type,
      rule.pay_code,
      rule.role_code,
      rule.service_type,
      rule.job_type,
      rule.client_org_id ? clientNames.get(rule.client_org_id) : null,
      rule.site_id ? siteNames.get(rule.site_id) : null,
      rule.zone_id ? zoneNames.get(rule.zone_id) : null,
      rule.day_category,
      rule.effective_from,
      rule.effective_to,
    ];
    return searchableFields.filter(Boolean).join(' ').toLocaleLowerCase().includes(normalizedRuleSearch);
  }), [clientNames, normalizedRuleSearch, ruleKindFilter, ruleStatusFilter, rules, siteNames, zoneNames]);

  const load = useCallback(async () => {
    if (!operatingBranchId) {
      setError('Organisation access could not be confirmed. Rate rules are unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    const agreementIds = clientAgreements.map((agreement) => agreement.id);
    const [rulesResponse, jobsResponse, payLinesResponse, chargeLinesResponse, roleCodesResponse, locationsResponse, bandsResponse, patrolChargeResponse] = await Promise.all([
      supabase.from('rate_rules').select('id,rule_kind,name,rate_type,amount,pay_code,role_code,service_type,job_type,client_org_id,site_id,zone_id,day_category,effective_from,effective_to,priority,active,updated_at').eq('organization_id', operatingBranchId).order('active', { ascending: false }).order('priority', { ascending: false }).order('name'),
      supabase.from('dispatch_jobs').select('id,job_type,completed_at,client_site_id').eq('organization_id', operatingBranchId).eq('status', 'completed').order('completed_at', { ascending: false }).limit(50),
      supabase.from('dispatch_job_pay_lines').select('source_dispatch_id,rate_rule_id').eq('organization_id', operatingBranchId).limit(500),
      supabase.from('dispatch_job_charge_lines').select('source_dispatch_id,rate_rule_id').eq('organization_id', operatingBranchId).limit(500),
      profile?.organizationId ? supabase.from('reference_codes').select('code,name').eq('organization_id', profile.organizationId).eq('code_type', 'role_code').eq('is_active', true).order('sort_order').order('code') : Promise.resolve({ data: [], error: null }),
      agreementIds.length ? supabase.from('service_agreement_locations').select('service_agreement_id,site_id,zone_id').in('service_agreement_id', agreementIds).eq('status', 'active') : Promise.resolve({ data: [], error: null }),
      supabase.from('sla_discount_bands').select('id,service_type,over_by_minutes_min,over_by_minutes_max,discount_pct,active,updated_at').eq('organization_id', operatingBranchId).eq('module_key', 'patrol').order('over_by_minutes_min'),
      supabase.from('patrol_stop_charge_lines').select('id,shift_stop_id,client_organization_id,service_type,module_key,status,created_at').eq('organization_id', operatingBranchId).in('status', ['unresolved_rate', 'unresolved_agreement']).is('invoice_line_item_id', null).order('created_at', { ascending: false }).limit(200),
    ]);
    const loadError = rulesResponse.error ?? jobsResponse.error ?? payLinesResponse.error ?? chargeLinesResponse.error ?? roleCodesResponse.error ?? locationsResponse.error ?? bandsResponse.error ?? patrolChargeResponse.error;
    if (loadError) setError(loadError.message); else {
      setRules((rulesResponse.data as RateRule[]) ?? []);
      setPayrollRoleCodes((roleCodesResponse.data as PayrollRoleCode[]) ?? []);
      setPatrolBands((bandsResponse.data as PatrolDiscountBand[]) ?? []);
      setUnresolvedPatrol((patrolChargeResponse.data as UnresolvedPatrolCharge[]) ?? []);
      setAgreementLocations((locationsResponse.data ?? []) as Array<{ service_agreement_id: string; site_id: string | null; zone_id: string | null }>);
      // A job needs attention when it has no lines yet, or only unresolved ones (no rule matched).
      const payByJob = new Map<string, boolean>();
      for (const line of (payLinesResponse.data ?? []) as Array<{ source_dispatch_id: string; rate_rule_id: string | null }>) payByJob.set(line.source_dispatch_id, (payByJob.get(line.source_dispatch_id) ?? false) || line.rate_rule_id !== null);
      const chargeByJob = new Map<string, boolean>();
      for (const line of (chargeLinesResponse.data ?? []) as Array<{ source_dispatch_id: string; rate_rule_id: string | null }>) chargeByJob.set(line.source_dispatch_id, (chargeByJob.get(line.source_dispatch_id) ?? false) || line.rate_rule_id !== null);
      setCompletedJobs(((jobsResponse.data as CompletedDispatchJob[]) ?? []).map((job) => ({ ...job, missing: [...(payByJob.get(job.id) ? [] : ['pay' as const]), ...(chargeByJob.get(job.id) ? [] : ['charge' as const])] })).filter((job) => job.missing.length > 0));
    }
    setLoading(false);
  }, [clientAgreements, operatingBranchId, profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!showForm) setEditingRule(null); }, [showForm]);

  const createRule = async (event: React.FormEvent) => {
    event.preventDefault();
    if (editingRule) { await updateRule(event); return; }
    setSaving(true); setError(null); setNotice(null);
  const { error: createError } = await supabase.rpc('manage_operating_branch_rate_rule', { p_operating_organization_id: operatingBranchId, p_client_request_id: crypto.randomUUID(), p_action: 'create', p_rate_rule_id: null, p_expected_updated_at: null, p_rule_kind: form.kind, p_name: form.name.trim(), p_rate_type: form.rateType, p_amount: Number(form.amount), p_pay_code: form.payCode.trim() || null, p_service_type: form.serviceType.trim() || null, p_job_type: form.jobType.trim() || null, p_client_org_id: form.kind === 'billing' ? form.clientOrgId || null : null, p_site_id: form.kind === 'billing' ? form.siteId || null : null, p_zone_id: form.kind === 'billing' ? form.zoneId || null : null, p_day_category: form.dayCategory || null, p_effective_from: form.effectiveFrom || null, p_effective_to: form.effectiveTo || null, p_priority: Number(form.priority), p_role_code: form.kind === 'pay' ? form.roleCode || '' : null });
    if (createError) setError(createError.message);
  else { setNotice('Rate rule created and available to the resolver.'); setForm(EMPTY_FORM); setShowForm(false); await load(); }
    setSaving(false);
  };

  const openEdit = (rule: RateRule) => {
    setEditingRule(rule);
  setForm({ ...EMPTY_FORM, kind: rule.rule_kind, name: rule.name, rateType: rule.rate_type, amount: String(rule.amount), payCode: rule.pay_code ?? '', roleCode: rule.role_code ?? '', serviceType: rule.service_type ?? '', jobType: rule.job_type ?? '', clientOrgId: rule.client_org_id ?? '', siteId: rule.site_id ?? '', zoneId: rule.zone_id ?? '', dayCategory: rule.day_category ?? '', effectiveFrom: rule.effective_from ?? '', effectiveTo: rule.effective_to ?? '', priority: String(rule.priority) });
    setShowForm(true); setError(null); setNotice(null);
  };

  const updateRule = async (event: React.FormEvent) => {
    event.preventDefault(); if (!editingRule) return;
    setSaving(true); setError(null); setNotice(null);
  const { error: updateError } = await supabase.rpc('manage_operating_branch_rate_rule', { p_operating_organization_id: operatingBranchId, p_client_request_id: crypto.randomUUID(), p_action: 'update', p_rate_rule_id: editingRule.id, p_expected_updated_at: editingRule.updated_at, p_rule_kind: form.kind, p_name: form.name.trim(), p_rate_type: form.rateType, p_amount: Number(form.amount), p_pay_code: form.payCode.trim() || null, p_service_type: form.serviceType.trim() || null, p_job_type: form.jobType.trim() || null, p_client_org_id: form.kind === 'billing' ? form.clientOrgId || null : null, p_site_id: form.kind === 'billing' ? form.siteId || null : null, p_zone_id: form.kind === 'billing' ? form.zoneId || null : null, p_day_category: form.dayCategory || null, p_effective_from: form.effectiveFrom || null, p_effective_to: form.effectiveTo || null, p_priority: Number(form.priority), p_role_code: form.kind === 'pay' ? form.roleCode : null });
    if (updateError) setError(updateError.message);
    else { setNotice('Rate rule updated with a new audit revision.'); setEditingRule(null); setShowForm(false); await load(); }
    setSaving(false);
  };

  const toggle = async (rule: RateRule) => {
    setSaving(true); setError(null); setNotice(null);
    const { error: actionError } = await supabase.rpc('manage_operating_branch_rate_rule', { p_operating_organization_id: operatingOrganizationId ?? profile?.organizationId, p_client_request_id: crypto.randomUUID(), p_action: rule.active ? 'deactivate' : 'reactivate', p_rate_rule_id: rule.id, p_expected_updated_at: rule.updated_at, p_rule_kind: null, p_name: null, p_rate_type: null, p_amount: null, p_pay_code: null, p_service_type: null, p_job_type: null, p_client_org_id: null, p_site_id: null, p_zone_id: null, p_day_category: null, p_effective_from: null, p_effective_to: null, p_priority: 0, p_role_code: null });
    if (actionError) setError(actionError.message); else { setNotice(`Rate rule ${rule.active ? 'deactivated' : 'reactivated'}.`); await load(); }
    setSaving(false);
  };

  const resolveCompletedJob = async (job: CompletedDispatchJob) => {
    setSaving(true); setError(null); setNotice(null);
    const { data, error: resolveError } = await supabase.rpc('resolve_dispatch_job_pay_lines', { p_client_request_id: crypto.randomUUID(), p_dispatch_job_id: job.id, p_day_category: null });
    const receipt = Array.isArray(data) ? data[0] : data;
    if (resolveError || !receipt) setError(resolveError?.message ?? 'Pay-line resolution was not confirmed.');
    else { setNotice(receipt.unresolved_count > 0 ? `Checked again: ${receipt.unresolved_count} line(s) still have no matching rule. Add the rule below, then re-check.` : `Priced: ${receipt.lines_written} pay line(s) written.`); await load(); }
    setSaving(false);
  };

  const editPatrolBand = (band: PatrolDiscountBand) => {
    setBandForm({ id: band.id, serviceType: band.service_type ?? '', minimum: String(band.over_by_minutes_min), maximum: band.over_by_minutes_max === null ? '' : String(band.over_by_minutes_max), discountPercent: String(Number(band.discount_pct) * 100), updatedAt: band.updated_at });
    setError(null); setNotice(null);
  };

  const togglePatrolBand = async (band: PatrolDiscountBand) => {
    setSaving(true); setError(null); setNotice(null);
    const { error: bandError } = await supabase.rpc('manage_patrol_sla_discount_band', {
      p_organization_id: operatingBranchId,
      p_action: band.active ? 'deactivate' : 'reactivate',
      p_band_id: band.id,
      p_expected_updated_at: band.updated_at,
      p_service_type: null,
      p_over_by_minutes_min: null,
      p_over_by_minutes_max: null,
      p_discount_pct: null,
    });
    if (bandError) setError(bandError.message);
    else { setNotice(`Patrol SLA discount band ${band.active ? 'deactivated' : 'reactivated'}.`); await load(); }
    setSaving(false);
  };

  const savePatrolBand = async (event: React.FormEvent) => {
    event.preventDefault();
    const minimum = Number(bandForm.minimum);
    const maximum = bandForm.maximum === '' ? null : Number(bandForm.maximum);
    const discount = Number(bandForm.discountPercent);
    if (!Number.isInteger(minimum) || minimum < 0 || (maximum !== null && (!Number.isInteger(maximum) || maximum < minimum)) || !Number.isFinite(discount) || discount < 0 || discount > 100) {
      setError('Enter whole late-minute bounds and a discount from 0 to 100 percent.');
      return;
    }
    setSaving(true); setError(null); setNotice(null);
    const { error: bandError } = await supabase.rpc('manage_patrol_sla_discount_band', {
      p_organization_id: operatingBranchId,
      p_action: bandForm.id ? 'update' : 'create',
      p_band_id: bandForm.id || null,
      p_expected_updated_at: bandForm.updatedAt || null,
      p_service_type: bandForm.serviceType.trim() || null,
      p_over_by_minutes_min: minimum,
      p_over_by_minutes_max: maximum,
      p_discount_pct: discount / 100,
    });
    if (bandError) setError(bandError.message);
    else { setNotice('Patrol SLA discount band saved.'); setBandForm(EMPTY_BAND_FORM); await load(); }
    setSaving(false);
  };

  const recheckPatrolCharge = async (charge: UnresolvedPatrolCharge) => {
    setSaving(true); setError(null); setNotice(null);
    const { data, error: resolveError } = await supabase.rpc('resolve_patrol_stop_charge_line', { p_charge_line_id: charge.id, p_client_request_id: crypto.randomUUID() });
    if (resolveError || !data) setError(resolveError?.message ?? 'The patrol visit rate could not be rechecked.');
    else {
      const receipt = data as { status?: string; line_total?: number | null };
      setNotice(receipt.status === 'ready' ? `Patrol visit priced at $${Number(receipt.line_total ?? 0).toFixed(2)} before GST.` : receipt.status === 'waived_sla' ? 'Patrol visit is non-billable under the configured SLA band.' : receipt.status === 'unresolved_agreement' ? 'No active service agreement is linked to this patrol shift. Nothing was priced.' : 'No per-visit rate matched. Nothing was priced.');
      await load();
    }
    setSaving(false);
  };

  return <div className="page-container rate-rules-page">
    <header className="page-header"><div><h1>Pay and charge rules</h1><p className="subtitle">The rules that decide what staff are paid and what customers are charged for shifts, callouts, court time, and dispatch jobs.</p></div><div><button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /></button><button type="button" className="btn btn-primary" onClick={() => setShowForm((value) => !value)}><Plus size={16} />{showForm ? 'Cancel' : 'New pay or charge rule'}</button></div></header>
    {error && <div className="alert alert-error" role="alert"><AlertTriangle size={16} />{error}</div>}
    {notice && <div className="alert alert-success" role="status"><CheckCircle2 size={16} />{notice}</div>}
    <section className="reports-section" aria-label="Patrol SLA discount bands">
      <h2>Patrol late-arrival discounts</h2>
      <p>A discount applies only to a completed per-visit charge when recorded arrival is later than the contracted deadline. Dwell time remains service evidence, not an additional charge. No discount is applied unless a band matches.</p>
      <form className="assessment-form" onSubmit={savePatrolBand}>
        <div className="form-row">
          <label><span>Filter patrol discounts by service (optional)</span><input value={bandForm.serviceType} onChange={(event) => setBandForm({ ...bandForm, serviceType: event.target.value })} placeholder="All patrol service types" /></label>
          <label><span>Late by at least (minutes)</span><input type="number" min="0" step="1" required value={bandForm.minimum} onChange={(event) => setBandForm({ ...bandForm, minimum: event.target.value })} /></label>
          <label><span>Late through (minutes, optional)</span><input type="number" min="0" step="1" value={bandForm.maximum} onChange={(event) => setBandForm({ ...bandForm, maximum: event.target.value })} /></label>
          <label><span>Discount (%)</span><input type="number" min="0" max="100" step="0.01" required value={bandForm.discountPercent} onChange={(event) => setBandForm({ ...bandForm, discountPercent: event.target.value })} /></label>
        </div>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving' : bandForm.id ? 'Save discount band' : 'Add discount band'}</button>
        {bandForm.id && <button type="button" className="btn btn-secondary" onClick={() => setBandForm(EMPTY_BAND_FORM)}>Cancel edit</button>}
      </form>
      {patrolBands.length === 0 ? <p>No patrol discount bands configured; late visits use the full per-visit charge and remain visible as SLA breaches.</p> : <div className="reports-table-wrapper"><table className="reports-table"><thead><tr><th>Service type</th><th>Late by</th><th>Discount</th><th>Status</th><th /></tr></thead><tbody>{patrolBands.map((band) => <tr key={band.id}><td>{band.service_type || 'All patrol service types'}</td><td>{band.over_by_minutes_max === null ? `${band.over_by_minutes_min}+ min` : `${band.over_by_minutes_min}–${band.over_by_minutes_max} min`}</td><td>{(Number(band.discount_pct) * 100).toFixed(2).replace(/\.00$/, '')}%</td><td>{band.active ? 'Active' : 'Inactive'}</td><td><button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => editPatrolBand(band)}>Edit</button> <button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => void togglePatrolBand(band)}>{band.active ? 'Deactivate' : 'Reactivate'}</button></td></tr>)}</tbody></table></div>}
    </section>
    {!loading && <FuelPriceMedianPanel organizationId={operatingOrganizationId ?? profile?.organizationId ?? null} />}
    {!loading && <section className="reports-section"><h2>Finished jobs that still need a pay or charge rule ({completedJobs.length})</h2>{completedJobs.length === 0 ? <div className="empty-state"><p>Every finished job has been priced. New jobs are priced automatically the moment they are completed.</p></div> : <div className="contacts-list">{completedJobs.map((job) => <div className="contact-card" key={job.id}><div className="contact-header"><h3>{job.job_type.replaceAll('_', ' ')}</h3><span className="contact-type-badge">Completed</span></div><div className="contact-details"><p>Completed {job.completed_at ? new Date(job.completed_at).toLocaleString() : 'time unavailable'}</p><p className="contact-meta">Missing: {job.missing.map((kind) => kind === 'pay' ? 'staff pay rule' : 'customer charge rule').join(' and ')} for “{job.job_type.replaceAll('_', ' ')}”. Add it below (set “Job type” to {job.job_type}), then re-check. Nothing is written as $0.</p></div><button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void resolveCompletedJob(job)}>{saving ? 'Checking' : 'Re-check'}</button></div>)}</div>}</section>}
    {!loading && <section className="reports-section"><h2>Completed patrol visits awaiting a per-visit rate ({unresolvedPatrol.length})</h2>{unresolvedPatrol.length === 0 ? <p>No completed patrol visit needs rate review.</p> : <div className="contacts-list">{unresolvedPatrol.map((charge) => <div className="contact-card" key={charge.id}><div className="contact-header"><h3>{clientNames.get(charge.client_organization_id ?? '') ?? (charge.status === 'unresolved_agreement' ? 'No linked client agreement' : 'Client account')}</h3><span className="contact-type-badge">Completed patrol visit</span></div><div className="contact-details"><p>{charge.module_key.replaceAll('_', ' ')} · {charge.service_type.replaceAll('_', ' ')} · stop {charge.shift_stop_id.slice(0, 8)}</p><p className="contact-meta">{charge.status === 'unresolved_agreement' ? 'The shift is not linked to an active client service agreement.' : 'No matching customer billing rule uses the per_visit rate type. No amount was charged.'} Completed {new Date(charge.created_at).toLocaleString('en-NZ')}.</p></div><button type="button" className="btn btn-sm btn-primary" disabled={saving || charge.status === 'unresolved_agreement'} onClick={() => void recheckPatrolCharge(charge)}>{saving ? 'Checking' : 'Re-check rate'}</button></div>)}</div>}</section>}
    {showForm && <form className="assessment-form rate-rules-form" onSubmit={createRule}>
      <div className="form-row">
        <label><span>What this rule sets</span><select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as 'pay' | 'billing', roleCode: event.target.value === 'billing' ? '' : form.roleCode })}><option value="pay">Staff pay</option><option value="billing">Customer charge</option></select></label>
        <label><span>Name</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      </div>
      <div className="form-row">
        <label><span>How it is charged</span><select value={form.rateType} onChange={(event) => setForm({ ...form, rateType: event.target.value })}>{RATE_TYPES.map((type) => <option value={type} key={type}>{type.replaceAll('_', ' ')}</option>)}</select></label>
        <label><span>Amount</span><input type="number" min="0" step="0.0001" required value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
        <label><span>Priority</span><input type="number" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })} /></label>
      </div>
      {form.kind === 'pay' && <div className="form-row">
        <label><span>Payroll role</span><select value={form.roleCode} onChange={(event) => setForm({ ...form, roleCode: event.target.value })}>
          <option value="">Any payroll role</option>
          {payrollRoleCodes.map((code) => <option value={code.code} key={code.code}>{code.code} · {code.name}</option>)}
        </select></label>
        {!payrollRoleCodes.length && <p className="contact-meta">No payroll role codes are set up yet. <Link to="/admin/people-hr">Create one in People &amp; HR</Link>.</p>}
      </div>}
      <div className="form-row">
        <label><span>Payroll or invoice code (optional)</span><input value={form.payCode} onChange={(event) => setForm({ ...form, payCode: event.target.value })} /></label>
        <label><span>Service type</span><input value={form.serviceType} onChange={(event) => setForm({ ...form, serviceType: event.target.value })} /></label>
        <label><span>Job type</span><input value={form.jobType} onChange={(event) => setForm({ ...form, jobType: event.target.value })} /></label>
      </div>
      {form.kind === 'billing' && <fieldset className="form-row" aria-label="Customer billing scope">
        <legend>Customer scope</legend>
        <p>Leave a field unrestricted to use this rate as a fallback. Place overrides apply only to linked places on an operational agreement.</p>
        <label><span>Client account</span><select value={form.clientOrgId} onChange={(event) => setForm({ ...form, clientOrgId: event.target.value, siteId: '', zoneId: '' })}>
          <option value="">Any client account</option>
          {form.clientOrgId && !clientOptions.some((client) => client.id === form.clientOrgId) && <option value={form.clientOrgId}>Current client (not in active agreement list)</option>}
          {clientOptions.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
        </select></label>
        <label><span>Site or zone override</span><select value={form.siteId ? `site:${form.siteId}` : form.zoneId ? `zone:${form.zoneId}` : ''} disabled={!form.clientOrgId} onChange={(event) => {
          const [kind, id] = event.target.value.split(':');
          setForm({ ...form, siteId: kind === 'site' ? id : '', zoneId: kind === 'zone' ? id : '' });
        }}>
          <option value="">All linked places</option>
          {form.siteId && !clientSites.some((site) => site.id === form.siteId) && <option value={`site:${form.siteId}`}>Current site (not in active agreement list)</option>}
          {clientSites.length > 0 && <optgroup label="Sites">{clientSites.map((site) => <option key={site.id} value={`site:${site.id}`}>{site.name}{site.address ? ` · ${site.address}` : ''}</option>)}</optgroup>}
          {form.zoneId && !clientZones.some((zone) => zone.id === form.zoneId) && <option value={`zone:${form.zoneId}`}>Current zone (not in active agreement list)</option>}
          {clientZones.length > 0 && <optgroup label="Zones">{clientZones.map((zone) => <option key={zone.id} value={`zone:${zone.id}`}>{zone.name}</option>)}</optgroup>}
        </select></label>
      </fieldset>}
      <div className="form-row">
        <label><span>Day category</span><select value={form.dayCategory} onChange={(event) => setForm({ ...form, dayCategory: event.target.value })}><option value="">Any day</option><option value="weekday">Weekday</option><option value="weekend">Weekend</option><option value="public_holiday">Public holiday</option><option value="night">Night</option></select></label>
        <label><span>Effective from</span><input type="date" value={form.effectiveFrom} onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })} /></label>
        <label><span>Effective through</span><input type="date" value={form.effectiveTo} onChange={(event) => setForm({ ...form, effectiveTo: event.target.value })} /></label>
      </div>
      {form.kind === 'billing' && <p role="status">Applies to {form.clientOrgId ? clientNames.get(form.clientOrgId) ?? 'the selected client' : 'any client'} · {form.siteId ? siteNames.get(form.siteId) ?? 'the selected site' : form.zoneId ? zoneNames.get(form.zoneId) ?? 'the selected zone' : 'all linked places'}.</p>}
      <button type="submit" className="btn btn-primary" disabled={saving || !form.name.trim() || !form.amount}>{saving ? 'Saving' : editingRule ? 'Save rate rule' : 'Create rate rule'}</button>
    </form>}
    {loading ? <div className="loading-state"><div className="spinner" /><p>Loading pay and charge rules</p></div> : <section className="reports-section rate-rules-ledger" aria-labelledby="rate-rules-ledger-title">
      <header><div><h2 id="rate-rules-ledger-title">Pay and charge rules</h2><p className="subtitle">Search and review rules loaded for this operating branch.</p></div><strong role="status" aria-live="polite">Showing {visibleRules.length} of {rules.length}</strong></header>
      <div className="rate-rules-filters" role="search" aria-label="Filter pay and charge rules">
        <label><span>Search rules</span><input type="search" aria-label="Search pay and charge rules" value={ruleSearch} onChange={(event) => setRuleSearch(event.target.value)} placeholder="Name, client, place, code, or service" /></label>
        <label><span>Rule type</span><select aria-label="Filter by rule type" value={ruleKindFilter} onChange={(event) => setRuleKindFilter(event.target.value as RuleKindFilter)}><option value="all">All rule types</option><option value="pay">Staff pay</option><option value="billing">Customer charge</option></select></label>
        <label><span>Status</span><select aria-label="Filter by rule status" value={ruleStatusFilter} onChange={(event) => setRuleStatusFilter(event.target.value as RuleStatusFilter)}><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        {(ruleSearch || ruleKindFilter !== 'all' || ruleStatusFilter !== 'all') && <button type="button" className="btn btn-secondary" onClick={() => { setRuleSearch(''); setRuleKindFilter('all'); setRuleStatusFilter('all'); }}>Clear filters</button>}
      </div>
      <p className="rate-rules-scroll-cue">Scroll horizontally to review rule scope and actions.</p>
      <div className="reports-table-wrapper rate-rules-table-region" role="region" aria-label="Pay and charge rule register" tabIndex={0}>
        <table className="reports-table"><thead><tr><th>Name</th><th>Kind</th><th>Rate</th><th>Scope and dates</th><th>Priority</th><th>Status</th><th>Actions</th></tr></thead><tbody>
          {rules.length === 0 ? <tr><td colSpan={7} className="text-center">No pay or charge rules yet</td></tr> : visibleRules.length === 0 ? <tr><td colSpan={7} className="text-center"><div className="rate-rules-empty"><span>No rules match these filters.</span><button type="button" className="btn btn-sm btn-secondary" onClick={() => { setRuleSearch(''); setRuleKindFilter('all'); setRuleStatusFilter('all'); }}>Clear filters</button></div></td></tr> : visibleRules.map((rule) => <tr key={rule.id}>
            <td>{rule.name}<small>{rule.pay_code ? `Pay / invoice code ${rule.pay_code}` : rule.role_code ? `Payroll role ${rule.role_code}` : ''}</small></td>
            <td>{rule.rule_kind === 'pay' ? 'Staff pay' : 'Customer charge'}</td>
            <td>{rule.rate_type.replaceAll('_', ' ')} · {Number(rule.amount).toFixed(2)}</td>
            <td>{[rule.client_org_id ? clientNames.get(rule.client_org_id) ?? 'Client account' : null, rule.site_id ? siteNames.get(rule.site_id) ?? 'Site override' : null, rule.zone_id ? zoneNames.get(rule.zone_id) ?? 'Zone override' : null, rule.service_type, rule.job_type, rule.day_category?.replaceAll('_', ' '), rule.effective_from ? `from ${rule.effective_from}` : null, rule.effective_to ? `through ${rule.effective_to}` : null].filter(Boolean).join(' · ') || 'Whole organisation'}</td>
            <td>{rule.priority}</td>
            <td><span className={`status-badge status-${rule.active ? 'active' : 'inactive'}`}>{rule.active ? 'Active' : 'Inactive'}</span></td>
            <td><button type="button" className="btn btn-sm btn-secondary" aria-label={`Edit rule ${rule.name}`} disabled={saving} onClick={() => openEdit(rule)}>Edit</button> <button type="button" className="btn btn-sm btn-secondary" aria-label={`${rule.active ? 'Deactivate' : 'Reactivate'} rule ${rule.name}`} disabled={saving} onClick={() => void toggle(rule)}>{rule.active ? 'Deactivate' : 'Reactivate'}</button></td>
          </tr>)}
        </tbody></table>
      </div>
    </section>}
  </div>;
}
