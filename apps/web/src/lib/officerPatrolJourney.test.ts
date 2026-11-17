import { describe, expect, it } from 'vitest';
import { parsePatrolJourney } from './officerPatrolJourney';

const plan = {
  shift_id: 'shift', patrol_id: null, checkpoint_requirement: 'site_zone', route_geometry: null,
  route_geometry_status: 'unavailable', stops: [{
    id: 'stop', stop_order: 1, visit_number: 1, status: 'pending',
    place: { kind: 'site', site_id: 'site', zone_id: null, name: 'Site', address: null, coordinates: null },
    clients: [], client_attribution_complete: false,
  }],
  checkpoints: [{ id: 'checkpoint', kind: 'site', name: 'Gate', required: true, visited: false,
    sequence_order: null, site_id: 'site', zone_id: null, stop_ids: ['stop'], auto_geofence_status: 'verified' }],
};

describe('patrol plan validation', () => {
  it('accepts a complete plan only for the selected shift', () => {
    expect(parsePatrolJourney(plan, 'shift').stops[0].id).toBe('stop');
    expect(() => parsePatrolJourney(plan, 'other')).toThrow('could not be confirmed');
  });

  it('rejects malformed checkpoints and invalid coordinates instead of showing an empty plan', () => {
    expect(() => parsePatrolJourney({ ...plan, checkpoints: [{ ...plan.checkpoints[0], required: null }] }, 'shift')).toThrow();
    expect(() => parsePatrolJourney({ ...plan, stops: [{ ...plan.stops[0], place: {
      ...plan.stops[0].place, coordinates: { lat: 999, lng: 174, source: 'site_center' },
    } }] }, 'shift')).toThrow();
  });
});
