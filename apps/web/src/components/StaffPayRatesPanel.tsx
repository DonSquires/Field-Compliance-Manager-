import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { RATE_TYPES, loadPayCodes, loadServiceCatalog, serviceLabel, type PayCode, type ServiceCode } from '../lib/payCatalog';
import { plainWords } from '../lib/rosterWords';
import { PayCodeSelect } from './PayCodeSelect';
import { ServiceCodeSelect } from './ServiceCodeSelect';

interface PayRule {
  id: string;
  name: string;
  rate_type: string;
  amount: number;
  pay_code: string | null;
  role_code: string | null;
  service_type: string | null;
  client_org_id: string | null;
  site_id: string | null;
  zone_id: string | null;
  day_category: string | null;
  effective_from: string | null;
  effective_to: string | null;
  active: boolean;
  updated_at: string;
  staff_id: string | null;
}

type Mode = { action: 'create' } | { action: 'review' | 'end'; rule: PayRule };

interface StaffPayRatesPanelProps {
  staffId: string;
  staffName: string;
  organizationId: string;
  roleCode: string | null;
  canManage: boolean;
  canCreatePayCode: boolean;
  initialService?: string | null;
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const money = (value: number) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(value);
const dateText = (value: string | null, fallback: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) : fallback;
const EMPTY = { rateType: 'hourly', amount: '', payCode: '', service: '', from: '', to: '', reason: '' };

const ruleState = (rule: PayRule, on: string) => {
  if (!rule.active || (rule.effective_to && rule.effective_to < on)) return 'Past';
  if (rule.effective_from && rule.effective_from > on) return 'Upcoming';
  return 'Current';
};

export const StaffPayRatesPanel: React.FC<StaffPayRatesPanelProps> = ({ staffId, staffName, organizationId, roleCode, canManage, canCreatePayCode, initialService }) => {
  const [rules, setRules] = useState<PayRule[]>([]);
  const [payCodes, setPayCodes] = useState<PayCode[]>([]);
  const [services, setServices] = useState<ServiceCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [draft, setDraft] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [showPast, setShowPast] = useState(false);
  const on = today();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ruleResult, codes, catalog] = await Promise.all([
        supabase.from('rate_rules')
          .select('id,name,rate_type,amount,pay_code,role_code,service_type,client_org_id,site_id,zone_id,day_category,effective_from,effective_to,active,updated_at,staff_id')
          .eq('organization_id', organizationId).eq('rule_kind', 'pay')
          .or(`staff_id.eq.${staffId},staff_id.is.null`)
          .order('effective_from', { ascending: false, nullsFirst: false }),
        loadPayCodes(organizationId),
        loadServiceCatalog(organizationId),
      ]);
      if (ruleResult.error) throw ruleResult.error;
      const applicable = ((ruleResult.data ?? []) as PayRule[]).filter((rule) => rule.staff_id === staffId || !rule.role_code || rule.role_code === roleCode);
      setRules(applicable);
      setPayCodes(codes);
      setServices(catalog);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Pay rates could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [organizationId, roleCode, staffId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (initialService && canManage) {
      setMode({ action: 'create' });
      setDraft({ ...EMPTY, service: initialService, from: today() });
    }
  }, [canManage, initialService]);

  const personal = useMemo(() => rules.filter((rule) => rule.staff_id === staffId), [rules, staffId]);
  const shared = useMemo(() => rules.filter((rule) => rule.staff_id !== staffId && ruleState(rule, on) !== 'Past'), [on, rules, staffId]);
  const visiblePersonal = showPast ? personal : personal.filter((rule) => ruleState(rule, on) !== 'Past');
  const pastCount = personal.length - personal.filter((rule) => ruleState(rule, on) !== 'Past').length;

  const open = (next: Mode) => {
    setMode(next);
    setNotice(null);
    setError(null);
    setRequestId(crypto.randomUUID());
    if (next.action === 'create') setDraft({ ...EMPTY, from: on });
    else setDraft({
      rateType: next.rule.rate_type,
      amount: next.action === 'review' ? String(next.rule.amount) : '',
      payCode: next.rule.pay_code ?? '',
      service: next.rule.service_type ?? '',
      from: on,
      to: next.action === 'end' ? on : '',
      reason: '',
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!mode) return;
    setSaving(true);
    setError(null);
    const rule = mode.action === 'create' ? null : mode.rule;
    const { error: actionError } = await supabase.rpc('manage_staff_pay_rate', {
      p_client_request_id: requestId,
      p_action: mode.action,
      p_staff_id: staffId,
      p_rate_rule_id: rule?.id ?? null,
      p_expected_updated_at: rule?.updated_at ?? null,
      p_rate_type: draft.rateType,
      p_amount: mode.action === 'end' ? null : Number(draft.amount),
      p_pay_code: draft.payCode || null,
      p_service_type: draft.service || null,
      p_effective_from: mode.action === 'end' ? null : draft.from || null,
      p_effective_to: draft.to || null,
      p_reason: draft.reason.trim(),
    });
    setSaving(false);
    if (actionError) { setError(actionError.message); return; }
    setNotice(mode.action === 'end' ? 'Pay rate ended.' : mode.action === 'review' ? 'Pay review saved. The previous rate closes the day before the new one starts.' : 'Pay rate added.');
    setMode(null);
    await load();
  };

  const scopeText = (rule: PayRule) => {
    if (rule.staff_id) return 'This person';
    const extras = [rule.client_org_id && 'one client', rule.site_id && 'one site', rule.zone_id && 'one zone', rule.day_category && plainWords(rule.day_category)].filter(Boolean);
    return `${rule.role_code ? `Role ${rule.role_code}` : 'Everyone'}${extras.length ? ` · ${extras.join(', ')}` : ''}`;
  };

  const row = (rule: PayRule, actions: boolean) => {
    const state = ruleState(rule, on);
    return <tr key={rule.id}>
      <td>{serviceLabel(rule.service_type, services)}</td>
      <td>{plainWords(rule.rate_type)}</td>
      <td>{money(Number(rule.amount))}</td>
      <td>{rule.pay_code ?? '—'}</td>
      <td>{dateText(rule.effective_from, 'Always')} – {dateText(rule.effective_to, 'open')}</td>
      <td><span className={`staff-pay-state staff-pay-state-${state.toLowerCase()}`}>{state}</span>{!actions && <small> · {scopeText(rule)}</small>}</td>
      {canManage && <td className="staff-pay-actions">{actions && state !== 'Past' && <>
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => open({ action: 'review', rule })}>Pay review</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => open({ action: 'end', rule })}>End</button>
      </>}</td>}
    </tr>;
  };

  const header = <thead><tr><th>Task</th><th>Type</th><th>Rate</th><th>Pay code</th><th>Applies</th><th>Status</th>{canManage && <th><span className="sr-only">Actions</span></th>}</tr></thead>;
  const title = mode?.action === 'review' ? 'Pay review' : mode?.action === 'end' ? 'End this pay rate' : 'New pay rate';

  return <section className="staff-profile-panel staff-pay-rates" aria-labelledby="staff-pay-rates-title">
    <div className="staff-pay-head">
      <div>
        <h2 id="staff-pay-rates-title">Pay rates</h2>
        <p>What {staffName} is paid, by task. A rate for this person overrides role and organisation rates for the same task.</p>
      </div>
      <div className="staff-pay-head-actions">
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => void load()} disabled={loading} aria-label="Refresh pay rates"><RefreshCw size={14} /></button>
        {canManage && <button type="button" className="btn btn-sm btn-primary" onClick={() => open({ action: 'create' })}><Plus size={14} /> New rate</button>}
      </div>
    </div>
    {error && <p className="staff-profile-warning" role="alert">{error}</p>}
    {notice && <p className="staff-pay-message" role="status">{notice}</p>}

    {mode && canManage && <form className="staff-profile-action-form staff-profile-form-grid" onSubmit={submit} aria-label={title}>
      <h3 className="staff-profile-form-wide">{title}{mode.action !== 'create' && <small> · {serviceLabel(mode.rule.service_type, services)} at {money(Number(mode.rule.amount))}</small>}</h3>
      {mode.action !== 'end' && <>
        <ServiceCodeSelect codes={services} value={draft.service} disabled={mode.action === 'review'} canCreate={canCreatePayCode} organizationId={organizationId}
          onChange={(code) => setDraft((current) => ({ ...current, service: code }))}
          onCreated={(code) => setServices((current) => [...current, code].sort((a, b) => a.name.localeCompare(b.name)))} />
        <label><span>Rate type</span><select value={draft.rateType} onChange={(event) => setDraft({ ...draft, rateType: event.target.value })}>
          {RATE_TYPES.map((type) => <option key={type} value={type}>{plainWords(type)}</option>)}
        </select></label>
        <label><span>Amount (NZD)</span><input type="number" min="0" step="0.01" required value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} /></label>
        <PayCodeSelect codes={payCodes} value={draft.payCode} required canCreate={canCreatePayCode}
          onChange={(code) => setDraft((current) => ({ ...current, payCode: code }))}
          onCreated={(code) => setPayCodes((current) => [...current, code])} />
        <label><span>{mode.action === 'review' ? 'New rate starts' : 'Starts'}</span><input type="date" required value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
      </>}
      <label><span>{mode.action === 'end' ? 'Last day this rate applies' : 'Ends (optional)'}</span><input type="date" required={mode.action === 'end'} min={mode.action === 'end' ? mode.rule.effective_from ?? undefined : draft.from || undefined} value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
      <label className="staff-profile-form-wide"><span>Reason</span><textarea required rows={2} placeholder={mode.action === 'review' ? 'e.g. Annual pay review' : 'Why this pay change is being made'} value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></label>
      <div className="staff-profile-form-wide staff-pay-form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving || !draft.reason.trim() || (mode.action !== 'end' && (!draft.amount || !draft.payCode))}>{saving ? 'Saving…' : mode.action === 'end' ? 'End rate' : mode.action === 'review' ? 'Save pay review' : 'Add rate'}</button>
        <button type="button" className="btn btn-secondary" onClick={() => setMode(null)} disabled={saving}>Cancel</button>
      </div>
    </form>}

    {loading ? <p className="staff-profile-empty">Loading pay rates…</p> : <>
      {visiblePersonal.length ? <div className="staff-pay-table-wrap"><table className="staff-pay-table">{header}<tbody>{visiblePersonal.map((rule) => row(rule, true))}</tbody></table></div>
        : <p className="staff-profile-empty">No personal pay rate is set. {shared.length ? 'The shared rates below apply.' : 'No pay rate applies yet, so timesheets cannot be costed.'}</p>}
      {pastCount > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowPast(!showPast)}>{showPast ? 'Hide' : 'Show'} {pastCount} past rate{pastCount === 1 ? '' : 's'}</button>}
      {shared.length > 0 && <details className="staff-pay-shared">
        <summary>Shared rates that also apply ({shared.length})</summary>
        <div className="staff-pay-table-wrap"><table className="staff-pay-table">{header}<tbody>{shared.map((rule) => row(rule, false))}</tbody></table></div>
        <p>Shared rates are managed in Pay and charge rules.</p>
      </details>}
    </>}
  </section>;
};

export default StaffPayRatesPanel;
