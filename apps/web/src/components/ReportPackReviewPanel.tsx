import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { FileCheck2, ShieldCheck, Sparkles } from 'lucide-react';
import { CustomReportSnapshot } from './CustomReportSnapshot';
import { ReportActivityReview } from './ReportActivityReview';
import { readActivityReport } from '../lib/reportActivity';
import { runPrivacyCheck } from '../lib/reportBob';
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
  templateName?: string | null;
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
  const template = pack.templateName?.trim() || (pack.report_kind === 'custom' ? 'Custom report' : `${pack.template_code.replaceAll('_', ' ')} report`);
  return `${template} - ${pack.period_start} to ${pack.period_end}`;
}

function numberFrom(data: Record<string, unknown> | null, key: string): string {
  const value = data?.[key];
  return typeof value === 'number' ? String(value) : '0';
}

const SLA_TILES: Array<[string, string]> = [['SLA met', 'slaMet'], ['SLA breached', 'slaBreached'], ['SLA in progress', 'slaRunning']];

/**
 * Generated values shown beside the client report preview. A pack with the client site activity
 * report already shows patrols, CCTV and observations there, and its PDF has SLA figures only when
 * one is recorded, so those tiles follow the PDF. Travel distance is never shown: it is not client content.
 */
function sourceTiles(data: Record<string, unknown> | null, hasActivityReport: boolean, subjectSummary: Record<string, unknown> | null): Array<[string, string]> {
  const tiles: Array<[string, string]> = [];
  if (!hasActivityReport || SLA_TILES.some(([, key]) => numberFrom(data, key) !== '0')) {
    tiles.push(...SLA_TILES.map(([label, key]): [string, string] => [label, numberFrom(data, key)]));
  }
  if (!hasActivityReport) {
    tiles.push(['Patrol visits', numberFrom(data, 'patrolVisits')], ['Camera activations', numberFrom(data, 'cameraActivations')], ['Vehicle observations', numberFrom(data, 'vehicleObservations')]);
  }
  if (subjectSummary) {
    tiles.push(
      ['Repeat vehicles', numberFrom(subjectSummary, 'repeatVehicles')],
      ['Vehicles seen at multiple places', numberFrom(subjectSummary, 'vehiclesAtMultiplePlaces')],
      ['Supporting evidence items', numberFrom(subjectSummary, 'supportingEvidenceItems')],
      ['Records with action notes', numberFrom(subjectSummary, 'recordsWithActionNotes')],
    );
  }
  return tiles;
}

function facilitiesFrom(data: Record<string, unknown> | null): Array<{ siteName: string; expected: number; completed: number }> {
  if (!Array.isArray(data?.facilities)) return [];
  return data.facilities.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const facility = value as Record<string, unknown>;
    const expected = typeof facility.expected === 'number' ? facility.expected : 0;
    const completed = typeof facility.completed === 'number' ? facility.completed : 0;
    if (expected === 0 && completed === 0) return [];
    return [{
      siteName: typeof facility.siteName === 'string' ? facility.siteName : 'Unnamed site',
      expected,
      completed,
    }];
  });
}

