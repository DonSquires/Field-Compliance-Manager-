// Pure helpers for the layered place map: per-layer counts, "Part of" nesting and advisory containment.
// Nesting is reporting-only (LOCATION_HOUSE_MODEL.md, 2026-09-23); nothing here affects GPS resolution.

export interface ParentContainment {
  status: 'no_parent' | 'no_boundary' | 'measured' | 'unavailable';
  child_hectares?: number | null;
  inside_parent_percent?: number | null;
  outside_parent_hectares?: number | null;
  checkpoints_outside?: Array<{ id: string; name: string; distance_m: number }>;
}

export interface LayerFacet {
  id: string;
  name: string;
  boundary: GeoJSON.GeoJsonObject | null;
  boundary_verification: string;
}

export interface LayerZone extends LayerFacet {
  parent_zone_id?: string | null;
  parent_containment?: ParentContainment | null;
}

export interface LayerCheckpoint {
  id: string;
  name: string;
  gps_lat: number | null;
  gps_lng: number | null;
  checkpoint_verification: string;
  active: boolean;
  zone_id?: string | null;
  client_site_id?: string | null;
}

const confirmed = (facet: LayerFacet) => Boolean(facet.boundary) && facet.boundary_verification === 'verified';

const layerLabel = (name: string, total: number, done: number) => total ? `${name} ${total} · ${done} confirmed` : `${name} 0`;

export function placeLayerGates(sites: LayerFacet[], zones: LayerFacet[], checkpoints?: LayerCheckpoint[]) {
  const layers = [
    layerLabel('Sites', sites.length, sites.filter(confirmed).length),
    layerLabel('Work areas', zones.length, zones.filter(confirmed).length),
  ];
  if (checkpoints) layers.push(layerLabel('Checkpoints', checkpoints.length, checkpoints.filter((item) => item.active && item.checkpoint_verification === 'verified').length));
  const count = [...sites, ...zones].filter((facet) => !confirmed(facet)).length;
  // A place with nothing to confirm is not a success: officers have no boundary to work inside.
  if (!sites.length && !zones.length) return { layers, ready: false, review: { count: 0, label: 'No boundaries yet' } };
  return { layers, ready: count === 0, review: { count, label: count === 0 ? 'All boundaries confirmed' : `${count} need${count === 1 ? 's' : ''} review` } };
}

export function orderZonesByParent<Z extends LayerZone>(zones: Z[]): Array<{ zone: Z; depth: number }> {
  const ids = new Set(zones.map((item) => item.id));
  const children = new Map<string, Z[]>();
  zones.forEach((item) => {
    if (item.parent_zone_id && ids.has(item.parent_zone_id) && item.parent_zone_id !== item.id) {
      children.set(item.parent_zone_id, [...(children.get(item.parent_zone_id) ?? []), item]);
    }
  });
  const byName = (a: Z, b: Z) => a.name.localeCompare(b.name);
  const ordered: Array<{ zone: Z; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (item: Z, depth: number) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    ordered.push({ zone: item, depth });
    [...(children.get(item.id) ?? [])].sort(byName).forEach((child) => visit(child, depth + 1));
  };
  zones.filter((item) => !item.parent_zone_id || !ids.has(item.parent_zone_id) || item.parent_zone_id === item.id).forEach((item) => visit(item, 0));
  // A cycle has no root; show its members at top level rather than losing them.
  zones.forEach((item) => visit(item, 0));
  return ordered;
}

export function partOfOptions<Z extends LayerZone>(zones: Z[], zoneId: string): Array<{ zone: Z; depth: number }> {
  const excluded = new Set([zoneId]);
  let grew = true;
  while (grew) {
    grew = false;
    zones.forEach((item) => {
      if (item.parent_zone_id && excluded.has(item.parent_zone_id) && !excluded.has(item.id)) { excluded.add(item.id); grew = true; }
    });
  }
  return orderZonesByParent(zones).filter(({ zone: item }) => !excluded.has(item.id));
}

type Point = [number, number];

function polygons(geometry: GeoJSON.GeoJsonObject | null): Point[][][] {
  if (!geometry) return [];
  if (geometry.type === 'Feature') return polygons((geometry as GeoJSON.Feature).geometry);
  if (geometry.type === 'FeatureCollection') return (geometry as GeoJSON.FeatureCollection).features.flatMap((feature) => polygons(feature.geometry));
  if (geometry.type === 'Polygon') return [(geometry as GeoJSON.Polygon).coordinates as Point[][]];
  if (geometry.type === 'MultiPolygon') return (geometry as GeoJSON.MultiPolygon).coordinates as Point[][][];
  return [];
}

function insideRing([x, y]: Point, ring: Point[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance([px, py]: Point, [ax, ay]: Point, [bx, by]: Point) {
  const dx = bx - ax; const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Metres from a point to the nearest edge of a boundary when it lies outside; 0 inside; null with no polygon. Local planar approximation, adequate for advisories at place scale. */
export function metresOutsideBoundary(point: { lat: number; lng: number }, geometry: GeoJSON.GeoJsonObject | null): number | null {
  const shapes = polygons(geometry);
  if (!shapes.length) return null;
  const earth = 6_371_008.8;
  const radians = Math.PI / 180;
  const scaleX = earth * radians * Math.cos(point.lat * radians);
  const scaleY = earth * radians;
  const project = ([lng, lat]: Point): Point => [(lng - point.lng) * scaleX, (lat - point.lat) * scaleY];
  const projected = shapes.map((rings) => rings.map((ring) => ring.map(project)));
  const origin: Point = [0, 0];
  if (projected.some(([outer, ...holes]) => outer && insideRing(origin, outer) && !holes.some((hole) => insideRing(origin, hole)))) return 0;
  let nearest = Infinity;
  projected.forEach((rings) => rings.forEach((ring) => ring.forEach((vertex, index) => {
    nearest = Math.min(nearest, segmentDistance(origin, vertex, ring[(index + 1) % ring.length]));
  })));
  return Number.isFinite(nearest) ? nearest : null;
}

export function placeAdvisories(sites: LayerFacet[], zones: LayerZone[], checkpoints: LayerCheckpoint[] = []) {
  const advisories: Array<{ id: string; text: string }> = [];
  zones.forEach((item) => {
    const parent = zones.find((candidate) => candidate.id === item.parent_zone_id);
    const containment = item.parent_containment?.status === 'measured' ? item.parent_containment : null;
    const outside = Number(containment?.outside_parent_hectares ?? 0);
    const child = Number(containment?.child_hectares ?? 0);
    const outsideShare = child > 0 ? (outside / child) * 100 : 100 - Number(containment?.inside_parent_percent ?? 100);
    // Edge slivers from independently drawn boundaries are noise, not a warning.
    if (parent && outside >= 0.1 && outsideShare >= 0.5) advisories.push({ id: `zone:${item.id}`, text: `${item.name} extends ${outside} ha outside ${parent.name}, the area it is part of` });
  });
  checkpoints.forEach((item) => {
    if (!item.active || item.gps_lat == null || item.gps_lng == null) return;
    const owner = item.zone_id ? zones.find((candidate) => candidate.id === item.zone_id) : sites.find((candidate) => candidate.id === item.client_site_id);
    if (!owner?.boundary) return;
    const metres = metresOutsideBoundary({ lat: item.gps_lat, lng: item.gps_lng }, owner.boundary);
    if (metres != null && metres >= 1) advisories.push({ id: `checkpoint:${item.id}`, text: `Checkpoint ${item.name} is ${Math.round(metres)} m outside its ${item.zone_id ? 'work area' : 'Site'} ${owner.name}` });
  });
  return advisories;
}
