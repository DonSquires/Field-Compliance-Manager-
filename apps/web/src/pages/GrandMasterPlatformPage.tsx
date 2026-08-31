/**
 * GrandMasterPlatformPage.tsx
 *
 * Platform-wide overview (grand_master only): all organizations (not scoped
 * to one org — this is the owner's cross-tenant view), aggregate breach/
 * observation activity, recent platform notifications, and a live services
 * health check via the check-services-health edge function.
 */

import React, { useEffect, useState, useCallback } from 'react';
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

function formatServiceLabel(service: string): string {
  const normalized = service.trim();
  if (!normalized) return 'Service';
  const byName: Record<string, string> = {
    'bob-control-plane': 'Bob Control Plane',
    'bob control plane': 'Bob Control Plane',
    'bob_control_plane': 'Bob Control Plane',
    ptt: 'PTT Server',
    inference: 'Inference',
    supabase: 'Supabase',
  };
  if (byName[normalized]) return byName[normalized];
  return normalized
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

const GrandMasterPlatformPage: React.FC = () => {
  const { profile } = useAuth();
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [breachCount, setBreachCount] = useState(0);
  const [observationCount, setObservationCount] = useState(0);
  const [userCount, setUserCount] = useState(0);
  const [notifications, setNotifications] = useState<PlatformNotification[]>([]);
  const [health, setHealth] = useState<HealthCheckResult[] | null>(null);
  const [browserCheck, setBrowserCheck] = useState<{ appUrl: string; status: string; title?: string; checks?: string[] } | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [browserLoading, setBrowserLoading] = useState(false);
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

      const nextHealth: HealthCheckResult[] = Object.entries(data ?? {}).reduce<HealthCheckResult[]>((items, [service, entry]) => {
        if (service === 'checkedAt') return items;
        const value = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
        items.push({
          service: String(service).replace(/_/g, ' '),
          status: String(value.status ?? 'unknown'),
          ...value,
        });
        return items;
      }, []);

      setHealth(nextHealth.length ? nextHealth : (Array.isArray(data) ? data as HealthCheckResult[] : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run health check');
    } finally {
      setHealthLoading(false);
    }
  };

  const runBrowserCheck = async () => {
    try {
      setBrowserLoading(true);
      setError(null);

      const appUrl = 'http://127.0.0.1:4173';
      const { data, error: fnError } = await supabase.functions.invoke('bob-builder-control-room', {
        body: {
          action: 'browser-check',
          appUrl,
          testName: 'live-app-check',
        },
      });
      if (fnError) throw fnError;
      if (data?.error) throw new Error(String(data.error));

      const status = (data?.result && typeof data.result === 'object' ? (data.result as Record<string, unknown>) : {}) as Record<string, unknown>;
      setBrowserCheck({
        appUrl: String((data?.appUrl ?? appUrl) || appUrl),
        status: String(status.status ?? 'unknown'),
        title: typeof status.title === 'string' ? status.title : undefined,
        checks: Array.isArray(status.checks) ? status.checks.filter((item): item is string => typeof item === 'string') : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run browser check');
      setBrowserCheck(null);
    } finally {
      setBrowserLoading(false);
    }
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-secondary btn-sm" onClick={runBrowserCheck} disabled={browserLoading}>
              {browserLoading ? 'Running browser check…' : 'Run Browser Check'}
            </button>
            <button className="btn btn-primary btn-sm" onClick={runHealthCheck} disabled={healthLoading}>
              {healthLoading ? 'Checking…' : 'Run Health Check'}
            </button>
          </div>
        </div>
        {health && (
          <div className="contacts-list">
            {health.map((h, idx) => (
              <div key={idx} className="contact-card">
                <div className="contact-header">
                  <h3>{formatServiceLabel(h.service || `Check ${idx + 1}`)}</h3>
                  <span className={`status-badge status-${['online', 'ok'].includes(String(h.status)) ? 'active' : 'inactive'}`}>
                    {String(h.status)}
                  </span>
                </div>
                {typeof h.builderReady === 'boolean' && (
                  <p className="contact-details">Builder ready: {String(h.builderReady)}</p>
                )}
                {formatServiceLabel(h.service || '').includes('Bob Control Plane') && typeof h.selfHostedProfiles !== 'undefined' && (
                  <p className="contact-details">Profiles: {Array.isArray(h.selfHostedProfiles) ? h.selfHostedProfiles.join(', ') : String(h.selfHostedProfiles)}</p>
                )}
              </div>
            ))}
          </div>
        )}
        {browserCheck && (
          <div className="contact-card" style={{ marginTop: 12 }}>
            <div className="contact-header">
              <h3>Live app check</h3>
              <span className={`status-badge status-${browserCheck.status === 'passed' ? 'active' : 'inactive'}`}>
                {browserCheck.status}
              </span>
            </div>
            <p className="contact-details">URL: {browserCheck.appUrl}</p>
            {browserCheck.title && <p className="contact-details">Title: {browserCheck.title}</p>}
            {browserCheck.checks && browserCheck.checks.length > 0 && (
              <p className="contact-details">Checks: {browserCheck.checks.join(', ')}</p>
            )}
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
