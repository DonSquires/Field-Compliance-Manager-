import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText, FolderPlus, RefreshCw, Search, ShieldCheck, UserRound, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './FieldReportsPage.css';

interface FieldReport {
  id: string;
  officer_id: string;
  report_type: string;
  severity: string;
  status: string;
  title: string;
  description: string;
  location_name: string | null;
  address: string | null;
  immediate_action: string | null;
  follow_up_required: boolean;
  follow_up_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  reported_at: string;
}

type StatusFilter = 'all' | 'submitted' | 'reviewed' | 'closed';

const FieldReportsPage: React.FC = () => {
  const { profile, operatingOrganizationId } = useAuth();
  const navigate = useNavigate();
  const [reports, setReports] = useState<FieldReport[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('submitted');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewNotes, setReviewNotes] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [investigationForm, setInvestigationForm] = useState<{ reference: string; title: string; type: string; priority: string; summary: string } | null>(null);
  const [investigationSaving, setInvestigationSaving] = useState(false);

  const loadReports = useCallback(async () => {
    const organizationId = operatingOrganizationId ?? profile?.organizationId;
    if (!organizationId) {
      setLoading(false);
      setError('Report review is unavailable until organisation access is confirmed.');
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: reportError } = await supabase
      .from('officer_field_reports')
      .select('id, officer_id, report_type, severity, status, title, description, location_name, address, immediate_action, follow_up_required, follow_up_notes, reviewed_by, reviewed_at, review_notes, reported_at')
      .eq('organization_id', organizationId)
      .order('reported_at', { ascending: false });
    if (reportError) {
      setError(reportError.message);
      setLoading(false);
      return;
    }
    const rows = (data as FieldReport[]) ?? [];
    setReports(rows);
    setSelectedId((current) => current && rows.some((report) => report.id === current) ? current : rows[0]?.id ?? null);
    const userIds = Array.from(new Set(rows.flatMap((report) => [report.officer_id, report.reviewed_by].filter(Boolean) as string[])));
    if (userIds.length > 0) {
      const { data: users, error: userError } = await supabase.from('user_profiles').select('id, display_name, email').in('id', userIds);
      if (userError) setError(`Reports loaded, but user names are unavailable: ${userError.message}`);
      else setNames(Object.fromEntries((users ?? []).map((user: { id: string; display_name: string | null; email: string | null }) => [user.id, user.display_name || user.email || user.id])));
    }
    setLoading(false);
  }, [operatingOrganizationId, profile?.organizationId]);

  useEffect(() => { void loadReports(); }, [loadReports]);

  const visibleReports = useMemo(() => {
    const term = search.trim().toLowerCase();
    return reports.filter((report) => {
      const matchesFilter = filter === 'all' || report.status === filter;
      const matchesSearch = !term || [report.title, report.description, report.report_type, report.severity, names[report.officer_id]].some((value) => value?.toLowerCase().includes(term));
      return matchesFilter && matchesSearch;
    });
  }, [filter, names, reports, search]);

  const selected = reports.find((report) => report.id === selectedId) ?? null;
  const submittedCount = reports.filter((report) => report.status === 'submitted').length;
  const criticalCount = reports.filter((report) => report.status === 'submitted' && report.severity === 'critical').length;

  const submitReview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !reviewNotes.trim()) return;
    setBusyId(selected.id);
    setError(null);
    setNotice(null);
    const { data, error: reviewError } = await supabase.rpc('review_officer_field_report', {
      p_report_id: selected.id,
      p_expected_status: selected.status,
      p_review_notes: reviewNotes.trim(),
    });
    if (reviewError || !data) {
      setError(reviewError?.message ?? 'The report review was not confirmed. Refresh and check its current state.');
    } else {
      setReviewing(false);
      setReviewNotes('');
      setNotice('Review recorded with supervisor notes and audit provenance.');
      await loadReports();
    }
    setBusyId(null);
  };

  const createInvestigationFromReport = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !investigationForm) return;
    const organizationId = operatingOrganizationId ?? profile?.organizationId;
    if (!organizationId) return;
    setInvestigationSaving(true);
    setError(null);
    const { data: investigation, error: createError } = await supabase.rpc('create_investigation', {
      p_organization_id: organizationId,
      p_client_request_id: crypto.randomUUID(),
      p_reference: investigationForm.reference.trim(),
      p_title: investigationForm.title.trim(),
      p_investigation_type: investigationForm.type,
      p_priority: investigationForm.priority,
      p_summary: investigationForm.summary.trim() || null,
      p_lead_user_id: null,
    });
    if (createError || !investigation) {
      setError(createError?.message ?? 'Investigation was not confirmed.');
      setInvestigationSaving(false);
      return;
    }
    const investigationId = (investigation as { id: string }).id;
    const { error: linkError } = await supabase.rpc('link_investigation_entity', {
      p_investigation_id: investigationId,
      p_entity_type: 'field_report',
      p_entity_id: selected.id,
      p_link_role: 'primary',
      p_link_reason: 'Investigation opened from field report review',
    });
    if (linkError) {
      setError(`Investigation created but report link failed: ${linkError.message}`);
    } else {
      setNotice(`Investigation ${investigationForm.reference.trim()} created and linked to this report.`);
      navigate(`/admin/investigations?id=${investigationId}`);
      setInvestigationForm(null);
    }
    setInvestigationSaving(false);
  };

  return (
    <div className="field-reports-page">
      <header className="field-reports-header">
        <div><span>Field operations / Reports</span><h1>Field report review</h1><p>Triage officer submissions, inspect operational context, and record governed review decisions.</p></div>
        <button type="button" onClick={() => void loadReports()} disabled={loading}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} />Refresh</button>
      </header>
      <section className="field-reports-summary" aria-label="Report workload"><div className={criticalCount > 0 ? 'is-critical' : ''}><AlertTriangle size={18} /><span>Critical submitted</span><strong>{criticalCount}</strong></div><div><FileText size={18} /><span>Awaiting review</span><strong>{submittedCount}</strong></div><div><ShieldCheck size={18} /><span>Total records</span><strong>{reports.length}</strong></div></section>
      {error && <div className="field-reports-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" className="btn-secondary" onClick={() => void loadReports()} disabled={loading}>Try again</button><button type="button" onClick={() => setError(null)} title="Dismiss"><X size={16} /></button></div>}
      {notice && <div className="field-reports-message is-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)} title="Dismiss"><X size={16} /></button></div>}
      <div className="field-reports-toolbar">
        <label><Search size={16} /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search reports or officers" /></label>
        <div role="tablist" aria-label="Report status">{(['submitted', 'reviewed', 'closed', 'all'] as StatusFilter[]).map((status) => <button type="button" role="tab" aria-selected={filter === status} className={filter === status ? 'is-active' : ''} onClick={() => setFilter(status)} key={status}>{status}</button>)}</div>
      </div>
      <div className="field-reports-layout">
        <section className="field-reports-queue">
          <div className="field-reports-panel-heading"><div><span>Review queue</span><h2>{visibleReports.length} reports</h2></div></div>
          {loading ? <div className="field-reports-empty"><RefreshCw size={20} className="is-spinning" />Loading reports</div> : visibleReports.length === 0 ? <div className="field-reports-empty"><ShieldCheck size={22} />No reports match this view</div> : <div className="field-reports-list">{visibleReports.map((report) => <button type="button" className={`${selectedId === report.id ? 'is-selected' : ''} severity-${report.severity}`} onClick={() => setSelectedId(report.id)} key={report.id}><span className="field-report-mark"><FileText size={17} /></span><div><strong>{report.title}</strong><small>{names[report.officer_id] || 'Officer'} · {report.report_type.replaceAll('_', ' ')}</small></div><div><span>{report.severity}</span><time dateTime={report.reported_at}>{new Date(report.reported_at).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}</time></div></button>)}</div>}
        </section>
        <aside className="field-reports-detail">
          {!selected ? <div className="field-reports-empty"><FileText size={22} />Select a report to review</div> : <>
            <div className="field-reports-panel-heading"><div><span>{selected.report_type.replaceAll('_', ' ')}</span><h2>{selected.title}</h2></div><span className={`field-report-status status-${selected.status}`}>{selected.status}</span></div>
            <div className={`field-report-banner severity-${selected.severity}`}><AlertTriangle size={19} /><div><strong>{selected.severity} severity</strong><span>Reported {new Date(selected.reported_at).toLocaleString('en-NZ')} by {names[selected.officer_id] || 'Officer'}</span></div></div>
            <section className="field-report-description"><span>Officer account</span><p>{selected.description}</p></section>
            <dl className="field-report-facts"><div><dt>Location</dt><dd>{selected.address || selected.location_name || 'Not recorded'}</dd></div><div><dt>Follow-up</dt><dd>{selected.follow_up_required ? 'Required' : 'Not requested'}</dd></div></dl>
            {selected.immediate_action && <section className="field-report-note"><strong>Immediate action</strong><span>{selected.immediate_action}</span></section>}
            {selected.follow_up_notes && <section className="field-report-note"><strong>Follow-up context</strong><span>{selected.follow_up_notes}</span></section>}
            {selected.review_notes && <section className="field-report-review-record"><ShieldCheck size={17} /><div><strong>Supervisor review</strong><span>{selected.review_notes}</span><small>{selected.reviewed_by ? names[selected.reviewed_by] || selected.reviewed_by : 'Reviewer unavailable'}{selected.reviewed_at ? ` · ${new Date(selected.reviewed_at).toLocaleString('en-NZ')}` : ''}</small></div></section>}
            <div className="field-report-provenance"><UserRound size={15} /><span>Report ID {selected.id}</span></div>
            <div className="field-report-actions">
              <button type="button" onClick={() => setInvestigationForm({ reference: `INV-${new Date().getFullYear()}-${selected.id.slice(0, 8).toUpperCase()}`, title: selected.title, type: selected.report_type === 'incident' ? 'incident' : 'compliance', priority: selected.severity, summary: selected.follow_up_notes ?? selected.description })}><FolderPlus size={17} />Create investigation</button>
              {selected.status === 'submitted' && <button type="button" onClick={() => { setReviewNotes(''); setReviewing(true); }}><ShieldCheck size={17} />Review report</button>}
            </div>
          </>}
        </aside>
      </div>
      {reviewing && selected && <div className="field-report-dialog-backdrop"><form className="field-report-dialog" onSubmit={submitReview} role="dialog" aria-modal="true" aria-labelledby="field-report-review-title"><div className="field-reports-panel-heading"><div><span>Governed decision</span><h2 id="field-report-review-title">Review field report</h2></div><button type="button" onClick={() => setReviewing(false)} title="Close"><X size={18} /></button></div><div className="field-report-dialog-subject"><strong>{selected.title}</strong><span>{selected.severity} · {names[selected.officer_id] || 'Officer'}</span></div><p>Confirm that the report has been assessed. Record the conclusion, required escalation, or reason no further action is needed.</p><label><span>Supervisor review notes</span><textarea required rows={5} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} placeholder="Assessment, escalation, ownership, and next action" /></label><div className="field-report-dialog-actions"><button type="button" onClick={() => setReviewing(false)}>Cancel</button><button type="submit" disabled={busyId === selected.id || !reviewNotes.trim()}>{busyId === selected.id ? 'Recording review' : 'Confirm review'}</button></div></form></div>}
      {investigationForm && selected && <div className="field-report-dialog-backdrop"><form className="field-report-dialog" onSubmit={createInvestigationFromReport} role="dialog" aria-modal="true" aria-labelledby="create-investigation-title"><div className="field-reports-panel-heading"><div><span>Court matter</span><h2 id="create-investigation-title">Create investigation</h2></div><button type="button" onClick={() => setInvestigationForm(null)} title="Close"><X size={18} /></button></div><p>This creates the authoritative investigation workspace and links this report as primary evidence.</p><label><span>Investigation reference</span><input required value={investigationForm.reference} onChange={(event) => setInvestigationForm({ ...investigationForm, reference: event.target.value })} /></label><label><span>Title</span><input required value={investigationForm.title} onChange={(event) => setInvestigationForm({ ...investigationForm, title: event.target.value })} /></label><div className="officer-report-grid"><label><span>Type</span><select value={investigationForm.type} onChange={(event) => setInvestigationForm({ ...investigationForm, type: event.target.value })}><option value="incident">Incident</option><option value="compliance">Compliance</option><option value="enforcement">Enforcement</option><option value="safety">Safety</option><option value="biosecurity">Biosecurity</option><option value="noise">Noise</option><option value="smoke">Smoke</option><option value="parking">Parking</option><option value="welfare">Welfare</option><option value="other">Other</option></select></label><label><span>Priority</span><select value={investigationForm.priority} onChange={(event) => setInvestigationForm({ ...investigationForm, priority: event.target.value })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label></div><label><span>Summary</span><textarea required rows={4} value={investigationForm.summary} onChange={(event) => setInvestigationForm({ ...investigationForm, summary: event.target.value })} /></label><div className="field-report-dialog-actions"><button type="button" onClick={() => setInvestigationForm(null)}>Cancel</button><button type="submit" disabled={investigationSaving}>{investigationSaving ? 'Creating investigation' : 'Create and link report'}</button></div></form></div>}
    </div>
  );
};

export default FieldReportsPage;
