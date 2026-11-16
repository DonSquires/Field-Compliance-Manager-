import { describe, expect, it } from 'vitest';
import { metresOutsideBoundary, orderZonesByParent, partOfOptions, placeAdvisories, placeLayerGates, type LayerCheckpoint, type LayerZone } from './placeLayers';

const square = (lng: number, lat: number, half: number): GeoJSON.Polygon => ({
  type: 'Polygon',
  coordinates: [[[lng - half, lat - half], [lng + half, lat - half], [lng + half, lat + half], [lng - half, lat + half], [lng - half, lat - half]]],
});

const zone = (id: string, name: string, extra: Partial<LayerZone> = {}): LayerZone => ({
  id, name, boundary: square(173, -41.3, 0.01), boundary_verification: 'verified', parent_zone_id: null, ...extra,
});

const checkpoint = (id: string, extra: Partial<LayerCheckpoint> = {}): LayerCheckpoint => ({
  id, name: `Checkpoint ${id}`, gps_lat: -41.3, gps_lng: 173, checkpoint_verification: 'verified', active: true, zone_id: 'estate', client_site_id: null, ...extra,
});

describe('place layer gates', () => {
  it('counts each layer separately instead of calling work areas place boundaries', () => {
    const gates = placeLayerGates([], [zone('estate', 'Estate'), zone('north', 'North'), zone('south', 'South')], [1, 2, 3, 4, 5, 6].map((n) => checkpoint(String(n))));
    expect(gates.layers).toEqual(['Sites 0', 'Work areas 3 · 3 confirmed', 'Checkpoints 6 · 6 confirmed']);
    expect(gates.review).toEqual({ count: 0, label: 'All boundaries confirmed' });
  });

  it('collapses review into one gate that names how many boundaries still need review', () => {
    const gates = placeLayerGates(
      [{ id: 's', name: 'Gatehouse', boundary: null, boundary_verification: 'unverified' }],
      [zone('estate', 'Estate'), zone('north', 'North', { boundary_verification: 'unverified' })],
      [checkpoint('1'), checkpoint('2', { checkpoint_verification: 'unverified' })],
    );
    expect(gates.layers).toEqual(['Sites 1 · 0 confirmed', 'Work areas 2 · 1 confirmed', 'Checkpoints 2 · 1 confirmed']);
    expect(gates.review).toEqual({ count: 2, label: '2 need review' });
    expect(placeLayerGates([], [zone('north', 'North', { boundary: null })]).review.label).toBe('1 needs review');
  });

  it('does not claim success for a place with no Sites or work areas', () => {
    const gates = placeLayerGates([], []);
    expect(gates.review).toEqual({ count: 0, label: 'No boundaries yet' });
    expect(gates.ready).toBe(false);
    expect(placeLayerGates([], [], [checkpoint('1')]).ready).toBe(false);
    expect(placeLayerGates([], [zone('estate', 'Estate')]).ready).toBe(true);
    expect(placeLayerGates([], [zone('estate', 'Estate', { boundary_verification: 'unverified' })]).ready).toBe(false);
  });

  it('counts only active checkpoints as confirmed', () => {
    const gates = placeLayerGates([], [zone('estate', 'Estate')], [checkpoint('1'), checkpoint('2', { active: false }), checkpoint('3', { active: false, checkpoint_verification: 'unverified' })]);
    expect(gates.layers[2]).toBe('Checkpoints 3 · 1 confirmed');
  });

  it('omits the checkpoint count when the map was not given checkpoints, rather than showing a false zero', () => {
    expect(placeLayerGates([], [zone('estate', 'Estate')]).layers).toEqual(['Sites 0', 'Work areas 1 · 1 confirmed']);
  });
});

