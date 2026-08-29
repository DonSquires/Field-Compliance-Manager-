/**
 * OfficerOvernightVerificationPage.tsx (Officer module: 'overnight_verification')
 *
 * Canonical schema: vehicle_overnight_sessions (evening/morning observation
 * pairing, verification_status, movement_decision). Read-only: verification
 * outcome is computed from evening/morning observation pairs, not a manual
 * officer decision — officers review status here, they don't set it.
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface OvernightSession {
  id: string;
  plate_number: string;
  overnight_date: string;
  verification_status: string;
  movement_decision: string | null;
  evidence_strength: string;
  evening_seen_at: string | null;
  morning_seen_at: string | null;
}

const OfficerOvernightVerificationPage: React.FC = () => {
  const { profile } = useAuth();
  const [sessions, setSessions] = useState<OvernightSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: vehicle_overnight_sessions
  useEffect(() => {
    const load = async () => {
      const orgId = profile?.organizationId;
      if (!orgId) return;

      try {
        setLoading(true);
        setError(null);

        const { data, error: err } = await supabase
          .from('vehicle_overnight_sessions')
          .select(
            'id, plate_number, overnight_date, verification_status, movement_decision, evidence_strength, evening_seen_at, morning_seen_at'
          )
          .eq('organization_id', orgId)
          .order('overnight_date', { ascending: false })
          .limit(50);

        if (err) throw err;
        setSessions((data as OvernightSession[]) || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load overnight sessions');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [profile?.organizationId]);

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading overnight sessions...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Overnight Verification</h1>
        <p className="subtitle">{sessions.length} recent sessions · evening/morning pairing</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="contacts-list">
        {sessions.length === 0 ? (
          <div className="empty-state">
            <p>No overnight sessions recorded.</p>
          </div>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className="contact-card">
              <div className="contact-header">
                <h3>{s.plate_number}</h3>
                <span className={`status-badge status-${s.verification_status === 'verified_overnight' ? 'active' : 'inactive'}`}>
                  {s.verification_status.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="contact-details">
                <p className="contact-meta">
                  {new Date(s.overnight_date).toLocaleDateString()} · evidence: {s.evidence_strength}
                  {s.movement_decision ? ` · ${s.movement_decision}` : ''}
                </p>
                <p className="contact-meta">
                  Evening: {s.evening_seen_at ? new Date(s.evening_seen_at).toLocaleTimeString() : 'not seen'} · Morning:{' '}
                  {s.morning_seen_at ? new Date(s.morning_seen_at).toLocaleTimeString() : 'not seen'}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerOvernightVerificationPage;
