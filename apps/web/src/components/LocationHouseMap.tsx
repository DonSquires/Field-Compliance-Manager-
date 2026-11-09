import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, Building2, CheckCircle2, Crosshair, LandPlot, LoaderCircle, MapPin, PenTool, ShieldCheck, Undo2, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { addLinzBaseLayers, rememberViewport, restoreViewportOr } from '../lib/mapPreferences';
import './LocationHouseMap.css';
import './LocationHouseMapSpine.css';
import './LocationHouseMapEditing.css';
import './LocationHouseMapEditing.css';

// ATLAS INVOKES: linz-map-tile
type Boundary = GeoJSON.GeoJsonObject | null;
type Ring = Array<[number, number]>;

function editableRing(geometry: Boundary): Ring | null {
  if (!geometry) return null;
  const shape = geometry.type === 'Feature' ? (geometry as GeoJSON.Feature).geometry : geometry as GeoJSON.Geometry;
  if (!shape) return null;
  const rings = shape.type === 'Polygon'
    ? shape.coordinates.length === 1 ? shape.coordinates : null
    : shape.type === 'MultiPolygon' && shape.coordinates.length === 1 && shape.coordinates[0].length === 1
      ? shape.coordinates[0]
      : null;
  const coordinates = rings?.[0];
  if (!coordinates || coordinates.length < 4) return null;
  const points = coordinates.map(([lng, lat]) => [Number(lng), Number(lat)] as [number, number]);
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) points.pop();
  return points.length >= 3 ? points : null;
}

export interface HouseMapSite {
  id: string;
  name: string;
  gps_lat: number | null;
  gps_lng: number | null;
  boundary: Boundary;
  boundary_status: string;
  boundary_verification: string;
}

export interface HouseMapZone {
  id: string;
  name: string;
  boundary: Boundary;
  center_point?: GeoJSON.Point | null;
  boundary_status: string;
  boundary_verification: string;
}

export interface HouseMapCheckpoint {
  id: string;
  name: string;
  gps_lat: number | null;
  gps_lng: number | null;
  radius_meters: number;
  checkpoint_verification: string;
  active: boolean;
}

interface LinzPreview {
  address: string;
  source: string;
  geometry: GeoJSON.GeoJsonObject;
  match: string;
  kind: string;
  properties: Record<string, unknown>;
  lat: number;
  lng: number;
}

/** A candidate that already carries real geometry (e.g. a registered council reserve) -- skip the LINZ lookup and preview this directly. */
export interface SeedBoundary {
  geometry: GeoJSON.Geometry;
  kind: string;
  label: string;
  lat: number;
  lng: number;
}

/** When set, the map becomes actionable for this one site or zone: accept the LINZ preview or a simple radius as its real boundary, right here. */
export interface EditableEntity {
  type: 'client_site' | 'location_zone';
  id: string;
  organizationId: string;
  zoneType?: string | null;
  centerLat?: number | null;
  centerLng?: number | null;
  onSaved?: (verified: boolean) => void;
}

