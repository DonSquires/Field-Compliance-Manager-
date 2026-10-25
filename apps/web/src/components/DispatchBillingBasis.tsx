import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { localToday } from '../lib/agreementTerm';
import { extraWorkOrderInForce, type ExtraWorkOrder } from '../lib/extraWorkOrders';

export type BillingBasis = 'contract' | 'extra';
export type BillingChoice = BillingBasis | 'unset';
/** '' = the dispatcher has not chosen yet. There is deliberately no default: regular security work is Contract, so assuming Extra would overcharge. */
export type BillingFormChoice = BillingChoice | '';

export const billingChoiceHelp = (choice: BillingFormChoice) => {
  if (choice === 'extra') return 'Charged on top of the contract price.';
  if (choice === 'contract') return 'Covered by the agreement; not charged separately.';
  if (choice === 'unset') return 'The job will show "Billing not set" until someone classifies it.';
  return 'Regular security work (patrols, gate open/close, lock checks and replacement) is contracted work. Choose Extra only for work outside the agreement.';
};

export interface JobBillingState {
  billingBasis: BillingBasis | null;
  extraWorkOrderId: string | null;
}

type OrderSummary = Pick<ExtraWorkOrder, 'id' | 'reference' | 'title' | 'starts_on' | 'ends_on'>;

// ATLAS READS: agreement_extra_work_orders (provider admins; RLS is_admin_for_org)
export function useExtraWorkOrders(agreementId: string | null | undefined) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!agreementId) { setOrders([]); return; }
    const { data, error: loadError } = await supabase.from('agreement_extra_work_orders')
      .select('id, reference, title, starts_on, ends_on')
      .eq('service_agreement_id', agreementId)
      .order('reference');
    setError(loadError?.message ?? null);
    setOrders((data ?? []) as OrderSummary[]);
  }, [agreementId]);
  useEffect(() => { void load(); }, [load]);
  return { orders, error };
}

export const billingBasisWords = (job: JobBillingState, orders: OrderSummary[] = []) => {
  if (!job.billingBasis) return 'Billing not set';
  if (job.billingBasis === 'contract') return 'Contracted work';
  const order = orders.find((candidate) => candidate.id === job.extraWorkOrderId);
  return order ? `Extra · ${order.reference}` : 'Extra';
};

export function BillingBasisChip({ job }: { job: JobBillingState }) {
  const tone = job.billingBasis ?? 'unset';
  return <span className={`dispatch-billing-chip is-${tone}`}>{job.billingBasis === 'extra' ? 'Extra' : job.billingBasis === 'contract' ? 'Contract' : 'Billing not set'}</span>;
}

/** Basis and optional Extra works order. Used by the create form and the job detail dialog. */
export function BillingBasisFields({ idPrefix, choice, orderId, orders, day, onChange }: {
  idPrefix: string;
  choice: BillingFormChoice;
  orderId: string;
  orders: OrderSummary[];
  day: string;
  onChange: (next: { choice: BillingFormChoice; orderId: string }) => void;
}) {
  const inForce = orders.filter((order) => extraWorkOrderInForce(order, day));
  return <>
    <div className="dispatch-console-form-field">
      <label className="dispatch-console-form-label" htmlFor={`${idPrefix}-basis`}>Billing</label>
      <select id={`${idPrefix}-basis`} required value={choice} aria-invalid={choice === '' ? true : undefined} onChange={(event) => onChange({ choice: event.target.value as BillingFormChoice, orderId: event.target.value === 'extra' ? orderId : '' })} aria-describedby={`${idPrefix}-basis-help`}>
        <option value="" disabled>Choose billing…</option>
        <option value="contract">Contracted work (in the monthly price)</option>
        <option value="extra">Extra (outside the contract)</option>
        <option value="unset">Decide later</option>
      </select>
      <div id={`${idPrefix}-basis-help`} className="dispatch-console-form-note">{billingChoiceHelp(choice)}</div>
    </div>
    {choice === 'extra' && <div className="dispatch-console-form-field">
      <label className="dispatch-console-form-label" htmlFor={`${idPrefix}-order`}>Extra works order</label>
      <select id={`${idPrefix}-order`} value={orderId} onChange={(event) => onChange({ choice, orderId: event.target.value })}>
        <option value="">One-off Extra job</option>
        {inForce.map((order) => <option key={order.id} value={order.id}>{order.reference} · {order.title}</option>)}
      </select>
      {!inForce.length && <div className="dispatch-console-form-note">No Extra works order is in force on this agreement. Repeating Extra work is authorised under Client Portfolios → agreement → Extra works.</div>}
    </div>}
  </>;
}

