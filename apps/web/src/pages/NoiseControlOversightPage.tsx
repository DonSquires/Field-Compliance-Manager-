/**
 * NoiseControlOversightPage.tsx (Admin field-ops sub-area: 'noise-control')
 *
 * Canonical schema: noise_assessments, org-wide oversight — distinct from
 * OfficerNoiseControlPage which is the officer's own submission view.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { supabase } from '../lib/supabase';
import { GeneratedArtifactActions } from '../components/GeneratedArtifactActions';
import './PageStyles.css';
import './NoiseControlOversightPage.css';

interface NoiseAssessment {
  id: string;
  officer_name: string | null;
  decibel_reading: number | null;
  noise_source: string | null;
  prior_notice_count: number;
  action_taken: string | null;
  assessed_at: string;
  review_status: string;
  reviewed_at: string | null;
  review_notes: string | null;
  follow_up_required: boolean;
  dispatch_job_id: string | null;
  end_number: string | null;
  end_expires_at: string | null;
  police_present: boolean | null;
  assessment_distance_to_complainant_m: number | null;
  evidence_package_url: string | null;
}

interface AttendanceReport {
  available: boolean;
  reason?: string;
  disclosure?: { custodian: boolean; harmed_party_place: boolean; complainant_identity: boolean };
  job?: { received_at: string; dispatched_at: string | null; on_scene_at: string | null; completed_at: string | null; sla_respond_by: string | null; sla_breached: boolean | null; sla_delay_reason: string | null; harmed_party_address: string | null; status: string };
  attendances?: Array<{ place_role: string; visit_number: number; arrived_at: string | null; departed_at: string | null; sla_status: string; arrival_verification: string | null; arrival_distance_m: number | null; bwc_reference_recorded: boolean }>;
  assessments?: Array<{ id: string; action_taken: string | null; matrix_total: number | null; end_number: string | null; end_expires_at: string | null; police_present: boolean | null; assessment_distance_to_complainant_m: number | null }>;
  interactions?: Array<{ party_role: string; mode: string; occurred_at: string; summary: string | null }>;
}

const REVIEW_FLAGS = (a: NoiseAssessment): string[] => {
  const flags: string[] = [];
  if (a.action_taken === 'direction_notice' && !a.dispatch_job_id) flags.push('END without a complaint job');
  if (a.action_taken === 'equipment_seized' && !a.police_present) flags.push('Seizure without Police present');
  if (a.dispatch_job_id && a.assessment_distance_to_complainant_m == null) flags.push('Assessment position not measured');
  return flags;
};

type ReviewAction = 'acknowledge' | 'require_follow_up' | 'close';

const NoiseControlOversightPage: React.FC = () => {
  const { profile } = useAuth();
  const { selectedAgreementSites } = useServiceRelationships();
  const [assessments, setAssessments] = useState<NoiseAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<NoiseAssessment | null>(null);
  const [reviewAction, setReviewAction] = useState<ReviewAction | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [generatingPackageId, setGeneratingPackageId] = useState<string | null>(null);
  const [report, setReport] = useState<{ jobId: string; data: AttendanceReport } | null>(null);
  const [loadingReportId, setLoadingReportId] = useState<string | null>(null);

  // ATLAS READS: get_noise_attendance_report (basis-scoped; never carries complainant identity)
  const openReport = async (jobId: string) => {
    setLoadingReportId(jobId); setError(null);
    const { data, error: reportError } = await supabase.rpc('get_noise_attendance_report', { p_dispatch_job_id: jobId });
    if (reportError) setError(reportError.message);
    else setReport({ jobId, data: data as AttendanceReport });
    setLoadingReportId(null);
  };

  // ATLAS READS: noise_assessments
  const load = useCallback(async () => {
      const orgId = profile?.organizationId;
      if (!orgId) {
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setError(null);

        let query = supabase
          .from('noise_assessments')
          .select('id, officer_name, decibel_reading, noise_source, prior_notice_count, action_taken, assessed_at, review_status, reviewed_at, review_notes, follow_up_required, dispatch_job_id, end_number, end_expires_at, police_present, assessment_distance_to_complainant_m, evidence_package_url')
          .eq('organization_id', orgId);
        if (selectedAgreementSites.length > 0) {
          query = query.in('site_id', selectedAgreementSites.map((site) => site.id));
        }
        const { data, error: err } = await query
          .order('assessed_at', { ascending: false })
          .limit(100);

        if (err) throw err;
        setAssessments((data as NoiseAssessment[]) || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load noise assessments');
      } finally {
        setLoading(false);
      }
  }, [profile?.organizationId, selectedAgreementSites]);

  useEffect(() => { void load(); }, [load]);

  const submitReview = async (event: React.FormEvent) => {
    event.preventDefault();if(!selected||!reviewAction||!reviewNotes.trim())return;setSaving(true);setError(null);setNotice(null);
    const {data,error:reviewError}=await supabase.rpc('manage_noise_assessment_review',{
      p_assessment_id: selected.id,
      p_expected_review_status: selected.review_status,
      p_action: reviewAction,
      p_notes: reviewNotes.trim(),
    });
    const receipt=(data as Array<{assessment_id:string;review_status:string;follow_up_required:boolean}>|null)?.[0];
    if(reviewError||!receipt)setError(reviewError?.message??'Noise review receipt was not confirmed.');else{setNotice(`Noise assessment ${receipt.review_status} · receipt ${receipt.assessment_id.slice(0,8)}.`);setSelected(null);setReviewAction(null);setReviewNotes('');await load();}setSaving(false);
  };

  const generateEvidencePackage = async (assessment: NoiseAssessment) => {
    setGeneratingPackageId(assessment.id); setError(null); setNotice(null);
    const { data, error: packageError } = await supabase.functions.invoke<{ evidence_package_url?: string }>('generate-noise-evidence-package', { body: { assessment_id: assessment.id } });
    if (packageError || !data?.evidence_package_url) setError(packageError?.message ?? 'The noise evidence package was not generated.');
    else {
      setAssessments((current) => current.map((row) => row.id === assessment.id ? { ...row, evidence_package_url: data.evidence_package_url as string } : row));
      setNotice(`Court-ready evidence package generated for ${assessment.id.slice(0, 8)}.`);
    }
    setGeneratingPackageId(null);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading noise assessments...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Noise Control</h1>
        <p className="subtitle">{assessments.length} assessments across the organisation</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}
      {notice&&<div className="alert alert-success" role="status">{notice}</div>}

      <p className="noise-assessment-scroll-cue" role="note">Scroll the assessment register horizontally to review every action and evidence field.</p>
      <div className="reports-table-wrapper noise-assessment-table" role="region" aria-label="Noise assessment review register" tabIndex={0}>
        <table className="reports-table">
          <thead>
            <tr>
              <th>Officer</th>
              <th>Source</th>
              <th>Decibels</th>
              <th>Prior Notices</th>
              <th>Action</th>
              <th>Date</th>
              <th>Review</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {assessments.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center">
                  No assessments
                </td>
              </tr>
            ) : (
              assessments.map((a) => (
                <tr key={a.id}>
                  <td>{a.officer_name || '-'}</td>
                  <td>{a.noise_source || '-'}</td>
                  <td>{a.decibel_reading ?? '-'}</td>
                  <td>{a.prior_notice_count}</td>
                  <td>{a.action_taken || '-'}{a.end_number ? ` · ${a.end_number}` : ''}{a.end_expires_at ? <small> · in force until {new Date(a.end_expires_at).toLocaleString('en-NZ')}</small> : null}{REVIEW_FLAGS(a).map((flag) => <span key={flag} className="noise-review-flag">{flag}</span>)}</td>
                  <td>{new Date(a.assessed_at).toLocaleString()}</td>
                  <td><span className={`status-badge status-${a.review_status}`}>{a.review_status.replaceAll('_',' ')}</span>{a.follow_up_required&&<small> · follow-up required</small>}</td>
                  <td><div className="noise-review-actions">{a.dispatch_job_id&&<button className="btn btn-sm btn-secondary" disabled={loadingReportId===a.dispatch_job_id} onClick={()=>void openReport(a.dispatch_job_id!)}>{loadingReportId===a.dispatch_job_id?'Loading report':'Attendance report'}</button>}{a.review_status==='open'&&<button className="btn btn-sm btn-secondary" onClick={()=>{setSelected(a);setReviewAction('acknowledge');setReviewNotes('');}}>Acknowledge</button>}{a.review_status!=='closed'&&<button className="btn btn-sm btn-secondary" onClick={()=>{setSelected(a);setReviewAction('require_follow_up');setReviewNotes('');}}>Require follow-up</button>}{a.review_status!=='closed'&&<button className="btn btn-sm btn-primary" onClick={()=>{setSelected(a);setReviewAction('close');setReviewNotes('');}}>Close review</button>}{a.review_status==='closed'&&!a.evidence_package_url&&<button className="btn btn-sm btn-primary" disabled={generatingPackageId===a.id} onClick={()=>void generateEvidencePackage(a)}>{generatingPackageId===a.id?'Generating...':'Generate evidence package'}</button>}{a.evidence_package_url&&<GeneratedArtifactActions bucket="notice-artifacts" path={a.evidence_package_url} fileName={`noise-evidence-${a.id.slice(0,8)}.pdf`} label="Evidence PDF" />}</div></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {report && (
        <section className="noise-report" aria-label="Attendance report">
          <header className="noise-report-header">
            <div><span className="noise-report-kicker">Attendance report · exactly what happened</span><h2>Complaint job {report.jobId.slice(0, 8)}</h2></div>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setReport(null)} aria-label="Close attendance report">Close</button>
          </header>
          {!report.data.available ? (
            <p>No basis to read this report ({report.data.reason ?? 'no_basis'}).</p>
          ) : (
            <>
              <p className="noise-report-disclosure">Disclosure: {report.data.disclosure?.custodian ? 'custodian (full operational record)' : report.data.disclosure?.harmed_party_place ? 'harmed-party place owner (complainant place shown, officer narrative withheld)' : 'source-side reader (complainant redacted)'} · complainant identity is never in this report.</p>
              <dl className="noise-report-grid">
                <div><dt>Received</dt><dd>{report.data.job?.received_at ? new Date(report.data.job.received_at).toLocaleString('en-NZ') : '—'}</dd></div>
                <div><dt>Dispatched</dt><dd>{report.data.job?.dispatched_at ? new Date(report.data.job.dispatched_at).toLocaleString('en-NZ') : '—'}</dd></div>
                <div><dt>Respond by</dt><dd>{report.data.job?.sla_respond_by ? new Date(report.data.job.sla_respond_by).toLocaleString('en-NZ') : 'No SLA clock'}</dd></div>
                <div><dt>On scene</dt><dd>{report.data.job?.on_scene_at ? new Date(report.data.job.on_scene_at).toLocaleString('en-NZ') : 'Not yet'}</dd></div>
                <div><dt>SLA</dt><dd>{report.data.job?.sla_breached ? `Breached · ${report.data.job.sla_delay_reason ?? 'DELAY REASON MISSING'}` : 'Met or running'}</dd></div>
                <div><dt>Complainant place</dt><dd>{report.data.job?.harmed_party_address ?? (report.data.disclosure?.harmed_party_place ? 'Not recorded' : 'Redacted for this reader')}</dd></div>
              </dl>
              <h3>Attendances</h3>
              {report.data.attendances?.length ? report.data.attendances.map((stop, index) => (
                <p key={index} className={`noise-report-row ${stop.arrival_verification && ['off_site', 'no_gps', 'unverified_boundary', 'no_geofence'].includes(stop.arrival_verification) ? 'is-flagged' : ''}`}>
                  <strong>{stop.place_role === 'work_place' ? 'Source' : 'Complainant place'}</strong> · visit {stop.visit_number} · arrived {stop.arrived_at ? new Date(stop.arrived_at).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' }) : '—'} · departed {stop.departed_at ? new Date(stop.departed_at).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' }) : '—'} · {stop.arrival_verification?.replaceAll('_', ' ') ?? 'not verified'}{stop.arrival_distance_m != null ? ` (${stop.arrival_distance_m} m)` : ''} · {stop.sla_status.replaceAll('_', ' ')}{stop.bwc_reference_recorded ? ' · BWC referenced' : ''}
                </p>
              )) : <p>No attendance recorded.</p>}
              <h3>Assessments</h3>
              {report.data.assessments?.length ? report.data.assessments.map((row) => (
                <p key={row.id} className="noise-report-row">matrix {row.matrix_total ?? '—'} · {row.action_taken?.replaceAll('_', ' ') ?? 'no action'}{row.end_number ? ` · ${row.end_number}` : ''}{row.end_expires_at ? ` · in force until ${new Date(row.end_expires_at).toLocaleString('en-NZ')}` : ''}{row.assessment_distance_to_complainant_m != null ? ` · assessed ${row.assessment_distance_to_complainant_m} m from the complainant boundary` : ''}{row.police_present ? ' · Police present' : ''}</p>
              )) : <p>No assessment recorded.</p>}
              <h3>Complainant contact</h3>
              {report.data.interactions?.length ? report.data.interactions.map((row, index) => (
                <p key={index} className="noise-report-row">{row.party_role} · {row.mode.replaceAll('_', ' ')} · {new Date(row.occurred_at).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}{row.summary ? ` · ${row.summary}` : ''}</p>
              )) : <p>No contact recorded.</p>}
            </>
          )}
        </section>
      )}
      {selected&&reviewAction&&<div className="noise-review-backdrop"><form className="noise-review-dialog" role="dialog" aria-modal="true" aria-labelledby="noise-review-title" onSubmit={submitReview}><header><div><span>Governed Noise Control decision</span><h2 id="noise-review-title">{reviewAction==='acknowledge'?'Acknowledge assessment':reviewAction==='require_follow_up'?'Require follow-up':'Close review'}</h2></div><button type="button" onClick={()=>setSelected(null)} aria-label="Close review">×</button></header><p>The decision is expected-state checked, attributed, audited, and returned to the attending officer.</p><label><span>Review notes</span><textarea rows={5} required value={reviewNotes} onChange={(event)=>setReviewNotes(event.target.value)}/></label><footer><button type="button" className="btn btn-secondary" onClick={()=>setSelected(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving||!reviewNotes.trim()}>{saving?'Saving':'Confirm review'}</button></footer></form></div>}
    </div>
  );
};

export default NoiseControlOversightPage;
