export type VisitMode = 'gps' | 'manual';
export type CheckpointVisitScanMethod = 'qr_camera' | 'nfc' | 'manual_code' | 'url_deep_link';

export type CheckpointVisitEvaluation = {
  mode: VisitMode;
  accepted: boolean;
  distanceMetres: number | null;
  withinRadius: boolean | null;
  reason:
    | 'gps_within_radius'
    | 'gps_outside_radius'
    | 'gps_missing_manual_allowed'
    | 'gps_missing_manual_blocked'
    | 'gps_inaccurate';
};

export function mapCheckpointVisitScanMethod({
  mode,
  accepted,
}: {
  mode: VisitMode;
  accepted: boolean;
}): CheckpointVisitScanMethod {
  if (mode === 'manual') return 'manual_code';
  return accepted ? 'qr_camera' : 'url_deep_link';
}

export function countCompletedCheckpoints(
  visits: Array<{ checkpoint_id: string | null | undefined }>
): number {
  return new Set(
    visits
      .map((visit) => visit.checkpoint_id)
      .filter((checkpointId): checkpointId is string => Boolean(checkpointId))
  ).size;
}

export function evaluateCheckpointVisit({
  checkpointLat,
  checkpointLng,
  officerLat,
  officerLng,
  checkpointRadiusMetres,
  gpsPrecisionMetres,
  allowManualFallback = false,
}: {
  checkpointLat: number | null;
  checkpointLng: number | null;
  officerLat: number | null;
  officerLng: number | null;
  checkpointRadiusMetres: number;
  gpsPrecisionMetres?: number | null;
  allowManualFallback?: boolean;
}): CheckpointVisitEvaluation {
  const safeRadius = Number.isFinite(checkpointRadiusMetres) && checkpointRadiusMetres > 0
    ? checkpointRadiusMetres
    : 0;

  const precision = Number.isFinite(gpsPrecisionMetres ?? NaN) ? (gpsPrecisionMetres ?? 0) : 0;

  if (
    checkpointLat == null ||
    checkpointLng == null ||
    officerLat == null ||
    officerLng == null
  ) {
    return {
      mode: 'manual',
      accepted: allowManualFallback,
      distanceMetres: null,
      withinRadius: null,
      reason: allowManualFallback
        ? 'gps_missing_manual_allowed'
        : 'gps_missing_manual_blocked',
    };
  }

  const distanceMetres = haversineMeters(
    officerLat,
    officerLng,
    checkpointLat,
    checkpointLng,
  );

  const gpsIsReliableEnough =
    precision <= safeRadius || precision === 0 || Number.isNaN(precision);

  if (!gpsIsReliableEnough) {
    return {
      mode: 'gps',
      accepted: false,
      distanceMetres,
      withinRadius: false,
      reason: 'gps_inaccurate',
    };
  }

  const withinRadius = distanceMetres <= safeRadius;

  return {
    mode: 'gps',
    accepted: withinRadius,
    distanceMetres,
    withinRadius,
    reason: withinRadius
      ? 'gps_within_radius'
      : 'gps_outside_radius',
  };
}

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const earthRadiusMeters = 6371000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const deltaLat = toRadians(lat2 - lat1);
  const deltaLng = toRadians(lng2 - lng1);

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(deltaLng / 2) *
      Math.sin(deltaLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusMeters * c;
}