// ATLAS WRITES: set_dispatch_job_billing_basis (audited; refuses invoiced jobs)
export const saveJobBillingBasis = (jobId: string, choice: BillingBasis, orderId: string, reason: string | null) =>
  supabase.rpc('set_dispatch_job_billing_basis', {
    p_job_id: jobId,
    p_billing_basis: choice,
    p_extra_work_order_id: choice === 'extra' && orderId ? orderId : null,
    p_reason: reason,
  });

/** Job detail: shows the classification and lets a dispatcher set or change it, with a reason for changes. */
export function DispatchJobBillingPanel({ job, onSaved }: {
  job: JobBillingState & { id: string; serviceAgreementId: string | null; createdAt: string };
  onSaved: (message: string) => Promise<void> | void;
}) {
  const { orders, error: ordersError } = useExtraWorkOrders(job.serviceAgreementId);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<BillingFormChoice>(job.billingBasis ?? '');
  const [orderId, setOrderId] = useState(job.extraWorkOrderId ?? '');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const day = localToday(new Date(job.createdAt));
  const reclassifying = job.billingBasis !== null;
  const unchanged = choice === job.billingBasis && (orderId || null) === job.extraWorkOrderId;

  useEffect(() => { setChoice(job.billingBasis ?? ''); setOrderId(job.extraWorkOrderId ?? ''); setEditing(false); setReason(''); setError(null); }, [job.id, job.billingBasis, job.extraWorkOrderId]);

  const save = async () => {
    if (choice !== 'contract' && choice !== 'extra') return;
    setSaving(true);
    setError(null);
    const { error: saveError } = await saveJobBillingBasis(job.id, choice, orderId, reclassifying ? reason.trim() : null);
    if (saveError) setError(saveError.message);
    else { setEditing(false); await onSaved(`Billing set to ${choice === 'extra' ? 'Extra' : 'contracted work'}. The change is in the audit log.`); }
    setSaving(false);
  };

  return <section className="dispatch-job-dialog-detail dispatch-billing-panel" aria-labelledby={`billing-${job.id}`}>
    <h3 id={`billing-${job.id}`}>Billing</h3>
    {!editing ? <p><BillingBasisChip job={job} /> {billingBasisWords(job, orders)} <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(true)}>{job.billingBasis ? 'Change' : 'Set billing'}</button></p> : <>
      <BillingBasisFields idPrefix={`job-${job.id}`} choice={choice} orderId={orderId} orders={orders} day={day} onChange={(next) => { setChoice(next.choice); setOrderId(next.orderId); }} />
      {reclassifying && <div className="dispatch-console-form-field">
        <label className="dispatch-console-form-label" htmlFor={`job-${job.id}-reason`}>Why is the billing changing?</label>
        <input id={`job-${job.id}-reason`} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>}
      {ordersError && <div className="dispatch-console-inline-warning" role="status">Extra works orders could not be loaded: {ordersError}</div>}
      {error && <div className="dispatch-console-inline-error" role="alert">{error}</div>}
      <div className="dispatch-console-form-actions">
        <button type="button" className="dispatch-console-primary-button" disabled={saving || (choice !== 'contract' && choice !== 'extra') || unchanged || (reclassifying && reason.trim().length < 3)} onClick={() => void save()}>{saving ? 'Saving…' : 'Save billing'}</button>
        <button type="button" className="dispatch-console-secondary-button" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </>}
  </section>;
}