function subjectSummaryFrom(data: Record<string, unknown> | null): Record<string, unknown> | null {
  const value = data?.subjectSummary;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

interface EditorialFields { title: string; executiveSummary: string; clientNotes: string; followUp: string }

function editorialFields(pack: ReviewableReportPack): EditorialFields {
  return {
    title: pack.editorial?.title ?? defaultTitle(pack),
    executiveSummary: pack.editorial?.executive_summary ?? '',
    clientNotes: pack.editorial?.client_notes ?? '',
    followUp: pack.editorial?.follow_up ?? '',
  };
}

function sameFields(a: EditorialFields, b: EditorialFields): boolean {
  return a.title === b.title && a.executiveSummary === b.executiveSummary && a.clientNotes === b.clientNotes && a.followUp === b.followUp;
}

export function ReportPackReviewPanel({ pack, onClose, onSaved }: ReportPackReviewPanelProps) {
  const [title, setTitle] = useState(pack.editorial?.title ?? defaultTitle(pack));
  const [executiveSummary, setExecutiveSummary] = useState(pack.editorial?.executive_summary ?? '');
  const [clientNotes, setClientNotes] = useState(pack.editorial?.client_notes ?? '');
  const [followUp, setFollowUp] = useState(pack.editorial?.follow_up ?? '');
  const [savingAction, setSavingAction] = useState<'save' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const subjectSummary = subjectSummaryFrom(pack.data);
  const facilities = facilitiesFrom(pack.data);
  const hasActivityReport = pack.report_kind === 'monthly' && readActivityReport(pack.data) !== null;
  const tiles = pack.report_kind === 'custom' ? [] : sourceTiles(pack.data, hasActivityReport, subjectSummary);
  const canDraftSummary = hasActivityReport && pack.status !== 'sent';
  const [drafting, setDrafting] = useState(false);
  const [draftStatus, setDraftStatus] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const currentPackId = useRef(pack.id);
  const autoDrafted = useRef<string | null>(null);
  const summaryText = useRef(executiveSummary);
  summaryText.current = executiveSummary;

  const savedFields = editorialFields(pack);
  const loaded = useRef({ packId: pack.id, fields: savedFields });
  const edits = useRef(savedFields);
  edits.current = { title, executiveSummary, clientNotes, followUp };
  const [staleNotice, setStaleNotice] = useState(false);

  // Background reloads hand the panel a fresh pack object; only reset the form when a different
  // pack is opened, or when the saved review changed and the reviewer has no unsaved edits.
  useEffect(() => {
    const previous = loaded.current;
    if (previous.packId === pack.id && sameFields(previous.fields, savedFields)) return;
    const unsaved = previous.packId === pack.id && !sameFields(previous.fields, edits.current);
    loaded.current = { packId: pack.id, fields: savedFields };
    if (unsaved) {
      setStaleNotice(true);
      return;
    }
    setTitle(savedFields.title);
    setExecutiveSummary(savedFields.executiveSummary);
    setClientNotes(savedFields.clientNotes);
    setFollowUp(savedFields.followUp);
    setStaleNotice(false);
    setError(null);
  }, [pack.id, savedFields.title, savedFields.executiveSummary, savedFields.clientNotes, savedFields.followUp]);

  useEffect(() => {
    currentPackId.current = pack.id;
    setDraftStatus(null);
    setDraftError(null);
  }, [pack.id]);

  /** Bob's draft fills the box only; nothing is saved until the reviewer saves or publishes. */
  const draftSummary = useCallback(async (mode: 'auto' | 'manual') => {
    const packId = pack.id;
    setDrafting(true);
    setDraftError(null);
    setDraftStatus('Bob is drafting the executive summary from this report\'s recorded entries...');
    const { data, error: draftFailure } = await supabase.functions.invoke('draft-report-executive-summary', { body: { pack_id: packId } });
    if (currentPackId.current !== packId) return;
    setDrafting(false);
    const summary = typeof data?.summary === 'string' ? data.summary : '';
    if (draftFailure || !summary) {
      setDraftStatus(null);
      setDraftError(`Bob could not draft the summary${draftFailure?.message ? ` (${draftFailure.message})` : ''}. Write it yourself or try again.`);
      return;
    }
    if (mode === 'auto' && summaryText.current.trim()) {
      setDraftStatus(null);
      return;
    }
    setExecutiveSummary(summary);
    setDraftStatus('Bob drafted this summary from the report\'s recorded entries. Check and edit it; it is not saved until you save the draft or publish.');
  }, [pack.id]);

  useEffect(() => {
    if (!canDraftSummary || (pack.editorial?.executive_summary ?? '').trim() || autoDrafted.current === pack.id) return;
    autoDrafted.current = pack.id;
    void draftSummary('auto');
  }, [canDraftSummary, draftSummary, pack.editorial?.executive_summary, pack.id]);

  const redraftSummary = () => {
    if (executiveSummary.trim() && !window.confirm('Replace the current executive summary with a new draft from Bob?')) return;
    void draftSummary('manual');
  };

  const submit = async (action: 'save' | 'publish') => {
    if (action === 'publish' && !title.trim()) {
      setError('Add a client-facing report title before publishing.');
      return;
    }
    setSavingAction(action);
    setError(null);
    let wording = { title, executive_summary: executiveSummary, client_notes: clientNotes, follow_up: followUp };
    let expectedUpdatedAt = pack.updated_at;
    let withheldNote = '';
    // Everything the client reads passes Bob's privacy oracle first; the PDF and email refuse unchecked wording.
    if (action === 'publish' && pack.report_kind === 'monthly') {
      const privacy = await runPrivacyCheck(pack.id, { editorial: wording });
      if (!privacy.cleared || !privacy.editorial) {
        setError(privacy.error
          ? `Bob's privacy check could not finish (${privacy.error}). The report was not published; try again.`
          : `Bob still has ${privacy.remaining === 1 ? '1 entry' : `${privacy.remaining} entries`} to check for personal names. Publish again to continue.`);
        setSavingAction(null);
        return;
      }
      wording = privacy.editorial;
      if (privacy.updatedAt) expectedUpdatedAt = privacy.updatedAt;
      if (privacy.reworded > 0) withheldNote = ` Bob withheld personal names or contact details in ${privacy.reworded === 1 ? '1 place' : `${privacy.reworded} places`}.`;
    }
    const { data, error: reviewError } = await supabase.rpc('review_monthly_report_pack', {
      p_pack_id: pack.id,
      p_expected_updated_at: expectedUpdatedAt,
      p_title: wording.title,
      p_executive_summary: wording.executive_summary,
      p_client_notes: wording.client_notes,
      p_follow_up: wording.follow_up,
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
    await onSaved(message + withheldNote);
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
      {staleNotice && <div className="alert alert-warning" role="status">This report's saved review changed while you were editing. Your unsaved wording is kept; saving it will replace the newer saved version.</div>}

      {pack.report_kind === 'monthly' && <ReportActivityReview key={`${pack.id}:${pack.updated_at}`} packId={pack.id} updatedAt={pack.updated_at} data={pack.data} status={pack.status} summary={executiveSummary} highlights={clientNotes} />}
      {pack.report_kind === 'custom' ? (
        <CustomReportSnapshot data={pack.data} reportScope={pack.report_scope} idPrefix={`report-${pack.id}`} />
      ) : tiles.length > 0 && (
        <div className="report-review-source" aria-label="Generated source metrics">
          {tiles.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
        </div>
      )}
      {pack.report_kind === 'monthly' && facilities.length > 0 && (
        <div className="report-review-sites">
          <h4>Site coverage</h4>
          <div className="reports-table-wrapper" role="region" aria-label="Site coverage table" tabIndex={0}>
            <table className="reports-table">
              <thead><tr><th>Site</th><th>Planned activities</th><th>Completed activities</th></tr></thead>
              <tbody>{facilities.map((facility, index) => <tr key={`${facility.siteName}-${index}`}><td>{facility.siteName}</td><td>{facility.expected}</td><td>{facility.completed}</td></tr>)}</tbody>
            </table>
          </div>
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
        <div className="report-review-summary-field">
          <div className="report-review-summary-head">
            <label htmlFor={`executive-summary-${pack.id}`}>Executive summary</label>
            {canDraftSummary && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={redraftSummary} disabled={drafting || savingAction !== null}>
                <Sparkles size={14} aria-hidden="true" /> {drafting ? 'Drafting...' : executiveSummary.trim() ? 'Redraft with Bob' : 'Draft with Bob'}
              </button>
            )}
          </div>
          <textarea id={`executive-summary-${pack.id}`} name="executive-summary" value={executiveSummary} onChange={(event) => setExecutiveSummary(event.target.value)} maxLength={4000} rows={8} aria-describedby={`executive-summary-help-${pack.id}`} aria-busy={drafting} />
          <small id={`executive-summary-help-${pack.id}`}>Exception-based summary for the client: significant breaches and infrastructure issues, pest control and trends against the previous two months. Use **bold**, a line that is wholly **bold** for a heading, and "- " for bullets. {executiveSummary.length}/4000 characters</small>
          <p className="report-review-draft-status" aria-live="polite">{draftStatus}</p>
          {draftError && <p className="report-review-draft-error" role="alert">{draftError}</p>}
        </div>
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