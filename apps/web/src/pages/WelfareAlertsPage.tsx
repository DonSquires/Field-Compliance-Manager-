/**
 * WelfareAlertsPage.tsx (360 lines)
 * Welfare alerts dashboard: officer check-ins, missed check-ins, SOS alerts, man-down escalation
 *
 * Features:
 * - Welfare alert types: check_in, missed, sos, man_down
 * - Server-authoritative escalation model
 * - Alert cards with officer, GPS, escalation level
 * - Actions: Acknowledge, Resolve, Contact Officer
 * - Real-time subscription to welfare_alerts
 * - Escalation-level color coding
 * - Responsive layout
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';

type AlertType = 'check_in' | 'missed' | 'sos' | 'man_down';
type AlertStatus = 'open' | 'acknowledged' | 'resolved';

interface WelfareAlert {
  id: string;
  officer_user_id: string;
  organization_id: string;
  status: AlertStatus;
  alert_type: AlertType;
  escalation_level: number;
  escalated_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  acknowledged_by: string | null;
  created_at: string;
  gps_lat: number | null;
  gps_lng: number | null;
  metadata: Record<string, any> | null;
  officer?: {
    id: string;
    display_name: string;
  };
}

const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  check_in: 'Check-in',
  missed: 'Missed Check-in',
  sos: 'SOS Alert',
  man_down: 'Man-down',
};

const ALERT_TYPE_ICONS: Record<AlertType, string> = {
  check_in: '✅',
  missed: '⏰',
  sos: '🚨',
  man_down: '⚠️',
};

const ESCALATION_COLORS: Record<number, string> = {
  0: '#4CAF50', // green - none
  1: '#FF9800', // orange - warning
  2: '#FF6F00', // deep orange - escalated
  3: '#EF5350', // red - critical
};

const StatusBadge: React.FC<{
  status: AlertStatus;
  escalationLevel: number;
}> = ({ status, escalationLevel }) => {
  const statusColors: Record<AlertStatus, string> = {
    open: '#EF5350',
    acknowledged: '#FF9800',
    resolved: '#4CAF50',
  };

  return (
    <div
      style={{
        display: 'inline-block',
        padding: '4px 12px',
        borderRadius: '12px',
        fontSize: '12px',
        fontWeight: 600,
        backgroundColor: statusColors[status],
        color: 'white',
      }}
    >
      {status === 'open' ? 'Open' : status === 'acknowledged' ? 'Acknowledged' : 'Resolved'}
    </div>
  );
};

const AlertCard: React.FC<{
  alert: WelfareAlert;
  onAcknowledge: (id: string) => Promise<void>;
  onResolve: (id: string) => Promise<void>;
  loading: boolean;
}> = ({ alert, onAcknowledge, onResolve, loading }) => {
  const timeAgo = (timestamp: string) => {
    const now = new Date();
    const date = new Date(timestamp);
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const escalationLabel = (level: number) => {
    switch (level) {
      case 0: return 'None';
      case 1: return 'Warning';
      case 2: return 'Escalated';
      case 3: return 'Critical';
      default: return 'Unknown';
    }
  };

  const hasGps = alert.gps_lat && alert.gps_lng;

  return (
    <div
      style={{
        padding: '16px',
        backgroundColor: 'var(--color-bg-secondary)',
        border: `2px solid ${ESCALATION_COLORS[alert.escalation_level] || '#666'}`,
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
          <span style={{ fontSize: '24px' }}>
            {ALERT_TYPE_ICONS[alert.alert_type]}
          </span>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
              {alert.officer?.display_name || 'Officer'}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
              {ALERT_TYPE_LABELS[alert.alert_type]}
            </div>
          </div>
        </div>
        <StatusBadge status={alert.status} escalationLevel={alert.escalation_level} />
      </div>

      {/* Details */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '12px' }}>
        <div>
          <span style={{ color: 'var(--color-text-secondary)' }}>Triggered</span>
          <div style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>
            {timeAgo(alert.created_at)}
          </div>
        </div>
        <div>
          <span style={{ color: 'var(--color-text-secondary)' }}>Escalation</span>
          <div
            style={{
              color: ESCALATION_COLORS[alert.escalation_level],
              fontWeight: 500,
            }}
          >
            {escalationLabel(alert.escalation_level)}
          </div>
        </div>
        {hasGps && (
          <>
            <div>
              <span style={{ color: 'var(--color-text-secondary)' }}>GPS Lat</span>
              <div style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>
                {alert.gps_lat?.toFixed(6)}
              </div>
            </div>
            <div>
              <span style={{ color: 'var(--color-text-secondary)' }}>GPS Lng</span>
              <div style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>
                {alert.gps_lng?.toFixed(6)}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Metadata Notes */}
      {alert.metadata?.inactivity_duration && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', padding: '8px', backgroundColor: 'var(--color-bg-primary)', borderRadius: '4px' }}>
          Inactive for {Math.floor(alert.metadata.inactivity_duration / 60)} minutes
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {alert.status === 'open' && (
          <button
            onClick={() => onAcknowledge(alert.id)}
            disabled={loading}
            style={{
              flex: '1 1 auto',
              minWidth: '100px',
              padding: '8px 12px',
              backgroundColor: '#FF9800',
              border: 'none',
              borderRadius: '4px',
              color: 'white',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '12px',
              fontWeight: 500,
              opacity: loading ? 0.6 : 1,
            }}
          >
            Acknowledge
          </button>
        )}
        {alert.status !== 'resolved' && (
          <button
            onClick={() => onResolve(alert.id)}
            disabled={loading}
            style={{
              flex: '1 1 auto',
              minWidth: '100px',
              padding: '8px 12px',
              backgroundColor: '#4CAF50',
              border: 'none',
              borderRadius: '4px',
              color: 'white',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '12px',
              fontWeight: 500,
              opacity: loading ? 0.6 : 1,
            }}
          >
            Resolve
          </button>
        )}
        <button
          style={{
            flex: '1 1 auto',
            minWidth: '100px',
            padding: '8px 12px',
            backgroundColor: 'transparent',
            border: '1px solid var(--color-primary)',
            borderRadius: '4px',
            color: 'var(--color-primary)',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 500,
          }}
        >
          Call Officer
        </button>
      </div>
    </div>
  );
};

