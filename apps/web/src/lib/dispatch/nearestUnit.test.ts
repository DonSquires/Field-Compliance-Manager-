import { describe, expect, it } from 'vitest';
import { findNearestAvailableUnit } from './nearestUnit';

const site = { gpsLat: -36.8485, gpsLng: 174.7633 };

describe('findNearestAvailableUnit', () => {
  it('returns null when the site has no GPS fix', () => {
    expect(findNearestAvailableUnit({ gpsLat: null, gpsLng: null }, [], '')).toBeNull();
    expect(findNearestAvailableUnit(null, [], '')).toBeNull();
  });

  it('returns null when no resource is available with a GPS fix', () => {
    const resources = [
      { id: 'r1', name: 'Unit 1', callsign: null, status: 'busy', gpsLat: -36.85, gpsLng: 174.76 },
      { id: 'r2', name: 'Unit 2', callsign: null, status: 'available', gpsLat: null, gpsLng: null },
    ];
    expect(findNearestAvailableUnit(site, resources, '')).toBeNull();
  });

  it('picks the closest available resource with a GPS fix, ignoring busy/no-GPS ones', () => {
    const resources = [
      { id: 'far', name: 'Far Unit', callsign: 'F1', status: 'available', gpsLat: -37.5, gpsLng: 175.5 },
      { id: 'near', name: 'Near Unit', callsign: 'N1', status: 'available', gpsLat: -36.849, gpsLng: 174.764 },
      { id: 'busy-near', name: 'Busy Unit', callsign: 'B1', status: 'busy', gpsLat: -36.8485, gpsLng: 174.7633 },
    ];
    const result = findNearestAvailableUnit(site, resources, '');
    expect(result?.resourceId).toBe('near');
    expect(result?.label).toBe('N1');
    expect(result?.distanceKm).toBeGreaterThan(0);
  });

  it('falls back to name when callsign is null', () => {
    const resources = [{ id: 'r1', name: 'Unit One', callsign: null, status: 'available', gpsLat: -36.849, gpsLng: 174.764 }];
    expect(findNearestAvailableUnit(site, resources, '')?.label).toBe('Unit One');
  });

  it('returns null when the nearest candidate is already the selected resource', () => {
    const resources = [{ id: 'r1', name: 'Unit One', callsign: null, status: 'available', gpsLat: -36.849, gpsLng: 174.764 }];
    expect(findNearestAvailableUnit(site, resources, 'r1')).toBeNull();
  });
});
