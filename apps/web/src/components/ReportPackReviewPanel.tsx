import { useEffect, useState, type FormEvent } from 'react';
import { FileCheck2, ShieldCheck } from 'lucide-react';
import { CustomReportSnapshot } from './CustomReportSnapshot';
import { supabase } from '../lib/supabase';
import './ReportPackReviewPanel.css';

export interface ReportPackEditorial {
  title?: string;
  executive_summary?: string;
  client_notes?: string;
  follow_up?: string;
}

export interface ReviewableReportPack {
  id: string;
  template_code: string;
  report_kind: 'monthly' | 'custom';
  report_scope: Record<string, unknown>;
  period_start: string;
  period_end: string;
  status: string;
  data: Record<string, unknown> | null;
  editorial: ReportPackEditorial | null;
  updated_at: string;
  reviewed_at: string | null;
  published_at: string | null;
  delivery_channel: 'portal' | 'email' | null;
  agreementName: string;
}

interface ReviewResult {
  status: string;
  delivery_channel: 'portal' | 'email' | null;
  client_has_login: boolean;
}

interface ReportPackReviewPanelProps {
  pack: ReviewableReportPack;
  onClose: () => void;
  onSaved: (message: string) => Promise<void> | void;
}

function defaultTitle(pack: ReviewableReportPack): string {
  const template = pack.template_code.replaceAll('_', ' ');
  return `${template} report - ${pack.period_start} to ${pack.period_end}`;
}

function numberFrom(data: Record<string, unknown> | null, key: string): string {
  const value = data?.[key];
  return typeof value === 'number' ? String(value) : '0';
}

