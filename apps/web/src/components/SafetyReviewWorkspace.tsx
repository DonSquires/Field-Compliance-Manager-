import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import type { TaskRiskAssessment } from './DynamicRiskAssessment';
import './PlaceHazardRegister.css';

type Option = { id: string; name: string; summary?: string | null };
interface ReviewHazard { id: string; title: string; version: number; controls: string[]; control_levels: Record<string, string>; risk_owner_id: string | null; review_due: string | null; location_id: string }
interface SafetyReview { id: string; location_id: string | null; title: string; status: string; outcome: string | null; created_at: string; field_report_id: string | null; incident_id: string | null; assessment: TaskRiskAssessment | null; investigation_id: string | null; source_description?: string | null }
interface Workspace { owners: Option[]; hazards: ReviewHazard[]; reviews: SafetyReview[]; incidents: Option[]; investigations: Option[] }
const LEVELS: Record<string, string> = {
  elimination: 'Elimination', substitution: 'Substitution', isolation: 'Isolation', engineering: 'Engineering',
  administrative: 'Administrative', ppe: 'Personal protective equipment',
};

export function SafetyReviewWorkspace({ organizationId, locationId = null, refreshKey = 0, onChanged }: {
  organizationId: string; locationId?: string | null; refreshKey?: number; onChanged?: () => void;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [risk, setRisk] = useState<{ hazard: ReviewHazard; owner: string; due: string; levels: Record<string, string>; notes: string } | null>(null);
  const [review, setReview] = useState<{ item: SafetyReview; outcome: string; hazard: string; investigation: string } | null>(null);
  const [incidentId, setIncidentId] = useState('');
  const scope = `${organizationId}:${locationId}`;
  const active = useRef(scope);
  active.current = scope;
  const load = useCallback(async () => {
    setLoading(true);
    // ATLAS READS: get_safety_review_workspace
    const { data, error: failure } = await supabase.rpc('get_safety_review_workspace', { p_organization_id: organizationId, p_location_id: locationId });
    if (active.current !== scope) return;
    if (failure || !data || !Array.isArray(data.reviews) || !Array.isArray(data.hazards)
      || !Array.isArray(data.owners) || !Array.isArray(data.incidents) || !Array.isArray(data.investigations)) {
      setError(failure?.message ?? 'Safety review workspace was not returned.');
    } else { setWorkspace(data as Workspace); setError(null); }
    setLoading(false);
  }, [organizationId, locationId, scope]);
  useEffect(() => { setWorkspace(null); setRisk(null); setReview(null); setNotice(null); setError(null); void load(); }, [load, refreshKey]);
  useEffect(() => { setBusy(false); setIncidentId(''); }, [scope]);
  const write = async (name: string, args: Record<string, unknown>, message: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const { data, error: failure } = await supabase.rpc(name, args);
      if (failure || !data) throw new Error(failure?.message ?? 'The safety action was not confirmed.');
      if (active.current !== scope) return;
      setNotice(message); setReview(null); setRisk(null); setIncidentId('');
      await load(); onChanged?.();
    } catch (cause) { if (active.current === scope) setError(cause instanceof Error ? cause.message : 'Safety action failed.'); }
    finally { if (active.current === scope) setBusy(false); }
  };
  const saveRisk = (e: FormEvent) => {
    e.preventDefault(); if (!risk) return;
    // ATLAS WRITES: review_place_hazard
    void write('review_place_hazard', { p_hazard_id: risk.hazard.id, p_expected_version: risk.hazard.version, p_owner_id: risk.owner || null,
      p_control_levels: risk.levels, p_review_due: risk.due, p_notes: risk.notes }, 'Risk review recorded. Officers will be asked to confirm the updated briefing.');
  };
  const closeReview = (e: FormEvent) => {
    e.preventDefault(); if (!review) return;
    // ATLAS WRITES: complete_safety_review
    void write('complete_safety_review', { p_review_id: review.item.id, p_outcome: review.outcome, p_hazard_id: review.hazard || null,
      p_investigation_id: review.investigation || null }, 'Review closed with findings and links preserved. An unsafe assessment remains unsafe evidence.');
  };

  return <section className="safety-review-workspace" aria-label="Safety reviews and risk ownership">
    <details>
      <summary>Safety reviews and risk ownership{workspace ? ` (${workspace.reviews.filter((r) => r.status === 'open').length} open reviews)` : ''}</summary>
      <p>Review officer assessments and H&S reports; record findings, corrective action, the responsible person and control hierarchy. Completing a review does not approve unsafe work.</p>
      <button type="button" className="btn btn-sm btn-secondary" disabled={loading || busy} onClick={() => void load()}>Refresh safety reviews</button>
      {loading && <p role="status">Loading safety reviews...</p>}
      {error && <p role="alert" className="place-hazard-message is-error">{error}</p>}
      {notice && <p role="status" className="place-hazard-message is-success">{notice}</p>}
      {workspace && <>
        <h4>Hazard review owners and controls</h4>
        {!workspace.hazards.length && <p>No live hazards in this scope. Add a hazard above or ask Bob to propose one from the source evidence.</p>}
        {workspace.hazards.map((h) => <div key={h.id} className="safety-review-row">
          <strong>{h.title}</strong><span>Owner: {workspace.owners.find((o) => o.id === h.risk_owner_id)?.name ?? (h.risk_owner_id ? 'Inactive or unavailable staff member' : 'Not assigned')} | Next review: {h.review_due ?? 'Not scheduled'}</span>
          <small>{h.controls.filter((c) => h.control_levels[c]).length}/{h.controls.length} controls classified</small>
          <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => setRisk({ hazard: h, owner: h.risk_owner_id ?? '', due: h.review_due ?? '', levels: h.control_levels, notes: '' })}>Review owner and controls</button>
        </div>)}
        {risk && <form className="place-hazard-form" onSubmit={saveRisk}>
          <h4>Review: {risk.hazard.title}</h4>
          <label>Risk owner<select value={risk.owner} onChange={(e) => setRisk({ ...risk, owner: e.target.value })}><option value="">Unassigned - administrator remains responsible</option>{workspace.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
          {risk.hazard.controls.map((c) => <label key={c}>{c}<select value={risk.levels[c] ?? ''} onChange={(e) => {
            const levels = { ...risk.levels }; if (e.target.value) levels[c] = e.target.value; else delete levels[c]; setRisk({ ...risk, levels });
          }}><option value="">Not classified</option>{Object.entries(LEVELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>)}
          <label>Next review date<input required type="date" value={risk.due} onChange={(e) => setRisk({ ...risk, due: e.target.value })} /></label>
          <label>Review findings<textarea required minLength={10} maxLength={4000} value={risk.notes} onChange={(e) => setRisk({ ...risk, notes: e.target.value })} /></label>
          <div className="place-hazard-form-actions"><button type="button" disabled={busy} onClick={() => setRisk(null)}>Cancel risk review</button><button type="submit" disabled={busy}>Record risk review</button></div>
        </form>}
        <h4>Officer evidence requiring H&S review</h4>
        {!workspace.reviews.length && <p>No safety reviews in this scope.</p>}
        {workspace.reviews.map((r) => <article key={r.id} className="safety-review-row">
          <strong>{r.title}</strong><span>{r.status} | {new Date(r.created_at).toLocaleString('en-NZ')}{!r.location_id ? ' | Place not resolved - review source evidence' : ''}</span>
          {r.assessment && <><p>{r.assessment.task}: {r.assessment.hazards}</p><p>{r.assessment.decision === 'stop_work' ? 'STOP WORK - officer marked the task unsafe' : 'Officer proposes proceeding with controls'} | Score {r.assessment.likelihood * r.assessment.consequence}/25</p><ul>{r.assessment.controls.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
          {r.field_report_id && <small>Source: field report {r.field_report_id} (read the officer account in the report queue below).</small>}
          {r.incident_id && <small>Source: incident {r.incident_id}. Link the original evidence to an investigation when needed.</small>}
          {r.source_description && <details><summary>Read original source account</summary><p>{r.source_description}</p></details>}
          {r.outcome && <p>Recorded findings: {r.outcome}</p>}
          {r.investigation_id && <a href={`/admin/investigations?id=${r.investigation_id}`}>Open linked investigation</a>}
          {r.status === 'open' && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => setReview({ item: r, outcome: '', hazard: '', investigation: '' })}>Record corrective action</button>}
        </article>)}
        {review && <form className="place-hazard-form" onSubmit={closeReview}>
          <h4>Complete: {review.item.title}</h4>
          <label>Findings, corrective action and closure reason<textarea required minLength={10} maxLength={4000} value={review.outcome} onChange={(e) => setReview({ ...review, outcome: e.target.value })} /></label>
          <label>Related place hazard<select value={review.hazard} onChange={(e) => setReview({ ...review, hazard: e.target.value })}><option value="">No hazard link</option>{workspace.hazards.filter((h) => h.location_id === review.item.location_id).map((h) => <option key={h.id} value={h.id}>{h.title}</option>)}</select></label>
          <label>Existing investigation<select value={review.investigation} onChange={(e) => setReview({ ...review, investigation: e.target.value })}><option value="">No investigation link</option>{workspace.investigations.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
          <p>Create an investigation through the existing report/investigation workflow if further investigation is needed; then link it here.</p>
          <div className="place-hazard-form-actions"><button type="button" disabled={busy} onClick={() => setReview(null)}>Cancel corrective action</button><button type="submit" disabled={busy}>Complete safety review</button></div>
        </form>}
        <form className="place-hazard-form" onSubmit={(e) => {
          e.preventDefault();
          // ATLAS WRITES: open_incident_safety_review
          void write('open_incident_safety_review', { p_incident_id: incidentId }, 'Incident linked to the H&S review queue.');
        }}>
          <label>Link another incident to H&S review<select required value={incidentId} onChange={(e) => setIncidentId(e.target.value)}><option value="">Choose an incident after reviewing its evidence</option>{workspace.incidents.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
          {incidentId && <p>Source account: {workspace.incidents.find((i) => i.id === incidentId)?.summary ?? 'No narrative recorded. Review the incident evidence before opening an H&S review.'}</p>}
          <button type="submit" disabled={busy || !incidentId}>Open incident safety review</button>
        </form>
      </>}
    </details>
  </section>;
}
