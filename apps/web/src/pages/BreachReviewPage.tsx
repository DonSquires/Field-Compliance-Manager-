/**
 * BreachReviewPage.tsx (Admin field-ops sub-area: 'breach-review')
 *
 * Canonical schema: breach_alerts (org-wide), with actioning workflow
 * (action_type, actioned_by/at, notes). Distinct from ReportsHubPage, which
 * is read-only analytics — this is the triage/action queue.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type ActionType =
  | 'verbal_warning'
  | 'written_warning'
  | 'notice_to_vacate'
  | 'infringement'
  | 'tow_request'
  | 'welfare_referral'
  | 'dismissed';

interface BreachAlert {
  id: string;
  plate_number: string;
  breach_type: string;
  status: string;
  nights_count: number | null;
  notes: string | null;
  created_at: string;
}

const BreachReviewPage: React.FC = () => {
  const { profile } = useAuth();
  const [alerts, setAlerts] = useState<BreachAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // ATLAS READS: breach_alerts
  const loadAlerts = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;

    try {
      setLoading(true);
      setError(null);

      const { data, error: err } = await supabase
        .from('breach_alerts')
        .select('id, plate_number, breach_type, status, nights_count, notes, created_at')
        .eq('organization_id', orgId)
        .eq('status', 'open')
        .order('created_at', { ascending: false });

      if (err) throw err;
      setAlerts((data as BreachAlert[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load breach alerts');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);

  const handleAction = async (alert: BreachAlert, actionType: ActionType) => {
    if (!profile?.id) return;
    try {
      setBusyId(alert.id);

      // ATLAS WRITES: breach_alerts
      const { error } = await supabase
        .from('breach_alerts')
        .update({
          status: actionType === 'dismissed' ? 'dismissed' : 'actioned',
          action_type: actionType,
          actioned_by: profile.id,
          actioned_at: new Date().toISOString(),
        })
        .eq('id', alert.id);

      if (error) throw error;
      setAlerts(alerts.filter((a) => a.id !== alert.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to action breach');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading breach alerts...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Breach Review</h1>
        <p className="subtitle">{alerts.length} open breaches awaiting action</p>
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
            <p>No open breaches to review.</p>
          </div>
        ) : (
          alerts.map((alert) => (
            <div key={alert.id} className="contact-card">
              <div className="contact-header">
                <h3>{alert.plate_number}</h3>
                <span className="badge">{alert.breach_type}</span>
              </div>
              <div className="contact-details">
                {alert.nights_count != null && <p>{alert.nights_count} nights recorded</p>}
                {alert.notes && <p>{alert.notes}</p>}
                <p className="contact-meta">{new Date(alert.created_at).toLocaleString()}</p>
              </div>
              <div className="assessment-actions" style={{ flexWrap: 'wrap' }}>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={busyId === alert.id}
                  onClick={() => handleAction(alert, 'verbal_warning')}
                >
                  Verbal Warning
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={busyId === alert.id}
                  onClick={() => handleAction(alert, 'written_warning')}
                >
                  Written Warning
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={busyId === alert.id}
                  onClick={() => handleAction(alert, 'infringement')}
                >
                  Infringement
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busyId === alert.id}
                  onClick={() => handleAction(alert, 'dismissed')}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default BreachReviewPage;
