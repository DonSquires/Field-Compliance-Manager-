import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Crosshair, MapPin, RefreshCw, ShieldAlert, ShieldCheck, WifiOff } from 'lucide-react';
import type { SafetyStatus } from '../hooks/useOfficerSafety';
import { useAuth } from '../context/AuthContext';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { SafetyGate } from '../components/SafetyGate';
import { deriveAdminSafetyStatus, deriveOfficerPinStatus, type OfficerPinStatus } from '../lib/officerPinStatus';
import { supabase } from '../lib/supabase';
import './LiveMapPage.css';

interface GpsPing {
  id: string;
  officer_id: string;
  gps_lat: number | null;
  gps_lng: number | null;
  activity_type: string;
  speed_kmh: number | null;
  created_at: string;
}

interface OfficerLatest extends GpsPing {
  officer_name: string;
  safety_status: SafetyStatus | null;
  pin_status: OfficerPinStatus;
}

interface WelfareSetting {
  officer_user_id: string;
  welfare_check_enabled: boolean;
  check_interval_minutes: number;
  last_checkin_at: string | null;
}

interface ActiveWelfareAlert {
  id: string;
  officer_user_id: string;
  gps_lat: number | null;
  gps_lng: number | null;
  triggered_at: string;
}

const STATUS_LABEL: Record<OfficerPinStatus, string> = {
  ok: 'Safety OK',
  due: 'Check-in due',
  overdue: 'Check-in overdue',
  alerting: 'Active alert',
  offline: 'GPS offline',
  unknown: 'Safety unknown',
};