const WelfareAlertsPage: React.FC = () => {
  const { profile } = useAuth();
  const [alerts, setAlerts] = useState<WelfareAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | AlertStatus>('all');
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  // Load alerts
  const loadAlerts = useCallback(async () => {
    if (!profile?.organizationId) return;

    try {
      setLoading(true);
      let query = supabase
        .from('officer_welfare_alerts')
        .select('*, officer:officer_user_id(id, display_name)')
        .eq('organization_id', profile.organizationId);

      if (filter !== 'all') {
        query = query.eq('status', filter);
      }

      const { data, error } = await query
        .order('escalation_level', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;
      setAlerts(data || []);
    } catch (err) {
      console.error('Failed to load alerts:', err);
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId, filter]);

  // Acknowledge alert
  const handleAcknowledge = useCallback(
    async (id: string) => {
      if (!profile?.id) return;

      try {
        setActionLoading(id);
        const { error } = await supabase
          .from('officer_welfare_alerts')
          .update({
            status: 'acknowledged',
            acknowledged_by: profile.id,
          })
          .eq('id', id);

        if (error) throw error;
        await loadAlerts();
      } catch (err) {
        console.error('Failed to acknowledge alert:', err);
      } finally {
        setActionLoading(null);
      }
    },
    [profile?.id, loadAlerts]
  );

  // Resolve alert
  const handleResolve = useCallback(
    async (id: string) => {
      if (!profile?.id) return;

      try {
        setActionLoading(id);
        const { error } = await supabase
          .from('officer_welfare_alerts')
          .update({
            status: 'resolved',
            resolved_at: new Date().toISOString(),
            resolved_by: profile.id,
          })
          .eq('id', id);

        if (error) throw error;
        await loadAlerts();
      } catch (err) {
        console.error('Failed to resolve alert:', err);
      } finally {
        setActionLoading(null);
      }
    },
    [profile?.id, loadAlerts]
  );

  // Track mobile viewport
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Initial load
  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);

  // Set up real-time subscription
  useEffect(() => {
    if (!profile?.organizationId) return;

    const subscription = supabase
      .channel(`welfare_alerts_${profile.organizationId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'officer_welfare_alerts',
          filter: `organization_id=eq.${profile.organizationId}`,
        },
        () => {
          loadAlerts();
        }
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [profile?.organizationId, loadAlerts]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(loadAlerts, 30000);
    return () => clearInterval(interval);
  }, [loadAlerts]);

  const filteredAlerts = useMemo(() => {
    if (filter === 'all') return alerts;
    return alerts.filter((a) => a.status === filter);
  }, [alerts, filter]);

  const openCount = alerts.filter((a) => a.status === 'open').length;
  const acknowledgedCount = alerts.filter((a) => a.status === 'acknowledged').length;
  const resolvedCount = alerts.filter((a) => a.status === 'resolved').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', paddingBottom: '24px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>
            Welfare Alerts
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: '4px 0 0 0' }}>
            Officer check-in and escalation triage
          </p>
        </div>
        <button
          onClick={loadAlerts}
          style={{
            padding: '8px 16px',
            backgroundColor: 'var(--color-primary)',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 500,
            fontSize: '13px',
          }}
        >
          🔄 Refresh
        </button>
      </div>

      {/* Filter Tabs */}
      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--color-border)', paddingBottom: '12px', overflowX: 'auto' }}>
        <button
          onClick={() => setFilter('all')}
          style={{
            padding: '8px 16px',
            backgroundColor: filter === 'all' ? 'var(--color-primary)' : 'transparent',
            color: filter === 'all' ? 'white' : 'var(--color-text-secondary)',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 500,
            fontSize: '13px',
            whiteSpace: 'nowrap',
          }}
        >
          All ({alerts.length})
        </button>
        <button
          onClick={() => setFilter('open')}
          style={{
            padding: '8px 16px',
            backgroundColor: filter === 'open' ? '#EF5350' : 'transparent',
            color: filter === 'open' ? 'white' : '#EF5350',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 500,
            fontSize: '13px',
            whiteSpace: 'nowrap',
          }}
        >
          Open ({openCount})
        </button>
        <button
          onClick={() => setFilter('acknowledged')}
          style={{
            padding: '8px 16px',
            backgroundColor: filter === 'acknowledged' ? '#FF9800' : 'transparent',
            color: filter === 'acknowledged' ? 'white' : '#FF9800',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 500,
            fontSize: '13px',
            whiteSpace: 'nowrap',
          }}
        >
          Acknowledged ({acknowledgedCount})
        </button>
        <button
          onClick={() => setFilter('resolved')}
          style={{
            padding: '8px 16px',
            backgroundColor: filter === 'resolved' ? '#4CAF50' : 'transparent',
            color: filter === 'resolved' ? 'white' : '#4CAF50',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 500,
            fontSize: '13px',
            whiteSpace: 'nowrap',
          }}
        >
          Resolved ({resolvedCount})
        </button>
      </div>

      {/* Alerts List */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--color-text-secondary)' }}>
          Loading alerts...
        </div>
      ) : filteredAlerts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--color-text-secondary)' }}>
          No alerts to display
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: '12px',
          }}
        >
          {filteredAlerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              onAcknowledge={handleAcknowledge}
              onResolve={handleResolve}
              loading={actionLoading === alert.id}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default WelfareAlertsPage;
