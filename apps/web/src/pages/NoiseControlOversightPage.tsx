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
}

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
          .select('id, officer_name, decibel_reading, noise_source, prior_notice_count, action_taken, assessed_at, review_status, reviewed_at, review_notes, follow_up_required')
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
    else setNotice(`Court-ready evidence package generated for ${assessment.id.slice(0, 8)}.`);
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

      <div className="reports-table-wrapper">
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
                  <td>{a.action_taken || '-'}</td>
                  <td>{new Date(a.assessed_at).toLocaleString()}</td>
                  <td><span className={`status-badge status-${a.review_status}`}>{a.review_status.replaceAll('_',' ')}</span>{a.follow_up_required&&<small> · follow-up required</small>}</td>
                  <td><div className="noise-review-actions">{a.review_status==='open'&&<button className="btn btn-sm btn-secondary" onClick={()=>{setSelected(a);setReviewAction('acknowledge');setReviewNotes('');}}>Acknowledge</button>}{a.review_status!=='closed'&&<button className="btn btn-sm btn-secondary" onClick={()=>{setSelected(a);setReviewAction('require_follow_up');setReviewNotes('');}}>Require follow-up</button>}{a.review_status!=='closed'&&<button className="btn btn-sm btn-primary" onClick={()=>{setSelected(a);setReviewAction('close');setReviewNotes('');}}>Close review</button>}{a.review_status==='closed'&&<button className="btn btn-sm btn-primary" disabled={generatingPackageId===a.id} onClick={()=>void generateEvidencePackage(a)}>{generatingPackageId===a.id?'Generating...':'Generate evidence package'}</button>}</div></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {selected&&reviewAction&&<div className="noise-review-backdrop"><form className="noise-review-dialog" role="dialog" aria-modal="true" aria-labelledby="noise-review-title" onSubmit={submitReview}><header><div><span>Governed Noise Control decision</span><h2 id="noise-review-title">{reviewAction==='acknowledge'?'Acknowledge assessment':reviewAction==='require_follow_up'?'Require follow-up':'Close review'}</h2></div><button type="button" onClick={()=>setSelected(null)} aria-label="Close review">×</button></header><p>The decision is expected-state checked, attributed, audited, and returned to the attending officer.</p><label><span>Review notes</span><textarea rows={5} required value={reviewNotes} onChange={(event)=>setReviewNotes(event.target.value)}/></label><footer><button type="button" className="btn btn-secondary" onClick={()=>setSelected(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={saving||!reviewNotes.trim()}>{saving?'Saving':'Confirm review'}</button></footer></form></div>}
    </div>
  );
};

export default NoiseControlOversightPage;
