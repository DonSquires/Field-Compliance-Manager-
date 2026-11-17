import type { PatrolCheckpoint } from '../components/PatrolCheckpointList';

export interface PatrolJourneyStop {
  id: string;
  stop_order: number;
  visit_number: number;
  status: string;
  place: {
    kind: 'site' | 'zone' | 'unknown';
    site_id: string | null;
    zone_id: string | null;
    name: string | null;
    address: string | null;
    coordinates: { lat: number; lng: number; source: 'site_center' | 'zone_center' } | null;
  };
  clients: Array<{ id: string; name: string }>;
  client_attribution_complete: boolean;
}

export interface PatrolJourney {
  shift_id: string;
  patrol_id: string | null;
  checkpoint_requirement: 'route' | 'site_zone';
  route_geometry: null;
  route_geometry_status: 'unavailable';
  stops: PatrolJourneyStop[];
  checkpoints: PatrolCheckpoint[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

function isStop(value: unknown): value is PatrolJourneyStop {
  if (!isRecord(value) || !isRecord(value.place) || !Array.isArray(value.clients)) return false;
  const place = value.place;
  const coordinates = place.coordinates;
  return typeof value.id === 'string' && typeof value.stop_order === 'number' && typeof value.visit_number === 'number'
    && typeof value.status === 'string' && typeof value.client_attribution_complete === 'boolean'
    && ['site', 'zone', 'unknown'].includes(String(place.kind)) && nullableString(place.site_id)
    && nullableString(place.zone_id) && nullableString(place.name) && nullableString(place.address)
    && (coordinates === null || (isRecord(coordinates) && typeof coordinates.lat === 'number' && Number.isFinite(coordinates.lat)
      && coordinates.lat >= -90 && coordinates.lat <= 90 && typeof coordinates.lng === 'number'
      && Number.isFinite(coordinates.lng) && coordinates.lng >= -180 && coordinates.lng <= 180
      && (coordinates.source === 'site_center' || coordinates.source === 'zone_center')))
    && value.clients.every((client: unknown) => isRecord(client) && typeof client.id === 'string' && typeof client.name === 'string');
}

function isCheckpoint(value: unknown): value is PatrolCheckpoint {
  return isRecord(value) && typeof value.id === 'string' && (value.kind === 'site' || value.kind === 'route')
    && typeof value.name === 'string' && typeof value.required === 'boolean' && typeof value.visited === 'boolean'
    && nullableString(value.site_id) && nullableString(value.zone_id)
    && (value.sequence_order === null || typeof value.sequence_order === 'number')
    && ['verified', 'unverified', 'missing_or_invalid_geofence', 'unavailable_route'].includes(String(value.auto_geofence_status))
    && Array.isArray(value.stop_ids) && value.stop_ids.every((id: unknown) => typeof id === 'string');
}

export function parsePatrolJourney(value: unknown, shiftId: string): PatrolJourney {
  if (!isRecord(value) || value.shift_id !== shiftId || !nullableString(value.patrol_id)
    || (value.checkpoint_requirement !== 'route' && value.checkpoint_requirement !== 'site_zone')
    || value.route_geometry !== null || value.route_geometry_status !== 'unavailable'
    || !Array.isArray(value.stops) || !value.stops.every(isStop)
    || !Array.isArray(value.checkpoints) || !value.checkpoints.every(isCheckpoint)) {
    throw new Error('The patrol plan could not be confirmed. Retry or contact operations.');
  }
  return {
    shift_id: shiftId, patrol_id: value.patrol_id, checkpoint_requirement: value.checkpoint_requirement,
    route_geometry: null, route_geometry_status: 'unavailable', stops: value.stops, checkpoints: value.checkpoints,
  };
}
