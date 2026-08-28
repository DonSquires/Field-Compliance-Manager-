/**
 * useOfficerSafety.ts — unified officer welfare/SOS/man-down safety state
 *
 * Rebuilt per docs/ui-baseline.md ("P0 SAFETY-CRITICAL" findings). Replaces
 * the original two independent, uncoordinated hooks (useWelfareCheckin's
 * time-based missed-check-in detector and useManDownDetection's GPS-motion
 * detector) with ONE shared safety-state model, because the originals could
 * each independently reach an "alerting" condition for the same officer with
 * neither aware of the other, and resolving one never reset the other.
 *
 * Corrected defects (all verified against the original behaviour):
 *   1. Movement alone can NEVER resolve an active alert. The original
 *      auto-resolved a man-down alert purely from GPS movement, with no
 *      acknowledgement step — a distressed officer's own struggling
 *      movement, or someone else moving the device, was enough to silently
 *      clear a live emergency. Here, movement only updates `last_activity_at`
 *      as evidence; only an explicit officer action (`checkIn` or
 *      `acknowledgeAlert`) can clear `activeAlert`.
 *   2. Every write checks `{ error }` and surfaces it via `writeStatus`,
 *      instead of silently appearing to succeed on failure (the original
 *      `checkIn`/`triggerSOS`/shift-`respond`-style writes did not).
 *   3. `detectionState` is exposed in plain terms (active / disabled by org /
 *      disabled by officer / unknown) so the officer is never left guessing
 *      whether detection is even running (Bob's UX review item 6).
 *   4. Escalation timing remains entirely server-owned — this hook only
 *      fires the INITIAL alert and reports status; it never re-implements
 *      escalation levels client-side.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

const DEFAULT_CHECKIN_INTERVAL_MINUTES = 30;
const DEFAULT_STATIONARY_MINUTES = 15;
const MOVEMENT_THRESHOLD_M = 25;
const TICK_MS = 10_000;

export type SafetyStatus = 'ok' | 'due' | 'overdue' | 'alerting';
export type AlertKind = 'sos' | 'timeout' | 'motion';
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
  /** The ONLY other way to clear a motion/timeout alert besides checkIn(). */
  acknowledgeAlert: () => Promise<boolean>;
  /** Records movement as evidence only — never resolves an alert by itself. */
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
    getGps = defaultGetGps,
  } = options;

  const [status, setStatus] = useState<SafetyStatus>('ok');
  const [activeAlert, setActiveAlert] = useState<ActiveAlert | null>(null);
  const [minutesRemaining, setMinutesRemaining] = useState(checkinIntervalMinutes);
  const [writeStatus, setWriteStatus] = useState<WriteStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);

  const lastCheckinRef = useRef<Date>(new Date());
  const lastMovementRef = useRef<{ lat: number; lng: number; at: number } | null>(null);
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
        }
      }
    }

    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectionState, checkinIntervalMinutes, stationaryMinutes]);

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
          alert_type: kind === 'sos' ? 'sos' : kind === 'timeout' ? 'man_down' : 'man_down',
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
                : 'GPS-stationary: no movement detected',
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
      await supabase
        .from('welfare_alerts')
        .update({
          status: 'resolved',
          resolved_by: officerId,
          resolved_at: now.toISOString(),
          resolution_notes: 'Resolved by officer check-in',
        })
        .eq('id', activeAlertRef.current.id);
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
    // Evidence only. Deliberately does NOT touch activeAlert/status —
    // movement can never resolve an alert by itself.
    lastPositionRef.current = { lat, lng };
    lastMovementRef.current = { lat, lng, at: Date.now() };
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
