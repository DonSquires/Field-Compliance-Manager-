import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, CheckCircle2, Clock3, Crosshair, History, Landmark, MapPin, PenTool, RefreshCw, Ruler, Search, ShieldCheck, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { resolveAddressCandidates, type AddressCandidate } from '../lib/locationAddress';
import { ShellLayout } from '../layouts/ShellLayout';
import './SiteBoundaryReviewPage.css';
import './SiteBoundaryVisualReview.css';

// Geofence Workbench (GEOFENCE_PRINCIPLES P1/P2, Q2, Q6): every boundary from every
// source is staged as a proposal, drawn for a human, and only accept writes the live
// entity. Nothing here reads or writes client_sites / location_zones directly.

type EntityType = 'client_site' | 'location_zone';
type BoundaryState = 'missing' | 'unverified' | 'verified';
type Ring = Array<[number, number]>; // [lng, lat]

interface QueueEntity {
  entity_type: EntityType;
  entity_id: string;
  name: string;
  address: string | null;
  organization_id: string;
  organization_name: string;
  zone_type: string | null;
  module_key: string | null;
  boundary_state: BoundaryState;
  boundary_status: 'authoritative' | 'provisional' | null;
  boundary_verification: 'verified' | 'unverified';
  has_boundary: boolean;
  boundary_geojson: GeoJSON.GeoJsonObject | null;
  center_lat: number | null;
  center_lng: number | null;
  active_agreements: number;
  open_proposal_id: string | null;
  open_proposal_source: string | null;
  open_proposal_gate_ok: boolean | null;
  open_proposal_area_m2: number | null;
  open_proposal_drift_m: number | null;
  open_proposal_geojson: GeoJSON.GeoJsonObject | null;
  configuration_version: number;
  priority: number;
}

interface BoundaryHistory {
  id: string;
  boundary_source: string | null;
  verification_state: string;
  changed_via: string;
  change_reason: string;
  version: number;
  created_at: string;
  has_boundary: boolean;
}

interface ProposeReceipt { proposal_id: string; area_m2: number; gate_ok: boolean; gate_reason: string | null; drift_from_current_m: number | null; current_has_boundary: boolean }
interface AcceptReceipt { entity_type: string; entity_id: string; area_m2: number; human_edited: boolean; verified: boolean; history_version: number }
interface LinzBoundary { kind: 'parcel' | 'building' | null; geometry: GeoJSON.Geometry | null; properties?: Record<string, unknown>; matched_via?: { layer: string; radius_m: number; exact: boolean } | null; note?: string }

// Tier 4: a point + radius at a site, direct-save (Q3) but never verified by its writer (P2).
interface Checkpoint { id: string; name: string; description: string | null; gps_lat: number | null; gps_lng: number | null; radius_meters: number; qr_code: string | null; active: boolean; checkpoint_verification: 'verified' | 'unverified'; checkpoint_verified_at: string | null }
interface CheckpointReceipt { id: string; name: string; radius_meters: number; checkpoint_verification: string; created: boolean; geometry_changed: boolean; history_version: number | null }
const EMPTY_CHECKPOINT_FORM = { name: '', radius: '', qrCode: '', latitude: '', longitude: '' };

type QueueFilter = 'attention' | 'proposals' | 'verified' | 'all';
type SourcePanel = 'linz' | 'radius' | 'draw';

const SOURCE_LABEL: Record<string, string> = {
  linz_parcel: 'LINZ legal parcel', linz_building: 'LINZ building outline', council_gis: 'Council GIS', nzta: 'NZTA',
  google_point_radius: 'Point + radius (provisional)', user_drawn: 'Drawn by hand', bob: 'Bob extraction', imported_geojson: 'Imported GeoJSON',
};
const STATE_LABEL: Record<BoundaryState, string> = { missing: 'Geometry required', unverified: 'Visual review required', verified: 'Verified boundary' };
const keyOf = (entity: Pick<QueueEntity, 'entity_type' | 'entity_id'>) => `${entity.entity_type}:${entity.entity_id}`;
const entityLabel = (entity: QueueEntity) => (entity.entity_type === 'client_site' ? 'Site' : `Zone · ${(entity.zone_type ?? 'general').replaceAll('_', ' ')}`);

export function formatArea(m2: number | null | undefined): string {
  if (m2 == null || !Number.isFinite(m2)) return 'Not measured';
  return m2 >= 10_000 ? `${(m2 / 10_000).toLocaleString('en-NZ', { maximumFractionDigits: 2 })} ha` : `${Math.round(m2).toLocaleString('en-NZ')} m²`;
}