function circlePolygon(lat: number, lng: number, radiusM: number, vertices = 64): GeoJSON.Polygon {
  const earth = 6_378_137;
  const dLat = (radiusM / earth) * (180 / Math.PI);
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < vertices; i += 1) {
    const angle = (i / vertices) * 2 * Math.PI;
    ring.push([Number((lng + dLng * Math.cos(angle)).toFixed(7)), Number((lat + dLat * Math.sin(angle)).toFixed(7))]);
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

/** The vertices a person clicked, closed back to the first one so it is a real ring. */
function drawnPolygon(points: Array<[number, number]>): GeoJSON.Polygon {
  return { type: 'Polygon', coordinates: [[...points, points[0]]] };
}

function ringMidpoints(points: Ring): Ring {
  return points.map(([lng, lat], index) => {
    const [nextLng, nextLat] = points[(index + 1) % points.length];
    return [Number(((lng + nextLng) / 2).toFixed(7)), Number(((lat + nextLat) / 2).toFixed(7))];
  });
}

interface GeofenceResolution {
  in_operating_bounds: boolean;
  out_of_bounds_district: string | null;
  on_site: boolean;
  site_id: string | null;
  matched_zone_id: string | null;
  matched_module_key: string | null;
  effective_rules: Record<string, unknown> | null;
  resolution_status: string;
  governor_overlap_flag: boolean;
}

interface ZoneClosure {
  closed: boolean;
  closure_type: string;
  reason: string | null;
  effective_from: string;
  effective_to: string | null;
}

const RESOLUTION_LABEL: Record<string, string> = {
  resolved: 'Verified boundary matched',
  outside_all_geofences: 'Outside all verified boundaries',
  unresolved_no_geofence: 'No boundary configured here',
  unresolved_unverified: 'Boundary needs visual confirmation',
  unresolved_invalid: 'Boundary shape needs repair',
};

export function LocationHouseMap({ organizationId, house, sites, zones, editableEntity, seedBoundary, onSelectFacet, checkpoints = [], checkpointDraftPoint, checkpointPlacement = false, onCheckpointPosition }: { organizationId: string; house: { name: string; address: string | null }; sites: HouseMapSite[]; zones: HouseMapZone[]; editableEntity?: EditableEntity; seedBoundary?: SeedBoundary | null; onSelectFacet?: (facet: { type: EditableEntity['type']; id: string }) => void; checkpoints?: HouseMapCheckpoint[]; checkpointDraftPoint?: { lat: number; lng: number } | null; checkpointPlacement?: boolean; onCheckpointPosition?: (point: { lat: number; lng: number }) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);
  const framedRef = useRef<string>('');
  const [linzPreview, setLinzPreview] = useState<LinzPreview | null>(seedBoundary ? { address: seedBoundary.label, source: 'council_registry', geometry: seedBoundary.geometry, match: 'Already known from your search selection', kind: seedBoundary.kind, properties: {}, lat: seedBoundary.lat, lng: seedBoundary.lng } : null);
  const [probePoint, setProbePoint] = useState<{ lat: number; lng: number } | null>(null);
  const [resolution, setResolution] = useState<GeofenceResolution | null>(null);
  const [closure, setClosure] = useState<ZoneClosure | null>(null);
  const [resolving, setResolving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [radiusMeters, setRadiusMeters] = useState('30');
  const [savingBoundary, setSavingBoundary] = useState<'linz' | 'radius' | 'drawn' | null>(null);
  const [boundaryNotice, setBoundaryNotice] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [drawPoints, setDrawPoints] = useState<Array<[number, number]>>([]);
  const [editBoundaryPoints, setEditBoundaryPoints] = useState<Ring | null>(null);
  // The map's click handler is registered once, so it reads the current mode from a ref rather than a stale closure.
  const drawingRef = useRef(false);
  drawingRef.current = drawing;
  const editingBoundaryRef = useRef(false);
  editingBoundaryRef.current = editBoundaryPoints !== null;
  const checkpointPlacementRef = useRef(checkpointPlacement);
  checkpointPlacementRef.current = checkpointPlacement;
  const checkpointPositionRef = useRef(onCheckpointPosition);
  checkpointPositionRef.current = onCheckpointPosition;
  // One map per house: a probe click, a LINZ preview or a resolution result must not rebuild it and lose the person's zoom, position or base layer.
  const viewKey = `house:${organizationId}:${house.name}`;

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true });
    mapRef.current = map;
    // On a narrow map the open layer list covers the top-right corner, and a click meant for the map lands on it instead.
    addLinzBaseLayers(map, { collapsed: containerRef.current.clientWidth < 520 });
    overlayRef.current = L.layerGroup().addTo(map);
    rememberViewport(map, viewKey);
    map.on('click', ({ latlng }) => {
      if (drawingRef.current) { setDrawPoints((points) => [...points, [Number(latlng.lng.toFixed(7)), Number(latlng.lat.toFixed(7))]]); return; }
      if (editingBoundaryRef.current) return;
      if (checkpointPlacementRef.current) { checkpointPositionRef.current?.({ lat: latlng.lat, lng: latlng.lng }); return; }
      setProbePoint({ lat: latlng.lat, lng: latlng.lng }); setResolution(null); setClosure(null);
    });
    framedRef.current = '';
    const invalidateTimer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => { window.clearTimeout(invalidateTimer); map.remove(); mapRef.current = null; overlayRef.current = null; };
  }, [viewKey]);

  useEffect(() => {
    const map = mapRef.current; const overlay = overlayRef.current;
    if (!map || !overlay) return;
    overlay.clearLayers();
    const bounds = L.latLngBounds([]);
    // While the boundary is being drawn every corner click must reach the map, so nothing already drawn may intercept it.
    const interactive = !drawing && !checkpointPlacement && !editBoundaryPoints;
    const addBoundary = (geometry: GeoJSON.GeoJsonObject, style: L.PathOptions, label: string) => {
      const layer = L.geoJSON(geometry, { style, interactive }).bindTooltip(label);
      layer.addTo(overlay);
      const layerBounds = layer.getBounds();
      if (layerBounds.isValid()) bounds.extend(layerBounds);
    };

    sites.forEach((site) => {
      if (site.boundary) addBoundary(site.boundary, { color: '#2fc4a7', weight: 3, fillColor: '#2fc4a7', fillOpacity: 0.12 }, `Site: ${site.name}`);
      else if (site.gps_lat != null && site.gps_lng != null) {
        const point = L.circleMarker([site.gps_lat, site.gps_lng], { radius: 7, color: '#2fc4a7', fillColor: '#0e705f', fillOpacity: 0.9, interactive }).bindTooltip(`Site: ${site.name}`).addTo(overlay);
        bounds.extend(point.getLatLng());
      }
    });
    zones.forEach((zone) => {
      if (zone.boundary) addBoundary(zone.boundary, { color: '#f0b35a', weight: 2, dashArray: '7 5', fillColor: '#f0b35a', fillOpacity: 0.1 }, `Zone: ${zone.name}`);
      else if (zone.center_point?.coordinates?.length === 2) {
        const [lng, lat] = zone.center_point.coordinates;
        const point = L.circleMarker([lat, lng], { radius: 6, color: '#f0b35a', fillColor: '#9a5f18', fillOpacity: 0.9, interactive }).bindTooltip(`Zone: ${zone.name}`).addTo(overlay);
        bounds.extend(point.getLatLng());
      }
    });
    if (editBoundaryPoints) {
      addBoundary(drawnPolygon(editBoundaryPoints), { color: '#f0b35a', weight: 3, dashArray: '7 5', fillColor: '#f0b35a', fillOpacity: 0.1 }, 'Boundary adjustment preview');
      editBoundaryPoints.forEach(([lng, lat], index) => {
        const marker = L.marker([lat, lng], { draggable: true, icon: L.divIcon({ className: 'house-map-vertex', iconSize: [14, 14] }), title: `Vertex ${index + 1}: drag to move or right-click to remove` }).addTo(overlay);
        marker.on('dragend', () => {
          const position = marker.getLatLng();
          setEditBoundaryPoints((points) => points ? points.map((point, pointIndex) => pointIndex === index ? [Number(position.lng.toFixed(7)), Number(position.lat.toFixed(7))] : point) : points);
        });
        marker.on('contextmenu', (event) => {
          L.DomEvent.stop(event);
          setEditBoundaryPoints((points) => points && points.length > 3 ? points.filter((_, pointIndex) => pointIndex !== index) : points);
        });
      });
      ringMidpoints(editBoundaryPoints).forEach(([lng, lat], index) => {
        const marker = L.marker([lat, lng], { draggable: true, icon: L.divIcon({ className: 'house-map-vertex is-midpoint', iconSize: [10, 10] }), title: 'Drag to add a boundary vertex' }).addTo(overlay);
        marker.on('dragend', () => {
          const position = marker.getLatLng();
          setEditBoundaryPoints((points) => points ? [...points.slice(0, index + 1), [Number(position.lng.toFixed(7)), Number(position.lat.toFixed(7))], ...points.slice(index + 1)] : points);
        });
      });
    }
    checkpoints.forEach((checkpoint) => {
      if (checkpoint.gps_lat == null || checkpoint.gps_lng == null) return;
      const verified = checkpoint.checkpoint_verification === 'verified';
      const circle = L.circle([checkpoint.gps_lat, checkpoint.gps_lng], {
        radius: checkpoint.radius_meters,
        color: checkpoint.active ? (verified ? '#4cc38a' : '#e5aa45') : '#879aaa',
        weight: 2,
        fillOpacity: checkpoint.active ? 0.18 : 0.08,
        interactive,
      }).bindTooltip(`Checkpoint: ${checkpoint.name} · ${verified ? 'verified' : 'unverified'}${checkpoint.active ? '' : ' · inactive'}`);
      circle.addTo(overlay);
      bounds.extend([checkpoint.gps_lat, checkpoint.gps_lng]);
    });
    if (checkpointDraftPoint) {
      const marker = L.circleMarker([checkpointDraftPoint.lat, checkpointDraftPoint.lng], {
        radius: 8, color: '#edf2f7', weight: 2, fillColor: '#4c8f84', fillOpacity: 1, interactive: false,
      }).bindTooltip('Checkpoint position being edited').addTo(overlay);
      bounds.extend(marker.getLatLng());
    }
    if (linzPreview) addBoundary(linzPreview.geometry, { color: '#5da9ff', weight: 3, dashArray: '3 5', fillColor: '#5da9ff', fillOpacity: 0.08 }, `LINZ preview: ${linzPreview.address}`);
    if (drawPoints.length) {
      const latlngs = drawPoints.map(([lng, lat]) => L.latLng(lat, lng));
      if (latlngs.length > 2) L.polygon(latlngs, { color: '#f4b942', weight: 3, fillColor: '#f4b942', fillOpacity: 0.12, interactive: false }).addTo(overlay);
      else if (latlngs.length === 2) L.polyline(latlngs, { color: '#f4b942', weight: 3, interactive: false }).addTo(overlay);
      latlngs.forEach((latlng) => { L.circleMarker(latlng, { radius: 5, color: '#f4b942', fillColor: '#1c1408', fillOpacity: 1, weight: 2, interactive: false }).addTo(overlay); });
    }
    if (probePoint) {
      L.circleMarker([probePoint.lat, probePoint.lng], { radius: 7, color: '#f4f7f8', weight: 2, fillColor: resolution?.matched_zone_id ? '#2fc4a7' : '#d26a5c', fillOpacity: 1, interactive }).bindTooltip('Geofence resolution point').addTo(overlay);
    }
    // Frame the house once per set of places (or when it comes back after a remembered viewport was left behind); never on a probe or preview.
    const placeKey = [...sites.map((site) => site.id), ...zones.map((zone) => zone.id)].join('|');
    if (framedRef.current !== placeKey) {
      framedRef.current = placeKey;
      restoreViewportOr(map, viewKey, () => {
        if (bounds.isValid()) map.fitBounds(bounds.pad(0.18), { maxZoom: 18 });
        else map.setView([-41.2, 172.5], 5);
      });
    }
  }, [sites, zones, checkpoints, checkpointDraftPoint, linzPreview, probePoint, resolution, drawPoints, drawing, editBoundaryPoints, checkpointPlacement, viewKey]);

  useEffect(() => {
    if (!probePoint || !organizationId) return;
    let active = true;
    const resolvePoint = async () => {
      setProbing(true); setError(null);
      const { data, error: resolveError } = await supabase.rpc('resolve_operational_context_authorized', { p_lat: probePoint.lat, p_lng: probePoint.lng, p_org_id: organizationId, p_module_key: null });
      if (!active) return;
      const row = Array.isArray(data) ? data[0] : data;
      if (resolveError || !row) setError(resolveError?.message ?? 'The geofence spine returned no resolution evidence for this point.');
      else {
        const nextResolution = row as GeofenceResolution;
        setResolution(nextResolution);
        if (nextResolution.matched_zone_id) {
          const { data: closureData, error: closureError } = await supabase.rpc('is_zone_closed', { p_zone_id: nextResolution.matched_zone_id, p_at: new Date().toISOString() });
          if (!active) return;
          if (closureError) setError(`Point resolved, but closure evidence failed: ${closureError.message}`);
          else setClosure((closureData as ZoneClosure | null) ?? null);
        }
      }
      setProbing(false);
    };
    void resolvePoint();
    return () => { active = false; };
  }, [organizationId, probePoint]);

  const previewLinzBoundary = async (): Promise<LinzPreview | null> => {
    const query = house.address?.trim() || house.name.trim();
    if (!query) return null;
    setResolving(true); setError(null); setLinzPreview(null);
    try {
      const { data: addressData, error: addressError } = await supabase.functions.invoke('linz-lookup', { body: { action: 'address_autocomplete', q: query, max: 1 } });
      const candidate = addressData?.candidates?.[0] as { label: string; lat: number; lng: number; source: string } | undefined;
      if (addressError || !candidate) {
        setError(addressError?.message ?? 'LINZ returned no canonical address candidate for this house.');
        return null;
      }
      const { data: boundaryData, error: boundaryError } = await supabase.functions.invoke('linz-lookup', { body: { action: 'boundary_for_point_escalating', lat: candidate.lat, lng: candidate.lng } });
      if (boundaryError || !boundaryData?.geometry) {
        setError(boundaryError?.message ?? 'LINZ returned an address point but no parcel or building polygon. Draw the boundary on the map, or save a radius around the pin.');
        return null;
      }
      const preview: LinzPreview = { address: candidate.label, source: candidate.source, geometry: boundaryData.geometry as GeoJSON.GeoJsonObject, kind: boundaryData.kind === 'building' ? 'building' : 'parcel', properties: (boundaryData.properties ?? {}) as Record<string, unknown>, match: boundaryData.matched_via?.exact ? `Exact ${boundaryData.matched_via.layer}` : `${boundaryData.matched_via?.layer ?? 'boundary'} within ${boundaryData.matched_via?.radius_m ?? 0} m`, lat: candidate.lat, lng: candidate.lng };
      setLinzPreview(preview); setBoundaryNotice(null);
      return preview;
    } finally { setResolving(false); }
  };

  const proposeAndAccept = async (geometry: GeoJSON.Geometry, source: string, sourceRef: Record<string, unknown>, verify = true) => {
    if (!editableEntity) return;
    const { data: proposeData, error: proposeError } = await supabase.rpc('propose_boundary', {
      p_organization_id: editableEntity.organizationId, p_entity_type: editableEntity.type, p_entity_id: editableEntity.id,
      p_geojson: geometry, p_source: source, p_source_ref: sourceRef, p_address_candidate: null,
      p_zone_type: editableEntity.type === 'location_zone' ? editableEntity.zoneType ?? null : null, p_proposed_via: 'house_map',
    });
    const proposal = (proposeData as Array<{ proposal_id: string }> | null)?.[0];
    if (proposeError || !proposal?.proposal_id) throw proposeError ?? new Error('The boundary proposal was not confirmed.');
    const { data: acceptData, error: acceptError } = await supabase.rpc('accept_boundary_proposal', { p_proposal_id: proposal.proposal_id, p_final_geojson: null, p_verify: verify, p_note: null });
    if (acceptError || !(acceptData as Array<{ entity_id: string }> | null)?.[0]?.entity_id) throw acceptError ?? new Error('The boundary could not be confirmed.');
  };

  const saveLinzBoundary = (preview: LinzPreview | null = linzPreview, verify = true) => {
    if (!editableEntity || !preview) return;
    void (async () => {
      setSavingBoundary('linz'); setError(null); setBoundaryNotice(null);
      try {
        await proposeAndAccept(preview.geometry as GeoJSON.Geometry, preview.kind === 'building' ? 'linz_building' : preview.kind === 'reserve' ? 'council_gis' : 'linz_parcel', { matched_via: preview.match, queried_at: { lat: preview.lat, lng: preview.lng } }, verify);
        const source = preview.kind === 'reserve' ? 'the council registry' : 'LINZ';
        const shape = preview.kind === 'building' ? 'building outline' : preview.kind === 'reserve' ? 'reserve boundary' : 'legal parcel';
        setBoundaryNotice(verify ? `Boundary confirmed from ${source} (${shape}). If it is not the right shape, draw it by hand and save again.` : `Boundary found and set from ${source} (${shape}). Check the shape on the map, then confirm it before officers use it.`);
        // Once saved, the preview is the boundary; leaving it up would offer a second button that silently re-saves it.
        setLinzPreview(null);
        editableEntity.onSaved?.(verify);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'The boundary could not be saved.');
      } finally { setSavingBoundary(null); }
    })();
  };

  /**
   * The geofence sets itself: on a place with no boundary yet, look the land lot up and save it when LINZ matched the
   * address exactly. Anything less certain is left on the map as a preview for the person to accept, redraw or replace.
   */
  const autoResolvedRef = useRef('');
  useEffect(() => {
    // The house's LINZ parcel is the Site's outline. A work area is usually only part of the place, so it is previewed, never saved for it unasked.
    if (!editableEntity || seedBoundary || editableEntity.type !== 'client_site') return;
    const facet = [...sites, ...zones].find((item) => item.id === editableEntity.id);
    if (facet?.boundary || autoResolvedRef.current === editableEntity.id) return;
    autoResolvedRef.current = editableEntity.id;
    void (async () => {
      const preview = await previewLinzBoundary();
      if (preview?.match.startsWith('Exact')) saveLinzBoundary(preview, false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editableEntity?.id]);

  const saveDrawnBoundary = () => {
    if (!editableEntity) return;
    if (drawPoints.length < 3) { setError('Click at least three corners on the map to outline the place.'); return; }
    void (async () => {
      setSavingBoundary('drawn'); setError(null); setBoundaryNotice(null);
      try {
        await proposeAndAccept(drawnPolygon(drawPoints), 'user_drawn', { vertices: drawPoints.length, drawn_via: 'house_map' });
        setBoundaryNotice(`Boundary saved and confirmed from the ${drawPoints.length} corners you placed.`);
        setDrawing(false);
        // The saved shape now renders from the record. A lingering LINZ preview would offer to overwrite the drawing.
        setDrawPoints([]);
        setLinzPreview(null);
        editableEntity.onSaved?.(true);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'The boundary could not be saved.');
      } finally { setSavingBoundary(null); }
    })();
  };

  const editableFacet = editableEntity ? [...sites, ...zones].find((facet) => facet.id === editableEntity.id) : null;
  const currentBoundaryRing = editableRing(editableFacet?.boundary ?? null);
  const saveEditedBoundary = () => {
    if (!editableEntity || !editBoundaryPoints || editBoundaryPoints.length < 3) return;
    void (async () => {
      setSavingBoundary('drawn'); setError(null); setBoundaryNotice(null);
      try {
        await proposeAndAccept(drawnPolygon(editBoundaryPoints), 'user_drawn', { adjusted_from: 'current_boundary', vertices: editBoundaryPoints.length }, false);
        setEditBoundaryPoints(null);
        setBoundaryNotice('Boundary updated. Review and confirm the revised shape before officers use it.');
        editableEntity.onSaved?.(false);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'The boundary could not be saved.');
      } finally { setSavingBoundary(null); }
    })();
  };

  const confirmExistingBoundary = () => {
    if (!editableEntity) return;
    void (async () => {
      setSavingBoundary('linz'); setError(null); setBoundaryNotice(null);
      const { error: verifyError } = await supabase.rpc('verify_boundary', { p_entity_type: editableEntity.type, p_entity_id: editableEntity.id });
      if (verifyError) setError(verifyError.message);
      else { setBoundaryNotice('Boundary confirmed. Officers can now use it for runtime location checks.'); editableEntity.onSaved?.(true); }
      setSavingBoundary(null);
    })();
  };

  const saveRadiusBoundary = () => {
    if (!editableEntity) return;
    const centerLat = linzPreview?.lat ?? editableEntity.centerLat ?? null;
    const centerLng = linzPreview?.lng ?? editableEntity.centerLng ?? null;
    const radius = Number(radiusMeters);
    if (centerLat == null || centerLng == null) { setError('Resolve an address or a LINZ preview first so there is a centre to draw the circle from.'); return; }
    if (!Number.isFinite(radius) || radius < 5) { setError('Enter a radius of at least 5 metres.'); return; }
    void (async () => {
      setSavingBoundary('radius'); setError(null); setBoundaryNotice(null);
      try {
        await proposeAndAccept(circlePolygon(centerLat, centerLng, radius), 'google_point_radius', { center: { lat: centerLat, lng: centerLng }, radius_m: radius });
        setBoundaryNotice(`Boundary saved as a ${radius} m radius.`);
        setLinzPreview(null);
        editableEntity.onSaved?.(true);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'The boundary could not be saved.');
      } finally { setSavingBoundary(null); }
    })();
  };

  const verifiedPlaces = [...sites, ...zones].filter((place) => place.boundary && place.boundary_verification === 'verified').length;
  const reviewFacets = [
    ...sites.map((facet) => ({ facet, type: 'client_site' as const, kind: 'Site' })),
    ...zones.map((facet) => ({ facet, type: 'location_zone' as const, kind: 'Work area' })),
  ].filter(({ facet }) => !facet.boundary || facet.boundary_verification !== 'verified');
  const unresolvedFacets = reviewFacets.length;
  return <section className="house-map" aria-label={`Map for ${house.name}`}>
    <header><div><span>Place boundary map</span><h3>{house.name}</h3><p>{house.address ?? 'Address not recorded'}</p></div><button type="button" onClick={() => void previewLinzBoundary()} disabled={resolving || (!house.address && !house.name)}>{resolving ? <LoaderCircle size={15} className="is-spinning" /> : <LandPlot size={15} />}{resolving ? 'Finding LINZ boundary' : 'Find LINZ boundary'}</button></header>
    <div className="house-map-gates"><span className={verifiedPlaces ? 'is-ready' : 'is-blocked'}><ShieldCheck size={14} /><strong>{verifiedPlaces}</strong> verified place boundar{verifiedPlaces === 1 ? 'y' : 'ies'}</span><span className={unresolvedFacets ? 'is-blocked' : 'is-ready'}><AlertTriangle size={14} /><strong>{unresolvedFacets}</strong> Site or work area{unresolvedFacets === 1 ? '' : 's'} need review</span><span><Crosshair size={14} />{drawing ? 'Drawing the boundary' : probing ? 'Checking this point' : 'Click the map to check a location'}</span></div>
    {reviewFacets.length > 0 && <ul className="house-map-review-list" aria-label="Sites and work areas that still need a confirmed boundary">{reviewFacets.map(({ facet, type, kind }) => <li key={facet.id}><span><strong>{facet.name}</strong> · {kind} · {facet.boundary ? 'boundary saved, not yet confirmed' : 'no boundary yet'}</span>{facet.id === editableEntity?.id ? <em>Selected below</em> : onSelectFacet && <button type="button" onClick={() => onSelectFacet({ type, id: facet.id })}>Set this boundary</button>}</li>)}</ul>}
    {error && <div className="house-map-message is-error" role="alert"><AlertTriangle size={15} />{error}</div>}
    {linzPreview && <><div className="house-map-message is-success" role="status"><CheckCircle2 size={15} /><span><strong>{linzPreview.kind === 'reserve' ? 'Council reserve boundary' : `Read-only LINZ ${linzPreview.kind === 'parcel' ? 'land-lot' : 'building'} preview`}</strong>{linzPreview.address} · {linzPreview.match}</span></div><div className="house-map-lot-details"><div><span>Canonical address</span><strong>{linzPreview.address}</strong></div><div><span>Source</span><strong>{linzPreview.source.replaceAll('_', ' ')}</strong></div><div><span>Geometry</span><strong>{linzPreview.kind === 'reserve' ? 'Council reserve boundary' : linzPreview.kind === 'parcel' ? 'LINZ parcel / land lot' : 'LINZ building outline'}</strong></div>{Object.entries(linzPreview.properties).filter(([, value]) => value !== null && value !== '').slice(0, 6).map(([key, value]) => <div key={key}><span>{key.replaceAll('_', ' ')}</span><strong>{String(value)}</strong></div>)}</div></>}
    {resolution && <div className={`house-map-resolution is-${resolution.resolution_status === 'resolved' ? 'resolved' : 'unresolved'}`} role="status"><div><span>Map check</span><strong>{RESOLUTION_LABEL[resolution.resolution_status] ?? 'Location could not be confirmed'}</strong></div><div><span>Provider service area</span><strong>{resolution.in_operating_bounds ? 'Inside' : resolution.out_of_bounds_district ? `Outside · ${resolution.out_of_bounds_district}` : 'Outside'}</strong></div><div><span>Matched work area</span><strong>{resolution.matched_zone_id ? zones.find((zone) => zone.id === resolution.matched_zone_id)?.name ?? 'Matched work area' : 'No verified active work area'}</strong></div><div><span>Site match</span><strong>{resolution.site_id ? resolution.on_site ? 'Inside the Site' : 'Work area matched · outside Site boundary' : 'No verified Site match'}</strong></div><div><span>Service</span><strong>{resolution.matched_module_key?.replaceAll('_', ' ') ?? 'None'}</strong></div><div><span>Rules loaded</span><strong>{resolution.effective_rules ? `${Object.keys(resolution.effective_rules).length} applicable setting${Object.keys(resolution.effective_rules).length === 1 ? '' : 's'}` : 'None'}</strong></div><div className={closure ? 'is-warning' : ''}><span>Temporary restriction</span><strong>{closure ? `${closure.closure_type.replaceAll('_', ' ')} · ${closure.reason ?? 'No reason recorded'}` : 'None in force'}</strong></div>{resolution.governor_overlap_flag && <div className="is-warning"><span>Jurisdiction</span><strong>Overlapping authority needs review</strong></div>}</div>}
    {boundaryNotice && <div className="house-map-message is-success" role="status"><CheckCircle2 size={15} />{boundaryNotice}</div>}
    {editableEntity && <div className="house-map-editable">
      <span>{drawing ? 'Click each corner of the place on the map, then save the shape. Switch the map to Satellite to see what is actually there.' : 'Set the boundary right here — no separate workbench needed.'}</span>
      <div className="house-map-editable-actions">
        {editableFacet?.boundary && editableFacet.boundary_verification !== 'verified' && !drawing && !editBoundaryPoints && <button type="button" onClick={confirmExistingBoundary} disabled={savingBoundary !== null}><CheckCircle2 size={14} />{savingBoundary === 'linz' ? 'Confirming' : 'Confirm this boundary'}</button>}
        {currentBoundaryRing && !drawing && !editBoundaryPoints && <button type="button" onClick={() => setEditBoundaryPoints(currentBoundaryRing)} disabled={savingBoundary !== null}>Adjust current boundary</button>}
        {editBoundaryPoints && <><button type="button" onClick={() => setEditBoundaryPoints(currentBoundaryRing)} disabled={savingBoundary !== null}><Undo2 size={14} />Undo edits</button><button type="button" onClick={() => setEditBoundaryPoints(null)} disabled={savingBoundary !== null}><X size={14} />Cancel edit</button><button type="button" onClick={saveEditedBoundary} disabled={savingBoundary !== null}>{savingBoundary === 'drawn' ? 'Saving' : 'Save boundary edit'}</button></>}
        {linzPreview && !drawing && !editBoundaryPoints && <button type="button" onClick={() => saveLinzBoundary()} disabled={savingBoundary !== null}><LandPlot size={14} />{savingBoundary === 'linz' ? 'Saving' : editableFacet?.boundary ? `Replace with this ${linzPreview.kind === 'reserve' ? 'council' : 'LINZ'} boundary` : `Use this ${linzPreview.kind === 'reserve' ? 'council' : 'LINZ'} boundary`}</button>}
        {!drawing && !editBoundaryPoints && <button type="button" onClick={() => { setDrawing(true); setDrawPoints([]); setProbePoint(null); setResolution(null); setClosure(null); }} disabled={savingBoundary !== null}><PenTool size={14} />Draw the boundary</button>}
        {drawing && <>
          <strong className="house-map-draw-count">{drawPoints.length} corner{drawPoints.length === 1 ? '' : 's'} placed{drawPoints.length < 3 ? ` · ${3 - drawPoints.length} more needed` : ''}</strong>
          <button type="button" onClick={() => setDrawPoints((points) => points.slice(0, -1))} disabled={!drawPoints.length}><Undo2 size={14} />Undo corner</button>
          <button type="button" onClick={() => { setDrawing(false); setDrawPoints([]); }}><X size={14} />Stop drawing</button>
          <button type="button" onClick={saveDrawnBoundary} disabled={savingBoundary !== null || drawPoints.length < 3}><PenTool size={14} />{savingBoundary === 'drawn' ? 'Saving' : 'Save this shape'}</button>
        </>}
        {!drawing && !editBoundaryPoints && <><label><span>Or a simple radius (m)</span><input type="number" min="5" max="5000" value={radiusMeters} onChange={(event) => setRadiusMeters(event.target.value)} /></label><button type="button" onClick={saveRadiusBoundary} disabled={savingBoundary !== null || (linzPreview?.lat == null && editableEntity.centerLat == null)}><Crosshair size={14} />{savingBoundary === 'radius' ? 'Saving' : 'Save as point + radius'}</button></>}
      </div>
    </div>}
    <div className="house-map-canvas" ref={containerRef} />
    <footer><span><Building2 size={13} />Boundary shows where work applies</span><span><MapPin size={13} />Area settings control what officers do</span><span><LandPlot size={13} />LINZ supplies the property outline</span><em>{editableEntity ? 'Officers use only a saved and confirmed boundary. A preview alone changes nothing.' : 'A LINZ preview changes nothing until it is saved and confirmed.'}</em></footer>
  </section>;
}