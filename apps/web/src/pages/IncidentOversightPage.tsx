/**
 * IncidentOversightPage.tsx (Admin field-ops sub-area: 'incidents')
 *
 * Canonical schema: incidents, org-wide oversight with inline status
 * transitions (open -> in_review -> resolved / escalated). This is the
 * register consumed directly by client governance report-pack generation
 * (severity aggregation) -- distinct from officer_field_reports triage.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type IncidentStatus = 'open' | 'in_review' | 'resolved' | 'escalated';

interface IncidentRecord {
  id: string;
  incident_type: string;
  severity: string;
  description: string | null;
  status: IncidentStatus;
  occurred_at: string;
  client_sites: { name: string } | null;
}

const STATUS_OPTIONS: IncidentStatus[] = ['open', 'in_review', 'resolved', 'escalated'];

const IncidentOversightPage: React.FC = () => {
  const { profile } = useAuth();
  const [incidents, setIncidents] = useState<IncidentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: incidents
  const load = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('incidents')
      .select('id, incident_type, severity, description, status, occurred_at, client_sites(name)')
      .eq('organization_id', orgId)
      .order('occurred_at', { ascending: false })
      .limit(100);
    if (err) setError(err.message);
    else setIncidents((data as unknown as IncidentRecord[]) ?? []);
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ATLAS WRITES: incidents
  const handleStatusChange = async (id: string, status: IncidentStatus) => {
    const previous = incidents;
    setIncidents(incidents.map((incident) => (incident.id === id ? { ...incident, status } : incident)));
    const { error: err } = await supabase.from('incidents').update({ status }).eq('id', id);
    if (err) {
      setError(err.message);
      setIncidents(previous);
    }
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
        <h1>Incidents</h1>
        <p className="subtitle">{incidents.length} incidents across the organisation</p>
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
              <th>Site</th>
              <th>Type</th>
              <th>Severity</th>
              <th>Description</th>
              <th>Status</th>
              <th>Occurred</th>
            </tr>
          </thead>
          <tbody>
            {incidents.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center">
                  No incidents
                </td>
              </tr>
            ) : (
              incidents.map((incident) => (
                <tr key={incident.id}>
                  <td>{incident.client_sites?.name || '-'}</td>
                  <td>{incident.incident_type.replaceAll('_', ' ')}</td>
                  <td>{incident.severity}</td>
                  <td>{incident.description || '-'}</td>
                  <td>
                    <select value={incident.status} onChange={(e) => handleStatusChange(incident.id, e.target.value as IncidentStatus)}>
                      {STATUS_OPTIONS.map((status) => (
                        <option key={status} value={status}>
                          {status.replaceAll('_', ' ')}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{new Date(incident.occurred_at).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default IncidentOversightPage;
