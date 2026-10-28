import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, ExternalLink, FileText, Link2, Plus } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './FinanceApplyWorkspace.css';

type ApplyApplication = { id: string; akahu_application_id: string; reference: string; status: string };
type ApplySharingRequest = { id: string; application_id: string; akahu_sharing_request_id: string; link: string; expires_at: string };
type ApplyReport = { id: string; application_id: string; akahu_report_id: string; status: string; completed_at?: string | null };
type ApplyReviewTransaction = { id?: string; _id?: string; date?: string; description?: string; amount?: number; action?: string };
type ApplyReviewSummary = { account_count: number; data_source_count: number; transaction_count: number; insight_count: number; transaction_total: number; transactions: ApplyReviewTransaction[]; truncated: boolean };
type BankDestination = { id: string; bank_account_id: string; status: string; provider_name: string | null };
type ApplyOrganization = { id: string; name: string };

const financeRoles = new Set(['grand_master', 'master', 'admin', 'admin_officer']);

export function FinanceApplyWorkspace() {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(false);
  const [reference, setReference] = useState(`finance-review:${new Date().toISOString().slice(0, 7)}`);
  const [application, setApplication] = useState<ApplyApplication | null>(null);
  const [sharingRequest, setSharingRequest] = useState<ApplySharingRequest | null>(null);
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [reviewSummary, setReviewSummary] = useState<ApplyReviewSummary | null>(null);
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<string[]>([]);
  const [reviewIds, setReviewIds] = useState<Record<string, string>>({});
  const [bankDestinations, setBankDestinations] = useState<BankDestination[]>([]);
  const [applyOrganization, setApplyOrganization] = useState<ApplyOrganization | null>(null);
  const [providerNotConfigured, setProviderNotConfigured] = useState(false);
  const [connectionRequestId, setConnectionRequestId] = useState('');
  const [requestedDays, setRequestedDays] = useState(365);
  const [allowManualUploads, setAllowManualUploads] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canManage = Boolean(profile?.organizationId && financeRoles.has(profile.role));

  useEffect(() => {
    if (!profile?.organizationId) {
      setError('Organisation access could not be confirmed. Finance Apply is unavailable.');
      setLoading(false);
      return;
    }
    if (!canManage) {
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setProviderNotConfigured(false);
    void (async () => {
      const [destinationResult, providerResult] = await Promise.all([
        supabase.from('finance_external_connection_requests').select('id,bank_account_id,status,provider_name').eq('organization_id', profile.organizationId).eq('provider_type', 'bank').not('bank_account_id', 'is', null).in('status', ['connected', 'needs_review']).order('updated_at', { ascending: false }),
        supabase.functions.invoke('finance-akahu-apply-org', { body: {} }),
      ]);
      if (destinationResult.error) setError(destinationResult.error.message);
      else setBankDestinations((destinationResult.data as BankDestination[]) ?? []);
      if (!providerResult.error && !providerResult.data?.error && providerResult.data?.configured === false) {
        setApplyOrganization(null);
        setProviderNotConfigured(true);
      } else if (providerResult.error || providerResult.data?.error || !providerResult.data?.configured) {
        setApplyOrganization(null);
        setError((current) => current ?? providerResult.error?.message ?? providerResult.data?.error ?? 'Akahu Apply provider configuration could not be verified.');
      } else {
        setApplyOrganization(providerResult.data.apply_org as ApplyOrganization);
      }
      setLoading(false);
    })();
  }, [canManage, profile?.organizationId]);

  const createApplication = async () => {
    setSaving(true); setError(null); setNotice(null);
    const { data, error: invokeError } = await supabase.functions.invoke('finance-akahu-apply-application', { body: { reference: reference.trim() } });
    if (invokeError || data?.error) setError(invokeError?.message ?? data?.error ?? 'Apply application could not be prepared.');
    else { setApplication(data.application as ApplyApplication); setSharingRequest(null); setReport(null); setReviewSummary(null); setSelectedTransactionIds([]); setReviewIds({}); setNotice(data.created ? 'Apply finance case created and recorded for this organisation.' : 'Existing Apply finance case reused for this organisation.'); }
    setSaving(false);
  };

  const createSharingRequest = async () => {
    if (!application) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: invokeError } = await supabase.functions.invoke('finance-akahu-apply-sharing-request', { body: { application_id: application.id, requested_days: requestedDays, allow_manual_uploads: allowManualUploads } });
    if (invokeError || data?.error) setError(invokeError?.message ?? data?.error ?? 'Applicant sharing link could not be created.');
    else { setSharingRequest(data.sharing_request as ApplySharingRequest); setNotice('Secure applicant sharing link created. No bank credentials were collected by FCM.'); }
    setSaving(false);
  };

  const createReport = async () => {
    if (!application) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: invokeError } = await supabase.functions.invoke('finance-akahu-apply-report', { body: { action: 'create', application_id: application.id } });
    if (invokeError || data?.error) setError(invokeError?.message ?? data?.error ?? 'Apply report could not be created.');
    else { setReport(data.report as ApplyReport); setNotice('Apply report created and staged for review while Akahu processes the submitted data.'); }
    setSaving(false);
  };

  const checkReport = async () => {
    if (!application || !report) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: invokeError } = await supabase.functions.invoke('finance-akahu-apply-report', { body: { action: 'status', application_id: application.id, report_id: report.akahu_report_id } });
    if (invokeError || data?.error) setError(invokeError?.message ?? data?.error ?? 'Apply report status could not be checked.');
    else { setReport(data.report as ApplyReport); setNotice(`Apply report status: ${data.report?.status ?? 'unknown'}.`); }
    setSaving(false);
  };

  const loadReviewSummary = async () => {
    if (!application || !report) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: invokeError } = await supabase.functions.invoke('finance-akahu-apply-report', { body: { action: 'data', application_id: application.id, report_id: report.akahu_report_id } });
    if (invokeError || data?.error) setError(invokeError?.message ?? data?.error ?? 'Apply review summary could not be loaded.');
    else { setReviewSummary(data.review_summary as ApplyReviewSummary); setSelectedTransactionIds([]); setReviewIds({}); setNotice('Apply report summary loaded for human review.'); }
    setSaving(false);
  };

  const transactionId = (transaction: ApplyReviewTransaction) => transaction.id ?? transaction._id ?? '';

  const toggleTransaction = (id: string) => setSelectedTransactionIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);

  const reviewSelected = async (decision: 'approve' | 'reject') => {
    if (!report || !reviewSummary || selectedTransactionIds.length === 0) return;
    const transactions = reviewSummary.transactions.filter((transaction) => selectedTransactionIds.includes(transactionId(transaction)));
    setSaving(true); setError(null); setNotice(null);
    const { data, error: invokeError } = await supabase.functions.invoke('finance-akahu-apply-transaction-review', { body: { report_id: report.akahu_report_id, decision, transactions, reason: decision === 'approve' ? 'Reviewed in Finance Apply workspace' : 'Rejected in Finance Apply workspace' } });
    if (invokeError || data?.error) setError(invokeError?.message ?? data?.error ?? 'Transaction review could not be recorded.');
    else { const nextReviewIds = { ...reviewIds }; (data.reviews ?? []).forEach((review: { id: string; external_transaction_id: string }) => { nextReviewIds[review.external_transaction_id] = review.id; }); setReviewIds(nextReviewIds); setNotice(`${data.transaction_count ?? transactions.length} transaction(s) marked ${decision === 'approve' ? 'approved' : 'rejected'}.`); }
    setSaving(false);
  };

  const promoteSelected = async () => {
    const selectedReviewIds = selectedTransactionIds.map((id) => reviewIds[id]).filter(Boolean);
    if (!connectionRequestId || selectedReviewIds.length === 0) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: invokeError } = await supabase.functions.invoke('finance-akahu-apply-promote', { body: { connection_request_id: connectionRequestId, review_ids: selectedReviewIds } });
    if (invokeError || data?.error) setError(invokeError?.message ?? data?.error ?? 'Approved transactions could not be promoted.');
    else setNotice(`${data.promoted_count ?? selectedReviewIds.length} approved transaction(s) promoted to reconciliation review.`);
    setSaving(false);
  };

  if (!profile?.organizationId) return <section className="finance-apply-workspace" aria-labelledby="finance-apply-heading"><header><FileText size={18} /><div><p className="finance-apply-eyebrow">Statement collection</p><h2 id="finance-apply-heading">Akahu Apply</h2><p>{error ?? 'Organisation access could not be confirmed. Finance Apply is unavailable.'}</p></div></header></section>;
  if (!canManage) return <section className="finance-apply-workspace" aria-labelledby="finance-apply-heading"><header><FileText size={18} /><div><p className="finance-apply-eyebrow">Statement collection</p><h2 id="finance-apply-heading">Akahu Apply</h2><p>Finance administrator access is required to prepare an Apply case.</p></div></header></section>;
  if (loading) return <section className="finance-apply-workspace" aria-busy="true"><header><FileText size={18} /><div><p className="finance-apply-eyebrow">Statement collection</p><h2 id="finance-apply-heading">Akahu Apply case</h2><p>Loading Apply finance workspace...</p></div></header></section>;

  return <section className="finance-apply-workspace" aria-labelledby="finance-apply-heading">
    <header><FileText size={18} /><div><p className="finance-apply-eyebrow">Statement collection</p><h2 id="finance-apply-heading">Akahu Apply case</h2><p>Collect bank statements or open-banking data in a separate provider window for review. FCM never asks for bank credentials.</p></div></header>
    {applyOrganization && <p className="finance-apply-message is-success" role="status"><CheckCircle2 size={14} />Provider ready: {applyOrganization.name}</p>}
    {providerNotConfigured && <p className="finance-apply-message is-info" role="status"><CircleAlert size={14} />Akahu Apply is not connected for this platform yet. Statement collection stays off until a platform administrator provisions the provider key.</p>}
    {error && <p className="finance-apply-message is-error" role="alert"><CircleAlert size={14} />{error}</p>}
    {notice && <p className="finance-apply-message is-success" role="status"><CheckCircle2 size={14} />{notice}</p>}
    <div className="finance-apply-grid">
      <div className="finance-apply-panel"><h3>1. Prepare a finance case</h3><label><span>Case reference</span><input value={reference} maxLength={500} onChange={(event) => setReference(event.target.value)} /></label><button type="button" className="btn btn-primary" disabled={saving || !reference.trim() || !applyOrganization} onClick={() => void createApplication()}><Plus size={15} />{saving ? 'Preparing...' : 'Create or reuse case'}</button>{application && <p className="finance-apply-record"><strong>{application.reference}</strong><span>Provider case: {application.akahu_application_id}</span><span>Status: {application.status}</span></p>}</div>
      <div className="finance-apply-panel"><h3>2. Request applicant data</h3><label><span>History requested (days)</span><input type="number" min={30} max={730} value={requestedDays} onChange={(event) => setRequestedDays(Number(event.target.value))} /></label><label className="finance-apply-check"><input type="checkbox" checked={allowManualUploads} onChange={(event) => setAllowManualUploads(event.target.checked)} /><span>Allow PDF statement uploads</span></label><button type="button" className="btn btn-secondary" disabled={saving || !application} onClick={() => void createSharingRequest()}><Link2 size={15} />{saving ? 'Creating...' : 'Create secure sharing link'}</button>{sharingRequest && <div className="finance-apply-link"><strong>Applicant link ready</strong><span>Expires {new Date(sharingRequest.expires_at).toLocaleDateString()}</span><a href={sharingRequest.link} target="_blank" rel="noreferrer">Open Akahu Apply <ExternalLink size={13} /></a></div>}</div>
      <div className="finance-apply-panel"><h3>3. Stage for review</h3><p className="finance-apply-panel-copy">After the applicant submits data, ask Apply to prepare an aggregate report for review.</p><div className="finance-apply-report-actions"><button type="button" className="btn btn-secondary" disabled={saving || !application} onClick={() => void createReport()}><FileText size={15} />Create report</button><button type="button" className="btn btn-secondary" disabled={saving || !report} onClick={() => void checkReport()}>Check status</button><button type="button" className="btn btn-secondary" disabled={saving || report?.status !== 'completed'} onClick={() => void loadReviewSummary()}>Load review summary</button></div>{report && <div className="finance-apply-record"><strong>Report {report.status}</strong><span>{report.akahu_report_id}</span>{report.completed_at && <span>Completed {new Date(report.completed_at).toLocaleString()}</span>}</div>}{reviewSummary && <div className="finance-apply-review-summary"><strong>{reviewSummary.transaction_count} transactions · {reviewSummary.account_count} accounts</strong><span>{reviewSummary.data_source_count} statement source(s) · {reviewSummary.insight_count} insight(s)</span><span>Total movement: {reviewSummary.transaction_total.toLocaleString(undefined, { style: 'currency', currency: 'NZD' })}</span>{reviewSummary.truncated && <small>Preview limited to the first 50 transactions and insights.</small>}<div className="finance-apply-transaction-list">{reviewSummary.transactions.map((transaction) => { const id = transactionId(transaction); return id ? <label key={id}><input type="checkbox" checked={selectedTransactionIds.includes(id)} onChange={() => toggleTransaction(id)} /><span>{transaction.date?.slice(0, 10) ?? 'Undated'} · {transaction.description ?? 'Provider transaction'} · {Number(transaction.amount ?? 0).toLocaleString(undefined, { style: 'currency', currency: 'NZD' })}</span><strong>{reviewIds[id] ? 'Reviewed' : 'Pending'}</strong></label> : null; })}</div><div className="finance-apply-review-actions"><button type="button" className="btn btn-secondary" disabled={saving || selectedTransactionIds.length === 0} onClick={() => void reviewSelected('approve')}>Approve selected</button><button type="button" className="btn btn-secondary" disabled={saving || selectedTransactionIds.length === 0} onClick={() => void reviewSelected('reject')}>Reject selected</button><select value={connectionRequestId} onChange={(event) => setConnectionRequestId(event.target.value)} aria-label="Reconciliation bank destination"><option value="">Choose bank destination</option>{bankDestinations.map((destination) => <option key={destination.id} value={destination.id}>{destination.provider_name ?? 'Bank'} · {destination.status}</option>)}</select><button type="button" className="btn btn-primary" disabled={saving || selectedTransactionIds.length === 0 || selectedTransactionIds.some((id) => !reviewIds[id]) || !connectionRequestId} onClick={() => void promoteSelected()}>Promote to reconciliation</button></div></div>}</div>
    </div>
    <footer><strong>Review boundary</strong><span>Apply reports remain staged for human review. They do not post transactions, make payments, or submit IRD filings.</span></footer>
  </section>;
}