// A point-radius rung of the Q6 ladder: a 64-vertex geodesic circle, always provisional.
export function circlePolygon(lat: number, lng: number, radiusM: number, vertices = 64): GeoJSON.Polygon {
  const earth = 6_378_137;
  const dLat = (radiusM / earth) * (180 / Math.PI);
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  const ring: Ring = [];
  for (let i = 0; i < vertices; i += 1) {
    const angle = (i / vertices) * 2 * Math.PI;
    ring.push([Number((lng + dLng * Math.cos(angle)).toFixed(7)), Number((lat + dLat * Math.sin(angle)).toFixed(7))]);
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

// The outer ring of a single polygon without holes; anything else is not editable by vertex drag.
export function editableRing(geometry: GeoJSON.GeoJsonObject | null): Ring | null {
  if (!geometry) return null;
  const geom = geometry.type === 'Feature' ? (geometry as GeoJSON.Feature).geometry : (geometry as GeoJSON.Geometry);
  if (!geom) return null;
  let rings: GeoJSON.Position[][] | null = null;
  if (geom.type === 'Polygon') rings = geom.coordinates;
  else if (geom.type === 'MultiPolygon' && geom.coordinates.length === 1) rings = geom.coordinates[0];
  if (!rings || rings.length !== 1 || rings[0].length < 4) return null;
  return rings[0].slice(0, -1).map(([lng, lat]) => [lng, lat] as [number, number]);
}

export function ringPolygon(ring: Ring): GeoJSON.Polygon {
  return { type: 'Polygon', coordinates: [[...ring, ring[0]]] };
}

const SiteBoundaryReviewPage = () => {
  const { profile } = useAuth();
  const [queue, setQueue] = useState<QueueEntity[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [history, setHistory] = useState<BoundaryHistory[]>([]);
  const [filter, setFilter] = useState<QueueFilter>('attention');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourcePanel, setSourcePanel] = useState<SourcePanel>('linz');
  const [coordinates, setCoordinates] = useState({ latitude: '', longitude: '', radius: '50' });
  const [addressQuery, setAddressQuery] = useState('');
  const [addressCandidate, setAddressCandidate] = useState<AddressCandidate | null>(null);
  const [drawPoints, setDrawPoints] = useState<Ring>([]);
  const [editRing, setEditRing] = useState<Ring | null>(null);
  const [visualReviewConfirmed, setVisualReviewConfirmed] = useState(false);
  const [decisionNote, setDecisionNote] = useState('');
  const [rejectNote, setRejectNote] = useState('');
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [checkpointForm, setCheckpointForm] = useState(EMPTY_CHECKPOINT_FORM);
  const [placingCheckpoint, setPlacingCheckpoint] = useState(false);
  const [checkpointReviewed, setCheckpointReviewed] = useState<string | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);
  const drawModeRef = useRef(false);
  const placingRef = useRef(false);

  const selected = useMemo(() => queue.find((entity) => keyOf(entity) === selectedKey) ?? null, [queue, selectedKey]);
  const proposalRing = useMemo(() => editableRing(selected?.open_proposal_geojson ?? null), [selected?.open_proposal_geojson]);
  const proposalEdited = Boolean(editRing && proposalRing && JSON.stringify(editRing) !== JSON.stringify(proposalRing));
  const drawMode = sourcePanel === 'draw' && !selected?.open_proposal_id;
  drawModeRef.current = drawMode;
  placingRef.current = placingCheckpoint;
  const pickedPoint = Number.isFinite(Number(checkpointForm.latitude)) && Number.isFinite(Number(checkpointForm.longitude)) && checkpointForm.latitude.trim() && checkpointForm.longitude.trim()
    ? { lat: Number(checkpointForm.latitude), lng: Number(checkpointForm.longitude) } : null;
  const centre = selected && selected.center_lat != null && selected.center_lng != null ? { lat: selected.center_lat, lng: selected.center_lng } : addressCandidate ? { lat: addressCandidate.lat, lng: addressCandidate.lng } : null;

  const loadCheckpoints = useCallback(async (entity: QueueEntity) => {
    if (entity.entity_type !== 'client_site') { setCheckpoints([]); return; }
    // ATLAS READS: patrol_checkpoints (Tier 4 facets of the selected site)
    const { data, error: checkpointError } = await supabase.from('patrol_checkpoints')
      .select('id, name, description, gps_lat, gps_lng, radius_meters, qr_code, active, checkpoint_verification, checkpoint_verified_at')
      .eq('client_site_id', entity.entity_id).order('name');
    if (checkpointError) throw checkpointError;
    setCheckpoints((data as Checkpoint[]) ?? []);
  }, []);

  const loadHistory = useCallback(async (entity: QueueEntity) => {
    // ATLAS READS: get_boundary_history
    const { data, error: historyError } = await supabase.rpc('get_boundary_history', { p_entity_type: entity.entity_type, p_entity_id: entity.entity_id });
    if (historyError) throw historyError;
    setHistory((data as BoundaryHistory[]) ?? []);
  }, []);

  const loadQueue = useCallback(async (preferredKey?: string | null) => {
    setLoading(true); setError(null);
    try {
      // ATLAS READS: get_geofence_review_queue (sites + zones within the caller's reach, worst first)
      const { data, error: queueError } = await supabase.rpc('get_geofence_review_queue', { p_organization_id: null });
      if (queueError) throw queueError;
      const rows = (data as QueueEntity[]) ?? [];
      const nextKey = preferredKey && rows.some((entity) => keyOf(entity) === preferredKey) ? preferredKey : rows[0] ? keyOf(rows[0]) : null;
      setQueue(rows); setSelectedKey(nextKey);
      const next = rows.find((entity) => keyOf(entity) === nextKey);
      if (next) await Promise.all([loadHistory(next), loadCheckpoints(next)]); else { setHistory([]); setCheckpoints([]); }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'The geofence review queue could not be loaded.');
    } finally { setLoading(false); }
  }, [loadHistory, loadCheckpoints]);

  useEffect(() => { void loadQueue(); }, [loadQueue]);

  useEffect(() => {
    if (!selected) return;
    setCoordinates({ latitude: selected.center_lat?.toString() ?? '', longitude: selected.center_lng?.toString() ?? '', radius: '50' });
    setVisualReviewConfirmed(false); setDecisionNote(''); setRejectNote(''); setDrawPoints([]); setAddressCandidate(null); setAddressQuery('');
    setCheckpointForm(EMPTY_CHECKPOINT_FORM); setPlacingCheckpoint(false); setCheckpointReviewed(null);
    setSourcePanel(selected.entity_type === 'location_zone' && selected.center_lat == null ? 'draw' : 'linz');
  }, [selectedKey]);

  useEffect(() => { setEditRing(proposalRing); }, [proposalRing]);

  // One map per selected entity; LINZ basemaps; the overlay group is re-rendered by the effect below.
  useEffect(() => {
    if (!mapContainerRef.current || !selected) return;
    mapRef.current?.remove();
    const map = L.map(mapContainerRef.current, { zoomControl: true, attributionControl: true, doubleClickZoom: false });
    mapRef.current = map;
    const linzTile = (layer: 'topographic' | 'aerial') => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/linz-map-tile?layer=${layer}&z={z}&x={x}&y={y}`;
    const topographic = L.tileLayer(linzTile('topographic'), { maxZoom: 20, attribution: '&copy; LINZ | CC BY 4.0' }).addTo(map);
    const aerial = L.tileLayer(linzTile('aerial'), { maxZoom: 20, attribution: '&copy; LINZ | CC BY 4.0' });
    L.control.layers({ 'LINZ topographic': topographic, 'LINZ aerial': aerial }, undefined, { collapsed: true }).addTo(map);
    overlayRef.current = L.layerGroup().addTo(map);
    map.on('click', (event: L.LeafletMouseEvent) => {
      if (placingRef.current) {
        setCheckpointForm((form) => ({ ...form, latitude: event.latlng.lat.toFixed(7), longitude: event.latlng.lng.toFixed(7) }));
        return;
      }
      if (!drawModeRef.current) return;
      setDrawPoints((points) => [...points, [Number(event.latlng.lng.toFixed(7)), Number(event.latlng.lat.toFixed(7))]]);
    });
    const focus = selected.boundary_geojson ?? selected.open_proposal_geojson;
    if (focus) {
      const bounds = L.geoJSON(focus).getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.25), { maxZoom: 19 });
    } else if (selected.center_lat != null && selected.center_lng != null) {
      map.setView([selected.center_lat, selected.center_lng], 18);
    } else {
      map.fitBounds(L.latLngBounds([-47.3, 166.4], [-34.4, 178.6]));
    }
    window.setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; overlayRef.current = null; };
  }, [selected?.entity_id]);

  useEffect(() => {
    const map = mapRef.current; const overlay = overlayRef.current;
    if (!map || !overlay || !selected) return;
    overlay.clearLayers();
    if (selected.boundary_geojson) L.geoJSON(selected.boundary_geojson, { style: { color: '#2fc4a7', weight: 3, fillColor: '#2fc4a7', fillOpacity: 0.14 } }).bindTooltip(`Current boundary · ${selected.boundary_verification}`).addTo(overlay);
    if (selected.open_proposal_geojson) {
      const shape = editRing ? ringPolygon(editRing) : selected.open_proposal_geojson;
      L.geoJSON(shape as GeoJSON.GeoJsonObject, { style: { color: '#e0a93a', weight: 3, dashArray: '8 6', fillColor: '#e0a93a', fillOpacity: 0.12 } }).bindTooltip(`Proposed · ${SOURCE_LABEL[selected.open_proposal_source ?? ''] ?? selected.open_proposal_source ?? 'proposal'}`).addTo(overlay);
      editRing?.forEach(([lng, lat], index) => {
        const marker = L.marker([lat, lng], { draggable: true, icon: L.divIcon({ className: 'workbench-vertex', iconSize: [14, 14] }), title: `Vertex ${index + 1} — drag to adjust` }).addTo(overlay);
        marker.on('dragend', () => {
          const position = marker.getLatLng();
          setEditRing((ring) => ring ? ring.map((point, i) => (i === index ? [Number(position.lng.toFixed(7)), Number(position.lat.toFixed(7))] : point)) : ring);
        });
      });
    }
    if (drawMode && drawPoints.length) {
      const latlngs = drawPoints.map(([lng, lat]) => L.latLng(lat, lng));
      if (latlngs.length >= 3) L.polygon(latlngs, { color: '#8fcfc0', weight: 2, dashArray: '4 4', fillOpacity: 0.1 }).addTo(overlay);
      else L.polyline(latlngs, { color: '#8fcfc0', weight: 2, dashArray: '4 4' }).addTo(overlay);
      latlngs.forEach((latlng, index) => L.circleMarker(latlng, { radius: 5, color: '#e7f0f2', fillColor: '#2fc4a7', fillOpacity: 1 }).bindTooltip(`Point ${index + 1}`).addTo(overlay));
    }
    if (centre) L.circleMarker([centre.lat, centre.lng], { radius: 4, color: '#e7f0f2', fillColor: '#e0a93a', fillOpacity: 1 }).bindTooltip('Recorded centre').addTo(overlay);
    checkpoints.filter((checkpoint) => checkpoint.gps_lat != null && checkpoint.gps_lng != null).forEach((checkpoint) => {
      const colour = !checkpoint.active ? '#7a8794' : checkpoint.checkpoint_verification === 'verified' ? '#2fc4a7' : '#e0a93a';
      L.circle([checkpoint.gps_lat as number, checkpoint.gps_lng as number], { radius: checkpoint.radius_meters, color: colour, weight: 2, fillColor: colour, fillOpacity: 0.25 })
        .bindTooltip(`${checkpoint.name} · ${checkpoint.radius_meters} m · ${!checkpoint.active ? 'inactive' : checkpoint.checkpoint_verification}`).addTo(overlay);
    });
    if (pickedPoint) L.marker([pickedPoint.lat, pickedPoint.lng], { icon: L.divIcon({ className: 'workbench-vertex is-checkpoint', iconSize: [16, 16] }), title: 'Checkpoint position' }).bindTooltip('New checkpoint position').addTo(overlay);
    if (addressCandidate && selected.center_lat == null) map.setView([addressCandidate.lat, addressCandidate.lng], 18);
  }, [selected, editRing, drawMode, drawPoints, centre?.lat, centre?.lng, addressCandidate, checkpoints, pickedPoint?.lat, pickedPoint?.lng]);

  const run = async (label: string, command: () => Promise<string | void>) => {
    setBusy(label); setError(null); setNotice(null);
    try {
      const message = await command();
      if (message) setNotice(message);
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : (commandError as { message?: string })?.message ?? `${label} failed.`);
    } finally { setBusy(null); }
  };

  const chooseEntity = (entity: QueueEntity) => run('select', async () => {
    setSelectedKey(keyOf(entity));
    await Promise.all([loadHistory(entity), loadCheckpoints(entity)]);
  });

  const manageCheckpoint = async (action: 'create' | 'update' | 'deactivate' | 'reactivate', checkpoint: Checkpoint | null) => {
    if (!selected || selected.entity_type !== 'client_site' || !profile?.organizationId) throw new Error('Select a site in your organisation first.');
    const radius = checkpointForm.radius.trim() === '' ? null : Number(checkpointForm.radius);
    if (radius !== null && (!Number.isInteger(radius) || radius < 1 || radius > 500)) throw new Error('Radius must be a whole number of metres between 1 and 500 (leave blank for the organisation rule).');
    // ATLAS WRITES: manage_patrol_checkpoint (Q3 direct save; lands unverified; P2 reset on any move)
    const { data, error: manageError } = await supabase.rpc('manage_patrol_checkpoint', {
      p_client_request_id: crypto.randomUUID(),
      p_action: action,
      p_organization_id: profile.organizationId,
      p_checkpoint_id: checkpoint?.id ?? null,
      p_client_site_id: action === 'create' ? selected.entity_id : null,
      p_name: action === 'create' ? checkpointForm.name.trim() : null,
      p_description: null,
      p_gps_lat: action === 'create' || action === 'update' ? pickedPoint?.lat ?? null : null,
      p_gps_lng: action === 'create' || action === 'update' ? pickedPoint?.lng ?? null : null,
      p_radius_meters: action === 'create' || action === 'update' ? radius : null,
      p_qr_code: action === 'create' ? checkpointForm.qrCode.trim() || null : null,
    });
    const receipt = (data as CheckpointReceipt[] | null)?.[0];
    if (manageError || !receipt?.id) throw manageError ?? new Error('The checkpoint receipt was not confirmed.');
    setCheckpointForm(EMPTY_CHECKPOINT_FORM); setPlacingCheckpoint(false); setCheckpointReviewed(null);
    await loadCheckpoints(selected);
    return receipt;
  };

  const placeCheckpoint = (event: FormEvent) => {
    event.preventDefault();
    void run('checkpoint', async () => {
      if (!checkpointForm.name.trim()) throw new Error('A checkpoint name is required.');
      if (!pickedPoint) throw new Error('Pick the checkpoint position on the map or enter its coordinates.');
      const receipt = await manageCheckpoint('create', null);
      return `${receipt.name} placed (${receipt.radius_meters} m, history v${receipt.history_version ?? 1}). It is unverified until you confirm its position on the map.`;
    });
  };

  const moveCheckpoint = (checkpoint: Checkpoint) => run('checkpoint', async () => {
    if (!pickedPoint && checkpointForm.radius.trim() === '') throw new Error('Pick a new position on the map or enter a new radius first.');
    const receipt = await manageCheckpoint('update', checkpoint);
    return receipt.geometry_changed
      ? `${receipt.name} moved (history v${receipt.history_version}). Its verification was reset — confirm the new position on the map.`
      : `${receipt.name} unchanged: the geometry is identical, so its verification stands.`;
  });

  const toggleCheckpoint = (checkpoint: Checkpoint) => run('checkpoint', async () => {
    const receipt = await manageCheckpoint(checkpoint.active ? 'deactivate' : 'reactivate', checkpoint);
    return `${receipt.name} ${checkpoint.active ? 'deactivated; officers will no longer be offered it' : 'reactivated'}.`;
  });

  const verifyCheckpoint = (checkpoint: Checkpoint) => run('checkpoint-verify', async () => {
    if (!selected || checkpointReviewed !== checkpoint.id) return;
    // ATLAS WRITES: verify_boundary (patrol_checkpoint) — refuses a checkpoint with no point (P1)
    const { data, error: verifyError } = await supabase.rpc('verify_boundary', { p_entity_type: 'patrol_checkpoint', p_entity_id: checkpoint.id });
    if (verifyError) throw verifyError;
    if (data !== true) throw new Error('The checkpoint could not be found for verification.');
    setCheckpointReviewed(null);
    await loadCheckpoints(selected);
    return `${checkpoint.name} verified from visual map review.`;
  });

  const propose = async (entity: QueueEntity, geometry: GeoJSON.Geometry, source: string, sourceRef: Record<string, unknown>) => {
    // ATLAS WRITES: propose_boundary (stages only; never touches the live boundary)
    const { data, error: proposeError } = await supabase.rpc('propose_boundary', {
      p_organization_id: entity.organization_id,
      p_entity_type: entity.entity_type,
      p_entity_id: entity.entity_id,
      p_geojson: geometry,
      p_source: source,
      p_source_ref: sourceRef,
      p_address_candidate: addressCandidate ? { label: addressCandidate.label, lat: addressCandidate.lat, lng: addressCandidate.lng, source: addressCandidate.source } : null,
      p_zone_type: entity.entity_type === 'location_zone' ? entity.zone_type : null,
      p_proposed_via: 'workbench',
    });
    const receipt = (data as ProposeReceipt[] | null)?.[0];
    if (proposeError || !receipt?.proposal_id) throw proposeError ?? new Error('The proposal receipt was not confirmed.');
    setDrawPoints([]);
    await loadQueue(keyOf(entity));
    return `${SOURCE_LABEL[source] ?? source} proposed for ${entity.name}: ${formatArea(receipt.area_m2)}${receipt.gate_ok ? '' : ` — outside the ${entity.entity_type === 'client_site' ? 'site' : entity.zone_type ?? 'zone'} area band (${receipt.gate_reason}); it cannot be accepted as drawn`}${receipt.drift_from_current_m != null ? ` · ${Math.round(receipt.drift_from_current_m)} m from the current boundary` : ''}. Inspect it on the map before deciding.`;
  };

  const findAddress = () => run('address', async () => {
    const candidate = (await resolveAddressCandidates(addressQuery, 1))[0];
    if (!candidate) throw new Error('No matching address was returned by LINZ.');
    setAddressCandidate(candidate);
    setCoordinates((current) => ({ ...current, latitude: candidate.lat.toString(), longitude: candidate.lng.toString() }));
    return `Address resolved: ${candidate.label}. Suggest a LINZ boundary or use it as the point-radius centre.`;
  });

  const proposeFromLinz = () => run('linz', async () => {
    if (!selected || !centre) throw new Error('Resolve an address first so LINZ can be queried at a point.');
    const { data, error: linzError } = await supabase.functions.invoke<LinzBoundary>('linz-lookup', { body: { action: 'boundary_for_point_escalating', lat: centre.lat, lng: centre.lng } });
    if (linzError) throw linzError;
    if (!data?.geometry || !data.kind) throw new Error(data?.note ?? 'No parcel or building polygon was found at this point. Draw the boundary on the map or use point + radius (provisional).');
    const properties = (data.properties ?? {}) as Record<string, unknown>;
    return propose(selected, data.geometry, data.kind === 'building' ? 'linz_building' : 'linz_parcel', {
      appellation: properties.appellation ?? null, parcel_id: properties.id ?? null, matched_via: data.matched_via ?? null, queried_at: { lat: centre.lat, lng: centre.lng },
    });
  });

  const proposePointRadius = (event: FormEvent) => {
    event.preventDefault();
    void run('radius', async () => {
      if (!selected) return;
      const lat = Number(coordinates.latitude); const lng = Number(coordinates.longitude); const radius = Number(coordinates.radius);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius) || radius < 5) throw new Error('A centre and a radius of at least 5 m are required.');
      return propose(selected, circlePolygon(lat, lng, radius), 'google_point_radius', { center: { lat, lng }, radius_m: radius });
    });
  };

  const proposeDrawn = () => run('draw', async () => {
    if (!selected) return;
    if (drawPoints.length < 3) throw new Error('Click at least three points on the map to outline the boundary.');
    return propose(selected, ringPolygon(drawPoints), 'user_drawn', { vertices: drawPoints.length });
  });

  const acceptProposal = () => run('accept', async () => {
    if (!selected?.open_proposal_id) return;
    // ATLAS WRITES: accept_boundary_proposal (the human-confirmed shape becomes the live boundary; verify is a separate human act)
    const { data, error: acceptError } = await supabase.rpc('accept_boundary_proposal', {
      p_proposal_id: selected.open_proposal_id,
      p_final_geojson: proposalEdited && editRing ? ringPolygon(editRing) : null,
      p_verify: visualReviewConfirmed,
      p_note: decisionNote.trim() || null,
    });
    const receipt = (data as AcceptReceipt[] | null)?.[0];
    if (acceptError || !receipt?.entity_id) throw acceptError ?? new Error('The acceptance receipt was not confirmed.');
    await loadQueue(keyOf(selected));
    return `${selected.name} boundary accepted${receipt.human_edited ? ' with your edits' : ''} (${formatArea(receipt.area_m2)}, history v${receipt.history_version})${receipt.verified ? ' and verified from visual map review.' : '. It stays unverified until you confirm it on the map.'}`;
  });

  const rejectProposal = () => run('reject', async () => {
    if (!selected?.open_proposal_id) return;
    if (!rejectNote.trim()) throw new Error('A rejection reason is required.');
    // ATLAS WRITES: reject_boundary_proposal
    const { error: rejectError } = await supabase.rpc('reject_boundary_proposal', { p_proposal_id: selected.open_proposal_id, p_note: rejectNote.trim() });
    if (rejectError) throw rejectError;
    await loadQueue(keyOf(selected));
    return `Proposal rejected for ${selected.name}. The live boundary is unchanged.`;
  });

  const verifyBoundary = () => run('verify', async () => {
    if (!selected?.has_boundary || !visualReviewConfirmed) return;
    // ATLAS WRITES: verify_boundary (refuses when no valid geometry exists — P1)
    const { data, error: verifyError } = await supabase.rpc('verify_boundary', { p_entity_type: selected.entity_type, p_entity_id: selected.entity_id });
    if (verifyError) throw verifyError;
    if (data !== true) throw new Error('The place could not be found for verification.');
    await loadQueue(keyOf(selected));
    return `${selected.name} boundary verified from visual map review.`;
  });

  const counts = useMemo(() => ({
    missing: queue.filter((entity) => entity.boundary_state === 'missing').length,
    unverified: queue.filter((entity) => entity.boundary_state === 'unverified').length,
    proposals: queue.filter((entity) => entity.open_proposal_id).length,
    verified: queue.filter((entity) => entity.boundary_state === 'verified').length,
  }), [queue]);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = queue.filter((entity) => {
    if (filter === 'attention' && entity.boundary_state === 'verified' && !entity.open_proposal_id) return false;
    if (filter === 'proposals' && !entity.open_proposal_id) return false;
    if (filter === 'verified' && entity.boundary_state !== 'verified') return false;
    return !normalizedQuery || `${entity.name} ${entity.organization_name} ${entity.address ?? ''} ${entity.zone_type ?? ''}`.toLowerCase().includes(normalizedQuery);
  });

  const verdict = selected ? (selected.open_proposal_id ? 'Proposal awaiting decision' : STATE_LABEL[selected.boundary_state]) : '';
  const placeNoun = selected?.entity_type === 'location_zone' ? 'zone' : 'site';
  const inspectionTarget = selected?.entity_type === 'location_zone' ? 'zone extent' : 'site address';

  return <ShellLayout shell="admin" className="boundary-shell">
    <div className="boundary-page">
    <header className="boundary-heading"><div><span>Site operations</span><h1>Geofence workbench</h1><p>Every boundary is proposed from a source, inspected on the LINZ map by a person, then accepted and verified. Nothing becomes authoritative on its own.</p></div><button type="button" onClick={() => void loadQueue(selectedKey)} disabled={loading}><RefreshCw size={16} className={loading ? 'is-spinning' : ''} />Refresh</button></header>
    {error && <div className="boundary-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span></div>}
    {notice && <div className="boundary-message is-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span></div>}

    <section className="boundary-summary workbench-summary" aria-label="Geofence review status"><div><MapPin size={18} /><span>No geometry</span><strong>{counts.missing}</strong></div><div><AlertTriangle size={18} /><span>Awaiting verification</span><strong>{counts.unverified}</strong></div><div><PenTool size={18} /><span>Open proposals</span><strong>{counts.proposals}</strong></div><div><ShieldCheck size={18} /><span>Verified</span><strong>{counts.verified}</strong></div></section>

    <div className="boundary-workspace">
      <aside className="boundary-queue"><div className="boundary-tools"><div className="boundary-search"><Search size={15} /><input aria-label="Search places" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search place, organisation, address" /></div><div className="boundary-filters workbench-filters" role="group" aria-label="Geofence queue filter"><button className={filter === 'attention' ? 'is-active' : ''} onClick={() => setFilter('attention')}>Attention</button><button className={filter === 'proposals' ? 'is-active' : ''} onClick={() => setFilter('proposals')}>Proposals</button><button className={filter === 'verified' ? 'is-active' : ''} onClick={() => setFilter('verified')}>Verified</button><button className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>All</button></div></div>
        <div className="boundary-list" aria-label="Places in the geofence queue">{loading && !queue.length ? <div className="boundary-empty"><RefreshCw size={18} className="is-spinning" />Loading places</div> : visible.length ? visible.map((entity) => <button type="button" key={keyOf(entity)} className={selectedKey === keyOf(entity) ? 'is-selected' : ''} onClick={() => void chooseEntity(entity)}><span className={`boundary-state is-${entity.boundary_state === 'verified' ? 'verified' : 'unverified'}`}>{entity.entity_type === 'client_site' ? <MapPin size={16} /> : <Landmark size={16} />}</span><span><strong>{entity.name}</strong><small>{entity.organization_name} · {entityLabel(entity)}</small><small>{entity.address ?? 'Address not recorded'}</small></span><em>{entity.open_proposal_id ? 'Proposal' : entity.boundary_state === 'verified' ? 'Verified' : entity.has_boundary ? 'Review' : 'No geometry'}</em></button>) : <div className="boundary-empty">No places match this queue.</div>}</div>
      </aside>

      <main className="boundary-detail">{selected ? <>
        <header><div><span>{selected.organization_name} · {entityLabel(selected)}</span><h2>{selected.name}</h2><p>{selected.address ?? 'Address not recorded'}</p></div><div className={`boundary-verdict is-${selected.boundary_state === 'verified' && !selected.open_proposal_id ? 'verified' : 'unverified'}`}><strong>{verdict}</strong><span>{selected.boundary_status ? `${selected.boundary_status} provenance` : 'no provenance yet'}</span></div></header>
        <section className="boundary-facts workbench-facts"><div><span>Geometry</span><strong>{selected.has_boundary ? 'Recorded' : 'Missing'}</strong></div><div><span>Centre</span><strong>{selected.center_lat != null && selected.center_lng != null ? `${selected.center_lat.toFixed(5)}, ${selected.center_lng.toFixed(5)}` : 'Not recorded'}</strong></div><div><span>Active agreements</span><strong>{selected.active_agreements}</strong></div><div><span>Configuration</span><strong>v{selected.configuration_version}</strong></div></section>

        <section className="boundary-action-panel">
          <div className="boundary-panel-heading"><div><MapPin size={18} /><span><strong>Map inspection</strong><small>Current boundary in teal; proposal in amber (dashed). Drag amber vertices to correct a proposal before accepting.</small></span></div></div>
          <div className="boundary-map" ref={mapContainerRef} aria-label={`Boundary map for ${selected.name}`} />
          <div className="workbench-legend" aria-hidden="true"><span className="is-current" />Current<span className="is-proposed" />Proposed<span className="is-centre" />Centre</div>
          {!selected.has_boundary && !selected.open_proposal_id && <p className="workbench-hint"><AlertTriangle size={14} /> No boundary is recorded. Until one is accepted and verified, scans, dispatch and billing at this place resolve as <code>unresolved_no_geofence</code>.</p>}
          {selected.has_boundary && selected.boundary_verification !== 'verified' && !selected.open_proposal_id && <p className="workbench-hint"><AlertTriangle size={14} /> Geometry exists but has not been verified on the map; runtime resolution treats it as <code>unresolved_unverified</code>.</p>}
        </section>

        {selected.open_proposal_id ? (
          <section className="boundary-action-panel workbench-proposal" aria-label="Open boundary proposal">
            <div className="boundary-panel-heading"><div><PenTool size={18} /><span><strong>Proposal awaiting your decision</strong><small>{SOURCE_LABEL[selected.open_proposal_source ?? ''] ?? selected.open_proposal_source}</small></span></div></div>
            <div className="boundary-facts workbench-facts"><div><span>Proposed area</span><strong>{formatArea(selected.open_proposal_area_m2)}</strong></div><div><span>Area gate</span><strong className={selected.open_proposal_gate_ok ? 'is-ok' : 'is-fail'}>{selected.open_proposal_gate_ok ? 'Within band' : 'Outside band — cannot be accepted as drawn'}</strong></div><div><span>Drift from current</span><strong>{selected.open_proposal_drift_m != null ? `${Math.round(selected.open_proposal_drift_m)} m` : selected.has_boundary ? 'Not measured' : 'No current boundary'}</strong></div><div><span>Your edits</span><strong>{proposalRing ? (proposalEdited ? 'Vertices moved' : 'None') : 'Not editable (multi-part or holes)'}</strong></div></div>
            <div className="boundary-review-gate"><ShieldCheck size={18} /><div><strong>Visual verification</strong><span>Accepting writes this shape to the live {placeNoun} as unverified. Tick to also verify it now — only if you have inspected the full boundary on the map.</span><label><input type="checkbox" checked={visualReviewConfirmed} onChange={(event) => setVisualReviewConfirmed(event.target.checked)} />I inspected the full boundary against the {inspectionTarget}.</label></div></div>
            <div className="workbench-decision">
              <label><span>Decision note (optional)</span><input aria-label="Decision note" value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} placeholder="e.g. nudged to the fence line" /></label>
              <div className="workbench-decision-actions">
                {proposalEdited && <button type="button" className="is-secondary" onClick={() => setEditRing(proposalRing)} disabled={busy !== null}>Undo edits</button>}
                <button type="button" onClick={() => void acceptProposal()} disabled={busy !== null}>{busy === 'accept' ? 'Accepting' : visualReviewConfirmed ? 'Accept and verify boundary' : 'Accept boundary'}</button>
              </div>
              <label><span>Rejection reason (required to reject)</span><input aria-label="Rejection reason" value={rejectNote} onChange={(event) => setRejectNote(event.target.value)} placeholder="Why this shape is wrong" /></label>
              <div className="workbench-decision-actions"><button type="button" className="is-danger" onClick={() => void rejectProposal()} disabled={busy !== null || !rejectNote.trim()}><XCircle size={15} /> Reject proposal</button></div>
            </div>
          </section>
        ) : (
          <section className="boundary-action-panel" aria-label="Propose a boundary">
            <div className="boundary-panel-heading"><div><PenTool size={18} /><span><strong>Propose a boundary</strong><small>Source ladder: LINZ parcel or building → drawn by hand → point + radius (provisional). Every rung lands as a proposal.</small></span></div></div>
            <div className="workbench-source-tabs" role="tablist" aria-label="Boundary source">
              <button type="button" role="tab" aria-selected={sourcePanel === 'linz'} className={sourcePanel === 'linz' ? 'is-active' : ''} onClick={() => setSourcePanel('linz')}><Landmark size={14} /> Suggest from LINZ</button>
              <button type="button" role="tab" aria-selected={sourcePanel === 'draw'} className={sourcePanel === 'draw' ? 'is-active' : ''} onClick={() => setSourcePanel('draw')}><PenTool size={14} /> Draw on map</button>
              <button type="button" role="tab" aria-selected={sourcePanel === 'radius'} className={sourcePanel === 'radius' ? 'is-active' : ''} onClick={() => setSourcePanel('radius')}><Ruler size={14} /> Point + radius</button>
            </div>
            {sourcePanel === 'linz' && <div className="workbench-source" role="tabpanel">
              {!centre && <div className="workbench-address"><label><span>Address to query</span><input aria-label="Address to query" value={addressQuery} onChange={(event) => setAddressQuery(event.target.value)} placeholder="Street address (LINZ autocomplete)" /></label><button type="button" onClick={() => void findAddress()} disabled={busy !== null || !addressQuery.trim()}>{busy === 'address' ? 'Resolving' : 'Resolve address'}</button></div>}
              {addressCandidate && <p className="workbench-hint"><MapPin size={14} /> {addressCandidate.label}</p>}
              <p className="workbench-hint">Queries the legal parcel at the {selected.center_lat != null ? 'recorded centre' : 'resolved address point'}, widening to 100 m and then the building outline before giving up. The result is a proposal, not a boundary.</p>
              <button type="button" onClick={() => void proposeFromLinz()} disabled={busy !== null || !centre}>{busy === 'linz' ? 'Querying LINZ' : 'Suggest boundary from LINZ'}</button>
            </div>}
            {sourcePanel === 'draw' && <div className="workbench-source" role="tabpanel">
              <p className="workbench-hint">Click the map to place vertices around the place; {drawPoints.length} placed{drawPoints.length < 3 ? ` (${3 - drawPoints.length} more needed)` : ''}. Keyboard users: use point + radius.</p>
              <div className="workbench-decision-actions"><button type="button" className="is-secondary" onClick={() => setDrawPoints((points) => points.slice(0, -1))} disabled={!drawPoints.length}>Undo point</button><button type="button" className="is-secondary" onClick={() => setDrawPoints([])} disabled={!drawPoints.length}>Clear</button><button type="button" onClick={() => void proposeDrawn()} disabled={busy !== null || drawPoints.length < 3}>{busy === 'draw' ? 'Proposing' : 'Propose drawn boundary'}</button></div>
            </div>}
            {sourcePanel === 'radius' && <form onSubmit={proposePointRadius} role="tabpanel"><label><span>Latitude</span><input aria-label="Latitude" type="number" min="-90" max="90" step="any" required value={coordinates.latitude} onChange={(event) => setCoordinates({ ...coordinates, latitude: event.target.value })} /></label><label><span>Longitude</span><input aria-label="Longitude" type="number" min="-180" max="180" step="any" required value={coordinates.longitude} onChange={(event) => setCoordinates({ ...coordinates, longitude: event.target.value })} /></label><label><span>Radius (metres)</span><div><Ruler size={14} /><input aria-label="Radius in metres" type="number" min="5" max="5000" required value={coordinates.radius} onChange={(event) => setCoordinates({ ...coordinates, radius: event.target.value })} /></div></label><button type="submit" disabled={busy !== null || !coordinates.latitude || !coordinates.longitude}>{busy === 'radius' ? 'Proposing' : 'Propose point-radius boundary'}</button></form>}
            {selected.has_boundary && selected.boundary_verification !== 'verified' && <div className="boundary-review-gate"><ShieldCheck size={18} /><div><strong>Verify the existing boundary</strong><span>Confirm the rendered boundary encloses the intended operating {placeNoun} before certifying it for runtime use.</span><label><input type="checkbox" checked={visualReviewConfirmed} onChange={(event) => setVisualReviewConfirmed(event.target.checked)} />I inspected the full boundary against the {inspectionTarget}.</label></div><button type="button" onClick={() => void verifyBoundary()} disabled={busy !== null || !visualReviewConfirmed}>{busy === 'verify' ? 'Verifying' : 'Verify boundary'}</button></div>}
          </section>
        )}

        {selected.entity_type === 'client_site' && (
          <section className="boundary-action-panel workbench-checkpoints" aria-label="Checkpoints at this site">
            <div className="boundary-panel-heading"><div><Crosshair size={18} /><span><strong>Checkpoints (Tier 4)</strong><small>Point + radius, saved directly (Q3). Every placement lands unverified; moving one resets it. Only the map confirmation certifies it.</small></span></div></div>
            {checkpoints.length ? <ul className="workbench-checkpoint-list">{checkpoints.map((checkpoint) => <li key={checkpoint.id} className={!checkpoint.active ? 'is-inactive' : checkpoint.checkpoint_verification === 'verified' ? 'is-verified' : 'is-unverified'}>
              <div><strong>{checkpoint.name}</strong><small>{checkpoint.gps_lat != null && checkpoint.gps_lng != null ? `${checkpoint.gps_lat.toFixed(5)}, ${checkpoint.gps_lng.toFixed(5)}` : 'No position recorded'} · {checkpoint.radius_meters} m{checkpoint.qr_code ? ` · QR ${checkpoint.qr_code}` : ''}</small></div>
              <em>{!checkpoint.active ? 'Inactive' : checkpoint.checkpoint_verification === 'verified' ? 'Verified' : 'Unverified'}</em>
              <div className="workbench-decision-actions">
                {checkpoint.active && checkpoint.checkpoint_verification !== 'verified' && checkpoint.gps_lat != null && <label className="workbench-inline-gate"><input type="checkbox" checked={checkpointReviewed === checkpoint.id} onChange={(event) => setCheckpointReviewed(event.target.checked ? checkpoint.id : null)} />Position inspected on the map</label>}
                {checkpoint.active && checkpoint.checkpoint_verification !== 'verified' && checkpoint.gps_lat != null && <button type="button" onClick={() => void verifyCheckpoint(checkpoint)} disabled={busy !== null || checkpointReviewed !== checkpoint.id}>{busy === 'checkpoint-verify' ? 'Verifying' : 'Verify checkpoint'}</button>}
                {checkpoint.active && (pickedPoint || checkpointForm.radius.trim()) && <button type="button" className="is-secondary" onClick={() => void moveCheckpoint(checkpoint)} disabled={busy !== null}>Move here{checkpointForm.radius.trim() ? ` · ${checkpointForm.radius} m` : ''}</button>}
                <button type="button" className="is-secondary" onClick={() => void toggleCheckpoint(checkpoint)} disabled={busy !== null}>{checkpoint.active ? 'Deactivate' : 'Reactivate'}</button>
              </div>
            </li>)}</ul> : <p className="workbench-hint">No checkpoints at this site yet. Officers on patrol are offered the site's active checkpoints; a visit records the server-measured distance and the checkpoint's verification state.</p>}
            <form className="workbench-checkpoint-form" onSubmit={placeCheckpoint}>
              <label><span>Name</span><input aria-label="Checkpoint name" value={checkpointForm.name} onChange={(event) => setCheckpointForm({ ...checkpointForm, name: event.target.value })} placeholder="e.g. Gate A" /></label>
              <label><span>Radius (m)</span><input aria-label="Checkpoint radius in metres" type="number" min="1" max="500" step="1" value={checkpointForm.radius} onChange={(event) => setCheckpointForm({ ...checkpointForm, radius: event.target.value })} placeholder="org rule" title="Leave blank to use the organisation rule (checkpoint_radius_m, platform default 5 m)" /></label>
              <label><span>QR code (optional)</span><input aria-label="Checkpoint QR code" value={checkpointForm.qrCode} onChange={(event) => setCheckpointForm({ ...checkpointForm, qrCode: event.target.value })} /></label>
              <label><span>Latitude</span><input aria-label="Checkpoint latitude" type="number" step="any" min="-90" max="90" value={checkpointForm.latitude} onChange={(event) => setCheckpointForm({ ...checkpointForm, latitude: event.target.value })} /></label>
              <label><span>Longitude</span><input aria-label="Checkpoint longitude" type="number" step="any" min="-180" max="180" value={checkpointForm.longitude} onChange={(event) => setCheckpointForm({ ...checkpointForm, longitude: event.target.value })} /></label>
              <div className="workbench-decision-actions">
                <button type="button" className={placingCheckpoint ? '' : 'is-secondary'} aria-pressed={placingCheckpoint} onClick={() => setPlacingCheckpoint((value) => !value)}><Crosshair size={14} /> {placingCheckpoint ? 'Click the map to set the position' : 'Pick position on map'}</button>
                <button type="submit" disabled={busy !== null || !checkpointForm.name.trim() || !pickedPoint}>{busy === 'checkpoint' ? 'Saving' : 'Place checkpoint'}</button>
              </div>
              <p className="workbench-hint workbench-checkpoint-hint">A blank radius uses the organisation rule (platform default 5 m). The QR code is what the officer scans; the radius is how close the GPS fix must be for the server to record the visit as within range.</p>
            </form>
          </section>
        )}

        <section className="boundary-history"><div className="boundary-panel-heading"><div><History size={18} /><span><strong>Boundary history</strong><small>{history.length} recorded {history.length === 1 ? 'event' : 'events'}</small></span></div></div>{history.length ? <div>{history.map((event) => <article key={event.id}><span className={`boundary-history-icon is-${event.verification_state}`}>{event.verification_state === 'verified' ? <CheckCircle2 size={16} /> : <Clock3 size={16} />}</span><div><strong>{event.change_reason}</strong><span>{event.boundary_source ?? 'No source recorded'} · {event.changed_via.replaceAll('_', ' ')}</span></div><time dateTime={event.created_at}>v{event.version} · {new Date(event.created_at).toLocaleString('en-NZ')}</time></article>)}</div> : <div className="boundary-empty">No boundary events have been recorded for this place.</div>}</section>
      </> : <div className="boundary-empty boundary-empty-main"><MapPin size={22} />Select a place to inspect its boundary evidence.</div>}</main>
    </div>
    </div>
  </ShellLayout>;
};

export default SiteBoundaryReviewPage;