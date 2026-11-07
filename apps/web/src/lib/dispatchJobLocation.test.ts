import { describe, expect, it } from 'vitest';
import { addressFromBriefing, boundaryCentre, directionsUrl, resolveDispatchDestination } from './dispatchJobLocation';

const square = { type: 'Polygon', coordinates: [[[175, -41], [175.2, -41], [175.2, -41.2], [175, -41.2]]] };

describe('resolveDispatchDestination', () => {
  it('prefers site GPS', () => {
    const result = resolveDispatchDestination({ site: { name: 'Depot', gps_lat: -41.1, gps_lng: 175.1 }, zone: { center_point: { coordinates: [170, -40] } } });
    expect(result).toMatchObject({ kind: 'coordinates', source: 'site', lat: -41.1, lng: 175.1, label: 'Depot' });
  });

  it('routes a zone-only job (no site, no location) to the zone centre, then the boundary centre', () => {
    expect(resolveDispatchDestination({ site: null, zone: { name: 'Gibbons', center_point: { coordinates: [175.05, -41.12] } } }))
      .toMatchObject({ kind: 'coordinates', source: 'zone_centre', lat: -41.12, lng: 175.05, label: 'Gibbons' });
    const fromBoundary = resolveDispatchDestination({ zone: { name: 'Gibbons', center_point: null, boundary: square } });
    expect(fromBoundary.kind).toBe('coordinates');
    if (fromBoundary.kind === 'coordinates') {
      expect(fromBoundary.source).toBe('zone_boundary');
      expect(fromBoundary.lat).toBeCloseTo(-41.1);
      expect(fromBoundary.lng).toBeCloseTo(175.1);
    }
  });

  it('uses site then complainant address before zone geometry', () => {
    expect(resolveDispatchDestination({ site: { address: '1 Main Street' }, harmed_party_address: '2 Other Road' })).toMatchObject({ kind: 'address', source: 'site_address', address: '1 Main Street' });
    expect(resolveDispatchDestination({ harmed_party_address: '2 Other Road', zone: { boundary: square } })).toMatchObject({ kind: 'address', source: 'harmed_party_address' });
  });

  it('falls back to an address in the briefing, otherwise reports no map location', () => {
    expect(resolveDispatchDestination({ briefing_notes: 'Noise complaint. Attend 12 Gibbons Road, Upper Hutt. Ask for owner.' }))
      .toMatchObject({ kind: 'address', source: 'briefing', address: '12 Gibbons Road, Upper Hutt' });
    expect(resolveDispatchDestination({ briefing_notes: 'Call the client first.' })).toEqual({ kind: 'none', label: 'Dispatch location' });
  });
});

describe('location helpers', () => {
  it('ignores invalid geometry', () => {
    expect(boundaryCentre(null)).toBeNull();
    expect(boundaryCentre({ coordinates: [] })).toBeNull();
    expect(addressFromBriefing(null)).toBeNull();
  });

  it('builds an external Google Maps directions link', () => {
    expect(directionsUrl({ lat: -41.1, lng: 175.1 })).toBe('https://www.google.com/maps/dir/?api=1&destination=-41.100000%2C175.100000');
    expect(directionsUrl('12 Gibbons Road')).toContain('destination=12%20Gibbons%20Road');
  });
});