const LiveMapPage: React.FC = () => {
  const { profile } = useAuth();
  const { status: moduleStatus, isModuleEnabled } = useEnabledModules(profile?.organizationId);
  const welfareEnabled = isModuleEnabled('welfare', { safetyRelevant: true });
  const [positions, setPositions] = useState<OfficerLatest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [safetyError, setSafetyError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const loadPositions = useCallback(async () => {
    const orgId = profile?.organizationId;
    if (!orgId) return;

    setLoading(true);
    setError(null);
    setSafetyError(null);
    let safetyLoadFailed = false;
    try {
      const since = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      const { data, error: gpsError } = await supabase
        .from('officer_gps_log')
        .select('id, officer_id, gps_lat, gps_lng, activity_type, speed_kmh, created_at')
        .eq('organization_id', orgId)
        .gte('created_at', since)
        .order('created_at', { ascending: false });
      if (gpsError) throw gpsError;

      const latestByOfficer = new Map<string, GpsPing>();
      ((data as GpsPing[]) ?? []).forEach((row) => {
        if (!latestByOfficer.has(row.officer_id)) latestByOfficer.set(row.officer_id, row);
      });

      const activeAlerts = new Map<string, ActiveWelfareAlert>();
      if (welfareEnabled) {
        const { data: alertRows, error: alertError } = await supabase
          .from('welfare_alerts')
          .select('id, officer_user_id, gps_lat, gps_lng, triggered_at')
          .eq('organization_id', orgId)
          .in('status', ['pending', 'acknowledged'])
          .order('triggered_at', { ascending: false });
        if (alertError) {
          safetyLoadFailed = true;
          setSafetyError(alertError.message);
        } else {
          (alertRows as ActiveWelfareAlert[] ?? []).forEach((alert) => {
            if (!activeAlerts.has(alert.officer_user_id)) activeAlerts.set(alert.officer_user_id, alert);
          });
        }
      }

      const officerIds = Array.from(new Set([...latestByOfficer.keys(), ...activeAlerts.keys()]));
      const names: Record<string, string> = {};
      const safetyByOfficer = new Map<string, SafetyStatus | null>();

      if (officerIds.length > 0) {
        const { data: profiles, error: profileError } = await supabase
          .from('user_profiles')
          .select('id, display_name')
          .in('id', officerIds);
        if (profileError) throw profileError;
        (profiles ?? []).forEach((officer: { id: string; display_name: string | null }) => {
          names[officer.id] = officer.display_name || officer.id;
        });

        if (welfareEnabled) {
          const settingsResponse = await supabase
            .from('officer_welfare_settings')
            .select('officer_user_id, welfare_check_enabled, check_interval_minutes, last_checkin_at')
            .eq('organization_id', orgId)
            .in('officer_user_id', officerIds);

          if (settingsResponse.error) {
            safetyLoadFailed = true;
            setSafetyError(settingsResponse.error.message);
          } else {
            const settings = new Map((settingsResponse.data as WelfareSetting[] ?? []).map((setting) => [setting.officer_user_id, setting]));
            officerIds.forEach((officerId) => {
              const setting = settings.get(officerId);
              safetyByOfficer.set(officerId, deriveAdminSafetyStatus({
                hasActiveAlert: activeAlerts.has(officerId),
                welfareEnabled: setting?.welfare_check_enabled ?? null,
                lastCheckinAt: setting?.last_checkin_at ?? null,
                checkIntervalMinutes: setting?.check_interval_minutes ?? null,
              }));
            });
          }
        }
      }

      const now = Date.now();
      const allRows: GpsPing[] = [...latestByOfficer.values()];
      activeAlerts.forEach((alert, officerId) => {
        if (!latestByOfficer.has(officerId)) {
          allRows.push({
            id: alert.id,
            officer_id: officerId,
            gps_lat: alert.gps_lat,
            gps_lng: alert.gps_lng,
            activity_type: 'active_welfare_alert',
            speed_kmh: null,
            created_at: alert.triggered_at,
          });
        }
      });

      setPositions(allRows.map((row) => {
        const safetyStatus = welfareEnabled && !safetyLoadFailed ? safetyByOfficer.get(row.officer_id) ?? null : null;
        const hasGps = row.gps_lat != null && row.gps_lng != null;
        return {
          ...row,
          officer_name: names[row.officer_id] || row.officer_id,
          safety_status: safetyStatus,
          pin_status: deriveOfficerPinStatus({ gpsAgeMs: hasGps ? now - new Date(row.created_at).getTime() : null, safetyStatus }),
        };
      }));
      setRefreshedAt(new Date());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Live positions could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId, welfareEnabled]);

  useEffect(() => {
    void loadPositions();
    const interval = window.setInterval(() => void loadPositions(), 30_000);
    return () => window.clearInterval(interval);
  }, [loadPositions]);

  useEffect(() => {
    if (!profile?.organizationId) return;
    const gpsChannel = supabase
      .channel(`live_positions_${profile.organizationId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'officer_gps_log', filter: `organization_id=eq.${profile.organizationId}` }, () => void loadPositions())
      .subscribe();
    const welfareChannel = welfareEnabled
      ? supabase
          .channel(`live_safety_${profile.organizationId}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'welfare_alerts', filter: `organization_id=eq.${profile.organizationId}` }, () => void loadPositions())
          .on('postgres_changes', { event: '*', schema: 'public', table: 'officer_welfare_settings', filter: `organization_id=eq.${profile.organizationId}` }, () => void loadPositions())
          .subscribe()
      : null;
    return () => {
      void supabase.removeChannel(gpsChannel);
      if (welfareChannel) void supabase.removeChannel(welfareChannel);
    };
  }, [loadPositions, profile?.organizationId, welfareEnabled]);

  const counts = useMemo(() => positions.reduce<Record<OfficerPinStatus, number>>((result, officer) => {
    result[officer.pin_status] += 1;
    return result;
  }, { ok: 0, due: 0, overdue: 0, alerting: 0, offline: 0, unknown: 0 }), [positions]);

  return (
    <div className="live-ops-page">
      <header className="live-ops-heading">
        <div><span>Field operations</span><h1>Live officer status</h1><p>GPS position and welfare state are separate operational signals.</p></div>
        <button type="button" onClick={() => void loadPositions()} disabled={loading}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /> Refresh</button>
      </header>

      {error && <div className="live-ops-message is-error" role="alert"><AlertTriangle size={17} /> {error}</div>}

      <SafetyGate
        status={moduleStatus}
        isEnabled={welfareEnabled}
        moduleLabel="Welfare monitoring"
        safetyRelevant
        renderUnavailable={(message) => <div className="live-ops-message is-warning" role="status"><ShieldAlert size={17} /><div><strong>{message.title}</strong><span>{message.description}</span></div></div>}
      >
        {safetyError ? <div className="live-ops-message is-error" role="alert"><AlertTriangle size={17} /><div><strong>Safety state unavailable</strong><span>{safetyError}. GPS positions remain visible, but no officer is shown as safe.</span></div></div> : (
          <section className="live-ops-summary" aria-label="Officer safety status">
            <div className="status-alerting"><ShieldAlert size={18} /><span>Active alerts</span><strong>{counts.alerting}</strong></div>
            <div className="status-overdue"><AlertTriangle size={18} /><span>Overdue</span><strong>{counts.overdue}</strong></div>
            <div className="status-due"><Crosshair size={18} /><span>Due</span><strong>{counts.due}</strong></div>
            <div className="status-ok"><ShieldCheck size={18} /><span>Safety OK</span><strong>{counts.ok}</strong></div>
          </section>
        )}
      </SafetyGate>

      <div className="live-ops-meta"><span>{positions.length} officers seen in the last four hours</span><span>{refreshedAt ? `Updated ${refreshedAt.toLocaleTimeString('en-NZ')}` : 'Not yet refreshed'}</span></div>

      {loading && positions.length === 0 ? <div className="live-ops-empty"><RefreshCw size={21} className="is-spinning" /> Loading live positions</div> : positions.length === 0 ? <div className="live-ops-empty"><WifiOff size={21} /> No officers have reported a position in the last four hours</div> : (
        <div className="live-ops-list">{positions.map((officer) => <OfficerRow officer={officer} showSafety={welfareEnabled && !safetyError} key={officer.officer_id} />)}</div>
      )}
    </div>
  );
};

function OfficerRow({ officer, showSafety }: { officer: OfficerLatest; showSafety: boolean }) {
  const hasGps = officer.gps_lat != null && officer.gps_lng != null;
  const gpsAgeMinutes = hasGps ? Math.max(0, Math.floor((Date.now() - new Date(officer.created_at).getTime()) / 60_000)) : null;
  return (
    <article className={`live-officer-row status-${officer.pin_status}`}>
      <span className="live-officer-marker"><MapPin size={18} /></span>
      <div><strong>{officer.officer_name}</strong><small>{officer.activity_type.replace(/_/g, ' ')}{officer.speed_kmh != null ? ` · ${officer.speed_kmh.toFixed(0)} km/h` : ''}</small></div>
      <div className="live-gps-fact"><span>GPS</span><strong>{gpsAgeMinutes == null ? 'No fix' : gpsAgeMinutes < 60 ? `${gpsAgeMinutes}m ago` : `${Math.floor(gpsAgeMinutes / 60)}h ago`}</strong><small>{hasGps ? `${officer.gps_lat?.toFixed(5)}, ${officer.gps_lng?.toFixed(5)}` : 'Location unavailable'}</small></div>
      {showSafety ? <span className={`live-safety-status status-${officer.pin_status}`}>{STATUS_LABEL[officer.pin_status]}</span> : <span className="live-safety-status status-unknown">Safety unavailable</span>}
      {hasGps ? <a href={`https://www.google.com/maps?q=${officer.gps_lat},${officer.gps_lng}`} target="_blank" rel="noreferrer" title="Open position"><MapPin size={16} /><span className="sr-only">Open position</span></a> : <span className="live-position-unavailable"><WifiOff size={15} /></span>}
    </article>
  );
}

export default LiveMapPage;