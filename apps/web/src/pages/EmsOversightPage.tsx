/**
 * EmsOversightPage.tsx (Admin field-ops sub-area: 'ems-alerts')
 *
 * Canonical schema: ems_alerts (joined to ems_devices for the device
 * serial), org-wide alert response. ems_alerts is SELECT-only under RLS;
 * status transitions go through respond_to_ems_alert(), which race-checks
 * the expected status and requires an outcome to close (resolved/false_alarm).
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'false_alarm';

interface EmsAlert {
  id: string;
  alert_type: string;
  severity: string;
  status: AlertStatus;
  outcome: string | null;
  triggered_at: string;
  ems_devices: { device_serial: string } | null;
}

const NEXT_STATUS: Partial<Record<AlertStatus, AlertStatus>> = {
  active: 'acknowledged',
  acknowledged: 'resolved',
};

const OUTCOME_OPTIONS = ['false_alarm', 'physical_damage', 'deliberate_tamper', 'device_fault', 'other'];

const EmsOversightPage: React.FC = () => {
  const { profile } = useAuth();
  const [alerts, setAlerts] = useState<EmsAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcomeInputs, setOutcomeInputs] = useState<Record<string, string>>({});

  // ATLAS READS: ems_alerts
  const load = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('ems_alerts')
      .select('id, alert_type, severity, status, outcome, triggered_at, ems_devices(device_serial)')
      .eq('organization_id', orgId)
      .neq('status', 'resolved')
      .neq('status', 'false_alarm')
      .order('triggered_at', { ascending: false })
      .limit(100);
    if (err) setError(err.message);
    else setAlerts((data as unknown as EmsAlert[]) ?? []);
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ATLAS WRITES: ems_alerts (via respond_to_ems_alert)
  const handleAdvance = async (alert: EmsAlert, nextStatus: AlertStatus) => {
    setBusyId(alert.id);
    setError(null);
    const outcome = nextStatus === 'resolved' ? outcomeInputs[alert.id] : undefined;
    const { error: err } = await supabase.rpc('respond_to_ems_alert', {
      p_alert_id: alert.id,
      p_expected_status: alert.status,
      p_next_status: nextStatus,
      p_outcome: outcome || null,
    });
    if (err) setError(err.message);
    else setAlerts(alerts.filter((a) => a.id !== alert.id));
    setBusyId(null);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading EMS alerts...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>EMS Alerts</h1>
        <p className="subtitle">{alerts.length} open alert(s)</p>
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
        {alerts.length === 0 ? (
          <div className="empty-state">
            <p>No open EMS alerts.</p>
          </div>
        ) : (
          alerts.map((alert) => (
            <div key={alert.id} className="contact-card">
              <div className="contact-header">
                <h3>{alert.ems_devices?.device_serial || 'Unknown device'}</h3>
                <span className={`badge ${alert.severity === 'critical' ? 'is-alert' : ''}`}>{alert.severity}</span>
              </div>
              <div className="contact-details">
                <p className="contact-meta">
                  {alert.alert_type.replaceAll('_', ' ')} · {alert.status} · {new Date(alert.triggered_at).toLocaleString()}
                </p>
                {alert.status === 'acknowledged' && (
                  <div className="form-group">
                    <label>Outcome (required to resolve)</label>
                    <select value={outcomeInputs[alert.id] ?? ''} onChange={(e) => setOutcomeInputs({ ...outcomeInputs, [alert.id]: e.target.value })}>
                      <option value="">Select outcome…</option>
                      {OUTCOME_OPTIONS.map((o) => (
                        <option key={o} value={o}>
                          {o.replaceAll('_', ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {NEXT_STATUS[alert.status] && (
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    disabled={busyId === alert.id || (alert.status === 'acknowledged' && !outcomeInputs[alert.id])}
                    onClick={() => handleAdvance(alert, NEXT_STATUS[alert.status]!)}
                  >
                    {busyId === alert.id ? 'Updating…' : alert.status === 'active' ? 'Acknowledge' : 'Resolve'}
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

export default EmsOversightPage;
