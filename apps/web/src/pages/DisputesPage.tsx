import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type DisputeStatus = 'received' | 'under_review' | 'upheld' | 'withdrawn' | 'referred' | 'dismissed';

interface Dispute {
  id: string;
  notice_number: string | null;
  dispute_type: string | null;
  plate_number: string | null;
  notice_date: string | null;
  submitter_name: string | null;
  submitter_email: string | null;
  submitter_phone: string | null;
  grounds: string | null;
  statement: string | null;
  scv_number: string | null;
  status: DisputeStatus;
  review_notes: string | null;
  reviewed_at: string | null;
  decision_note: string | null;
  decided_at: string | null;
  submitted_at: string;
}

const STATUS_OPTIONS: Array<{ value: DisputeStatus; label: string }> = [
  { value: 'under_review', label: 'Mark Under Review' },
  { value: 'upheld', label: 'Uphold Dispute' },
  { value: 'withdrawn', label: 'Mark Withdrawn' },
  { value: 'referred', label: 'Refer' },
  { value: 'dismissed', label: 'Dismiss Dispute' },
];

const DisputesPage: React.FC = () => {
  const { profile } = useAuth();
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const organizationId = profile?.organizationId;
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    const { data, error: queryError } = await supabase
      .from('disputes')
      .select('id, notice_number, dispute_type, plate_number, notice_date, submitter_name, submitter_email, submitter_phone, grounds, statement, scv_number, status, review_notes, reviewed_at, decision_note, decided_at, submitted_at')
      .eq('organization_id', organizationId)
      .order('submitted_at', { ascending: false })
      .limit(100);
    if (queryError) setError(queryError.message);
    else setDisputes((data as Dispute[]) ?? []);
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateStatus = async (dispute: Dispute, status: DisputeStatus) => {
    if (!profile?.id) return;
    const reviewNote = notes[dispute.id]?.trim();
    if (!reviewNote) {
      setError('Review notes are required before changing a dispute status.');
      return;
    }
    setBusyId(dispute.id);
    setError(null);
    const timestamp = new Date().toISOString();
    const isFinal = ['upheld', 'withdrawn', 'referred', 'dismissed'].includes(status);
    const { error: updateError } = await supabase
      .from('disputes')
      .update({
        status,
        review_notes: reviewNote,
        reviewed_by: profile.id,
        reviewed_at: timestamp,
        ...(isFinal ? { decision_note: reviewNote, decided_by: profile.id, decided_at: timestamp } : {}),
      })
      .eq('id', dispute.id);
    if (updateError) {
      setError(updateError.message);
    } else {
      setDisputes((current) => current.map((item) => item.id === dispute.id ? {
        ...item,
        status,
        review_notes: reviewNote,
        reviewed_at: timestamp,
        ...(isFinal ? { decision_note: reviewNote, decided_at: timestamp } : {}),
      } : item));
    }
    setBusyId(null);
  };

  if (loading) {
    return <div className="page-container"><div className="loading-state"><div className="spinner" /><p>Loading disputes...</p></div></div>;
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Disputes</h1>
        <p className="subtitle">{disputes.length} notice dispute(s) across the organisation</p>
      </header>

      {error && <div className="alert alert-error" role="alert"><button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">x</button>{error}</div>}

      <div className="contacts-list">
        {disputes.length === 0 ? <div className="empty-state"><p>No disputes received.</p></div> : disputes.map((dispute) => (
          <article key={dispute.id} className="contact-card">
            <div className="contact-header">
              <h3>{dispute.notice_number ?? 'Notice number unavailable'}</h3>
              <span className="badge">{dispute.status.replaceAll('_', ' ')}</span>
            </div>
            <div className="contact-details">
              <p>{dispute.statement ?? 'No statement supplied.'}</p>
              <p className="contact-meta">{dispute.submitter_name ?? 'Unnamed submitter'}{dispute.plate_number ? ` · ${dispute.plate_number}` : ''} · submitted {new Date(dispute.submitted_at).toLocaleString()}</p>
              {dispute.grounds && <p className="contact-meta">Grounds: {dispute.grounds}</p>}
              {(dispute.submitter_email || dispute.submitter_phone) && <p className="contact-meta">{[dispute.submitter_email, dispute.submitter_phone].filter(Boolean).join(' · ')}</p>}
              {dispute.review_notes && <p className="contact-meta">Review: {dispute.review_notes}</p>}
              {['received', 'under_review'].includes(dispute.status) && (
                <>
                  <div className="form-group">
                    <label>Review notes</label>
                    <textarea rows={3} value={notes[dispute.id] ?? ''} onChange={(event) => setNotes({ ...notes, [dispute.id]: event.target.value })} placeholder="Record the evidence considered and decision rationale" />
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {STATUS_OPTIONS.filter((option) => dispute.status === 'received' || option.value !== 'under_review').map((option) => (
                      <button key={option.value} type="button" className="btn btn-secondary btn-sm" disabled={busyId === dispute.id} onClick={() => void updateStatus(dispute, option.value)}>
                        {busyId === dispute.id ? 'Saving...' : option.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
};

export default DisputesPage;
