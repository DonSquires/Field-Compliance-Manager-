import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, RefreshCw, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { dayWords, localToday } from '../lib/agreementTerm';
import { extraWorkOrderState, extraWorkOrderStateLabels, type ExtraWorkOrder } from '../lib/extraWorkOrders';
import './CrmAgreementObligationsPanel.css';
import './CrmAgreementExtraWorksPanel.css';

type AuthorityKind = ExtraWorkOrder['authority_kind'];

interface OrderForm {
  title: string;
  scope: string;
  authorityKind: AuthorityKind;
  authorityReference: string;
  chargeCode: string;
  rateNote: string;
  startsOn: string;
  endsOn: string;
  reviewOn: string;
}

interface AgreementTerm { starts_on: string | null; ends_on: string | null; provider_organization_id: string }
interface ChargeCode { code: string; name: string | null }

const authorityLabels: Record<AuthorityKind, string> = {
  written: 'Written request (email or letter)',
  purchase_order: 'Purchase order',
  verbal: 'Verbal instruction',
  standing_instruction: 'Standing instruction',
};

const blankForm = (): OrderForm => ({
  title: '', scope: '', authorityKind: 'written', authorityReference: '', chargeCode: '', rateNote: '',
  startsOn: localToday(), endsOn: '', reviewOn: '',
});

