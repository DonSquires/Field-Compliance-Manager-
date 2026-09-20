import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LocateFixed, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { addLinzBaseLayers } from '../lib/mapPreferences';
import './OfficerRouteGuidance.css';

type Route = { distance_meters: number; duration_seconds: number; geometry: [number, number][]; steps: Array<{ instruction: string; distance_meters: number }>; destination_lat: number; destination_lng: number };
type RoutePlan = { stops: Array<{ id: string; eta_seconds: number; distance_meters: number; sla_risk: string }> };

export function OfficerRouteGuidance({ job, onRecommendation }: { job: { id: string; site: { name: string; address: string | null } | null; sla_respond_by: string | null }; onRecommendation: (jobId: string) => void }) {
  const mapElement = useRef<HTMLDivElement | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [parcel, setParcel] = useState<GeoJSON.GeoJsonObject | null>(null);
  const [message, setMessage] = useState('Use your current location to calculate the recommended route.');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!mapElement.current || !route?.geometry.length) return;
    const points = route.geometry.map(([longitude, latitude]) => L.latLng(latitude, longitude));
    const map = L.map(mapElement.current, { zoomControl: true }).fitBounds(L.latLngBounds(points).pad(0.14));
    const overlays: Record<string, L.Layer> = {};
    if (parcel) overlays['LINZ parcel boundary'] = L.geoJSON(parcel, { style: { color: '#f0b35a', weight: 3, fillColor: '#f0b35a', fillOpacity: 0.08 } }).addTo(map);
    addLinzBaseLayers(map, { collapsed: false, overlays });
    L.polyline(points, { color: '#14c8d4', weight: 5, opacity: 0.9 }).addTo(map);
    L.marker(points.at(-1)!).addTo(map).bindTooltip(job.site?.name ?? 'Destination', { permanent: true, direction: 'top' });
    const timer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => { window.clearTimeout(timer); map.remove(); };
  }, [job.site?.name, parcel, route]);

  const calculateRoute = () => {
    if (!navigator.geolocation) { setMessage('Location services are unavailable on this device.'); return; }
    setLoading(true); setMessage('Finding the best route for the current dispatch priority...');
    navigator.geolocation.getCurrentPosition(async (position) => {
      const origin = { origin_lat: position.coords.latitude, origin_lng: position.coords.longitude };
      const { data: plan, error: planError } = await supabase.functions.invoke<RoutePlan>('officer-route-guidance', { body: { dispatch_job_id: job.id, mode: 'plan', ...origin } });
      const nextJobId = plan?.stops?.[0]?.id ?? job.id;
      if (planError || !nextJobId) { setMessage(planError?.message ?? 'Route plan is unavailable.'); setLoading(false); return; }
      onRecommendation(nextJobId);
      const { data, error } = await supabase.functions.invoke<Route>('officer-route-guidance', { body: { dispatch_job_id: nextJobId, ...origin } });
      if (error || !data?.geometry?.length) setMessage(error?.message ?? 'Route guidance is unavailable.');
      else {
        setRoute(data); setMessage(`Route updated. ${Math.max(0, (plan?.stops.length ?? 1) - 1)} nearby job${(plan?.stops.length ?? 1) === 2 ? '' : 's'} consolidated after this stop.`);
        const { data: parcelData } = await supabase.functions.invoke<{ geometry?: GeoJSON.GeoJsonObject }>('linz-lookup', { body: { action: 'boundary_for_point_escalating', lat: data.destination_lat, lng: data.destination_lng } });
        setParcel(parcelData?.geometry ?? null);
      }
      setLoading(false);
    }, () => { setMessage('A current GPS position is needed to calculate this route.'); setLoading(false); }, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 10_000 });
  };

  return <section className="officer-route-guidance" aria-label="Recommended route guidance">
    <header><div><span>Recommended next stop</span><h2>{job.site?.name ?? 'Assigned dispatch location'}</h2><p>{job.site?.address ?? 'Address unavailable'}{job.sla_respond_by ? ` · respond by ${new Date(job.sla_respond_by).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}` : ''}</p></div><button type="button" onClick={calculateRoute} disabled={loading}><LocateFixed size={16} />{loading ? 'Routing' : route ? 'Re-route' : 'Route from here'}</button></header>
    <p className="officer-route-status">{message}</p>
    {route && <><div ref={mapElement} className="officer-route-map" /> <div className="officer-route-summary"><strong>{Math.ceil(route.duration_seconds / 60)} min</strong><span>{(route.distance_meters / 1000).toFixed(1)} km</span></div><ol>{route.steps.slice(0, 5).map((step, index) => <li key={`${step.instruction}-${index}`}><span>{step.instruction || 'Continue'}</span><small>{step.distance_meters >= 1000 ? `${(step.distance_meters / 1000).toFixed(1)} km` : `${step.distance_meters} m`}</small></li>)}</ol></>}
  </section>;
}