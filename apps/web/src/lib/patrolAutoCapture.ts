import { supabase } from './supabase';
import { notifyPatrolCheckpointRecorded } from './patrolCheckpointEvents';

export type PatrolCaptureStatus = { kind: 'waiting' | 'active' | 'warning'; message: string };

type CaptureResponse = {
  shift_id: string;
  status: 'no_session' | 'processed';
  patrol_id: string | null;
  recorded_checkpoint_ids: string[];
  checkpoints: { checkpoint_id: string; status: string }[];
};

const checkpointStatuses = new Set([
  'recorded', 'recorded_unattributed', 'already_recorded', 'unverified', 'not_verified_at_capture', 'missing_or_invalid_geofence',
  'accuracy_too_low', 'outside_geofence', 'boundary_uncertain', 'ambiguous_stop', 'stop_not_active', 'route_not_eligible',
]);

function isCaptureResponse(value: unknown, shiftId: string): value is CaptureResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return data.shift_id === shiftId
    && (data.status === 'no_session' || data.status === 'processed')
    && Array.isArray(data.recorded_checkpoint_ids) && data.recorded_checkpoint_ids.every((id: unknown) => typeof id === 'string')
    && Array.isArray(data.checkpoints) && data.checkpoints.every((checkpoint: unknown) =>
      !!checkpoint && typeof checkpoint === 'object' && 'status' in checkpoint && typeof checkpoint.status === 'string'
        && checkpointStatuses.has(checkpoint.status) && 'checkpoint_id' in checkpoint && typeof checkpoint.checkpoint_id === 'string')
    && (data.status === 'no_session'
      ? data.patrol_id === null && data.recorded_checkpoint_ids.length === 0 && data.checkpoints.length === 0
      : typeof data.patrol_id === 'string' && data.patrol_id.length > 0);
}

export function createPatrolAutoCapture(shiftId: string, onStatus: (status: PatrolCaptureStatus) => void, retryFreshFix: () => void = () => undefined) {
  let active = true;
  let processing = false;
  let patrolId: string | null = null;
  const knownVisits = new Set<string>();
  const pending: GeolocationPosition[] = [];
  const report = (status: PatrolCaptureStatus) => onStatus(status);

  const submit = async (position: GeolocationPosition) => {
    const { latitude, longitude, accuracy } = position.coords;
    const age = Date.now() - position.timestamp;
    if (![latitude, longitude, accuracy, position.timestamp].every(Number.isFinite)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy <= 0 || accuracy > 50
      || age > 30_000 || age < -5_000) {
      report({ kind: 'warning', message: 'A fresh, accurate GPS fix is needed to verify checkpoints. Move to a clear area and try again.' });
      return;
    }

    try {
      const { data, error } = await supabase.rpc('auto_record_patrol_checkpoints', {
        p_shift_id: shiftId, p_gps_lat: latitude, p_gps_lng: longitude,
        p_gps_accuracy: accuracy, p_captured_at: new Date(position.timestamp).toISOString(),
      });
      if (!active) return;
      if (error || !isCaptureResponse(data, shiftId)) {
        console.error('Automatic checkpoint recording failed:', error ?? 'invalid response');
        report({ kind: 'warning', message: 'Automatic checkpoint recording could not be confirmed. Check your connection and try again or contact operations.' });
        if (error?.code === '40001') retryFreshFix();
        return;
      }
      if (data.status === 'no_session') {
        patrolId = null;
        knownVisits.clear();
        report({ kind: 'waiting', message: 'Start a patrol session to enable automatic checkpoint recording.' });
        return;
      }
      if (patrolId !== data.patrol_id) {
        knownVisits.clear();
        patrolId = data.patrol_id;
      }
      const observedVisits = data.checkpoints.filter((checkpoint) => checkpoint.status === 'recorded' || checkpoint.status === 'recorded_unattributed' || checkpoint.status === 'already_recorded')
        .map((checkpoint) => checkpoint.checkpoint_id);
      if (observedVisits.some((id) => !knownVisits.has(id))) notifyPatrolCheckpointRecorded(shiftId);
      observedVisits.forEach((id) => knownVisits.add(id));
      const statuses = new Set(data.checkpoints.map((checkpoint) => checkpoint.status));
      if (statuses.has('recorded_unattributed')) {
        report({ kind: 'warning', message: 'Checkpoint verified and recorded without a stop link. Operations must resolve the matching planned visit.' });
      } else if (['unverified', 'not_verified_at_capture', 'missing_or_invalid_geofence', 'route_not_eligible', 'ambiguous_stop', 'stop_not_active'].some((status) => statuses.has(status))) {
        report({ kind: 'warning', message: 'Some checkpoints cannot be automatically verified. Check the patrol list and contact operations.' });
      } else if (statuses.has('accuracy_too_low') || statuses.has('boundary_uncertain')) {
        report({ kind: 'warning', message: 'GPS accuracy is not sufficient to verify every nearby checkpoint. Move to a clear area and try again.' });
      } else {
        report({ kind: 'active', message: data.recorded_checkpoint_ids.length ? 'Checkpoint verified and recorded.' : 'Automatic checkpoint recording is active.' });
      }
    } catch (error) {
      console.error('Automatic checkpoint recording request failed:', error);
      if (active) report({ kind: 'warning', message: 'Automatic checkpoint recording could not be confirmed. Check your connection and try again or contact operations.' });
    }
  };

  const capture = (position: GeolocationPosition) => {
    if (!active) return;
    if (pending.length >= 50) {
      report({ kind: 'warning', message: 'Location updates could not all be checked in time. Check your patrol and contact operations.' });
      return;
    }
    pending.push(position);
    if (processing) return;
    processing = true;
    void (async () => {
      while (active && pending.length) {
        const next = pending.shift();
        if (!next) break;
        await submit(next);
      }
      processing = false;
    })();
  };

  return {
    capture,
    sessionStarted: () => { knownVisits.clear(); },
    stop: () => { active = false; pending.length = 0; },
  };
}
