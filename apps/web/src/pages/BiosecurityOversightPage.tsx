import React, { useDeferredValue, useEffect, useState, useCallback } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Image as ImageIcon, Leaf, RefreshCw, Search, ShieldCheck, UserRoundCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';
import './BiosecurityOversightPage.css';

type ReviewStatus = 'awaiting_review' | 'triaged' | 'follow_up' | 'closed';
type ReviewPriority = 'urgent' | 'high' | 'routine' | 'monitor';
type SpeciesDecision = 'pending' | 'confirmed' | 'rejected' | 'insufficient_evidence';
type ReviewAction = 'triage' | 'require_follow_up' | 'close';

interface EvidencePhoto { id: string; name: string; storage_bucket: string; storage_path: string; uploaded_at?: string; }
interface BiosecurityAssessment {
  id: string; officer_name: string | null; species_name: string | null; species_confirmed: boolean;
  confirmed_species_name: string | null; species_review_decision: SpeciesDecision; density_estimate: string | null;
  action_taken: string | null; status: string; mpi_referral_number: string | null; location_name: string | null;
  notice_number: string | null; follow_up_required: boolean; notes: string | null; scene_description: string | null;
  protected_land_address: string | null; bob_species_id: string | null; bob_confidence: number | null;
  bob_recommendation: string | null; bob_checklist: { organism_type?: string; common_name?: string | null;
    threat_level?: string; density?: string; reasoning?: string; visible_features?: string[]; manual_review_required?: boolean; } | null;
  photo_urls: EvidencePhoto[] | null; review_status: ReviewStatus; review_version: number; review_priority: ReviewPriority;
  assigned_reviewer_id: string | null; review_due_at: string | null; reviewed_at: string | null; review_notes: string | null; assessed_at: string;
}
interface Reviewer { id: string; display_name: string | null; role: string; }

