import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, Building2, CheckCircle2, Crosshair, LandPlot, LoaderCircle, MapPin, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './LocationHouseMap.css';
import './LocationHouseMapSpine.css';

type Boundary = GeoJSON.GeoJsonObject | null;

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

interface LinzPreview {
  address: string;
  source: string;
  geometry: GeoJSON.GeoJsonObject;
  match: string;
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

export function LocationHouseMap({ organizationId, house, sites, zones }: { organizationId: string; house: { name: string; address: string | null }; sites: HouseMapSite[]; zones: HouseMapZone[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const [linzPreview, setLinzPreview] = useState<LinzPreview | null>(null);
  const [probePoint, setProbePoint] = useState<{ lat: number; lng: number } | null>(null);
  const [resolution, setResolution] = useState<GeofenceResolution | null>(null);
  const [closure, setClosure] = useState<ZoneClosure | null>(null);
  const [resolving, setResolving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    mapRef.current?.remove();
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true }).setView([-41.2, 172.5], 5);
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    const bounds = L.latLngBounds([]);
    const addBoundary = (geometry: GeoJSON.GeoJsonObject, style: L.PathOptions, label: string) => {
      const layer = L.geoJSON(geometry, { style }).bindTooltip(label);
      layer.addTo(map);
      const layerBounds = layer.getBounds();
      if (layerBounds.isValid()) bounds.extend(layerBounds);
    };

    sites.forEach((site) => {
      if (site.boundary) addBoundary(site.boundary, { color: '#2fc4a7', weight: 3, fillColor: '#2fc4a7', fillOpacity: 0.12 }, `Site: ${site.name}`);
      else if (site.gps_lat != null && site.gps_lng != null) {
        const point = L.circleMarker([site.gps_lat, site.gps_lng], { radius: 7, color: '#2fc4a7', fillColor: '#0e705f', fillOpacity: 0.9 }).bindTooltip(`Site: ${site.name}`).addTo(map);
        bounds.extend(point.getLatLng());
      }
    });
    zones.forEach((zone) => {
      if (zone.boundary) addBoundary(zone.boundary, { color: '#f0b35a', weight: 2, dashArray: '7 5', fillColor: '#f0b35a', fillOpacity: 0.1 }, `Zone: ${zone.name}`);
      else if (zone.center_point?.coordinates?.length === 2) {
        const [lng, lat] = zone.center_point.coordinates;
        const point = L.circleMarker([lat, lng], { radius: 6, color: '#f0b35a', fillColor: '#9a5f18', fillOpacity: 0.9 }).bindTooltip(`Zone: ${zone.name}`).addTo(map);
        bounds.extend(point.getLatLng());
      }
    });
    if (linzPreview) addBoundary(linzPreview.geometry, { color: '#5da9ff', weight: 3, dashArray: '3 5', fillColor: '#5da9ff', fillOpacity: 0.08 }, `LINZ preview: ${linzPreview.address}`);
    if (probePoint) {
      const probe = L.circleMarker([probePoint.lat, probePoint.lng], { radius: 7, color: '#f4f7f8', weight: 2, fillColor: resolution?.matched_zone_id ? '#2fc4a7' : '#d26a5c', fillOpacity: 1 }).bindTooltip('Geofence resolution point').addTo(map);
      bounds.extend(probe.getLatLng());
    }
    map.on('click', ({ latlng }) => { setProbePoint({ lat: latlng.lat, lng: latlng.lng }); setResolution(null); setClosure(null); });
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.18), { maxZoom: 18 });
    window.setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; };
  }, [sites, zones, linzPreview, probePoint, resolution, house.name]);

  useEffect(() => {
    if (!probePoint || !organizationId) return;
    let active = true;
    const resolvePoint = async () => {
      setProbing(true); setError(null);
      const { data, error: resolveError } = await supabase.rpc('resolve_context', { p_lat: probePoint.lat, p_lng: probePoint.lng, p_org_id: organizationId, p_module_key: null });
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

  const previewLinzBoundary = async () => {
    const query = house.address?.trim() || house.name.trim();
    if (!query) return;
    setResolving(true); setError(null); setLinzPreview(null);
    const { data: addressData, error: addressError } = await supabase.functions.invoke('linz-lookup', { body: { action: 'address_autocomplete', q: query, max: 1 } });
    const candidate = addressData?.candidates?.[0] as { label: string; lat: number; lng: number; source: string } | undefined;
    if (addressError || !candidate) {
      setError(addressError?.message ?? 'LINZ returned no canonical address candidate for this house.');
      setResolving(false); return;
    }
    const { data: boundaryData, error: boundaryError } = await supabase.functions.invoke('linz-lookup', { body: { action: 'boundary_for_point_escalating', lat: candidate.lat, lng: candidate.lng } });
    if (boundaryError || !boundaryData?.geometry) setError(boundaryError?.message ?? 'LINZ returned an address point but no parcel or building polygon.');
    else setLinzPreview({ address: candidate.label, source: candidate.source, geometry: boundaryData.geometry as GeoJSON.GeoJsonObject, match: boundaryData.matched_via?.exact ? `Exact ${boundaryData.matched_via.layer}` : `${boundaryData.matched_via?.layer ?? 'boundary'} within ${boundaryData.matched_via?.radius_m ?? 0} m` });
    setResolving(false);
  };

  const verifiedZones = zones.filter((zone) => zone.boundary && zone.boundary_verification === 'verified').length;
  const unresolvedFacets = [...sites, ...zones].filter((facet) => !facet.boundary || facet.boundary_verification !== 'verified').length;
  return <section className="house-map" aria-label={`Map for ${house.name}`}>
    <header><div><span>Geofence control spine</span><h3>{house.name}</h3><p>{house.address ?? 'Address not recorded'}</p></div><button type="button" onClick={() => void previewLinzBoundary()} disabled={resolving || (!house.address && !house.name)}>{resolving ? <LoaderCircle size={15} className="is-spinning" /> : <LandPlot size={15} />}{resolving ? 'Resolving LINZ' : 'Preview LINZ boundary'}</button></header>
    <div className="house-map-gates"><span className={verifiedZones ? 'is-ready' : 'is-blocked'}><ShieldCheck size={14} /><strong>{verifiedZones}</strong> verified runtime zone{verifiedZones === 1 ? '' : 's'}</span><span className={unresolvedFacets ? 'is-blocked' : 'is-ready'}><AlertTriangle size={14} /><strong>{unresolvedFacets}</strong> facet{unresolvedFacets === 1 ? '' : 's'} need boundary review</span><span><Crosshair size={14} />{probing ? 'Resolving point' : 'Select map point to resolve context'}</span></div>
    {error && <div className="house-map-message is-error" role="alert"><AlertTriangle size={15} />{error}</div>}
    {linzPreview && <div className="house-map-message is-success" role="status"><CheckCircle2 size={15} /><span><strong>Read-only LINZ preview</strong>{linzPreview.address} · {linzPreview.match}</span></div>}
    {resolution && <div className={`house-map-resolution is-${resolution.resolution_status === 'resolved' ? 'resolved' : 'unresolved'}`} role="status"><div><span>Resolution</span><strong>{resolution.resolution_status.replaceAll('_', ' ')}</strong></div><div><span>Operating bounds</span><strong>{resolution.in_operating_bounds ? 'Inside' : resolution.out_of_bounds_district ? `Outside · ${resolution.out_of_bounds_district}` : 'Outside'}</strong></div><div><span>Runtime zone</span><strong>{resolution.matched_zone_id ? zones.find((zone) => zone.id === resolution.matched_zone_id)?.name ?? 'Matched zone' : 'No verified active zone'}</strong></div><div><span>Site state</span><strong>{resolution.site_id ? resolution.on_site ? 'On site' : 'Zone match · off site' : 'No site match'}</strong></div><div><span>Module trigger</span><strong>{resolution.matched_module_key?.replaceAll('_', ' ') ?? 'None'}</strong></div><div><span>Effective rules</span><strong>{resolution.effective_rules ? `${Object.keys(resolution.effective_rules).length} resolved values` : 'None'}</strong></div><div className={closure ? 'is-warning' : ''}><span>Operational overlay</span><strong>{closure ? `${closure.closure_type.replaceAll('_', ' ')} · ${closure.reason ?? 'No reason recorded'}` : 'No in-force closure'}</strong></div>{resolution.governor_overlap_flag && <div className="is-warning"><span>Jurisdiction</span><strong>Governor overlap review</strong></div>}</div>}
    <div className="house-map-canvas" ref={containerRef} />
    <footer><span><Building2 size={13} />Geometry answers where</span><span><MapPin size={13} />Rules and closures answer what</span><span><LandPlot size={13} />LINZ source preview</span><em>LINZ preview is not saved, verified, or used by runtime resolution.</em></footer>
  </section>;
}