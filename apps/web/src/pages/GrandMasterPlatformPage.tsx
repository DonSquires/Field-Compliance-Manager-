/**
 * GrandMasterPlatformPage.tsx
 *
 * Platform-wide overview (grand_master only): all organizations (not scoped
 * to one org — this is the owner's cross-tenant view), aggregate breach/
 * observation activity, recent platform notifications, and a live services
 * health check via the check-services-health edge function.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface OrgSummary {
  id: string;
  name: string;
  organization_type: string;
  status: string;
  active: boolean;
}

interface PlatformNotification {
  id: string;
  category: string;
  severity: string;
  title: string;
  body: string | null;
  created_at: string;
}

interface HealthCheckResult {
  service: string;
  status: string;
  [key: string]: any;
}

const GrandMasterPlatformPage: React.FC = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [breachCount, setBreachCount] = useState(0);
  const [observationCount, setObservationCount] = useState(0);
  const [userCount, setUserCount] = useState(0);
  const [notifications, setNotifications] = useState<PlatformNotification[]>([]);
  const [health, setHealth] = useState<HealthCheckResult[] | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [scvImporting, setScvImporting] = useState(false);
  const [scvImportResult, setScvImportResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isGrandMaster = profile?.role === 'grand_master';

  // ATLAS READS: organizations, breach_alerts, observations, user_profiles, notifications
  const loadPlatformData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [orgsRes, breachRes, obsRes, userRes, notifRes] = await Promise.all([
        supabase.from('organizations').select('id, name, organization_type, status, active'),
        supabase.from('breach_alerts').select('id', { count: 'exact', head: true }).eq('status', 'open'),
        supabase.from('observations').select('id', { count: 'exact', head: true }),
        supabase.from('user_profiles').select('id', { count: 'exact', head: true }),
        supabase
          .from('notifications')
          .select('id, category, severity, title, body, created_at')
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      if (orgsRes.error) throw orgsRes.error;
      if (breachRes.error) throw breachRes.error;
      if (obsRes.error) throw obsRes.error;
      if (userRes.error) throw userRes.error;
      if (notifRes.error) throw notifRes.error;

      setOrgs((orgsRes.data as OrgSummary[]) || []);
      setBreachCount(breachRes.count || 0);
      setObservationCount(obsRes.count || 0);
      setUserCount(userRes.count || 0);
      setNotifications((notifRes.data as PlatformNotification[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load platform overview');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPlatformData();
  }, [loadPlatformData]);

  const runHealthCheck = async () => {
    try {
      setHealthLoading(true);
      setError(null);

      // ATLAS CALLS: check-services-health
      const { data, error: fnError } = await supabase.functions.invoke('check-services-health', { body: {} });
      if (fnError) throw fnError;
      setHealth((data?.services as HealthCheckResult[]) || (Array.isArray(data) ? data : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run health check');
    } finally {
      setHealthLoading(false);
    }
  };

  const importScvRegister = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      setScvImporting(true); setError(null); setScvImportResult(null);
      const csvText = await file.text();
      const { data, error: importError } = await supabase.functions.invoke<{ batch_id?: string; total_rows?: number; valid_rows?: number; invalid_rows?: number; status?: string }>('import-scv-csv', { body: { file_name: file.name, csv_text: csvText } });
      if (importError || !data?.batch_id) throw importError ?? new Error('SCV import was not confirmed.');
      setScvImportResult(`${file.name}: ${data.valid_rows ?? 0} valid of ${data.total_rows ?? 0} rows imported${data.invalid_rows ? `; ${data.invalid_rows} invalid rows require review` : ''}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'SCV register import failed');
    } finally { setScvImporting(false); }
  };

  if (!isGrandMaster) {
    return (
      <div className="page-container">
        <div className="empty-state">
          <p>Platform overview is restricted to grand_master.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading platform overview...</p>
        </div>
      </div>
    );
  }

  const byType: Record<string, number> = {};
  orgs.forEach((o) => {
    byType[o.organization_type] = (byType[o.organization_type] || 0) + 1;
  });

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Platform Overview</h1>
        <p className="subtitle">{orgs.length} organisations across the platform</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-value">{orgs.length}</div>
          <div className="kpi-label">Organisations</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-value">{userCount}</div>
          <div className="kpi-label">Users</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-value">{breachCount}</div>
          <div className="kpi-label">Open Breaches</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-value">{observationCount}</div>
          <div className="kpi-label">Total Observations</div>
        </div>
      </div>

      <section className="reports-section">
        <h2>Infrastructure data</h2>
        <p className="subtitle">Grand Master infrastructure ownership only. SCV register imports update the canonical platform vehicle source.</p>
        {scvImportResult && <div className="alert alert-success" role="status">{scvImportResult}</div>}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate('/nzscv')}>Open NZSCV supplier view</button>
        <label className="btn btn-primary btn-sm" style={{ display: 'inline-flex', cursor: scvImporting ? 'wait' : 'pointer' }}>
          {scvImporting ? 'Importing SCV register...' : 'Import SCV CSV'}
          <input type="file" accept=".csv,text/csv" onChange={importScvRegister} disabled={scvImporting} hidden />
        </label>
      </section>

      <section className="reports-section">
        <h2>Organisations by Type</h2>
        <div className="contacts-list">
          {Object.entries(byType).map(([type, count]) => (
            <div key={type} className="contact-card">
              <div className="contact-header">
                <h3>{type}</h3>
                <span className="contact-type-badge">{count}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="reports-section">
        <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <h2>Services Health</h2>
          <button className="btn btn-primary btn-sm" onClick={runHealthCheck} disabled={healthLoading}>
            {healthLoading ? 'Checking…' : 'Run Health Check'}
          </button>
        </div>
        {health && (
          <div className="contacts-list">
            {health.map((h, idx) => (
              <div key={idx} className="contact-card">
                <div className="contact-header">
                  <h3>{h.service || `Check ${idx + 1}`}</h3>
                  <span className={`status-badge status-${h.status === 'ok' || h.status === 'online' ? 'active' : 'inactive'}`}>
                    {h.status.replace(/_/g, ' ')}
                  </span>
                </div>
                {typeof h.detail === 'string' && <p>{h.detail}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="reports-section">
        <h2>Recent Notifications ({notifications.length})</h2>
        <div className="contacts-list">
          {notifications.length === 0 ? (
            <div className="empty-state">
              <p>No recent notifications.</p>
            </div>
          ) : (
            notifications.map((n) => (
              <div key={n.id} className="contact-card">
                <div className="contact-header">
                  <h3>{n.title}</h3>
                  <span className={`severity-badge severity-${n.severity}`}>{n.severity}</span>
                </div>
                {n.body && <p className="contact-details">{n.body}</p>}
                <p className="contact-meta">
                  {n.category} · {new Date(n.created_at).toLocaleString()}
                </p>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
};

export default GrandMasterPlatformPage;
