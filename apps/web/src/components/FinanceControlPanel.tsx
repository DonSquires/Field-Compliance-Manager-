import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, LockKeyhole } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { usePriceList } from './PriceListPicker';
import { itemToSelection, rateToSelection, type PriceListSelection } from '../lib/priceList';
import './FinanceControlPanel.css';

type Period = { id: string; name: string; status: string };
type TaxPeriod = { id: string; period_start: string; period_end: string; status: string; net_tax_due: number };
type Agreement = { id: string; name: string };
type Shift = { id: string; service_type: string; scheduled_start: string; status: string; officer_user_id: string | null; service_agreement_location_id: string | null; service_agreement_module_id: string | null; work_unit_id: string | null };
type AgreementLink = { id: string; service_agreement_id: string };
type ProfitabilityRow = { service_agreement_id: string; estimated_total_cost: number; actual_total_cost: number; estimated_vehicle: number; actual_vehicle: number; client_invoice_total: number; net_profit: number | null };

export function FinanceControlPanel({ mode = 'all', activePeriodId, onPeriodChange, onChanged }: {
  mode?: 'all' | 'cost' | 'tax' | 'close' | 'periods';
  activePeriodId?: string;
  onPeriodChange?: (id: string) => void;
  onChanged?: () => void;
} = {}) {
  const { profile } = useAuth();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [taxPeriods, setTaxPeriods] = useState<TaxPeriod[]>([]);
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [locationAgreementByLink, setLocationAgreementByLink] = useState<Record<string, string>>({});
  const [moduleAgreementByLink, setModuleAgreementByLink] = useState<Record<string, string>>({});
  const [profitability, setProfitability] = useState<ProfitabilityRow[]>([]);
  const [localPeriodId, setLocalPeriodId] = useState('');
  const periodId = activePeriodId ?? localPeriodId;
  const setPeriodId = (id: string) => activePeriodId === undefined ? setLocalPeriodId(id) : onPeriodChange?.(id);
  const [taxPeriodId, setTaxPeriodId] = useState('');
  const [agreementId, setAgreementId] = useState('');
  const [selectedShiftId, setSelectedShiftId] = useState('');
  const [costType, setCostType] = useState('labour');
  const [costPick, setCostPick] = useState('');
  const [category, setCategory] = useState('all');
  const priceList = usePriceList(profile?.organizationId ? [profile.organizationId] : []);
  const priceEntries = [
    ...priceList.billingRates.map((rate) => ({ token: `rate:${rate.id}`, selection: rateToSelection(rate, priceList.payRates) })),
    ...priceList.items.map((item) => ({ token: `item:${item.item_id}`, selection: itemToSelection(item) })),
  ];
  const visibleEntries = priceEntries.filter((entry) => category === 'all' || entry.selection.costType === category);
  const pickCost = (selection: PriceListSelection | null, token: string) => {
    setCostPick(token);
    if (!selection) return;
    setCostType(selection.costType);
    setUnitCost(selection.unitCost === null ? '' : selection.unitCost.toFixed(2));
    setSourceReference(selection.description);
  };
  const [quantity, setQuantity] = useState('1');
  const [unitCost, setUnitCost] = useState('0');
  const [sourceReference, setSourceReference] = useState('');
  const [periodName, setPeriodName] = useState('September 2026 money check');
  const [periodStart, setPeriodStart] = useState('2026-09-01');
  const [periodEnd, setPeriodEnd] = useState('2026-09-30');
  const [taxStart, setTaxStart] = useState('2026-09-01');
  const [taxEnd, setTaxEnd] = useState('2026-09-30');
  const [taxDue, setTaxDue] = useState('2026-10-28');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organizationId) {
      setError('Organisation access could not be confirmed. Finance controls are unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const [periodResponse, taxResponse, agreementResponse, shiftResponse] = await Promise.all([
      supabase.from('finance_pl_periods').select('id,name,status').eq('organization_id', profile.organizationId).in('status', ['draft', 'locked']).order('period_end', { ascending: false }),
      supabase.from('finance_tax_periods').select('id,period_start,period_end,status,net_tax_due').eq('organization_id', profile.organizationId).in('status', ['open', 'prepared']).order('period_end', { ascending: false }),
      supabase.from('service_agreements').select('id,name').eq('provider_organization_id', profile.organizationId).eq('invitation_status', 'accepted').order('name'),
      supabase.from('shifts').select('id,service_type,scheduled_start,status,officer_user_id,service_agreement_location_id,service_agreement_module_id,work_unit_id').eq('organization_id', profile.organizationId).in('status', ['accepted', 'in_progress']).order('scheduled_start', { ascending: false }).limit(50),
    ]);
    const baseFailure = periodResponse.error ?? taxResponse.error ?? agreementResponse.error ?? shiftResponse.error;
    if (baseFailure) {
      setError(baseFailure.message);
      setLoading(false);
      return;
    }

    const nextPeriods = (periodResponse.data as Period[]) ?? [];
    const nextTaxPeriods = (taxResponse.data as TaxPeriod[]) ?? [];
    const nextAgreements = (agreementResponse.data as Agreement[]) ?? [];
    const nextShifts = (shiftResponse.data as Shift[]) ?? [];
    const locationLinkIds = [...new Set(nextShifts.map((shift) => shift.service_agreement_location_id).filter((id): id is string => Boolean(id)))];
    const moduleLinkIds = [...new Set(nextShifts.map((shift) => shift.service_agreement_module_id).filter((id): id is string => Boolean(id)))];
    const [locationLinks, moduleLinks] = await Promise.all([
      locationLinkIds.length
        ? supabase.from('service_agreement_locations').select('id,service_agreement_id').in('id', locationLinkIds)
        : Promise.resolve({ data: [] as AgreementLink[], error: null }),
      moduleLinkIds.length
        ? supabase.from('service_agreement_modules').select('id,service_agreement_id').in('id', moduleLinkIds)
        : Promise.resolve({ data: [] as AgreementLink[], error: null }),
    ]);
    const linkFailure = locationLinks.error ?? moduleLinks.error;
    if (linkFailure) {
      setError(`Shift agreement links could not be verified: ${linkFailure.message}`);
      setLoading(false);
      return;
    }
    const visibleAgreementIds = new Set(nextAgreements.map((agreement) => agreement.id));
    setLocationAgreementByLink(Object.fromEntries(((locationLinks.data as AgreementLink[]) ?? []).filter((link) => visibleAgreementIds.has(link.service_agreement_id)).map((link) => [link.id, link.service_agreement_id])));
    setModuleAgreementByLink(Object.fromEntries(((moduleLinks.data as AgreementLink[]) ?? []).filter((link) => visibleAgreementIds.has(link.service_agreement_id)).map((link) => [link.id, link.service_agreement_id])));
    setPeriods(nextPeriods); setTaxPeriods(nextTaxPeriods); setAgreements(nextAgreements); setShifts(nextShifts);
    if (activePeriodId === undefined) setLocalPeriodId((current) => nextPeriods.some((period) => period.id === current) ? current : nextPeriods[0]?.id ?? '');
    setTaxPeriodId((current) => current || nextTaxPeriods[0]?.id || ''); setAgreementId((current) => nextAgreements.some((agreement) => agreement.id === current) ? current : '');
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);

  const runAction = async (action: 'cost' | 'tax' | 'close') => {
    setSaving(true); setError(null); setNotice(null);
    let message = '';
    if (action === 'cost') {
      if (!sourceReference.trim()) { setError('Enter a source reference before recording this cost.'); setSaving(false); return; }
      if (!quantity.trim() || !unitCost.trim() || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0 || !Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) { setError('Enter a valid quantity and evidenced unit cost.'); setSaving(false); return; }
      if (shiftAttributionError) { setError(shiftAttributionError); setSaving(false); return; }
      const { error: actionError } = await supabase.rpc('record_finance_service_cost', { p_pl_period_id: periodId, p_service_agreement_id: agreementId, p_cost_type: costType, p_quantity: Number(quantity), p_unit_cost: Number(unitCost), p_source_document_type: 'manual', p_source_reference: sourceReference.trim(), p_work_unit_id: selectedShift?.work_unit_id ?? null, p_shift_id: selectedShiftId || null });
      if (actionError) { setError(actionError.message); setSaving(false); return; }
      message = 'Job cost saved with an audit receipt.';
      setCostPick('');
    } else if (action === 'tax') {
      const { data, error: actionError } = await supabase.rpc('prepare_finance_tax_period', { p_tax_period_id: taxPeriodId });
      if (actionError) { setError(actionError.message); setSaving(false); return; }
      message = `Tax numbers prepared. Tax to set aside: $${Number(data?.net_tax_due ?? 0).toFixed(2)}. Nothing was filed with IRD.`;
    } else {
      const { error: actionError } = await supabase.rpc('close_finance_pl_period', { p_pl_period_id: periodId });
      if (actionError) { setError(actionError.message); setSaving(false); return; }
      message = 'Monthly money check finished and saved.';
    }
    setNotice(message); await load(); onChanged?.(); setSaving(false);
  };

  const createPeriod = async () => {
    setSaving(true); setError(null); setNotice(null);
    const { data, error: actionError } = await supabase.rpc('create_finance_pl_period', { p_name: periodName.trim(), p_period_start: periodStart, p_period_end: periodEnd });
    if (actionError) setError(actionError.message); else { setPeriodId(data.id); setNotice(`${data.name} created as a draft monthly money check.`); await load(); onChanged?.(); }
    setSaving(false);
  };

  const runProfitabilityCheck = async () => {
    setSaving(true); setError(null); setNotice(null); setProfitability([]);
    const { data, error: actionError } = await supabase.rpc('calculate_service_profitability_snapshot', { p_pl_period_id: periodId });
    if (actionError) { setError(actionError.message); setSaving(false); return; }
    const rows = (data as ProfitabilityRow[]) ?? [];
    setProfitability(rows);
    setNotice(rows.length > 0 ? `Compared ${rows.length} contract${rows.length === 1 ? '' : 's'} against actual cost for this money check.` : 'No contracts had both a quote and recorded cost for this money check yet.');
    setSaving(false);
  };

  const createTaxPeriod = async () => {
    setSaving(true); setError(null); setNotice(null);
    const { data, error: actionError } = await supabase.rpc('create_finance_tax_period', { p_period_start: taxStart, p_period_end: taxEnd, p_filing_due_date: taxDue });
    if (actionError) setError(actionError.message); else { setTaxPeriodId(data.id); setNotice('Tax period created. Preparing numbers does not file anything with IRD.'); await load(); }
    setSaving(false);
  };

  const selectedShift = shifts.find((shift) => shift.id === selectedShiftId) ?? null;
  const selectedShiftLinkIds = selectedShift ? [selectedShift.service_agreement_location_id, selectedShift.service_agreement_module_id].filter((id): id is string => Boolean(id)) : [];
  const selectedShiftAgreementIds = selectedShift ? [...new Set([
    selectedShift.service_agreement_location_id ? locationAgreementByLink[selectedShift.service_agreement_location_id] : null,
    selectedShift.service_agreement_module_id ? moduleAgreementByLink[selectedShift.service_agreement_module_id] : null,
  ].filter((id): id is string => Boolean(id)))] : [];
  const selectedShiftLinkUnresolved = Boolean(
    (selectedShift?.service_agreement_location_id && !locationAgreementByLink[selectedShift.service_agreement_location_id])
    || (selectedShift?.service_agreement_module_id && !moduleAgreementByLink[selectedShift.service_agreement_module_id])
  );
  const selectedShiftAgreementConflict = selectedShiftAgreementIds.length > 1;
  const selectedShiftAgreementId = selectedShiftAgreementIds.length === 1 ? selectedShiftAgreementIds[0] : null;
  const shiftAttributionError = selectedShiftLinkUnresolved
    ? 'The selected shift has a service link that could not be verified. Refresh before recording this cost.'
    : selectedShiftAgreementConflict
      ? 'The selected shift has conflicting agreement links. Resolve its work attribution before recording this cost.'
      : selectedShiftAgreementId && agreementId !== selectedShiftAgreementId
        ? 'Select the customer agreement linked to this shift before recording its cost.'
        : null;
  const shiftNeedsManualAgreement = Boolean(selectedShift && selectedShiftLinkIds.length === 0);
  const labourNeedsShift = costType === 'labour' && shifts.length > 0 && !selectedShiftId;
  const sourceReferenceMissing = !sourceReference.trim();

  useEffect(() => {
    if (!selectedShift) return;
    const nextAgreementId = selectedShiftAgreementId ?? '';
    if (agreementId !== nextAgreementId) setAgreementId(nextAgreementId);
  }, [agreementId, selectedShift, selectedShiftAgreementId]);

  useEffect(() => {
    setSourceReference('');
  }, [selectedShiftId]);

  useEffect(() => { setProfitability([]); }, [periodId]);

  if (loading) return <section className="finance-control-panel" aria-busy="true"><header><LockKeyhole size={18} /><div><p>Owner approvals</p><h2 id="finance-control-heading">Finance control centre</h2><span>Add job costs, prepare tax numbers, and finish a monthly money check. Nothing here touches your bank or IRD.</span></div></header><p className="finance-control-message is-loading">Loading finance controls...</p></section>;
  if (error && !profile?.organizationId) return <section className="finance-control-panel" aria-labelledby="finance-control-heading"><header><LockKeyhole size={18} /><div><p>Owner approvals</p><h2 id="finance-control-heading">Finance control centre</h2><span>Add job costs, prepare tax numbers, and finish a monthly money check. Nothing here touches your bank or IRD.</span></div></header><p className="finance-control-message is-error" role="alert"><CircleAlert size={14} />{error}</p></section>;

  return <section className="finance-control-panel" aria-labelledby="finance-control-heading">
    <header><LockKeyhole size={18} /><div><p>Owner approvals</p><h2 id="finance-control-heading">Finance control centre</h2><span>Add job costs, prepare tax numbers, and finish a monthly money check. Nothing here touches your bank or IRD.</span></div></header>
    {error && <p className="finance-control-message is-error" role="alert"><CircleAlert size={14} />{error}</p>}
    {notice && <p className="finance-control-message is-success" role="status"><CheckCircle2 size={14} />{notice}</p>}
    {activePeriodId !== undefined && mode !== 'tax' && <p className="finance-workbench-note">Active accounting period: {periods.find((period) => period.id === periodId)?.name ?? 'Choose an open period in the top bar'}</p>}
    {selectedShiftAgreementId && <p className="finance-control-message" role="status">Customer agreement follows the selected shift: {agreements.find((agreement) => agreement.id === selectedShiftAgreementId)?.name ?? 'verified contract'}.</p>}
    {shiftAttributionError && <p className="finance-control-message is-error" role="alert">{shiftAttributionError}</p>}
    {shiftNeedsManualAgreement && <p className="finance-control-shift-warning" role="note">This shift has no single contract link. Choose the agreement deliberately and cite the cost source.</p>}
    {(mode === 'all' || mode === 'cost') && sourceReferenceMissing && <p className="finance-control-shift-warning" role="note">A source reference is required before any cost can be recorded.</p>}
    <div className="finance-control-grid">
      {(mode === 'all' || mode === 'periods') && <div>
        <h3>Create a monthly money check</h3>
        <label><span>Name</span><input value={periodName} onChange={(event) => setPeriodName(event.target.value)} /></label>
        <div className="finance-control-row"><label><span>Start</span><input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></label><label><span>End</span><input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></label></div>
        <button type="button" className="btn btn-secondary" disabled={saving || !periodName.trim()} onClick={() => void createPeriod()}>Create draft money check</button>
      </div>}
      {(mode === 'all' || mode === 'cost') && <div>
        <h3>Add a job cost</h3>
        {activePeriodId === undefined && <label><span>Money check</span><select value={periodId} onChange={(event) => setPeriodId(event.target.value)}><option value="">Choose a money check</option>{periods.map((period) => <option key={period.id} value={period.id}>{period.name} · {period.status}</option>)}</select></label>}
        <label><span>Customer agreement</span><select value={agreementId} onChange={(event) => setAgreementId(event.target.value)}><option value="">Select agreement</option>{agreements.map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.name}</option>)}</select></label>
        <label><span>Which shift</span><select value={selectedShiftId} onChange={(event) => setSelectedShiftId(event.target.value)}><option value="">Not tied to a shift</option>{shifts.map((shift) => <option key={shift.id} value={shift.id}>{new Date(shift.scheduled_start).toLocaleString('en-NZ')} · {shift.service_type.replaceAll('_', ' ')} · {shift.status}{shift.officer_user_id ? ' · officer assigned' : ''}</option>)}</select></label>
        {labourNeedsShift && <small className="finance-control-shift-warning">Choose the officer's shift before saving a wage cost.</small>}
        <div className="finance-cost-categories" role="group" aria-label="Price list categories">
          {([['all', 'All'], ['labour', 'Wages'], ['vehicle', 'Vehicle'], ['materials', 'Materials'], ['equipment', 'Equipment']] as const).map(([id, name]) => <button type="button" key={id} aria-pressed={category === id} onClick={() => { setCategory(id); setCostPick(''); }}>{name} <span>{priceEntries.filter((entry) => id === 'all' || entry.selection.costType === id).length}</span></button>)}
        </div>
        <label><span>Pick from your price list (optional)</span><select id="job-cost-price-list" value={costPick} onChange={(event) => { const token = event.target.value; pickCost(priceEntries.find((entry) => entry.token === token)?.selection ?? null, token); }}><option value="">Type it in myself</option>{visibleEntries.map(({ token, selection }) => <option key={token} value={token}>{selection.description} · {selection.unitCost === null ? 'Cost not set' : `$${selection.unitCost.toFixed(2)}`} / {selection.unit}</option>)}</select></label>
        <small>{priceList.error ?? (visibleEntries.length ? 'Existing approved prices only. Verify the source and cost before saving.' : 'No entries in this category. Enter an evidenced cost manually or maintain your price list.')}</small>
        <div className="finance-control-row"><label><span>Cost type</span><select value={costType} onChange={(event) => setCostType(event.target.value)}><option value="labour">Wages</option><option value="vehicle">Vehicle</option><option value="materials">Materials</option><option value="equipment">Equipment</option><option value="overhead">Overhead</option><option value="depreciation">Depreciation</option><option value="other">Other</option></select></label><label><span>How many</span><input type="number" min="0.001" step="0.001" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><label><span>Cost each</span><input type="number" min="0" step="0.01" value={unitCost} onChange={(event) => setUnitCost(event.target.value)} /></label></div>
        <label><span>Where this number came from</span><input value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} /></label>
        <button type="button" className="btn btn-primary" disabled={saving || !periods.some((period) => period.id === periodId) || !agreementId || labourNeedsShift} onClick={() => void runAction('cost')}>Save job cost</button>
      </div>}
      {(mode === 'all' || mode === 'tax') && <div><h3>Prepare tax numbers</h3><p>Tax filing dates are independent of the active accounting period.</p><div className="finance-control-row"><label><span>Start</span><input type="date" value={taxStart} onChange={(event) => setTaxStart(event.target.value)} /></label><label><span>End</span><input type="date" value={taxEnd} onChange={(event) => setTaxEnd(event.target.value)} /></label><label><span>Due to IRD</span><input type="date" value={taxDue} onChange={(event) => setTaxDue(event.target.value)} /></label></div><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => void createTaxPeriod()}>Create tax period</button><label><span>Tax period</span><select value={taxPeriodId} onChange={(event) => setTaxPeriodId(event.target.value)}><option value="">Choose a tax period</option>{taxPeriods.map((period, idx) => <option key={`tax-select-${period.id || idx}`} value={period.id}>{period.period_start} to {period.period_end} · {period.status}</option>)}</select></label><button type="button" className="btn btn-secondary" disabled={saving || !taxPeriodId} onClick={() => void runAction('tax')}>Work out tax to set aside</button><small>This only prepares the numbers. Nothing is filed or paid.</small></div>}
      {(mode === 'all' || mode === 'close') && <div><h3>Finish a monthly money check</h3>{activePeriodId === undefined && <label><span>Draft money check</span><select value={periodId} onChange={(event) => setPeriodId(event.target.value)}><option value="">Choose a money check</option>{periods.map((period, idx) => <option key={`close-select-${period.id || idx}`} value={period.id}>{period.name} · {period.status}</option>)}</select></label>}<h3>Compare contract price to actual cost</h3><button type="button" className="btn btn-secondary" disabled={saving || !periodId} onClick={() => void runProfitabilityCheck()}>Compare price to cost</button>{profitability.length > 0 && <div className="finance-control-profitability">{profitability.map((row, idx) => { const agreementName = agreements.find((agreement) => agreement.id === row.service_agreement_id)?.name ?? 'Unknown contract'; const over = row.actual_total_cost > row.estimated_total_cost; return <div key={`profit-${row.service_agreement_id}-${idx}`} className={`finance-control-profit-row ${over ? 'is-over' : 'is-ok'}`}><strong>{agreementName}</strong><span>Quoted price ${row.client_invoice_total.toFixed(0)} · actual cost ${row.actual_total_cost.toFixed(0)} (vehicle ${row.actual_vehicle.toFixed(0)})</span><span>{row.net_profit !== null ? (row.net_profit >= 0 ? `$${row.net_profit.toFixed(0)} left after cost` : `$${Math.abs(row.net_profit).toFixed(0)} over the quoted price`) : 'No quoted price to compare against'}</span></div>; })}</div>}<button type="button" className="btn btn-secondary" disabled={saving || !periodId || periods.find((period) => period.id === periodId)?.status !== 'draft'} onClick={() => void runAction('close')}>Finish and lock this month</button><small>Finishing locks the month so the numbers cannot be quietly changed later. A finance administrator must do this.</small></div>}
    </div>
  </section>;
}
