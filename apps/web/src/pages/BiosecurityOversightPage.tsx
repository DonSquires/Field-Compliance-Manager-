/**
 * BiosecurityOversightPage.tsx (Admin field-ops sub-area: 'biosecurity')
 *
 * Canonical schema: biosecurity_assessments, org-wide oversight — distinct
 * from OfficerBiosecurityPage which is the officer's own submission view.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface BiosecurityAssessment {
  id: string;
  officer_name: string | null;
  species_name: string | null;
  density_estimate: string | null;
  action_taken: string | null;
  status: string;
  mpi_referral_number: string | null;
  assessed_at: string;
}

const BiosecurityOversightPage: React.FC = () => {
  const { profile } = useAuth();
  const [assessments, setAssessments] = useState<BiosecurityAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: biosecurity_assessments
  useEffect(() => {
    const load = async () => {
      const orgId = profile?.organizationId;
      if (!orgId) return;
      try {
        setLoading(true);
        setError(null);

        const { data, error: err } = await supabase
          .from('biosecurity_assessments')
          .select('id, officer_name, species_name, density_estimate, action_taken, status, mpi_referral_number, assessed_at')
          .eq('organization_id', orgId)
          .order('assessed_at', { ascending: false })
          .limit(100);

        if (err) throw err;
        setAssessments((data as BiosecurityAssessment[]) || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load biosecurity assessments');
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
          <p>Loading biosecurity assessments...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Biosecurity</h1>
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

      <div className="contacts-list">
        {assessments.length === 0 ? (
          <div className="empty-state">
            <p>No assessments recorded yet.</p>
          </div>
        ) : (
          assessments.map((a) => (
            <div key={a.id} className="contact-card">
              <div className="contact-header">
                <h3>{a.species_name || 'Unidentified species'}</h3>
                <span className={`status-badge status-${a.status}`}>{a.status}</span>
              </div>
              <div className="contact-details">
                <p className="contact-meta">
                  {a.officer_name || 'Unknown officer'} · {a.density_estimate} · {a.action_taken} ·{' '}
                  {new Date(a.assessed_at).toLocaleString()}
                </p>
                {a.mpi_referral_number && <p className="contact-meta">MPI referral: {a.mpi_referral_number}</p>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default BiosecurityOversightPage;