function subjectSummaryFrom(data: Record<string, unknown> | null): Record<string, unknown> | null {
  const value = data?.subjectSummary;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function ReportPackReviewPanel({ pack, onClose, onSaved }: ReportPackReviewPanelProps) {
  const [title, setTitle] = useState(pack.editorial?.title ?? defaultTitle(pack));
  const [executiveSummary, setExecutiveSummary] = useState(pack.editorial?.executive_summary ?? '');
  const [clientNotes, setClientNotes] = useState(pack.editorial?.client_notes ?? '');
  const [followUp, setFollowUp] = useState(pack.editorial?.follow_up ?? '');
  const [savingAction, setSavingAction] = useState<'save' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const subjectSummary = subjectSummaryFrom(pack.data);

  useEffect(() => {
    setTitle(pack.editorial?.title ?? defaultTitle(pack));
    setExecutiveSummary(pack.editorial?.executive_summary ?? '');
    setClientNotes(pack.editorial?.client_notes ?? '');
    setFollowUp(pack.editorial?.follow_up ?? '');
    setError(null);
  }, [pack]);

  const submit = async (action: 'save' | 'publish') => {
    if (action === 'publish' && !title.trim()) {
      setError('Add a client-facing report title before publishing.');
      return;
    }
    setSavingAction(action);
    setError(null);
    const { data, error: reviewError } = await supabase.rpc('review_monthly_report_pack', {
      p_pack_id: pack.id,
      p_expected_updated_at: pack.updated_at,
      p_title: title,
      p_executive_summary: executiveSummary,
      p_client_notes: clientNotes,
      p_follow_up: followUp,
      p_action: action,
    });
    if (reviewError || !data) {
      setError(reviewError?.message ?? 'The report review was not saved.');
      setSavingAction(null);
      return;
    }
    const result = data as unknown as ReviewResult;
    let message = `Draft review saved for ${pack.agreementName}.`;
    if (action === 'publish') {
      message = result.delivery_channel === 'portal'
        ? `Reviewed report published to ${pack.agreementName}'s live client portal.`
        : `Reviewed report approved for email delivery to ${pack.agreementName}.`;
    }
    await onSaved(message);
    setSavingAction(null);
  };

  const saveDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit('save');
  };

  return (
    <section className="report-review-panel" aria-labelledby={`report-review-${pack.id}`}>
      <header className="report-review-heading">
        <div>
          <span className="report-review-kicker"><FileCheck2 size={16} aria-hidden="true" /> Provider review</span>
          <h3 id={`report-review-${pack.id}`}>{pack.agreementName}</h3>
          <p>{pack.period_start} to {pack.period_end}</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
      </header>

      {pack.status === 'generated' && (
        <p className="report-review-warning"><ShieldCheck size={17} aria-hidden="true" /> Saving changes returns this live report to draft until it is published again.</p>
      )}
      {error && <div className="alert alert-error" role="alert">{error}</div>}

      {pack.report_kind === 'custom' ? (
        <CustomReportSnapshot data={pack.data} reportScope={pack.report_scope} idPrefix={`report-${pack.id}`} />
      ) : (
        <div className="report-review-source" aria-label="Generated source metrics">
          <div><span>SLA met</span><strong>{numberFrom(pack.data, 'slaMet')}</strong></div>
          <div><span>SLA breached</span><strong>{numberFrom(pack.data, 'slaBreached')}</strong></div>
          <div><span>Incidents</span><strong>{numberFrom(pack.data, 'incidentsTotal')}</strong></div>
          <div><span>Checkpoint visits</span><strong>{numberFrom(pack.data, 'checkpointVisits')}</strong></div>
          <div><span>Breach alerts</span><strong>{numberFrom(pack.data, 'breachAlerts')}</strong></div>
          <div><span>Operational events</span><strong>{numberFrom(pack.data, 'operationalEvents')}</strong></div>
          <div><span>Patrol visits</span><strong>{numberFrom(pack.data, 'patrolVisits')}</strong></div>
          <div><span>Camera activations</span><strong>{numberFrom(pack.data, 'cameraActivations')}</strong></div>
          <div><span>Vehicle observations</span><strong>{numberFrom(pack.data, 'vehicleObservations')}</strong></div>
          <div><span>Patrol travel (km)</span><strong>{numberFrom(pack.data, 'patrolTravelKm')}</strong></div>
          {subjectSummary && <>
            <div><span>Repeat vehicles</span><strong>{numberFrom(subjectSummary, 'repeatVehicles')}</strong></div>
            <div><span>Vehicles seen at multiple places</span><strong>{numberFrom(subjectSummary, 'vehiclesAtMultiplePlaces')}</strong></div>
            <div><span>Supporting evidence items</span><strong>{numberFrom(subjectSummary, 'supportingEvidenceItems')}</strong></div>
            <div><span>Records with action notes</span><strong>{numberFrom(subjectSummary, 'recordsWithActionNotes')}</strong></div>
          </>}
        </div>
      )}
      {typeof subjectSummary?.clientSummary === 'string' && <p className="report-review-source-note">{subjectSummary.clientSummary}</p>}
      <p className="report-review-source-note">These values come from governed operational records and cannot be edited here.</p>

      <form className="report-review-form" onSubmit={saveDraft}>
        <label>
          <span>Client-facing title</span>
          <input name="report-title" value={title} onChange={(event) => { setTitle(event.target.value); setError(null); }} maxLength={160} required aria-describedby={`report-title-help-${pack.id}`} />
          <small id={`report-title-help-${pack.id}`}>{title.length}/160 characters</small>
        </label>
        <label>
          <span>Executive summary</span>
          <textarea name="executive-summary" value={executiveSummary} onChange={(event) => setExecutiveSummary(event.target.value)} maxLength={4000} rows={5} />
        </label>
        <label>
          <span>Client notes</span>
          <textarea name="client-notes" value={clientNotes} onChange={(event) => setClientNotes(event.target.value)} maxLength={8000} rows={5} />
        </label>
        <label>
          <span>Follow-up</span>
          <textarea name="follow-up" value={followUp} onChange={(event) => setFollowUp(event.target.value)} maxLength={4000} rows={4} />
        </label>
        <div className="report-review-actions">
          <button type="submit" className="btn btn-secondary" disabled={savingAction !== null}>{savingAction === 'save' ? 'Saving...' : 'Save draft'}</button>
          <button type="button" className="btn btn-primary" onClick={() => void submit('publish')} disabled={savingAction !== null}>{savingAction === 'publish' ? 'Publishing...' : 'Publish reviewed report'}</button>
        </div>
      </form>
    </section>
  );
}