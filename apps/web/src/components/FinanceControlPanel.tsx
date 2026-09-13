import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, LockKeyhole } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './FinanceControlPanel.css';

type Period = { id: string; name: string; status: string };
type TaxPeriod = { id: string; period_start: string; period_end: string; status: string; net_tax_due: number };
type Agreement = { id: string; name: string };
type Shift = { id: string; service_type: string; scheduled_start: string; status: string; officer_user_id: string | null };

export function FinanceControlPanel() {
  const { profile } = useAuth();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [taxPeriods, setTaxPeriods] = useState<TaxPeriod[]>([]);
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [periodId, setPeriodId] = useState('');
  const [taxPeriodId, setTaxPeriodId] = useState('');
  const [agreementId, setAgreementId] = useState('');
  const [selectedShiftId, setSelectedShiftId] = useState('');
  const [costType, setCostType] = useState('labour');
  const [quantity, setQuantity] = useState('1');
  const [unitCost, setUnitCost] = useState('0');
  const [sourceReference, setSourceReference] = useState('E2E browser finance control');
  const [periodName, setPeriodName] = useState('E2E September 2026 P&L');
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
      supabase.from('shifts').select('id,service_type,scheduled_start,status,officer_user_id').eq('organization_id', profile.organizationId).in('status', ['accepted', 'in_progress']).order('scheduled_start', { ascending: false }).limit(50),
    ]);
    if (periodResponse.error || taxResponse.error || agreementResponse.error || shiftResponse.error) setError(periodResponse.error?.message ?? taxResponse.error?.message ?? agreementResponse.error?.message ?? shiftResponse.error?.message ?? 'Finance controls could not be loaded.');
    else {
      const nextPeriods = (periodResponse.data as Period[]) ?? [];
      const nextTaxPeriods = (taxResponse.data as TaxPeriod[]) ?? [];
      const nextAgreements = (agreementResponse.data as Agreement[]) ?? [];
      const nextShifts = (shiftResponse.data as Shift[]) ?? [];
      setPeriods(nextPeriods); setTaxPeriods(nextTaxPeriods); setAgreements(nextAgreements); setShifts(nextShifts);
      setPeriodId((current) => current || nextPeriods[0]?.id || ''); setTaxPeriodId((current) => current || nextTaxPeriods[0]?.id || ''); setAgreementId((current) => current || nextAgreements[0]?.id || '');
    }
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);

  const runAction = async (action: 'cost' | 'tax' | 'close') => {
    setSaving(true); setError(null); setNotice(null);
    let message = '';
    if (action === 'cost') {
      const { error: actionError } = await supabase.rpc('record_finance_service_cost', { p_pl_period_id: periodId, p_service_agreement_id: agreementId, p_cost_type: costType, p_quantity: Number(quantity), p_unit_cost: Number(unitCost), p_source_document_type: 'manual', p_source_reference: sourceReference.trim() || 'Browser finance control', p_shift_id: selectedShiftId || null });
      if (actionError) { setError(actionError.message); setSaving(false); return; }
      message = 'Service cost recorded with an audit receipt.';
    } else if (action === 'tax') {
      const { data, error: actionError } = await supabase.rpc('prepare_finance_tax_period', { p_tax_period_id: taxPeriodId });
      if (actionError) { setError(actionError.message); setSaving(false); return; }
      message = `Tax period prepared. Net tax due: $${Number(data?.net_tax_due ?? 0).toFixed(2)}. No IRD submission was made.`;
    } else {
      const { error: actionError } = await supabase.rpc('close_finance_pl_period', { p_pl_period_id: periodId });
      if (actionError) { setError(actionError.message); setSaving(false); return; }
      message = 'P&L period closed and snapshot created.';
    }
    setNotice(message); await load(); setSaving(false);
  };

  const createPeriod = async () => {
    setSaving(true); setError(null); setNotice(null);
    const { data, error: actionError } = await supabase.rpc('create_finance_pl_period', { p_name: periodName.trim(), p_period_start: periodStart, p_period_end: periodEnd });
    if (actionError) setError(actionError.message); else { setPeriodId(data.id); setNotice(`${data.name} created as a draft P&L period.`); await load(); }
    setSaving(false);
  };

  const createTaxPeriod = async () => {
    setSaving(true); setError(null); setNotice(null);
    const { data, error: actionError } = await supabase.rpc('create_finance_tax_period', { p_period_start: taxStart, p_period_end: taxEnd, p_filing_due_date: taxDue });
    if (actionError) setError(actionError.message); else { setTaxPeriodId(data.id); setNotice('Open tax period created. Preparation does not file with IRD.'); await load(); }
    setSaving(false);
  };

  const labourNeedsShift = costType === 'labour' && shifts.length > 0 && !selectedShiftId;

  if (loading) return <section className="finance-control-panel" aria-busy="true"><header><LockKeyhole size={18} /><div><p>Governed internal controls</p><h2 id="finance-control-heading">Finance control centre</h2><span>Record costs, prepare tax figures, and close a P&L period. No bank or IRD connection is used here.</span></div></header><p className="finance-control-message is-loading">Loading finance controls...</p></section>;
  if (error && !profile?.organizationId) return <section className="finance-control-panel" aria-labelledby="finance-control-heading"><header><LockKeyhole size={18} /><div><p>Governed internal controls</p><h2 id="finance-control-heading">Finance control centre</h2><span>Record costs, prepare tax figures, and close a P&L period. No bank or IRD connection is used here.</span></div></header><p className="finance-control-message is-error" role="alert"><CircleAlert size={14} />{error}</p></section>;

  return <section className="finance-control-panel" aria-labelledby="finance-control-heading">
    <header><LockKeyhole size={18} /><div><p>Governed internal controls</p><h2 id="finance-control-heading">Finance control centre</h2><span>Record costs, prepare tax figures, and close a P&L period. No bank or IRD connection is used here.</span></div></header>
    {error && <p className="finance-control-message is-error" role="alert"><CircleAlert size={14} />{error}</p>}
    {notice && <p className="finance-control-message is-success" role="status"><CheckCircle2 size={14} />{notice}</p>}
    <div className="finance-control-grid">
      <div><h3>Create or use P&L period</h3><label><span>Period name</span><input value={periodName} onChange={(event) => setPeriodName(event.target.value)} /></label><div className="finance-control-row"><label><span>Start</span><input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></label><label><span>End</span><input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></label></div><button type="button" className="btn btn-secondary" disabled={saving || !periodName.trim()} onClick={() => void createPeriod()}>Create draft period</button><label><span>Selected period</span><select value={periodId} onChange={(event) => setPeriodId(event.target.value)}><option value="">Select period</option>{periods.map((period, idx) => <option key={`pl-select-${period.id || idx}`} value={period.id}>{period.name} · {period.status}</option>)}</select></label><h3>Record service cost</h3><label><span>Service agreement</span><select value={agreementId} onChange={(event) => setAgreementId(event.target.value)}><option value="">Select agreement</option>{agreements.map((agreement, idx) => <option key={`agreement-select-${agreement.id || idx}`} value={agreement.id}>{agreement.name}</option>)}</select></label><label><span>Shift attribution</span><select value={selectedShiftId} onChange={(event) => setSelectedShiftId(event.target.value)}><option value="">No shift attribution</option>{shifts.map((shift, idx) => <option key={`shift-select-${shift.id || idx}`} value={shift.id}>{new Date(shift.scheduled_start).toLocaleString('en-NZ')} · {shift.service_type.replaceAll('_', ' ')} · {shift.status}{shift.officer_user_id ? ' · officer assigned' : ''}</option>)}</select></label>{labourNeedsShift && <small className="finance-control-shift-warning">Select the active officer shift before recording labour cost.</small>}<div className="finance-control-row"><label><span>Cost type</span><select value={costType} onChange={(event) => setCostType(event.target.value)}><option value="labour">Labour</option><option value="vehicle">Vehicle</option><option value="materials">Materials</option><option value="equipment">Equipment</option><option value="overhead">Overhead</option><option value="depreciation">Depreciation</option><option value="other">Other</option></select></label><label><span>Quantity</span><input type="number" min="0.001" step="0.001" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><label><span>Unit cost</span><input type="number" min="0" step="0.01" value={unitCost} onChange={(event) => setUnitCost(event.target.value)} /></label></div><label><span>Source reference</span><input value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} /></label><button type="button" className="btn btn-primary" disabled={saving || !periodId || !agreementId || labourNeedsShift} onClick={() => void runAction('cost')}>Record cost</button></div>
      <div><h3>Create or prepare tax period</h3><div className="finance-control-row"><label><span>Start</span><input type="date" value={taxStart} onChange={(event) => setTaxStart(event.target.value)} /></label><label><span>End</span><input type="date" value={taxEnd} onChange={(event) => setTaxEnd(event.target.value)} /></label><label><span>Filing due</span><input type="date" value={taxDue} onChange={(event) => setTaxDue(event.target.value)} /></label></div><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => void createTaxPeriod()}>Create open tax period</button><label><span>Tax period</span><select value={taxPeriodId} onChange={(event) => setTaxPeriodId(event.target.value)}><option value="">Select tax period</option>{taxPeriods.map((period, idx) => <option key={`tax-select-${period.id || idx}`} value={period.id}>{period.period_start} to {period.period_end} · {period.status}</option>)}</select></label><button type="button" className="btn btn-secondary" disabled={saving || !taxPeriodId} onClick={() => void runAction('tax')}>Prepare tax figures</button><small>Preparation only. No IRD filing or payment is made.</small></div>
      <div><h3>Close P&L period</h3><label><span>Draft period</span><select value={periodId} onChange={(event) => setPeriodId(event.target.value)}><option value="">Select period</option>{periods.map((period, idx) => <option key={`close-select-${period.id || idx}`} value={period.id}>{period.name} · {period.status}</option>)}</select></label><button type="button" className="btn btn-secondary" disabled={saving || !periodId || periods.find((period) => period.id === periodId)?.status !== 'draft'} onClick={() => void runAction('close')}>Close period and snapshot</button><small>Closing is irreversible for the period and requires finance administrator authority.</small></div>
    </div>
  </section>;
}
