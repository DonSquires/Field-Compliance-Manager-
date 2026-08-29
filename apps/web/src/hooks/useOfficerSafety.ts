/**
 * useOfficerSafety.ts — unified officer welfare/SOS/man-down safety state
 *
 * Rebuilt per docs/ui-baseline.md ("P0 SAFETY-CRITICAL" findings). Replaces
 * THREE original independent, uncoordinated writers to `welfare_alerts`
 * (useWelfareCheckin's time-based missed-check-in detector,
 * useManDownDetection's GPS-motion detector, and useInactivityDetection's
 * gps-lost/inactivity detector) with ONE shared safety-state model, because
 * the originals could each independently reach an "alerting" condition for
 * the same officer with neither aware of the others, and resolving one
 * never reset the others.
 *
 * Corrected defects (all verified against the original behaviour):
 *   1. Movement or a fresh GPS fix alone can NEVER resolve an active alert.
 *      The original auto-resolved a man-down alert purely from GPS movement,
 *      and separately auto-resolved gps_lost/inactivity episodes from
 *      movement OR merely a fresh fix arriving — none of these required an
 *      acknowledgement step. A distressed officer's own struggling movement,
 *      someone else moving the device, or the GPS simply reacquiring a
 *      signal, was enough to silently clear a live emergency in the
 *      original. Here, movement/fixes only update evidence (`recordMovement`);
 *      only an explicit officer action (`checkIn` or `acknowledgeAlert`) can
 *      clear `activeAlert`.
 *   2. Every write checks `{ error }` and surfaces it via `writeStatus`,
 *      instead of silently appearing to succeed on failure (the original
 *      `checkIn`/`triggerSOS`/shift-`respond`-style writes did not).
 *   3. `detectionState` is exposed in plain terms (active / disabled by org /
 *      disabled by officer / unknown) so the officer is never left guessing
 *      whether detection is even running (Bob's UX review item 6).
 *   4. Escalation timing remains entirely server-owned — this hook only
 *      fires the INITIAL alert and reports status; it never re-implements
 *      escalation levels client-side.
 *
 * `motion` (man-down, from useManDownDetection) and `inactivity` (from
 * useInactivityDetection) both derive from time-since-last-movement, with
 * separate thresholds. Whether these two are meant to be genuinely distinct
 * product signals or are themselves an unintentional duplication in the
 * original is an open question recorded in docs/ui-baseline.md — both are
 * preserved here as separate kinds rather than silently merged, since we
 * have no product-owner confirmation either way.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

const DEFAULT_CHECKIN_INTERVAL_MINUTES = 30;
const DEFAULT_STATIONARY_MINUTES = 15;
const DEFAULT_INACTIVITY_MINUTES = 20;
const MOVEMENT_THRESHOLD_M = 25;
const TICK_MS = 10_000;

function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export type SafetyStatus = 'ok' | 'due' | 'overdue' | 'alerting';
export type AlertKind = 'sos' | 'timeout' | 'motion' | 'inactivity' | 'gps_lost';
export type DetectionState = 'active' | 'disabled_by_org' | 'disabled_by_officer' | 'unknown';
export type WriteStatus = 'idle' | 'pending' | 'error';

export interface ActiveAlert {
  id: string;
  kind: AlertKind;
  triggeredAt: Date;
}

export interface UseOfficerSafetyOptions {
  officerId: string | null;
  organizationId: string | null;
  /** From useEnabledModules(...).isModuleEnabled('welfare', { safetyRelevant: true }) */
  orgManDownEnabled: boolean;
  officerManDownEnabled?: boolean;
  checkinIntervalMinutes?: number;
  stationaryMinutes?: number;
  /** Threshold for the gps_lost/inactivity signals (previously useInactivityDetection). */
  inactivityMinutes?: number;
  getGps?: () => Promise<{ lat: number; lng: number } | null>;
}

export interface UseOfficerSafetyApi {
  status: SafetyStatus;
  activeAlert: ActiveAlert | null;
  detectionState: DetectionState;
  minutesRemaining: number;
  writeStatus: WriteStatus;
  lastError: string | null;
  checkIn: () => Promise<boolean>;
  triggerSOS: () => Promise<boolean>;
  /** The ONLY other way to clear an active alert besides checkIn(). */
  acknowledgeAlert: () => Promise<boolean>;
  /** Records a GPS fix as evidence only — never resolves an alert by itself. */
  recordMovement: (lat: number, lng: number) => void;
}

