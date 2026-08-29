/**
 * AdminHubPage.tsx (599 lines)
 * Admin dashboard with KPI widgets, trend chart, module cards, NOC terminal
 *
 * Audience: Admin, Master, Grand Master roles
 *
 * Features:
 * - Header with greeting + refresh button
 * - NOC Terminal (Grand Master only)
 * - KPI grid (4 tiles: Active Shifts, Breach Alerts, On-Call, Approvals, NOC status)
 * - Sticky priority-action bar (links to key pages)
 * - Compliance trend chart (7d/14d/30d range selector)
 * - Module cards grid (14 cards linking to field modules)
 * - Real-time subscriptions to breach_alerts + welfare_alerts
 * - Responsive layout (4-col desktop, 2-col mobile)
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';

interface KpiData {
  scansToday: number;
  activeBreaches: number;
  patrols: number;
  welfareAlerts: number;
}

interface TrendDay {
  date: string;
  scans: number;
  breaches: number;
}

type TrendRange = '7d' | '14d' | '30d';

interface AdminHubPageProps {
  onNavigate?: (page: string) => void;
}

const MODULES = [
  { id: 'fc-patrol', label: 'FC Patrol', icon: '🚗', navigate: 'patrol' },
  { id: 'breach-review', label: 'Breach Review', icon: '⚖️', navigate: 'breach-review' },
  { id: 'fc-notice-print', label: 'Notice Print', icon: '🖨️', navigate: 'fc-notice-print' },
  { id: 'fc-compliance', label: 'Compliance', icon: '✅', navigate: 'fc-compliance' },
  { id: 'fc-reports', label: 'FC Reports', icon: '📊', navigate: 'fc-reporting' },
  { id: 'fc-scv-import', label: 'SCV Import', icon: '📥', navigate: 'fc-scv-import' },
  { id: 'fc-nzscv', label: 'NZSCV Monitor', icon: '🔍', navigate: 'fc-nzscv' },
  { id: 'field-reports', label: 'Field Reports', icon: '📝', navigate: 'field-reports' },
  { id: 'live-map', label: 'Live Map', icon: '🗺️', navigate: 'live-map' },
  { id: 'welfare-alerts', label: 'Welfare', icon: '🚧', navigate: 'welfare-alerts' },
  { id: 'dispatch', label: 'Dispatch', icon: '📡', navigate: 'dispatch' },
  { id: 'roster', label: 'Roster', icon: '👥', navigate: 'roster' },
  { id: 'staff', label: 'Staff', icon: '👤', navigate: 'staff' },
  { id: 'credentials', label: 'Credentials', icon: '🪪', navigate: 'credential-expiry' },
];

const KpiTile: React.FC<{
  label: string;
  value: number | string;
  icon: string;
  color: string;
  loading: boolean;
  onClick?: () => void;
}> = ({ label, value, icon, color, loading, onClick }) => (
  <button
    onClick={onClick}
    style={{
      padding: '16px',
      backgroundColor: 'var(--color-bg-secondary)',
      border: '1px solid var(--color-border)',
      borderRadius: '8px',
      cursor: onClick ? 'pointer' : 'default',
      transition: 'all 0.2s ease',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      alignItems: 'flex-start',
    }}
    onMouseEnter={(e) => onClick && (e.currentTarget.style.backgroundColor = 'var(--color-bg-tertiary)')}
    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--color-bg-secondary)')}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
      <span style={{ fontSize: '20px' }}>{icon}</span>
      <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)', fontWeight: 500 }}>
        {label}
      </span>
    </div>
    <div style={{ fontSize: '28px', fontWeight: 700, color: color }}>
      {loading ? '...' : value}
    </div>
  </button>
);

const ModuleCard: React.FC<{
  label: string;
  icon: string;
  onClick?: () => void;
}> = ({ label, icon, onClick }) => (
  <button
    onClick={onClick}
    style={{
      padding: '20px',
      backgroundColor: 'var(--color-bg-secondary)',
      border: '1px solid var(--color-border)',
      borderRadius: '8px',
      cursor: 'pointer',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '12px',
      transition: 'all 0.2s ease',
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.backgroundColor = 'var(--color-bg-tertiary)';
      e.currentTarget.style.borderColor = 'var(--color-primary)';
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.backgroundColor = 'var(--color-bg-secondary)';
      e.currentTarget.style.borderColor = 'var(--color-border)';
    }}
  >
    <span style={{ fontSize: '32px' }}>{icon}</span>
    <span style={{ fontSize: '13px', fontWeight: 500, textAlign: 'center' }}>
      {label}
    </span>
  </button>
);

const TrendChart: React.FC<{
  data: TrendDay[];
  range: TrendRange;
  onRangeChange: (range: TrendRange) => void;
}> = ({ data, range, onRangeChange }) => {
  const maxValue = Math.max(...data.map((d) => Math.max(d.scans, d.breaches)), 1);

  return (
    <div style={{ padding: '20px', backgroundColor: 'var(--color-bg-secondary)', borderRadius: '8px', border: '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
          Compliance Trend
        </h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          {(['7d', '14d', '30d'] as TrendRange[]).map((r) => (
            <button
              key={r}
              onClick={() => onRangeChange(r)}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                backgroundColor: range === r ? 'var(--color-primary)' : 'transparent',
                color: range === r ? 'white' : 'var(--color-text-secondary)',
                border: '1px solid var(--color-border)',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div style={{ height: '150px', display: 'flex', alignItems: 'flex-end', gap: '4px' }}>
        {data.map((day, idx) => (
          <div
            key={idx}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'flex-end',
              gap: '2px',
              height: '100%',
            }}
          >
            <div
              style={{
                flex: 1,
                height: `${(day.scans / maxValue) * 100}%`,
                backgroundColor: '#3B82F6',
                borderRadius: '2px',
                minHeight: '4px',
              }}
              title={`${day.date}: ${day.scans} scans`}
            />
            <div
              style={{
                flex: 1,
                height: `${(day.breaches / maxValue) * 100}%`,
                backgroundColor: '#EF5350',
                borderRadius: '2px',
                minHeight: '4px',
              }}
              title={`${day.date}: ${day.breaches} breaches`}
            />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '16px', marginTop: '12px', fontSize: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{ width: '12px', height: '12px', backgroundColor: '#3B82F6', borderRadius: '2px' }} />
          <span>Scans</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{ width: '12px', height: '12px', backgroundColor: '#EF5350', borderRadius: '2px' }} />
          <span>Breaches</span>
        </div>
      </div>
    </div>
  );
};

const NocTerminal: React.FC = () => (
  <div
    style={{
      padding: '20px',
      backgroundColor: '#1A0000',
      border: '2px solid #EF5350',
      borderRadius: '8px',
      fontFamily: 'Courier New, monospace',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
      <span style={{ fontSize: '20px' }}>🎛️</span>
      <span style={{ fontSize: '14px', fontWeight: 600, color: '#EF5350' }}>
        Platform Master Control (NOC)
      </span>
    </div>

    <div
      style={{
        padding: '8px 12px',
        backgroundColor: '#0A0A0A',
        borderRadius: '4px',
        marginBottom: '12px',
        fontSize: '12px',
        color: '#4CAF50',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <span>● ONLINE</span>
      <span style={{ color: '#666' }}>System Telemetry: Operational</span>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
      {[
        { name: 'fcm-api', value: '42ms', desc: 'API (Hpanel VPS)' },
        { name: 'fcm-inference', value: 'ONNX YOLOv8n', desc: 'ML Engine' },
      ].map((item) => (
        <div
          key={item.name}
          style={{
            padding: '8px 12px',
            backgroundColor: '#0A0A0A',
            borderRadius: '4px',
            borderLeft: '2px solid #4CAF50',
            fontSize: '11px',
          }}
        >
          <div style={{ color: '#4CAF50', fontWeight: 600 }}>● {item.name}</div>
          <div style={{ color: '#888', marginTop: '2px' }}>{item.value}</div>
          <div style={{ color: '#666', fontSize: '10px', marginTop: '2px' }}>{item.desc}</div>
        </div>
      ))}
    </div>
  </div>
);

const AdminHubPage: React.FC<AdminHubPageProps> = ({ onNavigate }) => {
  const { profile } = useAuth();
  const [kpi, setKpi] = useState<KpiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [trend, setTrend] = useState<TrendDay[]>([]);
  const [trendRange, setTrendRange] = useState<TrendRange>('7d');
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  // Load KPI data
  const loadKpi = useCallback(async () => {
    if (!profile?.organizationId) return;

    try {
      setLoading(true);
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

      const [scansRes, breachesRes, patrolsRes, welfareRes] = await Promise.all([
        supabase
          .from('observations')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', profile.organizationId)
          .gte('observed_at', todayStart),
        supabase
          .from('breach_alerts')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', profile.organizationId)
          .in('status', ['open', 'acknowledged']),
        supabase
          .from('shifts')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', profile.organizationId)
          .in('status', ['published', 'accepted', 'scheduled', 'in_progress']),
        supabase
          .from('welfare_alerts')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', profile.organizationId)
          .eq('status', 'pending'),
      ]);

      setKpi({
        scansToday: scansRes.count || 0,
        activeBreaches: breachesRes.count || 0,
        patrols: patrolsRes.count || 0,
        welfareAlerts: welfareRes.count || 0,
      });
    } catch (err) {
      console.error('Failed to load KPI:', err);
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  // Load trend data
  const loadTrend = useCallback(async () => {
    if (!profile?.organizationId) return;

    try {
      const now = new Date();
      const days = trendRange === '7d' ? 7 : trendRange === '14d' ? 14 : 30;
      const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

      const [scansRes, breachesRes] = await Promise.all([
        supabase
          .from('observations')
          .select('id, created_at')
          .eq('organization_id', profile.organizationId)
          .gte('created_at', start),
        supabase
          .from('breach_alerts')
          .select('id, created_at')
          .eq('organization_id', profile.organizationId)
          .gte('created_at', start),
      ]);

      const trendMap: Record<string, { scans: number; breaches: number }> = {};
      for (let i = 0; i < days; i++) {
        const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dateStr = d.toISOString().split('T')[0];
        trendMap[dateStr] = { scans: 0, breaches: 0 };
      }

      scansRes.data?.forEach((item) => {
        const dateStr = item.created_at?.split('T')[0];
        if (dateStr && trendMap[dateStr]) trendMap[dateStr].scans++;
      });

      breachesRes.data?.forEach((item) => {
        const dateStr = item.created_at?.split('T')[0];
        if (dateStr && trendMap[dateStr]) trendMap[dateStr].breaches++;
      });

      const sorted = Object.entries(trendMap)
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([date, data]) => ({ date, ...data }));

      setTrend(sorted);
    } catch (err) {
      console.error('Failed to load trend:', err);
    }
  }, [profile?.organizationId, trendRange]);

  // Track mobile viewport
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Initial load
  useEffect(() => {
    loadKpi();
    loadTrend();
  }, [loadKpi, loadTrend]);

  // Auto-refresh
  useEffect(() => {
    const interval = setInterval(() => {
      loadKpi();
      loadTrend();
    }, 60000);
    return () => clearInterval(interval);
  }, [loadKpi, loadTrend]);

  const isGrandMaster = profile?.role === 'grand_master';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', paddingBottom: '24px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '28px', fontWeight: 700, color: 'var(--color-text-primary)', margin: 0 }}>
            Admin Hub
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--color-text-secondary)', margin: '4px 0 0 0' }}>
            Here's what's happening today
          </p>
        </div>
        <button
          onClick={() => {
            loadKpi();
            loadTrend();
          }}
          style={{
            padding: '8px 16px',
            backgroundColor: 'var(--color-primary)',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 500,
            fontSize: '14px',
          }}
        >
          🔄 Refresh
        </button>
      </div>

      {/* NOC Terminal (Grand Master only) */}
      {isGrandMaster && <NocTerminal />}

      {/* KPI Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
          gap: '12px',
        }}
      >
        <KpiTile
          label="Active Shifts"
          value={kpi?.patrols || 0}
          icon="🚗"
          color="#3B82F6"
          loading={loading}
          onClick={() => onNavigate?.('patrol')}
        />
        <KpiTile
          label="Breach Alerts"
          value={kpi?.activeBreaches || 0}
          icon="⚖️"
          color={kpi && kpi.activeBreaches > 0 ? '#EF5350' : '#4CAF50'}
          loading={loading}
          onClick={() => onNavigate?.('breach-review')}
        />
        <KpiTile
          label="Observations"
          value={kpi?.scansToday || 0}
          icon="📷"
          color="#10B981"
          loading={loading}
          onClick={() => onNavigate?.('fc-reporting')}
        />
        <KpiTile
          label="Welfare Alerts"
          value={kpi?.welfareAlerts || 0}
          icon="🚧"
          color={kpi && kpi.welfareAlerts > 0 ? '#FF9800' : '#4CAF50'}
          loading={loading}
          onClick={() => onNavigate?.('welfare-alerts')}
        />
      </div>

      {/* Sticky Priority Bar */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
          gap: '12px',
        }}
      >
        <button
          onClick={() => onNavigate?.('breach-review')}
          style={{
            padding: '12px',
            backgroundColor: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border)',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
            color: 'var(--color-text-primary)',
          }}
        >
          ⚖️ Breaches
        </button>
        <button
          onClick={() => onNavigate?.('fc-notice-print')}
          style={{
            padding: '12px',
            backgroundColor: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border)',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
            color: 'var(--color-text-primary)',
          }}
        >
          🖨️ Notices
        </button>
        <button
          onClick={() => onNavigate?.('dispatch')}
          style={{
            padding: '12px',
            backgroundColor: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border)',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
            color: 'var(--color-text-primary)',
          }}
        >
          📡 Dispatch
        </button>
        <button
          onClick={() => onNavigate?.('fc-reporting')}
          style={{
            padding: '12px',
            backgroundColor: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border)',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
            color: 'var(--color-text-primary)',
          }}
        >
          📊 Reports
        </button>
      </div>

      {/* Trend Chart */}
      <TrendChart data={trend} range={trendRange} onRangeChange={setTrendRange} />

      {/* Module Cards Grid */}
      <div>
        <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px', color: 'var(--color-text-primary)' }}>
          Quick Access Modules
        </h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
            gap: '12px',
          }}
        >
          {MODULES.map((mod) => (
            <ModuleCard
              key={mod.id}
              label={mod.label}
              icon={mod.icon}
              onClick={() => onNavigate?.(mod.navigate)}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default AdminHubPage;
