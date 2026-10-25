import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  BILLING_CYCLES,
  COMMERCIAL_MODELS,
  COMMERCIAL_MODEL_HELP,
  COMMERCIAL_MODEL_LABEL,
  FEE_OVERRUN_POLICIES,
  FEE_OVERRUN_POLICY_LABEL,
  RATE_FIELDS,
  asCommercialModel,
  asFeeOverrunPolicy,
  commercialModelLabel,
  commercialTermsFormFrom,
  commercialTermsPayload,
  commercialTermsProblem,
  describePaymentTerms,
  formatLimit,
  ordinalDay,
  type CommercialModel,
  type CommercialSettingsRow,
  type CommercialTermsForm,
  type PaymentDueMode,
} from '../lib/commercialModel';
import './CrmAgreementCommercialTermsPanel.css';

const cycleLabels = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', quarterly: 'Quarterly' } as const;
const rateLabel = (key: string, label: string) => (key === 'callout_minimum_hours' ? label : `${label} (excl. GST)`);

/** How this client is billed under the agreement, and its billing terms. Writes go through set_agreement_commercial_terms. */
export function CrmAgreementCommercialTermsPanel({ agreementId, onModelChange }: {
  agreementId: string;
  onModelChange?: (model: CommercialModel | null) => void;
}) {
  const [saved, setSaved] = useState<CommercialSettingsRow | null>(null);
  const [form, setForm] = useState<CommercialTermsForm>(() => commercialTermsFormFrom(null));
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    // ATLAS READS: crm_commercial_settings (RLS: provider or client org access)
    const { data, error: readError } = await supabase.from('crm_commercial_settings')
      .select('commercial_model,billing_cycle,payment_terms_days,payment_due_day_of_month,invoice_email,purchase_order_number,notes,base_rate_per_hour,overtime_rate_per_hour,callout_rate_per_hour,callout_minimum_hours,travel_rate_per_km,standing_authority_limit,fee_overrun_policy,updated_at')
      .eq('service_agreement_id', agreementId)
      .maybeSingle();
    if (readError) {
      setLoadError(`Billing terms could not be loaded: ${readError.message}`);
    } else {
      const row = (data as CommercialSettingsRow | null) ?? null;
      setSaved(row);
      setForm(commercialTermsFormFrom(row));
      onModelChange?.(asCommercialModel(row?.commercial_model));
    }
    setLoading(false);
  }, [agreementId, onModelChange]);

  useEffect(() => { void load(); }, [load]);

  const savedModel = asCommercialModel(saved?.commercial_model);
  const modelChanging = Boolean(savedModel && form.model && savedModel !== form.model);
  const problem = editing ? commercialTermsProblem(form, savedModel, reason) : null;

  const startEdit = () => { setForm(commercialTermsFormFrom(saved)); setReason(''); setError(null); setNotice(null); setEditing(true); };
  const cancel = () => { setForm(commercialTermsFormFrom(saved)); setReason(''); setError(null); setEditing(false); };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || !form.model) return;
    setSaving(true);
    setError(null);
    // ATLAS WRITES: set_agreement_commercial_terms (provider admin; audited agreement_commercial_terms_set)
    const { error: saveError } = await supabase.rpc('set_agreement_commercial_terms', {
      p_service_agreement_id: agreementId,
      p_commercial_model: form.model,
      p_terms: commercialTermsPayload(form),
      p_reason: modelChanging ? reason.trim() : null,
    });
    setSaving(false);
    if (saveError) { setError(saveError.message); return; }
    setEditing(false);
    setNotice(`Saved. This client is billed ${COMMERCIAL_MODEL_LABEL[form.model].toLowerCase()}. The change is in the audit log.`);
    await load();
  };

  const rate = (value: number | null | undefined) => (value == null ? 'Not set' : value.toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 4 }));

  return <section className="agreement-obligations agreement-commercial" aria-labelledby="agreement-commercial-title" aria-busy={loading || saving}>
    <div className="agreement-section-heading">
      <div>
        <h3 id="agreement-commercial-title">How this client is billed</h3>
        <p>Each client has its own terms. The billing model decides whether Dispatch asks for Contracted work or Extra, whether a client reference is needed, and how completed work is invoiced.</p>
      </div>
      {!editing && !loading && !loadError && <button type="button" onClick={startEdit}>{savedModel ? 'Change terms' : 'Set billing model'}</button>}
    </div>

    {loadError && <div className="agreement-obligation-message is-error" role="alert"><AlertTriangle size={15} />{loadError}<button type="button" className="agreement-extra-retry" onClick={() => void load()}>Retry</button></div>}
    {loading && !saved && !loadError && <div className="agreement-setup-loading"><RefreshCw size={18} className="is-spinning" />Loading billing terms</div>}
    {notice && !editing && <div className="agreement-obligation-message is-success" role="status"><CheckCircle2 size={15} />{notice}</div>}

    {!editing && !loading && !loadError && (savedModel ? <dl className="agreement-commercial-summary">
      <div className="is-wide"><dt>Billing model</dt><dd><strong>{commercialModelLabel(savedModel)}</strong><small>{COMMERCIAL_MODEL_HELP[savedModel]}</small></dd></div>
      {savedModel === 'do_and_invoice' && <div className="is-wide"><dt>Standing authority limit per job</dt><dd>{saved?.standing_authority_limit != null ? <>{formatLimit(Number(saved.standing_authority_limit))}<small>A job costing more than this needs the client's approval reference in Dispatch before it is invoiced.</small></> : <>No limit<small>Every job is invoiced at actuals without asking first. Set a limit if the client caps what one job may cost.</small></>}</dd></div>}
      {savedModel === 'fixed_price_with_extras' && <div className="is-wide"><dt>Monthly fee drawdown</dt><dd>{FEE_OVERRUN_POLICY_LABEL[asFeeOverrunPolicy(saved?.fee_overrun_policy)]}<small>Each contracted job draws down the monthly fee. Unused value is credited on the month's invoice. Contracted work above the fee is Extra.</small></dd></div>}
      <div><dt>Billing cycle</dt><dd>{saved?.billing_cycle ? cycleLabels[saved.billing_cycle as keyof typeof cycleLabels] ?? saved.billing_cycle : 'Not set'}</dd></div>
      <div><dt>Payment due</dt><dd>{describePaymentTerms(saved)}{saved?.payment_due_day_of_month != null && <small>October's work, invoiced early November, is due {ordinalDay(saved.payment_due_day_of_month)} November. Invoiced after that day, it is due the next month.</small>}</dd></div>
      <div><dt>Invoice email</dt><dd>{saved?.invoice_email || 'Not set'}</dd></div>
      <div><dt>Standing PO</dt><dd>{saved?.purchase_order_number || 'None'}</dd></div>
      {RATE_FIELDS.map(({ key, label }) => <div key={key}><dt>{rateLabel(key, label)}</dt><dd>{rate(saved?.[key])}</dd></div>)}
      <div className="is-wide"><dt>GST</dt><dd>All rates and prices are before GST<small>GST (15%) is added when the invoice is created.</small></dd></div>
      {saved?.notes && <div className="is-wide"><dt>Notes</dt><dd>{saved.notes}</dd></div>}
    </dl> : <div className="agreement-setup-empty">No billing model is set. Until one is chosen, Dispatch treats callouts as Contracted work or Extra. Set it so invoices follow this client's terms.</div>)}

    {editing && <form className="agreement-obligation-form" onSubmit={save} aria-describedby="commercial-form-help">
      <header><div><strong>Billing terms</strong><span id="commercial-form-help">Only an administrator of the provider can save these. Every change is audited.</span></div></header>
      <fieldset className="agreement-commercial-models">
        <legend>Billing model</legend>
        {COMMERCIAL_MODELS.map((model) => <label key={model} className={form.model === model ? 'is-selected' : ''}>
          <input type="radio" name="commercial-model" value={model} checked={form.model === model} onChange={() => setForm({ ...form, model })} />
          <span><strong>{COMMERCIAL_MODEL_LABEL[model]}</strong><small>{COMMERCIAL_MODEL_HELP[model]}</small></span>
        </label>)}
      </fieldset>
      {modelChanging && <div className="agreement-obligation-grid">
        <label className="is-wide"><span>Why is the billing model changing? (required)</span><input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="New contract signed from 1 July" /></label>
      </div>}
      <div className="agreement-obligation-grid">
        {form.model === 'do_and_invoice' && <label className="is-wide"><span>Standing authority limit per job, excl. GST (optional)</span><input inputMode="decimal" value={form.standingAuthorityLimit} aria-describedby="commercial-limit-help" onChange={(event) => setForm({ ...form, standingAuthorityLimit: event.target.value })} placeholder="No limit" /><small id="commercial-limit-help">The most one job may cost before R&amp;M needs the client's approval. Leave blank if the client has not set a cap.</small></label>}
        {form.model === 'fixed_price_with_extras' && <label className="is-wide"><span>Contracted work above the monthly fee</span><select value={form.feeOverrunPolicy} aria-describedby="commercial-overrun-help" onChange={(event) => setForm({ ...form, feeOverrunPolicy: asFeeOverrunPolicy(event.target.value) })}>{FEE_OVERRUN_POLICIES.map((policy) => <option key={policy} value={policy}>{FEE_OVERRUN_POLICY_LABEL[policy]}</option>)}</select><small id="commercial-overrun-help">Each contracted job draws down the monthly fee, so a fully delivered month nets to $0. Unused value is credited. Choose "Already agreed" only when the contract says work above the fee is billed.</small></label>}
        <label><span>Billing cycle</span><select value={form.billingCycle} onChange={(event) => setForm({ ...form, billingCycle: event.target.value as CommercialTermsForm['billingCycle'] })}>{BILLING_CYCLES.map((cycle) => <option key={cycle} value={cycle}>{cycleLabels[cycle]}</option>)}</select></label>
        <label><span>Payment due</span><select value={form.paymentDueMode} onChange={(event) => setForm({ ...form, paymentDueMode: event.target.value as PaymentDueMode })}><option value="day_of_next_month">On a day of the month after the work</option><option value="days_after_invoice">A number of days after the invoice date</option></select></label>
        {form.paymentDueMode === 'day_of_next_month'
          ? <label><span>Due day of the month (1 to 28)</span><input inputMode="numeric" required value={form.paymentDueDay} onChange={(event) => setForm({ ...form, paymentDueDay: event.target.value })} aria-describedby="commercial-due-help" /><small id="commercial-due-help">{/^\d{1,2}$/.test(form.paymentDueDay.trim()) && Number(form.paymentDueDay) >= 1 && Number(form.paymentDueDay) <= 28 ? `October's work is due ${ordinalDay(Number(form.paymentDueDay))} November.` : 'Enter a day from 1 to 28.'}</small></label>
          : <label><span>Payment terms (days after invoice)</span><input inputMode="numeric" required value={form.paymentTermsDays} onChange={(event) => setForm({ ...form, paymentTermsDays: event.target.value })} /></label>}
        <label><span>Invoice email (optional)</span><input type="email" maxLength={320} value={form.invoiceEmail} onChange={(event) => setForm({ ...form, invoiceEmail: event.target.value })} /></label>
        <label><span>Standing PO number (optional)</span><input maxLength={120} value={form.purchaseOrderNumber} onChange={(event) => setForm({ ...form, purchaseOrderNumber: event.target.value })} /></label>
        <p className="is-wide agreement-extra-hint" role="note">Enter every rate and limit before GST. GST (15%) is added when the invoice is created.</p>
        {RATE_FIELDS.map(({ key, label }) => <label key={key}><span>{rateLabel(key, label)} (optional)</span><input inputMode="decimal" value={form.rates[key]} onChange={(event) => setForm({ ...form, rates: { ...form.rates, [key]: event.target.value } })} /></label>)}
        <label className="is-wide"><span>Notes (optional)</span><textarea rows={3} maxLength={2000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      </div>
      {problem && <p className="agreement-extra-hint" role="note">{problem}</p>}
      {error && <div className="agreement-obligation-message is-error" role="alert"><AlertTriangle size={15} />{error}</div>}
      <footer><button type="button" onClick={cancel} disabled={saving}>Cancel</button><button type="submit" disabled={saving || Boolean(problem)}>{saving ? 'Saving…' : 'Save billing terms'}</button></footer>
    </form>}
  </section>;
}
