/**
 * officerPinStatus.ts — derives what a map pin should show for an officer.
 *
 * Rebuilt per docs/ui-baseline.md's "LiveMapPage.tsx" findings. The original
 * page derived pin status from GPS recency alone (stale => 'offline',
 * otherwise => 'ok'), even though its own colour legend supports 'due' and
 * 'alert'. That means a genuinely overdue or alerting officer could render
 * as a plain green "ok" pin whenever their GPS happened to still be fresh —
 * officer welfare state and officer GPS recency are unrelated signals and
 * must not be conflated into one value.
 */
import type { SafetyStatus } from '../hooks/useOfficerSafety';

export type OfficerPinStatus = SafetyStatus | 'offline' | 'unknown';

export interface OfficerPinStatusInput {
  /** Milliseconds since the last GPS fix, or null if no fix has ever been received. */
  gpsAgeMs: number | null;
  /**
   * Real welfare/SOS/man-down status from `useOfficerSafety`, or null if that
   * state has not loaded / is gated off. Null must never be presented as 'ok'.
   */
  safetyStatus: SafetyStatus | null;
  /** Defaults to 1 hour, matching the original GPS staleness threshold. */
  gpsStaleThresholdMs?: number;
}

const DEFAULT_GPS_STALE_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * A live alert always wins, even over stale/missing GPS — a phone going
 * quiet does not cancel a real SOS. Unknown welfare state is reported as
 * 'unknown', never defaulted to 'ok', so the map can never show a
 * reassuring green pin for an officer whose real status was never verified.
 */
export function deriveOfficerPinStatus({
  gpsAgeMs,
  safetyStatus,
  gpsStaleThresholdMs = DEFAULT_GPS_STALE_THRESHOLD_MS,
}: OfficerPinStatusInput): OfficerPinStatus {
  if (safetyStatus === 'alerting') return 'alerting';
  if (safetyStatus === null) return 'unknown';
  if (gpsAgeMs === null || gpsAgeMs > gpsStaleThresholdMs) return 'offline';
  return safetyStatus;
}

export interface AdminSafetyStatusInput {
  hasActiveAlert: boolean;
  welfareEnabled: boolean | null;
  lastCheckinAt: string | null;
  checkIntervalMinutes: number | null;
  nowMs?: number;
}

export function deriveAdminSafetyStatus({
  hasActiveAlert,
  welfareEnabled,
  lastCheckinAt,
  checkIntervalMinutes,
  nowMs = Date.now(),
}: AdminSafetyStatusInput): SafetyStatus | null {
  if (hasActiveAlert) return 'alerting';
  if (welfareEnabled !== true || !lastCheckinAt || !checkIntervalMinutes) return null;

  const elapsedMinutes = (nowMs - new Date(lastCheckinAt).getTime()) / 60_000;
  if (!Number.isFinite(elapsedMinutes)) return null;
  if (elapsedMinutes >= checkIntervalMinutes) return 'overdue';
  if (checkIntervalMinutes - elapsedMinutes <= 5) return 'due';
  return 'ok';
}
