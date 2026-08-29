/**
 * OfficerFieldReportPage.tsx (Officer module: 'report')
 *
 * Canonical schema: officer_field_reports (report_type: incident|maintenance|
 * health_safety; severity: low|medium|high|critical; status: draft|submitted|
 * reviewed|closed). Officer-scoped: filtered to the signed-in officer.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type ReportType = 'incident' | 'maintenance' | 'health_safety';
type ReportSeverity = 'low' | 'medium' | 'high' | 'critical';

interface FieldReport {
  id: string;
  report_type: ReportType;
  severity: ReportSeverity;
  status: string;
  title: string;
  description: string;
  location_name: string | null;
  follow_up_required: boolean;
  created_at: string;
}

const OfficerFieldReportPage: React.FC = () => {
  const { profile } = useAuth();
  const [reports, setReports] = useState<FieldReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    report_type: 'incident' as ReportType,
    severity: 'low' as ReportSeverity,
    title: '',
    description: '',
    location_name: '',
    follow_up_required: false,
  });

  // ATLAS READS: officer_field_reports
  const loadReports = useCallback(async () => {
    if (!profile?.id) return;

    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('officer_field_reports')
        .select('id, report_type, severity, status, title, description, location_name, follow_up_required, created_at')
        .eq('officer_id', profile.id)
        .order('created_at', { ascending: false });

      if (err) throw err;
      setReports((data as FieldReport[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, [profile?.id]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile?.organizationId) return;

    try {
      // ATLAS WRITES: officer_field_reports
      const { data, error } = await supabase
        .from('officer_field_reports')
        .insert([
          {
            organization_id: profile.organizationId,
            officer_id: profile.id,
            report_type: form.report_type,
            severity: form.severity,
            title: form.title,
            description: form.description,
            location_name: form.location_name || null,
            follow_up_required: form.follow_up_required,
            status: 'submitted',
          },
        ])
        .select()
        .single();

      if (error) throw error;

      setReports([data as FieldReport, ...reports]);
      setForm({
        report_type: 'incident',
        severity: 'low',
        title: '',
        description: '',
        location_name: '',
        follow_up_required: false,
      });
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit report');
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading reports...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Field Reports</h1>
        <p className="subtitle">{reports.length} reports submitted</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
        {showForm ? 'Cancel' : '+ New Report'}
      </button>

      {showForm && (
        <form className="assessment-form" onSubmit={handleSubmit}>
          <div className="form-row">
            <div className="form-group">
              <label>Type</label>
              <select
                value={form.report_type}
                onChange={(e) => setForm({ ...form, report_type: e.target.value as ReportType })}
              >
                <option value="incident">Incident</option>
                <option value="maintenance">Maintenance</option>
                <option value="health_safety">Health & Safety</option>
              </select>
            </div>
            <div className="form-group">
              <label>Severity</label>
              <select
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: e.target.value as ReportSeverity })}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Title</label>
            <input type="text" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Location</label>
            <input
              type="text"
              value={form.location_name}
              onChange={(e) => setForm({ ...form, location_name: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea
              required
              rows={4}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={form.follow_up_required}
                onChange={(e) => setForm({ ...form, follow_up_required: e.target.checked })}
              />{' '}
              Follow-up required
            </label>
          </div>
          <button type="submit" className="btn btn-primary btn-block">
            Submit Report
          </button>
        </form>
      )}

      <div className="contacts-list" style={{ marginTop: '12px' }}>
        {reports.length === 0 ? (
          <div className="empty-state">
            <p>No reports submitted yet.</p>
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
                  {r.report_type} · {r.location_name || 'no location'} ·{' '}
                  {new Date(r.created_at).toLocaleString()}
                </p>
              </div>
              <span className={`status-badge status-${r.status}`}>{r.status}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerFieldReportPage;
