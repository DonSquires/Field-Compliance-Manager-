import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { addLinzBaseLayers } from '../lib/mapPreferences';
import type { FieldPoint } from '../lib/fieldPlaces';

interface Props {
  point: FieldPoint;
  boundaries: GeoJSON.Geometry[];
  onChange: (lat: number, lng: number) => void;
  onReady: (ready: boolean) => void;
}

export function FieldPointMap({ point, boundaries, onChange, onReady }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const overlays = useRef<L.LayerGroup | null>(null);
  const change = useRef(onChange);
  const ready = useRef(onReady);
  const [tileError, setTileError] = useState(false);
  change.current = onChange;
  ready.current = onReady;

  useEffect(() => {
    if (!container.current) return;
    const instance = L.map(container.current, { scrollWheelZoom: false });
    map.current = instance;
    overlays.current = L.layerGroup().addTo(instance);
    const layers = addLinzBaseLayers(instance);
    const loaded = new Set<L.TileLayer>();
    const failed = new Set<L.TileLayer>();
    const report = (layer: L.TileLayer) => {
      if (!instance.hasLayer(layer)) return;
      setTileError(failed.has(layer));
      ready.current(loaded.has(layer) && !layer.isLoading() && !failed.has(layer));
    };
    for (const layer of Object.values(layers)) {
      layer.on('loading', () => { loaded.delete(layer); report(layer); });
      layer.on('load', () => { loaded.add(layer); report(layer); });
      layer.on('tileerror', () => { failed.add(layer); report(layer); });
    }
    instance.on('baselayerchange', event => { if (event.layer instanceof L.TileLayer) report(event.layer); });
    instance.on('click', (event: L.LeafletMouseEvent) => change.current(event.latlng.lat, event.latlng.lng));
    instance.setView([point.confirmed_lat, point.confirmed_lng], 19);
    return () => { ready.current(false); instance.remove(); map.current = null; overlays.current = null; };
  }, []);

  useEffect(() => {
    const layer = overlays.current;
    if (!layer || !map.current || !container.current) return;
    const tokens = getComputedStyle(container.current);
    const primary = tokens.getPropertyValue('--color-brand-primary').trim();
    const secondary = tokens.getPropertyValue('--color-text-secondary').trim();
    const warning = tokens.getPropertyValue('--color-status-watch').trim();
    layer.clearLayers();
    for (const boundary of boundaries) L.geoJSON(boundary, { style: { color: secondary, fillOpacity: 0.05 } }).addTo(layer);
    L.circle([point.lat, point.lng], { radius: point.accuracy, color: warning, fillOpacity: 0.06, dashArray: '4 4' }).addTo(layer);
    L.circle([point.confirmed_lat, point.confirmed_lng], { radius: 10, color: primary, fillOpacity: 0.2 }).addTo(layer);
    L.circleMarker([point.confirmed_lat, point.confirmed_lng], { radius: 4, color: primary }).addTo(layer);
    map.current.panTo([point.confirmed_lat, point.confirmed_lng]);
  }, [point, boundaries]);

  return <div>
    <div ref={container} className="field-point-map" role="region" aria-label="Confirm the 10 metre location point on the map" />
    {tileError && <p role="alert">The map could not be loaded. Retry the capture or choose another map layer before confirming.</p>}
    <p className="place-help">Click the map to correct the point. The solid circle is 10 m; the dashed circle is the phone's reported accuracy.</p>
  </div>;
}