export function CrmAgreementExtraWorksPanel({ agreementId }: { agreementId: string }) {
  const [orders, setOrders] = useState<ExtraWorkOrder[]>([]);
  const [term, setTerm] = useState<AgreementTerm | null>(null);
  const [chargeCodes, setChargeCodes] = useState<ChargeCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ExtraWorkOrder | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<OrderForm>(blankForm);
  const [endingId, setEndingId] = useState<string | null>(null);
  const [endOn, setEndOn] = useState(localToday());
  const [endReason, setEndReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [ordersResult, termResult] = await Promise.all([
      supabase.from('agreement_extra_work_orders')
        .select('id, reference, title, scope, authority_kind, authority_reference, charge_code, rate_note, starts_on, ends_on, review_on, end_reason, updated_at')
        .eq('service_agreement_id', agreementId)
        .order('starts_on', { ascending: false }),
      supabase.from('service_agreements').select('starts_on, ends_on, provider_organization_id').eq('id', agreementId).maybeSingle(),
    ]);
    if (ordersResult.error || termResult.error) {
      setLoadError(ordersResult.error?.message ?? termResult.error?.message ?? 'Extra works could not be loaded.');
    } else {
      setOrders((ordersResult.data ?? []) as ExtraWorkOrder[]);
      const agreementTerm = termResult.data as AgreementTerm | null;
      setTerm(agreementTerm);
      if (agreementTerm) {
        const { data: codes } = await supabase.from('reference_codes')
          .select('code, name')
          .eq('organization_id', agreementTerm.provider_organization_id)
          .eq('code_type', 'charge_code')
          .eq('is_active', true)
          .order('code');
        setChargeCodes((codes ?? []) as ChargeCode[]);
      }
    }
    setLoading(false);
  }, [agreementId]);

  useEffect(() => { void load(); }, [load]);

  const today = localToday();
  const dateOrder = (from: string, to: string) => !from || !to || from <= to;
  const formProblem =
    form.title.trim().length < 3 ? 'Give the Extra work a short title.'
      : form.scope.trim().length < 10 ? 'Describe what the client asked for that is outside the contract.'
        : form.authorityKind === 'verbal' && !form.authorityReference.trim() ? 'Note who gave the verbal instruction and when.'
          : !form.startsOn ? 'Give the start date.'
            : term?.starts_on && form.startsOn < term.starts_on ? `The agreement starts ${dayWords(term.starts_on)}.`
              : !dateOrder(form.startsOn, form.endsOn) ? 'The end date must be on or after the start date.'
                : term?.ends_on && form.endsOn && form.endsOn > term.ends_on ? `The agreement ends ${dayWords(term.ends_on)}.`
                  : form.reviewOn && (form.reviewOn < form.startsOn || (form.endsOn && form.reviewOn > form.endsOn)) ? 'The review date must fall inside the term.'
                    : null;

  const resetMessages = () => { setError(null); setNotice(null); };

  const startCreate = () => {
    resetMessages();
    setEditing(null);
    setForm(blankForm());
    setEndingId(null);
    setShowForm(true);
    requestId.current = crypto.randomUUID();
  };

  const startEdit = (order: ExtraWorkOrder) => {
    resetMessages();
    setEditing(order);
    setForm({
      title: order.title, scope: order.scope, authorityKind: order.authority_kind,
      authorityReference: order.authority_reference ?? '', chargeCode: order.charge_code ?? '', rateNote: order.rate_note ?? '',
      startsOn: order.starts_on, endsOn: order.ends_on ?? '', reviewOn: order.review_on ?? '',
    });
    setEndingId(null);
    setShowForm(true);
    requestId.current = crypto.randomUUID();
  };

  const closeForm = () => { setShowForm(false); setEditing(null); requestId.current = crypto.randomUUID(); };

  const command = (action: 'create' | 'update' | 'end', order: ExtraWorkOrder | null, values: Partial<Record<string, unknown>>) =>
    supabase.rpc('manage_agreement_extra_work_order', {
      p_client_request_id: action === 'end' ? crypto.randomUUID() : requestId.current,
      p_agreement_id: agreementId,
      p_action: action,
      p_order_id: order?.id ?? null,
      p_expected_updated_at: order?.updated_at ?? null,
      p_title: null, p_scope: null, p_authority_kind: null, p_authority_reference: null, p_charge_code: null,
      p_rate_note: null, p_starts_on: null, p_ends_on: null, p_review_on: null, p_reason: null,
      ...values,
    });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (formProblem) return;
    setSaving(true);
    resetMessages();
    const { data, error: saveError } = await command(editing ? 'update' : 'create', editing, {
      p_title: form.title.trim(), p_scope: form.scope.trim(), p_authority_kind: form.authorityKind,
      p_authority_reference: form.authorityReference.trim() || null, p_charge_code: form.chargeCode.trim() || null,
      p_rate_note: form.rateNote.trim() || null, p_starts_on: form.startsOn, p_ends_on: form.endsOn || null, p_review_on: form.reviewOn || null,
    });
    if (saveError) setError(saveError.message);
    else {
      const reference = (data as { reference?: string } | null)?.reference ?? 'Extra works order';
      await load();
      setNotice(editing ? `${reference} updated with an audit receipt.` : `${reference} authorised. Dispatch can now bill jobs against it.`);
      closeForm();
    }
    setSaving(false);
  };

  const endOrder = async (order: ExtraWorkOrder) => {
    setSaving(true);
    resetMessages();
    const { error: endError } = await command('end', order, { p_ends_on: endOn, p_reason: endReason.trim() });
    if (endError) setError(endError.message);
    else {
      await load();
      setNotice(`${order.reference} ended. Jobs already billed under it keep their link.`);
      setEndingId(null);
      setEndReason('');
    }
    setSaving(false);
  };

  return <section className="agreement-obligations agreement-extra-works" aria-labelledby="agreement-extra-works-title">
    <div className="agreement-section-heading">
      <div>
        <h3 id="agreement-extra-works-title">Extra works</h3>
        <p>Temporary or ongoing work the client asked for outside the contracted scope. It is billed as Extra on top of the contract price.</p>
      </div>
      {!showForm && !loadError && <button type="button" onClick={startCreate} disabled={loading}><Plus size={15} />Authorise Extra work</button>}
    </div>
    <div className="agreement-obligation-boundary">
      <strong>Not a variation</strong>
      <span>An Extra works order does not change the contract, its covered places or its monthly price. When the work becomes permanent, vary the agreement instead and end this order.</span>
    </div>
    {error && <div className="agreement-obligation-message is-error" role="alert"><AlertTriangle size={15} />{error}</div>}
    {notice && <div className="agreement-obligation-message is-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
    {loadError && <div className="agreement-obligation-message is-error" role="alert"><AlertTriangle size={15} />{loadError}<button type="button" className="agreement-extra-retry" onClick={() => void load()}>Retry</button></div>}
    {loading && !orders.length && !loadError && <div className="agreement-setup-loading"><RefreshCw size={18} className="is-spinning" />Loading Extra works</div>}

    {showForm && <form className="agreement-obligation-form" onSubmit={save} aria-describedby="extra-works-form-help">
      <header><div><strong>{editing ? `Edit ${editing.reference}` : 'Authorise Extra work'}</strong><span id="extra-works-form-help">Record what the client asked for, how they authorised it, and how long it runs. Dispatch jobs can then be billed against it.</span></div><button type="button" onClick={closeForm} aria-label="Cancel Extra works editing"><X size={16} /></button></header>
      <div className="agreement-obligation-grid">
        <label className="is-wide"><span>Title</span><input required maxLength={160} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Hunter weekend lock access" /></label>
        <label className="is-wide"><span>What the client asked for</span><textarea required rows={3} maxLength={4000} value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })} placeholder="Remove gate locks on Friday and refit them on Monday for permit hunters." /></label>
        <label><span>How it was authorised</span><select value={form.authorityKind} onChange={(event) => setForm({ ...form, authorityKind: event.target.value as AuthorityKind })}>{Object.entries(authorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>{form.authorityKind === 'verbal' ? 'Who authorised it, and when (required)' : form.authorityKind === 'purchase_order' ? 'PO number' : 'Reference (optional)'}</span><input required={form.authorityKind === 'verbal'} maxLength={200} value={form.authorityReference} onChange={(event) => setForm({ ...form, authorityReference: event.target.value })} /></label>
        <label><span>Default charge code (optional)</span><input list="extra-works-charge-codes" maxLength={40} value={form.chargeCode} onChange={(event) => setForm({ ...form, chargeCode: event.target.value })} placeholder={chargeCodes.length ? 'Search the catalog' : 'No catalog codes'} /><datalist id="extra-works-charge-codes">{chargeCodes.map((code) => <option key={code.code} value={code.code}>{code.name ?? code.code}</option>)}</datalist></label>
        <label><span>Rate note (optional)</span><input maxLength={500} value={form.rateNote} onChange={(event) => setForm({ ...form, rateNote: event.target.value })} placeholder="Hourly rate plus km" /></label>
        <label><span>Starts</span><input type="date" required value={form.startsOn} min={term?.starts_on ?? undefined} max={term?.ends_on ?? undefined} onChange={(event) => setForm({ ...form, startsOn: event.target.value })} /></label>
        <label><span>Last day (blank = until ended)</span><input type="date" value={form.endsOn} min={form.startsOn || undefined} max={term?.ends_on ?? undefined} onChange={(event) => setForm({ ...form, endsOn: event.target.value })} /></label>
        <label><span>Review with client on (optional)</span><input type="date" value={form.reviewOn} min={form.startsOn || undefined} max={form.endsOn || term?.ends_on || undefined} onChange={(event) => setForm({ ...form, reviewOn: event.target.value })} /></label>
      </div>
      {formProblem && <p className="agreement-extra-hint" role="note">{formProblem}</p>}
      <footer><button type="button" onClick={closeForm}>Cancel</button><button type="submit" disabled={saving || Boolean(formProblem)}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Authorise'}</button></footer>
    </form>}

    {!showForm && !loading && !loadError && orders.length === 0 && <div className="agreement-setup-empty">No Extra work is authorised on this agreement. Dispatch can still mark one-off jobs as Extra; add an order here when the client asks for repeating or ongoing work outside the contract.</div>}
    {!showForm && orders.length > 0 && <div className="agreement-obligation-list">{orders.map((order) => {
      const state = extraWorkOrderState(order, today);
      const closed = state === 'ended' || state === 'cancelled';
      const termWords = order.ends_on && !closed ? `${dayWords(order.starts_on)} to ${dayWords(order.ends_on)}` : closed ? `Ended ${dayWords(order.ends_on as string)}` : `From ${dayWords(order.starts_on)}, until ended`;
      return <article key={order.id} className={closed ? 'is-inactive' : ''} aria-label={`${order.reference} ${extraWorkOrderStateLabels[state]}`}>
        <div><span>{order.reference} · {authorityLabels[order.authority_kind]}{order.authority_reference ? ` ${order.authority_reference}` : ''}</span><strong>{order.title}</strong><p>{order.scope}</p><small>{termWords}{order.charge_code ? ` · code ${order.charge_code}` : ''}{order.rate_note ? ` · ${order.rate_note}` : ''}{order.review_on && !closed ? ` · review ${dayWords(order.review_on)}` : ''}{order.end_reason ? ` · ${order.end_reason}` : ''}</small></div>
        <span className={`agreement-obligation-state agreement-extra-state is-${state}`}>{extraWorkOrderStateLabels[state]}</span>
        {!closed && <div className="agreement-obligation-actions">
          <button type="button" disabled={saving} onClick={() => startEdit(order)}>Edit</button>
          {endingId === order.id ? null : <button type="button" className="is-danger" disabled={saving} onClick={() => { resetMessages(); setEndingId(order.id); setEndOn(today < order.starts_on ? order.starts_on : today); setEndReason(''); }}>End</button>}
        </div>}
        {endingId === order.id && <div className="agreement-extra-end" role="group" aria-label={`End ${order.reference}`}>
          <label><span>Last day of the Extra work</span><input type="date" value={endOn} min={(() => { const d = new Date(`${order.starts_on}T00:00:00`); d.setDate(d.getDate() - 1); return localToday(d); })()} onChange={(event) => setEndOn(event.target.value)} /></label>
          <label><span>Why it is ending</span><input maxLength={500} value={endReason} onChange={(event) => setEndReason(event.target.value)} placeholder="Hunting season closed" /></label>
          <small>{endOn && endOn < order.starts_on ? 'Ending before it starts cancels the order.' : 'Jobs after this day can no longer be billed under this order.'}</small>
          <div className="agreement-obligation-actions"><button type="button" className="is-danger" disabled={saving || endReason.trim().length < 3 || !endOn} onClick={() => void endOrder(order)}>{saving ? 'Ending…' : 'Confirm end'}</button><button type="button" disabled={saving} onClick={() => setEndingId(null)}>Cancel</button></div>
        </div>}
      </article>;
    })}</div>}
  </section>;
}
