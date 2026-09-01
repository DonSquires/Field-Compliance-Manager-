/**
 * NoiseControlOversightPage.tsx (Admin field-ops sub-area: 'noise-control')
 *
 * Canonical schema: noise_assessments, org-wide oversight — distinct from
 * OfficerNoiseControlPage which is the officer's own submission view.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface NoiseAssessment {
  id: string;
  officer_name: string | null;
  decibel_reading: number | null;
  noise_source: string | null;
  prior_notice_count: number;
  action_taken: string | null;
  matrix_total: number | null;
  assessed_at: string;
}

const NoiseControlOversightPage: React.FC = () => {
  const { profile } = useAuth();
  const [assessments, setAssessments] = useState<NoiseAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: noise_assessments
  useEffect(() => {
    const load = async () => {
      const orgId = profile?.organizationId;
      if (!orgId) return;
      try {
        setLoading(true);
        setError(null);

        const { data, error: err } = await supabase
          .from('noise_assessments')
          .select('id, officer_name, decibel_reading, noise_source, prior_notice_count, action_taken, matrix_total, assessed_at')
          .eq('organization_id', orgId)
          .order('assessed_at', { ascending: false })
          .limit(100);

        if (err) throw err;
        setAssessments((data as NoiseAssessment[]) || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load noise assessments');
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

      <div className="reports-table-wrapper">
        <table className="reports-table">
          <thead>
            <tr>
              <th>Officer</th>
              <th>Source</th>
              <th>Decibels</th>
              <th>Prior Notices</th>
              <th>Matrix Total</th>
              <th>Action</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {assessments.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center">
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
                  <td>{a.matrix_total ?? '-'}</td>
                  <td>{a.action_taken || '-'}</td>
                  <td>{new Date(a.assessed_at).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default NoiseControlOversightPage;
