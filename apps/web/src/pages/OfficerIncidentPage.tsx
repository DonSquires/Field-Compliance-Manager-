/**
 * OfficerIncidentPage.tsx (Officer module: 'incident_report')
 *
 * Canonical schema: incidents (organization_id, officer_user_id,
 * client_site_id, incident_type, severity, description, status,
 * occurred_at). This is the structured incident register consumed
 * directly by client governance report-pack generation (severity
 * aggregation) -- distinct from the free-form officer_field_reports
 * ("Field report" quick action), which does not feed that aggregation.
 *
 * incidents requires at least one place anchor (client_site_id, zone_id, or
 * legacy location_id); this page anchors to a selected client_site_id.
 *
 * DEFERRED: incident_attachments has a SELECT-only RLS policy today (no
 * INSERT policy exists), so evidence attachment is not wired here -- that
 * needs a migration first. patrol_id/dispatch_job_id auto-linking is also
 * deferred.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type IncidentSeverity = 'low' | 'standard' | 'high' | 'critical';
type IncidentStatus = 'open' | 'in_review' | 'resolved' | 'escalated';

const INCIDENT_TYPES = ['confrontation', 'property_damage', 'welfare_concern', 'trespass', 'theft', 'medical', 'other'];

interface SiteOption {
  id: string;
  name: string;
}

interface IncidentRecord {
  id: string;
  incident_type: string;
  severity: IncidentSeverity;
  description: string | null;
  status: IncidentStatus;
  occurred_at: string;
  client_site_id: string | null;
}

const emptyForm = {
  client_site_id: '',
  incident_type: 'confrontation',
  severity: 'standard' as IncidentSeverity,
  description: '',
};

const STATUS_LABELS: Record<IncidentStatus, string> = {
  open: 'Open',
  in_review: 'In review',
  resolved: 'Resolved',
  escalated: 'Escalated',
};

const OfficerIncidentPage: React.FC = () => {
  const { profile } = useAuth();
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [incidents, setIncidents] = useState<IncidentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  // ATLAS READS: client_sites, incidents
  const load = useCallback(async () => {
    if (!profile?.id || !profile.organizationId) return;
    setLoading(true);
    setError(null);
    const [siteResponse, incidentResponse] = await Promise.all([
      supabase.from('client_sites').select('id, name').eq('active', true).order('name').limit(200),
      supabase
        .from('incidents')
        .select('id, incident_type, severity, description, status, occurred_at, client_site_id')
        .eq('officer_user_id', profile.id)
        .order('occurred_at', { ascending: false })
        .limit(30),
    ]);
    setSites((siteResponse.data as SiteOption[]) ?? []);
    setIncidents((incidentResponse.data as IncidentRecord[]) ?? []);
    const failures = [siteResponse.error?.message, incidentResponse.error?.message].filter(Boolean);
    if (failures.length) setError(failures.join(' · '));
    setLoading(false);
  }, [profile?.id, profile?.organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const canSubmit = form.client_site_id !== '' && form.description.trim().length >= 10 && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id || !profile.organizationId || !canSubmit) return;
    setSubmitting(true);
    setError(null);

    // ATLAS WRITES: incidents
    const { data, error: err } = await supabase
      .from('incidents')
      .insert([
        {
          organization_id: profile.organizationId,
          officer_user_id: profile.id,
          client_site_id: form.client_site_id,
          incident_type: form.incident_type,
          severity: form.severity,
          description: form.description.trim(),
        },
      ])
      .select()
      .single();

    if (err) {
      setError(err.message);
    } else {
      setIncidents([data as IncidentRecord, ...incidents]);
      setForm(emptyForm);
    }
    setSubmitting(false);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading incidents...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Report Incident</h1>
        <p className="subtitle">Confrontations, property damage, welfare concerns, and on-scene events</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <form className="assessment-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Site</label>
          <select required value={form.client_site_id} onChange={(e) => setForm({ ...form, client_site_id: e.target.value })}>
            <option value="">Select a site…</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Incident type</label>
          <select value={form.incident_type} onChange={(e) => setForm({ ...form, incident_type: e.target.value })}>
            {INCIDENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Severity</label>
          <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as IncidentSeverity })}>
            <option value="low">Low</option>
            <option value="standard">Standard</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div className="form-group">
          <label>Description</label>
          <textarea
            required
            minLength={10}
            rows={5}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="What happened, who or what was involved, and current conditions"
          />
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={!canSubmit}>
          {submitting ? 'Submitting…' : 'Submit Incident'}
        </button>
      </form>

      <div className="contacts-list" style={{ marginTop: '12px' }}>
        {incidents.length === 0 ? (
          <div className="empty-state">
            <p>No incidents recorded yet.</p>
          </div>
        ) : (
          incidents.map((incident) => (
            <div key={incident.id} className="contact-card">
              <div className="contact-header">
                <h3>{incident.incident_type.replaceAll('_', ' ')}</h3>
                <span className="badge">{incident.severity}</span>
              </div>
              <div className="contact-details">
                {incident.description && <p>{incident.description}</p>}
                <p className="contact-meta">
                  {STATUS_LABELS[incident.status]} · {new Date(incident.occurred_at).toLocaleString()}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerIncidentPage;