describe('work-area nesting', () => {
  const zones = [
    zone('south', 'South', { parent_zone_id: 'estate' }),
    zone('estate', 'Estate'),
    zone('beach', 'Beach', { parent_zone_id: 'south' }),
    zone('north', 'North', { parent_zone_id: 'estate' }),
    zone('ferry', 'Ferry'),
  ];

  it('orders the picker with each part indented under the area it is part of', () => {
    expect(orderZonesByParent(zones).map(({ zone: item, depth }) => `${depth}:${item.id}`)).toEqual(['0:estate', '1:north', '1:south', '2:beach', '0:ferry']);
  });

  it('treats a parent outside the list, or a cycle, as top level so no area disappears', () => {
    const ordered = orderZonesByParent([zone('a', 'A', { parent_zone_id: 'b' }), zone('b', 'B', { parent_zone_id: 'a' }), zone('c', 'C', { parent_zone_id: 'gone' })]);
    expect(ordered.map(({ zone: item }) => item.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('offers every other area except the area itself and its own parts', () => {
    expect(partOfOptions(zones, 'south').map(({ zone: item }) => item.id)).toEqual(['estate', 'north', 'ferry']);
    expect(partOfOptions(zones, 'estate').map(({ zone: item }) => item.id)).toEqual(['ferry']);
    expect(partOfOptions(zones, 'beach').map(({ zone: item }) => item.id)).toEqual(['estate', 'north', 'south', 'ferry']);
  });
});

describe('advisory containment', () => {
  it('measures how far a point lies outside a boundary and returns zero inside', () => {
    const boundary = square(173, -41.3, 0.001);
    expect(metresOutsideBoundary({ lat: -41.3, lng: 173 }, boundary)).toBe(0);
    const outside = metresOutsideBoundary({ lat: -41.3, lng: 173.001 + 0.0015 }, boundary)!;
    expect(outside).toBeGreaterThan(120);
    expect(outside).toBeLessThan(130);
    expect(metresOutsideBoundary({ lat: -41.3, lng: 173 }, null)).toBeNull();
  });

  it('respects holes and multipolygons', () => {
    const withHole: GeoJSON.Polygon = { type: 'Polygon', coordinates: [square(173, -41.3, 0.01).coordinates[0], square(173, -41.3, 0.001).coordinates[0]] };
    expect(metresOutsideBoundary({ lat: -41.3, lng: 173 }, withHole)).toBeGreaterThan(80);
    const multi: GeoJSON.MultiPolygon = { type: 'MultiPolygon', coordinates: [square(173, -41.3, 0.001).coordinates, square(174, -41.3, 0.001).coordinates] };
    expect(metresOutsideBoundary({ lat: -41.3, lng: 174 }, multi)).toBe(0);
  });

  it('warns, without blocking, when a part extends outside its area or a checkpoint lies outside its own work area', () => {
    const zones = [
      zone('estate', 'Estate'),
      zone('rough', 'Rough', { parent_zone_id: 'estate', parent_containment: { status: 'measured', child_hectares: 259, inside_parent_percent: 76.7, outside_parent_hectares: 60.3, checkpoints_outside: [] } }),
      zone('inner', 'Inner', { parent_zone_id: 'estate', parent_containment: { status: 'measured', child_hectares: 10, inside_parent_percent: 100, outside_parent_hectares: 0, checkpoints_outside: [] } }),
    ];
    const advisories = placeAdvisories([], zones, [
      checkpoint('ramp', { name: 'Boat ramp', gps_lng: 173.01 + 0.0015 }),
      checkpoint('gate', { name: 'Gate' }),
      checkpoint('old', { name: 'Old ramp', gps_lng: 173.05, active: false }),
    ]);
    expect(advisories).toHaveLength(2);
    expect(advisories[0]).toEqual({ id: 'zone:rough', text: 'Rough extends 60.3 ha outside Estate, the area it is part of' });
    expect(advisories[1].id).toBe('checkpoint:ramp');
    expect(advisories[1].text).toMatch(/^Checkpoint Boat ramp is 12[4-7] m outside its work area Estate$/);
  });

  it('ignores edge slivers: a part must extend at least 0.1 ha and 0.5% of its area outside before it is flagged', () => {
    const part = (id: string, child: number, outside: number) => zone(id, id, { parent_zone_id: 'estate', parent_containment: { status: 'measured', child_hectares: child, inside_parent_percent: 100 - (outside / child) * 100, outside_parent_hectares: outside } });
    const flagged = placeAdvisories([], [zone('estate', 'Estate'), part('tiny', 10, 0.05), part('thin', 100, 0.2), part('real', 10, 0.2)]).map((item) => item.id);
    expect(flagged).toEqual(['zone:real']);
  });
});