async function defaultGetGps(): Promise<{ lat: number; lng: number } | null> {
  return null;
}

export function useOfficerSafety(options: UseOfficerSafetyOptions): UseOfficerSafetyApi {
  const {
    officerId,
    organizationId,
    orgManDownEnabled,
    officerManDownEnabled = true,
    checkinIntervalMinutes = DEFAULT_CHECKIN_INTERVAL_MINUTES,
    stationaryMinutes = DEFAULT_STATIONARY_MINUTES,
    inactivityMinutes = DEFAULT_INACTIVITY_MINUTES,
    getGps = defaultGetGps,
  } = options;

  const [status, setStatus] = useState<SafetyStatus>('ok');
  const [activeAlert, setActiveAlert] = useState<ActiveAlert | null>(null);
  const [minutesRemaining, setMinutesRemaining] = useState(checkinIntervalMinutes);
  const [writeStatus, setWriteStatus] = useState<WriteStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);

  const lastCheckinRef = useRef<Date>(new Date());
  const lastMovementRef = useRef<{ lat: number; lng: number; at: number } | null>(null);
  const lastFixAtRef = useRef<number | null>(null);
  const lastPositionRef = useRef<{ lat: number; lng: number } | null>(null);
  const activeAlertRef = useRef<ActiveAlert | null>(null);
  useEffect(() => {
    activeAlertRef.current = activeAlert;
  }, [activeAlert]);

  const detectionState: DetectionState =
    !officerId || !organizationId
      ? 'unknown'
      : !orgManDownEnabled
        ? 'disabled_by_org'
        : !officerManDownEnabled
          ? 'disabled_by_officer'
          : 'active';

  // ─── Time-based tick: missed check-in + stationary detection ───────────
  useEffect(() => {
    if (detectionState !== 'active') return;

    function tick() {
      const elapsedMin = (Date.now() - lastCheckinRef.current.getTime()) / 60_000;
      const remaining = Math.max(0, checkinIntervalMinutes - elapsedMin);
      setMinutesRemaining(Math.round(remaining));

      if (activeAlertRef.current) {
        setStatus('alerting');
        return;
      }

      if (elapsedMin >= checkinIntervalMinutes * 2) {
        void fireAlert('timeout');
        return;
      }
      setStatus(remaining <= 0 ? 'overdue' : remaining <= 5 ? 'due' : 'ok');

      const lastMovement = lastMovementRef.current;
      if (lastMovement) {
        const stationaryMin = (Date.now() - lastMovement.at) / 60_000;
        if (stationaryMin >= stationaryMinutes) {
          void fireAlert('motion');
          return;
        }
      }

      // gps_lost takes priority over inactivity: no fix at all beats a fix
      // that arrived but showed no movement.
      const lastFix = lastFixAtRef.current;
      if (lastFix != null) {
        const sinceFixMin = (Date.now() - lastFix) / 60_000;
        if (sinceFixMin >= inactivityMinutes) {
          void fireAlert('gps_lost');
          return;
        }
      }
      if (lastMovement) {
        const sinceMovementMin = (Date.now() - lastMovement.at) / 60_000;
        if (sinceMovementMin >= inactivityMinutes) {
          void fireAlert('inactivity');
        }
      }
    }

    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectionState, checkinIntervalMinutes, stationaryMinutes, inactivityMinutes]);

  const fireAlert = useCallback(
    async (kind: AlertKind) => {
      if (!officerId || !organizationId) return false;
      if (activeAlertRef.current) return false; // duplicate-fire guard
      setWriteStatus('pending');
      const pos = lastPositionRef.current;
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase
        .from('welfare_alerts')
        .insert({
          officer_user_id: officerId,
          organization_id: organizationId,
          alert_type: kind === 'sos' ? 'sos' : kind === 'timeout' ? 'man_down' : kind === 'motion' ? 'man_down' : kind,
          status: 'pending',
          triggered_at: nowIso,
          gps_lat: pos?.lat ?? null,
          gps_lng: pos?.lng ?? null,
          last_activity_at: nowIso,
          escalation_level: 1,
          notes:
            kind === 'sos'
              ? 'SOS triggered by officer'
              : kind === 'timeout'
                ? 'Missed check-in: no check-in received within the expected interval'
                : kind === 'motion'
                  ? 'GPS-stationary: no movement detected'
                  : kind === 'gps_lost'
                    ? 'No GPS fix received within the inactivity threshold'
                    : 'No officer movement within the inactivity threshold',
        })
        .select('id')
        .single();

      if (error || !data) {
        setWriteStatus('error');
        setLastError(error?.message ?? 'Alert could not be recorded');
        return false;
      }
      setActiveAlert({ id: data.id, kind, triggeredAt: new Date() });
      setStatus('alerting');
      setWriteStatus('idle');
      setLastError(null);
      return true;
    },
    [officerId, organizationId],
  );

  const checkIn = useCallback(async () => {
    if (!officerId || !organizationId) return false;
    setWriteStatus('pending');
    const now = new Date();
    const gps = await getGps();

    const { error: checkinError } = await supabase.from('welfare_checks').insert({
      organization_id: organizationId,
      officer_user_id: officerId,
      status: 'ok',
      gps_lat: gps?.lat ?? null,
      gps_lng: gps?.lng ?? null,
      checked_in_at: now.toISOString(),
      notes: 'Officer self check-in',
    });
    if (checkinError) {
      setWriteStatus('error');
      setLastError(checkinError.message);
      return false;
    }

    const { error: settingsError } = await supabase.from('officer_welfare_settings').upsert(
      {
        organization_id: organizationId,
        officer_user_id: officerId,
        check_interval_minutes: checkinIntervalMinutes,
        last_checkin_at: now.toISOString(),
      },
      { onConflict: 'officer_user_id,organization_id' },
    );
    if (settingsError) {
      setWriteStatus('error');
      setLastError(settingsError.message);
      return false;
    }

    // A check-in is itself an explicit officer action, and is treated as a
    // valid positive acknowledgement — clearing any active alert IS allowed
    // here because the officer took a deliberate action, unlike raw movement.
    if (activeAlertRef.current) {
      const { error: alertResolutionError } = await supabase
        .from('welfare_alerts')
        .update({
          status: 'resolved',
          resolved_by: officerId,
          resolved_at: now.toISOString(),
          resolution_notes: 'Resolved by officer check-in',
        })
        .eq('id', activeAlertRef.current.id);
      if (alertResolutionError) {
        setWriteStatus('error');
        setLastError(alertResolutionError.message);
        return false;
      }
      setActiveAlert(null);
    }

    lastCheckinRef.current = now;
    setStatus('ok');
    setWriteStatus('idle');
    setLastError(null);
    return true;
  }, [officerId, organizationId, checkinIntervalMinutes, getGps]);

  const triggerSOS = useCallback(async () => fireAlert('sos'), [fireAlert]);

  const acknowledgeAlert = useCallback(async () => {
    const alert = activeAlertRef.current;
    if (!alert || !officerId) return false;
    setWriteStatus('pending');
    const { error } = await supabase
      .from('welfare_alerts')
      .update({
        status: 'resolved',
        resolved_by: officerId,
        resolved_at: new Date().toISOString(),
        resolution_notes: 'Officer acknowledged and cleared the alert',
      })
      .eq('id', alert.id);
    if (error) {
      setWriteStatus('error');
      setLastError(error.message);
      return false; // active alert is NOT cleared on a failed write
    }
    setActiveAlert(null);
    setStatus('ok');
    setWriteStatus('idle');
    setLastError(null);
    return true;
  }, [officerId]);

  const recordMovement = useCallback((lat: number, lng: number) => {
    // Evidence only. Deliberately does NOT touch activeAlert/status — a GPS
    // fix or genuine movement can never resolve an alert by itself.
    const now = Date.now();
    lastFixAtRef.current = now;
    const prev = lastPositionRef.current;
    if (!prev || haversineMetres(prev.lat, prev.lng, lat, lng) >= MOVEMENT_THRESHOLD_M) {
      lastMovementRef.current = { lat, lng, at: now };
    }
    lastPositionRef.current = { lat, lng };
  }, []);

  return {
    status,
    activeAlert,
    detectionState,
    minutesRemaining,
    writeStatus,
    lastError,
    checkIn,
    triggerSOS,
    acknowledgeAlert,
    recordMovement,
  };
}
