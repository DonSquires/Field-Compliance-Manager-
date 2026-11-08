import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleAlert, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './FinanceLabourCostWorkspace.css';

type Timesheet = { id: string; staff_id: string; shift_id: string | null; period_start: string; period_end: string; actual_hours: number | null; work_derived_hours: number | null; status: string };
type Shift = { id: string; service_type: string; work_unit_id: string | null; service_agreement_location_id: string | null; service_agreement_module_id: string | null };
type Staff = { id: string; employee_number: string | null; role_code: string | null };
type Period = { id: string; name: string; period_start: string; period_end: string };
type Agreement = { id: string; name: string };
type AgreementLink = { id: string; service_agreement_id: string; active: boolean };
type CostCentre = { id: string; code: string; name: string };
type Rate = { id: string; amount: number; pay_code: string | null; staff_id: string | null; role_code: string | null; service_type: string | null; effective_from: string | null; effective_to: string | null; priority: number };
type Posting = { timesheet_id: string };

const financeRoles = new Set(['grand_master', 'master', 'admin', 'admin_officer']);
const money = (value: number) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(value);
const shortDate = (value: string) => new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium' }).format(new Date(`${value}T00:00:00`));

export function FinanceLabourCostWorkspace({ activePeriodId, onChanged }: { activePeriodId?: string; onChanged?: () => void } = {}) {
  const { profile, operatingOrganizationId } = useAuth();
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [links, setLinks] = useState<Record<string, AgreementLink>>({});
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [rates, setRates] = useState<Rate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [localPeriodId, setPeriodId] = useState('');
  const periodId = activePeriodId ?? localPeriodId;
  const [costCentreId, setCostCentreId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const organizationId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const canManage = Boolean(organizationId && profile && financeRoles.has(profile.role));

  const load = useCallback(async () => {
    if (!organizationId || !canManage) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const orgId = organizationId;
    const [sheetResult, postingResult, periodResult, agreementResult, centreResult, rateResult] = await Promise.all([
      supabase.from('timesheets').select('id,staff_id,shift_id,period_start,period_end,actual_hours,work_derived_hours,status').eq('organization_id', orgId).in('status', ['approved', 'paid']).not('shift_id', 'is', null).order('period_end', { ascending: false }).limit(100),
      supabase.from('finance_labour_cost_postings').select('timesheet_id').eq('organization_id', orgId).limit(500),
      supabase.from('finance_pl_periods').select('id,name,period_start,period_end').eq('organization_id', orgId).in('status', ['draft', 'locked']).order('period_start', { ascending: false }),
      supabase.from('service_agreements').select('id,name').eq('provider_organization_id', orgId).eq('agreement_type', 'operational').order('name'),
      supabase.from('cost_centres').select('id,code,name').eq('organization_id', orgId).eq('active', true).order('code'),
      supabase.from('rate_rules').select('id,amount,pay_code,staff_id,role_code,service_type,effective_from,effective_to,priority').eq('organization_id', orgId).eq('rule_kind', 'pay').eq('rate_type', 'hourly').eq('active', true),
    ]);
    const firstError = sheetResult.error ?? postingResult.error ?? periodResult.error ?? agreementResult.error ?? centreResult.error ?? rateResult.error;
    if (firstError) {
      setError(firstError.message);
      setLoading(false);
      return;
    }
    const posted = new Set(((postingResult.data as Posting[]) ?? []).map((row) => row.timesheet_id));
    const nextSheets = ((sheetResult.data as Timesheet[]) ?? []).filter((row) => !posted.has(row.id));
    const shiftIds = nextSheets.map((row) => row.shift_id).filter((id): id is string => Boolean(id));
    const staffIds = [...new Set(nextSheets.map((row) => row.staff_id))];
    const [shiftResult, staffResult] = await Promise.all([
      shiftIds.length ? supabase.from('shifts').select('id,service_type,work_unit_id,service_agreement_location_id,service_agreement_module_id').eq('organization_id', orgId).in('id', shiftIds) : Promise.resolve({ data: [] as Shift[], error: null }),
      staffIds.length ? supabase.from('staff_profiles').select('id,employee_number,role_code').in('id', staffIds) : Promise.resolve({ data: [] as Staff[], error: null }),
    ]);
    const relatedError = shiftResult.error ?? staffResult.error;
    if (relatedError) {
      setError(relatedError.message);
      setLoading(false);
      return;
    }
    const nextShifts = (shiftResult.data as Shift[]) ?? [];
    const locationIds = nextShifts.map((row) => row.service_agreement_location_id).filter((id): id is string => Boolean(id));
    const moduleIds = nextShifts.map((row) => row.service_agreement_module_id).filter((id): id is string => Boolean(id));
    const [locationResult, moduleResult] = await Promise.all([
      locationIds.length ? supabase.from('service_agreement_locations').select('id,service_agreement_id,status').in('id', locationIds) : Promise.resolve({ data: [], error: null }),
      moduleIds.length ? supabase.from('service_agreement_modules').select('id,service_agreement_id,enabled').in('id', moduleIds) : Promise.resolve({ data: [], error: null }),
    ]);
    const linkError = locationResult.error ?? moduleResult.error;
    if (linkError) {
      setError(linkError.message);
      setLoading(false);
      return;
    }
    setTimesheets(nextSheets);
    setShifts(nextShifts);
    setStaff((staffResult.data as Staff[]) ?? []);
    setPeriods((periodResult.data as Period[]) ?? []);
    setAgreements((agreementResult.data as Agreement[]) ?? []);
    setCostCentres((centreResult.data as CostCentre[]) ?? []);
    setRates((rateResult.data as Rate[]) ?? []);
    setLinks(Object.fromEntries([
      ...((locationResult.data ?? []).map((row) => [row.id, { id: row.id, service_agreement_id: row.service_agreement_id, active: row.status === 'active' }])),
      ...((moduleResult.data ?? []).map((row) => [row.id, { id: row.id, service_agreement_id: row.service_agreement_id, active: row.enabled }])),
    ]));
    setSelectedId((current) => nextSheets.some((row) => row.id === current) ? current : '');
    setLoading(false);
  }, [canManage, organizationId]);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => timesheets.map((sheet) => {
    const shift = shifts.find((row) => row.id === sheet.shift_id);
    const employee = staff.find((row) => row.id === sheet.staff_id);
    const locationLink = shift?.service_agreement_location_id ? links[shift.service_agreement_location_id] : null;
    const moduleLink = shift?.service_agreement_module_id ? links[shift.service_agreement_module_id] : null;
    const agreementId = locationLink?.service_agreement_id ?? moduleLink?.service_agreement_id ?? null;
    const linksAgree = !locationLink || !moduleLink || locationLink.service_agreement_id === moduleLink.service_agreement_id;
    const agreement = agreements.find((row) => row.id === agreementId);
    const hours = Number(sheet.actual_hours ?? sheet.work_derived_hours ?? 0);
    const rate = rates
      .filter((row) => (!row.staff_id || row.staff_id === sheet.staff_id)
        && (!row.role_code || row.role_code === employee?.role_code)
        && (!row.service_type || row.service_type === shift?.service_type)
        && (!row.effective_from || row.effective_from <= sheet.period_start)
        && (!row.effective_to || row.effective_to >= sheet.period_start))
      .sort((left, right) => Number(Boolean(right.staff_id)) - Number(Boolean(left.staff_id))
        || Number(Boolean(right.role_code)) - Number(Boolean(left.role_code))
        || Number(Boolean(right.service_type)) - Number(Boolean(left.service_type))
        || right.priority - left.priority
        || (right.effective_from ?? '').localeCompare(left.effective_from ?? ''))[0];
    const eligible = Boolean(shift && employee && agreement && linksAgree && (locationLink?.active ?? true) && (moduleLink?.active ?? true) && hours > 0);
    return { sheet, shift, employee, agreement, hours, rate, eligible };
  }), [agreements, links, rates, shifts, staff, timesheets]);

  const selected = rows.find((row) => row.sheet.id === selectedId);
  const availablePeriods = selected ? periods.filter((row) => row.period_start <= selected.sheet.period_start && row.period_end >= selected.sheet.period_end) : [];
  const choose = (id: string) => {
    const row = rows.find((item) => item.sheet.id === id);
    setSelectedId(id);
    if (activePeriodId === undefined) setPeriodId(row ? periods.find((period) => period.period_start <= row.sheet.period_start && period.period_end >= row.sheet.period_end)?.id ?? '' : '');
    setCostCentreId('');
    setError(null);
    setNotice(null);
  };

  const postCost = async () => {
    if (!selected?.eligible || !selected.shift || !selected.agreement || !selected.rate || !availablePeriods.some((period) => period.id === periodId)) {
      setError('Choose an eligible timesheet with an active agreement, open accounting period, and resolved pay rate.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const { data, error: actionError } = await supabase.rpc('post_finance_timesheet_labour_cost', {
      p_timesheet_id: selected.sheet.id,
      p_pl_period_id: periodId,
      p_service_agreement_id: selected.agreement.id,
      p_service_type: selected.shift.service_type,
      p_cost_centre_id: costCentreId || null,
      p_work_unit_id: selected.shift.work_unit_id,
    });
    if (actionError) setError(actionError.message);
    else {
      const posting = data as { hours?: number; hourly_rate?: number } | null;
      setNotice(`${Number(posting?.hours ?? selected.hours).toFixed(2)} hours were posted at ${money(Number(posting?.hourly_rate ?? selected.rate.amount))} per hour. The actual labour cost is now included in the selected money period.`);
      onChanged?.();
      setSelectedId('');
      await load();
    }
    setSaving(false);
  };

  if (!canManage) return <section className="finance-labour is-permission"><CircleAlert size={18} /><div><strong>Labour-cost posting is restricted</strong><p>A finance administrator must confirm approved hours and accounting attribution.</p></div></section>;

  return <section className="finance-labour" aria-labelledby="finance-labour-heading">
    <header><div><p>Actual labour costs</p><h2 id="finance-labour-heading">Post approved shift hours into the money period</h2><span>The shift fixes the customer agreement, work unit, service type, and applicable pay rule.</span></div><button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading || saving}><RefreshCw size={15} className={loading ? 'is-spinning' : ''} />Refresh</button></header>
    {error && <div className="finance-labour-message is-error" role="alert"><CircleAlert size={15} />{error}</div>}
    {notice && <div className="finance-labour-message is-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
    {loading ? <div className="finance-labour-empty">Loading approved timesheets and finance controls...</div> : rows.length === 0 ? <div className="finance-labour-empty">No approved shift timesheets are waiting to be posted.</div> : (
      <div className="finance-labour-grid">
        <div><h3>1. Approved timesheet <span>{rows.length}</span></h3><div className="finance-labour-list">{rows.map((row) => <button type="button" key={row.sheet.id} className={selectedId === row.sheet.id ? 'is-selected' : ''} onClick={() => choose(row.sheet.id)}><span><strong>{row.employee?.employee_number || `Staff ${row.sheet.staff_id.slice(0, 8)}`}</strong><small>{shortDate(row.sheet.period_start)}–{shortDate(row.sheet.period_end)} · {row.shift?.service_type?.replaceAll('_', ' ') || 'shift unavailable'}</small></span><b>{row.hours.toFixed(2)} h</b></button>)}</div></div>
        <div><h3>2. Confirm attribution</h3>{!selected ? <div className="finance-labour-empty">Choose an approved timesheet to verify its agreement, period, and pay rate.</div> : <div className="finance-labour-review">
          <dl><div><dt>Agreement</dt><dd>{selected.agreement?.name ?? 'Shift agreement missing or conflicting'}</dd></div><div><dt>Payroll role</dt><dd>{selected.employee?.role_code ?? 'No payroll role assigned'}</dd></div><div><dt>Pay rate</dt><dd>{selected.rate ? `${money(selected.rate.amount)} per hour · ${selected.rate.pay_code ?? 'pay code missing'}` : 'No applicable hourly pay rule'}</dd></div><div><dt>Estimated cost</dt><dd>{selected.rate ? money(selected.hours * selected.rate.amount) : 'Blocked until rate is configured'}</dd></div></dl>
          {activePeriodId === undefined ? <label><span>Open money period</span><select value={periodId} onChange={(event) => setPeriodId(event.target.value)}><option value="">Select a period</option>{availablePeriods.map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}</select></label> : <p role="status">{availablePeriods.some((period) => period.id === periodId) ? `Posting to active accounting period: ${availablePeriods.find((period) => period.id === periodId)?.name}` : 'The active accounting period must be open and contain the entire timesheet. Choose an eligible period in the top bar.'}</p>}
          <label><span>Cost centre (optional)</span><select value={costCentreId} onChange={(event) => setCostCentreId(event.target.value)}><option value="">No cost centre</option>{costCentres.map((centre) => <option key={centre.id} value={centre.id}>{centre.code} — {centre.name}</option>)}</select></label>
          {!selected.eligible && <div className="finance-labour-message is-error"><CircleAlert size={15} />The timesheet is missing a valid shift-to-agreement path.</div>}
          {selected.eligible && !selected.rate && <div className="finance-labour-message is-error"><CircleAlert size={15} /><span>Add an applicable hourly pay rule before posting. A zero-cost P&amp;L line will not be created. <Link to="/admin/rate-rules">Open pay and charge rules</Link>.</span></div>}
        </div>}</div>
      </div>
    )}
    <footer><span>One timesheet can be posted once. The RPC rechecks every contract, tenant, period, and shift boundary.</span><button type="button" className="btn btn-primary" onClick={() => void postCost()} disabled={!selected?.eligible || !selected.rate || !availablePeriods.some((period) => period.id === periodId) || saving}>{saving ? 'Posting...' : 'Post actual labour cost'}</button></footer>
  </section>;
}