const priorityOrder: Record<ReviewPriority, number> = { urgent: 0, high: 1, routine: 2, monitor: 3 };
const priorityDays: Record<ReviewPriority, number> = { urgent: 1, high: 5, routine: 14, monitor: 60 };
function dueInput(priority: ReviewPriority) { const due = new Date(Date.now() + priorityDays[priority] * 86_400_000); const local = new Date(due.getTime() - due.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }
function formatLabel(value: string) { return value.replaceAll('_', ' '); }

const BiosecurityOversightPage: React.FC = () => {
  const { profile } = useAuth();
  const [assessments, setAssessments] = useState<BiosecurityAssessment[]>([]); const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null); const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState(''); const deferredQuery = useDeferredValue(query);
  const [statusFilter, setStatusFilter] = useState<'active' | 'all' | ReviewStatus>('active');
  const [priorityFilter, setPriorityFilter] = useState<'all' | ReviewPriority>('all');
  const [reviewAction, setReviewAction] = useState<ReviewAction>('triage'); const [priority, setPriority] = useState<ReviewPriority>('routine');
  const [reviewerId, setReviewerId] = useState(''); const [reviewDueAt, setReviewDueAt] = useState(dueInput('routine'));
  const [speciesDecision, setSpeciesDecision] = useState<SpeciesDecision>('pending'); const [confirmedSpeciesName, setConfirmedSpeciesName] = useState('');
  const [reviewNotes, setReviewNotes] = useState(''); const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false); const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const orgId = profile?.organizationId; if (!orgId) return;
    try {
      setLoading(true); setError(null);
      const [assessmentResult, reviewerResult] = await Promise.all([
        supabase.from('biosecurity_assessments').select('id, officer_name, species_name, species_confirmed, confirmed_species_name, species_review_decision, density_estimate, action_taken, status, mpi_referral_number, location_name, notice_number, follow_up_required, notes, scene_description, protected_land_address, bob_species_id, bob_confidence, bob_recommendation, bob_checklist, photo_urls, review_status, review_version, review_priority, assigned_reviewer_id, review_due_at, reviewed_at, review_notes, assessed_at').eq('organization_id', orgId).order('assessed_at', { ascending: false }).limit(250),
        supabase.from('user_profiles').select('id, display_name, role').eq('organization_id', orgId).is('deactivated_at', null).in('role', ['grand_master', 'master', 'admin', 'admin_officer']).order('display_name'),
      ]);
      if (assessmentResult.error) throw assessmentResult.error; if (reviewerResult.error) throw reviewerResult.error;
      const loaded = (assessmentResult.data as BiosecurityAssessment[]) || []; setAssessments(loaded); setReviewers((reviewerResult.data as Reviewer[]) || []);
      setSelectedId((current) => current && loaded.some((item) => item.id === current) ? current : loaded[0]?.id ?? null);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Failed to load biosecurity cases'); } finally { setLoading(false); }
  }, [profile?.organizationId]);
  useEffect(() => { void load(); }, [load]);

  const selected = assessments.find((item) => item.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected) return; setPriority(selected.review_priority); setReviewerId(selected.assigned_reviewer_id ?? profile?.id ?? '');
    setReviewDueAt(selected.review_due_at ? selected.review_due_at.slice(0, 16) : dueInput(selected.review_priority)); setSpeciesDecision(selected.species_review_decision);
    setConfirmedSpeciesName(selected.confirmed_species_name ?? selected.species_name ?? selected.bob_species_id ?? ''); setReviewNotes('');
    setReviewAction(selected.review_status === 'follow_up' ? 'require_follow_up' : 'triage');
  }, [profile?.id, selected]);

  const selectedPhoto = selected?.photo_urls?.[0] ?? null;
  useEffect(() => {
    let active = true; setEvidenceUrl(null); if (!selected || !selectedPhoto) return () => { active = false; }; setEvidenceLoading(true);
    supabase.functions.invoke('get-biosecurity-evidence-url', { body: { assessment_id: selected.id, photo_id: selectedPhoto.id } })
      .then(({ data, error: evidenceError }) => { if (!active) return; if (evidenceError || !data?.signed_url) setError(evidenceError?.message ?? 'Evidence preview is unavailable'); else setEvidenceUrl(String(data.signed_url)); })
      .finally(() => { if (active) setEvidenceLoading(false); }); return () => { active = false; };
  }, [selected?.id, selectedPhoto?.id]);

  const filtered = assessments.filter((item) => statusFilter === 'all' || (statusFilter === 'active' ? item.review_status !== 'closed' : item.review_status === statusFilter))
    .filter((item) => priorityFilter === 'all' || item.review_priority === priorityFilter)
    .filter((item) => { const needle = deferredQuery.trim().toLowerCase(); return !needle || [item.species_name, item.confirmed_species_name, item.bob_species_id, item.location_name, item.officer_name].some((value) => value?.toLowerCase().includes(needle)); })
    .sort((left, right) => priorityOrder[left.review_priority] - priorityOrder[right.review_priority] || (left.review_due_at ?? '9999').localeCompare(right.review_due_at ?? '9999'));
  const openCount = assessments.filter((item) => item.review_status !== 'closed').length;
  const urgentCount = assessments.filter((item) => item.review_status !== 'closed' && item.review_priority === 'urgent').length;
  const overdueCount = assessments.filter((item) => item.review_status !== 'closed' && item.review_due_at && new Date(item.review_due_at) < new Date()).length;
  const followUpCount = assessments.filter((item) => item.review_status === 'follow_up').length;

  const chooseAction = (action: ReviewAction) => { setReviewAction(action); if (action === 'triage') setSpeciesDecision('pending'); if (action === 'require_follow_up') setSpeciesDecision('insufficient_evidence'); if (action === 'close' && !['confirmed', 'rejected'].includes(speciesDecision)) setSpeciesDecision('confirmed'); };
  const submitReview = async (event: React.FormEvent) => {
    event.preventDefault(); if (!selected || !reviewerId || !reviewNotes.trim()) return; setSaving(true); setError(null); setNotice(null);
    const { data, error: reviewError } = await supabase.rpc('manage_biosecurity_assessment_review', { p_assessment_id: selected.id, p_expected_review_version: selected.review_version, p_action: reviewAction, p_priority: priority, p_assigned_reviewer_id: reviewerId, p_review_due_at: reviewAction === 'close' ? null : new Date(reviewDueAt).toISOString(), p_species_decision: speciesDecision, p_confirmed_species_name: speciesDecision === 'confirmed' ? confirmedSpeciesName.trim() : null, p_notes: reviewNotes.trim() });
    const receipt = (data as Array<{ assessment_id: string; review_status: string; review_version: number }> | null)?.[0];
    if (reviewError || !receipt) setError(reviewError?.message ?? 'Review receipt was not confirmed.'); else { setNotice(`Biosecurity case ${formatLabel(receipt.review_status)} · version ${receipt.review_version}.`); await load(); } setSaving(false);
  };

  if (loading) return <div className="page-container"><div className="loading-state"><div className="spinner" /><p>Loading biosecurity cases...</p></div></div>;
  return <div className="page-container biosecurity-ops">
    <header className="biosecurity-ops__header"><div><span className="biosecurity-ops__eyebrow"><Leaf size={16} /> Field Operations</span><h1>Biosecurity review</h1><p>Human-governed decisions for plant and insect evidence.</p></div><button className="btn btn-secondary btn-sm" onClick={() => void load()}><RefreshCw size={16} />Refresh</button></header>
    {error && <div className="alert alert-error" role="alert"><button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">×</button>{error}</div>}{notice && <div className="alert alert-success" role="status">{notice}</div>}
    <section className="biosecurity-metrics" aria-label="Biosecurity queue summary"><div><ShieldCheck /><strong>{openCount}</strong><span>Active cases</span></div><div><AlertTriangle /><strong>{urgentCount}</strong><span>Urgent</span></div><div><Clock3 /><strong>{overdueCount}</strong><span>Overdue</span></div><div><RefreshCw /><strong>{followUpCount}</strong><span>Follow-up</span></div></section>
    <div className="biosecurity-workspace">
      <aside className="biosecurity-queue" aria-label="Assessment queue"><div className="biosecurity-queue__tools"><label className="biosecurity-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search cases" aria-label="Search cases" /></label><div className="biosecurity-filters"><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} aria-label="Review status"><option value="active">Active</option><option value="all">All statuses</option><option value="awaiting_review">Awaiting review</option><option value="triaged">Triaged</option><option value="follow_up">Follow-up</option><option value="closed">Closed</option></select><select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as typeof priorityFilter)} aria-label="Priority"><option value="all">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="routine">Routine</option><option value="monitor">Monitor</option></select></div></div><div className="biosecurity-queue__count">{filtered.length} cases</div>
        <div className="biosecurity-queue__list">{filtered.map((item) => { const overdue = item.review_status !== 'closed' && item.review_due_at && new Date(item.review_due_at) < new Date(); return <button key={item.id} className={`biosecurity-case-row ${selectedId === item.id ? 'is-selected' : ''}`} onClick={() => setSelectedId(item.id)}><span className={`biosecurity-priority is-${item.review_priority}`}>{item.review_priority}</span><strong>{item.confirmed_species_name || item.species_name || item.bob_checklist?.common_name || 'Unidentified organism'}</strong><span>{item.location_name || 'Location not supplied'} · {item.officer_name || 'Officer unknown'}</span><small className={overdue ? 'is-overdue' : ''}>{formatLabel(item.review_status)}{item.review_due_at ? ` · due ${new Date(item.review_due_at).toLocaleDateString('en-NZ')}` : ''}</small></button>; })}{filtered.length === 0 && <div className="empty-state"><p>No cases match these filters.</p></div>}</div>
      </aside>
      <main className="biosecurity-case">{!selected ? <div className="empty-state"><Leaf size={28} /><p>Select a case to review.</p></div> : <>
        <header className="biosecurity-case__title"><div><span className={`biosecurity-priority is-${selected.review_priority}`}>{selected.review_priority}</span><h2>{selected.confirmed_species_name || selected.species_name || selected.bob_checklist?.common_name || 'Unidentified organism'}</h2><p>{selected.location_name || 'No observed location'} · {new Date(selected.assessed_at).toLocaleString('en-NZ')}</p></div><span className={`status-badge status-${selected.review_status}`}>{formatLabel(selected.review_status)}</span></header>
        <div className="biosecurity-evidence-grid"><section className="biosecurity-evidence" aria-labelledby="biosecurity-evidence-title"><h3 id="biosecurity-evidence-title"><ImageIcon size={18} /> Field evidence</h3><div className="biosecurity-photo">{evidenceLoading ? <div className="loading-state"><div className="spinner" /><span>Opening private evidence...</span></div> : evidenceUrl ? <img src={evidenceUrl} alt={`Biosecurity evidence for ${selected.location_name || 'assessment'}`} /> : <div className="biosecurity-photo__empty"><ImageIcon /><span>No photo evidence</span></div>}</div><dl><div><dt>Officer</dt><dd>{selected.officer_name || 'Unknown'}</dd></div><div><dt>Density</dt><dd>{selected.density_estimate ? formatLabel(selected.density_estimate) : 'Not recorded'}</dd></div><div><dt>Protected land</dt><dd>{selected.protected_land_address || 'Not recorded'}</dd></div><div><dt>Field action</dt><dd>{selected.action_taken ? formatLabel(selected.action_taken) : 'None recorded'}</dd></div></dl>{selected.scene_description && <p>{selected.scene_description}</p>}{selected.notes && <p className="biosecurity-note">Officer note: {selected.notes}</p>}</section>
          <section className="biosecurity-advisory" aria-labelledby="biosecurity-advisory-title"><h3 id="biosecurity-advisory-title"><ShieldCheck size={18} /> AI advisory</h3>{selected.bob_checklist ? <><div className="biosecurity-advisory__identity"><strong>{selected.bob_checklist.common_name || selected.bob_species_id || 'Identification uncertain'}</strong><span>{selected.bob_species_id || 'No scientific name'} · {selected.bob_checklist.organism_type || 'unknown'}</span></div><div className="biosecurity-confidence"><span style={{ width: `${Math.round((selected.bob_confidence ?? 0) * 100)}%` }} /><strong>{Math.round((selected.bob_confidence ?? 0) * 100)}%</strong></div><dl><div><dt>Threat</dt><dd>{formatLabel(selected.bob_checklist.threat_level || 'unknown')}</dd></div><div><dt>AI density</dt><dd>{formatLabel(selected.bob_checklist.density || 'not assessable')}</dd></div><div><dt>Review</dt><dd>{selected.bob_checklist.manual_review_required ? 'Specialist review required' : 'Standard human review'}</dd></div></dl>{selected.bob_recommendation && <p>{selected.bob_recommendation}</p>}{selected.bob_checklist.reasoning && <p className="biosecurity-note">{selected.bob_checklist.reasoning}</p>}</> : <p>No AI advisory was recorded. Review the field evidence directly.</p>}<div className="biosecurity-advisory__warning"><AlertTriangle size={16} />Advisory only. A named human reviewer owns the species decision.</div></section></div>
        <form className="biosecurity-decision" onSubmit={submitReview}><header><div><span>Governed decision</span><h3><UserRoundCheck size={18} /> Review case</h3></div><small>Version {selected.review_version}</small></header><div className="biosecurity-action-tabs" role="group" aria-label="Review action"><button type="button" className={reviewAction === 'triage' ? 'is-active' : ''} onClick={() => chooseAction('triage')}>Triage</button><button type="button" className={reviewAction === 'require_follow_up' ? 'is-active' : ''} onClick={() => chooseAction('require_follow_up')}>Request evidence</button><button type="button" className={reviewAction === 'close' ? 'is-active' : ''} onClick={() => chooseAction('close')}>Record decision</button></div><div className="form-row"><label className="form-group"><span>Priority</span><select value={priority} onChange={(event) => { const next = event.target.value as ReviewPriority; setPriority(next); setReviewDueAt(dueInput(next)); }}><option value="urgent">Urgent · 2 days</option><option value="high">High · 7 days</option><option value="routine">Routine · 30 days</option><option value="monitor">Monitor · 90 days</option></select></label><label className="form-group"><span>Assigned reviewer</span><select required value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}><option value="">Select reviewer</option>{reviewers.map((reviewer) => <option key={reviewer.id} value={reviewer.id}>{reviewer.display_name || reviewer.role}</option>)}</select></label></div>{reviewAction !== 'close' && <label className="form-group"><span>Review due</span><input required type="datetime-local" value={reviewDueAt} onChange={(event) => setReviewDueAt(event.target.value)} /></label>}{reviewAction === 'close' && <><div className="biosecurity-decision-options" role="group" aria-label="Species decision"><button type="button" className={speciesDecision === 'confirmed' ? 'is-active' : ''} onClick={() => setSpeciesDecision('confirmed')}><CheckCircle2 size={16} />Confirm species</button><button type="button" className={speciesDecision === 'rejected' ? 'is-active' : ''} onClick={() => setSpeciesDecision('rejected')}>Reject identification</button></div>{speciesDecision === 'confirmed' && <label className="form-group"><span>Confirmed species</span><input required value={confirmedSpeciesName} onChange={(event) => setConfirmedSpeciesName(event.target.value)} placeholder="Scientific or accepted common name" /></label>}</>}<label className="form-group"><span>Decision rationale</span><textarea required minLength={10} rows={4} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} placeholder="Evidence considered, conclusion, and required next step" /></label>{selected.review_notes && <p className="biosecurity-previous-decision"><strong>Previous review:</strong> {selected.review_notes}{selected.reviewed_at ? ` · ${new Date(selected.reviewed_at).toLocaleString('en-NZ')}` : ''}</p>}<footer><span>Expected-state checked, attributed, audited, and returned to the officer.</span><button className="btn btn-primary" disabled={saving || !reviewerId || reviewNotes.trim().length < 10}>{saving ? 'Recording...' : reviewAction === 'close' ? 'Record decision' : reviewAction === 'require_follow_up' ? 'Request evidence' : 'Save triage'}</button></footer></form>
      </>}</main>
    </div>
  </div>;
};
export default BiosecurityOversightPage;
