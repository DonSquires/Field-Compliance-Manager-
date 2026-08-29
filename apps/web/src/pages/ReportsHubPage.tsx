/**
 * ReportsHubPage.tsx
 *
 * Canonical schema: breach_alerts (plate_number, breach_type, status, zone_id,
 * actioned_by/at, notes) and observations (plate_number, officer_id,
 * is_compliant, compliance_reason, zone_id, observed_at). There is no
 * severity/location_name/observation_type/reported_by column on either table
 * — those were a screen-first guess and have been removed.
 */

import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface BreachAlert {
  id: string;
  created_at: string;
  breach_type: string;
  status: string;
  plate_number: string;
  zone_id: string | null;
  notes: string | null;
}

interface Observation {
  id: string;
  observed_at: string;
  plate_number: string;
  officer_id: string;
  is_compliant: boolean | null;
  compliance_reason: string | null;
  zone_id: string | null;
}

interface ReportMetrics {
  totalBreaches: number;
  totalObservations: number;
  nonCompliantObservations: number;
}

const ReportsHubPage: React.FC = () => {
  const { profile } = useAuth();
  const [metrics, setMetrics] = useState<ReportMetrics>({
    totalBreaches: 0,
    totalObservations: 0,
    nonCompliantObservations: 0,
  });

  const [breachAlerts, setBreachAlerts] = useState<BreachAlert[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState({
    start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });

  // ATLAS READS: breach_alerts, observations
  useEffect(() => {
    const loadReports = async () => {
      if (!profile?.organizationId) return;

      try {
        setLoading(true);
        setError(null);

        const { data: breachData, error: breachErr } = await supabase
          .from('breach_alerts')
          .select('id, created_at, breach_type, status, plate_number, zone_id, notes')
          .eq('organization_id', profile.organizationId)
          .gte('created_at', dateRange.start)
          .lte('created_at', dateRange.end)
          .order('created_at', { ascending: false });

        if (breachErr) throw breachErr;

        const { data: obsData, error: obsErr } = await supabase
          .from('observations')
          .select('id, observed_at, plate_number, officer_id, is_compliant, compliance_reason, zone_id')
          .eq('organization_id', profile.organizationId)
          .gte('observed_at', dateRange.start)
          .lte('observed_at', dateRange.end)
          .order('observed_at', { ascending: false });

        if (obsErr) throw obsErr;

        const breaches = (breachData as BreachAlert[]) || [];
        const obs = (obsData as Observation[]) || [];

        setBreachAlerts(breaches);
        setObservations(obs);
        setMetrics({
          totalBreaches: breaches.length,
          totalObservations: obs.length,
          nonCompliantObservations: obs.filter((o) => o.is_compliant === false).length,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load reports');
      } finally {
        setLoading(false);
      }
    };

    loadReports();
  }, [profile?.organizationId, dateRange]);

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
    <div className="page-container reports-hub-page">
      <header className="page-header">
        <h1>Reports & Analytics</h1>
        <p className="subtitle">Compliance metrics, breach alerts, vehicle observations</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="reports-filter">
        <label>Date Range</label>
        <div className="date-inputs">
          <input
            type="date"
            value={dateRange.start}
            onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
            max={dateRange.end}
          />
          <span>to</span>
          <input
            type="date"
            value={dateRange.end}
            onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
            min={dateRange.start}
          />
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-value">{metrics.totalBreaches}</div>
          <div className="kpi-label">Breach Alerts</div>
          <div className="kpi-unit">this period</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-value">{metrics.totalObservations}</div>
          <div className="kpi-label">Observations</div>
          <div className="kpi-unit">this period</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-value">{metrics.nonCompliantObservations}</div>
          <div className="kpi-label">Non-Compliant</div>
          <div className="kpi-unit">observations</div>
        </div>
      </div>

      <section className="reports-section">
        <h2>Recent Breach Alerts ({breachAlerts.length})</h2>
        <div className="reports-table-wrapper">
          <table className="reports-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Plate</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {breachAlerts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center">
                    No breach alerts in this period
                  </td>
                </tr>
              ) : (
                breachAlerts.slice(0, 10).map((breach) => (
                  <tr key={breach.id}>
                    <td>{new Date(breach.created_at).toLocaleString()}</td>
                    <td>
                      <span className="badge">{breach.breach_type}</span>
                    </td>
                    <td>{breach.plate_number}</td>
                    <td>
                      <span className={`status-badge status-${breach.status}`}>{breach.status}</span>
                    </td>
                    <td className="text-truncate" title={breach.notes || ''}>
                      {breach.notes ? breach.notes.substring(0, 50) : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="reports-section">
        <h2>Vehicle Observations ({observations.length})</h2>
        <div className="reports-table-wrapper">
          <table className="reports-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Plate</th>
                <th>Compliant</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {observations.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center">
                    No observations in this period
                  </td>
                </tr>
              ) : (
                observations.slice(0, 10).map((obs) => (
                  <tr key={obs.id}>
                    <td>{new Date(obs.observed_at).toLocaleString()}</td>
                    <td>{obs.plate_number}</td>
                    <td>
                      {obs.is_compliant === null ? '—' : obs.is_compliant ? 'Yes' : 'No'}
                    </td>
                    <td>{obs.compliance_reason ?? '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default ReportsHubPage;
