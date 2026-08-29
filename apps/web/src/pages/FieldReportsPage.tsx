/**
 * FieldReportsPage.tsx (Admin field-ops sub-area: 'field-reports')
 *
 * Canonical schema: officer_field_reports, org-wide, with review workflow
 * (reviewed_by/reviewed_at/review_notes) — distinct from
 * OfficerFieldReportPage which is the officer's own submission view.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface FieldReport {
  id: string;
  officer_id: string;
  report_type: string;
  severity: string;
  status: string;
  title: string;
  description: string;
  follow_up_required: boolean;
  created_at: string;
}

const FieldReportsPage: React.FC = () => {
  const { profile } = useAuth();
  const [reports, setReports] = useState<FieldReport[]>([]);
  const [officerNames, setOfficerNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // ATLAS READS: officer_field_reports, user_profiles
  const loadReports = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;

    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('officer_field_reports')
        .select('id, officer_id, report_type, severity, status, title, description, follow_up_required, created_at')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });

      if (err) throw err;
      const rows = (data as FieldReport[]) || [];
      setReports(rows);

      const officerIds = Array.from(new Set(rows.map((r) => r.officer_id)));
      if (officerIds.length > 0) {
        const { data: profiles } = await supabase.from('user_profiles').select('id, display_name').in('id', officerIds);
        const names: Record<string, string> = {};
        (profiles || []).forEach((p: { id: string; display_name: string | null }) => {
          names[p.id] = p.display_name || p.id;
        });
        setOfficerNames(names);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load field reports');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const handleMarkReviewed = async (report: FieldReport) => {
    if (!profile?.id) return;
    try {
      setBusyId(report.id);

      // ATLAS WRITES: officer_field_reports
      const { error } = await supabase
        .from('officer_field_reports')
        .update({ status: 'reviewed', reviewed_by: profile.id, reviewed_at: new Date().toISOString() })
        .eq('id', report.id);

      if (error) throw error;
      setReports(reports.map((r) => (r.id === report.id ? { ...r, status: 'reviewed' } : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update report');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading field reports...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Field Reports</h1>
        <p className="subtitle">{reports.length} reports across the organisation</p>
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
        {reports.length === 0 ? (
          <div className="empty-state">
            <p>No field reports submitted yet.</p>
          </div>
        ) : (
          reports.map((r) => (
            <div key={r.id} className="contact-card">
              <div className="contact-header">
                <h3>{r.title}</h3>
                <span className={`severity-badge severity-${r.severity}`}>{r.severity}</span>
              </div>
              <div className="contact-details">
                <p>{r.description}</p>
                <p className="contact-meta">
                  {officerNames[r.officer_id] || r.officer_id} · {r.report_type} ·{' '}
                  {new Date(r.created_at).toLocaleString()}
                  {r.follow_up_required ? ' · follow-up required' : ''}
                </p>
              </div>
              <div className="assessment-actions">
                <span className={`status-badge status-${r.status}`}>{r.status}</span>
                {r.status === 'submitted' && (
                  <button
                    className="btn btn-sm btn-secondary"
                    disabled={busyId === r.id}
                    onClick={() => handleMarkReviewed(r)}
                  >
                    Mark Reviewed
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default FieldReportsPage;
