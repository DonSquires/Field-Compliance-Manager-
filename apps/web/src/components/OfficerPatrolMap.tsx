import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { addLinzBaseLayers } from '../lib/mapPreferences';
import './OfficerPatrolMap.css';

export interface PatrolMapPoint {
  id: string;
  name: string;
  order: number;
  latitude: number;
  longitude: number;
}

function MapView({ points, onTileError }: { points: PatrolMapPoint[]; onTileError: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const tileError = useRef(onTileError);
  tileError.current = onTileError;

  useEffect(() => {
    if (!container.current) return;
    const map = L.map(container.current, { scrollWheelZoom: false });
    const layers = addLinzBaseLayers(map);
    for (const layer of Object.values(layers)) layer.on('tileerror', () => tileError.current());
    const bounds = L.latLngBounds([]);
    for (const point of points) {
      const position: L.LatLngExpression = [point.latitude, point.longitude];
      bounds.extend(position);
      L.marker(position, {
        keyboard: false,
        title: `${point.order}. ${point.name}`,
        icon: L.divIcon({ className: 'patrol-map-marker', html: `<span>${point.order}</span>`, iconSize: [30, 30] }),
      }).addTo(map);
    }
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: 16 });
    return () => { map.remove(); };
  }, [points]);

  return <div ref={container} className="patrol-map-canvas" role="region" aria-label="Map of planned patrol stops" />;
}

export function OfficerPatrolMap({ points, totalStops }: { points: PatrolMapPoint[]; totalStops: number }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  return <section className="patrol-map" aria-label="Planned patrol map">
    <h3>Planned stop map</h3>
    <p>Numbers show the planned stop order, not a road route. Road directions are not available here.</p>
    {points.length < totalStops && <p>{totalStops - points.length} {totalStops - points.length === 1 ? 'stop has' : 'stops have'} no mapped position and cannot be shown.</p>}
    {points.length === 0 ? <p>No stop positions are available for this shift.</p> : <>
      {!open && <button className="btn btn-secondary" type="button" onClick={() => setOpen(true)}>Show stop map</button>}
      {!open && <p>Loading the map shares the viewed area with the selected map provider.</p>}
      {open && <MapView key={attempt} points={points} onTileError={() => setFailed(true)} />}
      {open && failed && <div role="alert">
        <p>Some map tiles could not be loaded. The ordered stop list remains available.</p>
        <button className="btn btn-secondary" type="button" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}>Retry map</button>
      </div>}
    </>}
  </section>;
}
