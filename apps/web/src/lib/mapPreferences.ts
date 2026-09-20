/**
 * Map preferences shared by every Leaflet surface: the LINZ base layers, the person's remembered base-layer
 * choice (per browser, localStorage) and the last viewport of a named map (per tab, sessionStorage), so a map
 * comes back the way it was left instead of snapping to its default framing on every render or return.
 */
import L from 'leaflet';

export type BaseLayerKey = 'topographic' | 'aerial';
const BASE_LAYER_KEY = 'fcm.map.baseLayer';
const VIEW_PREFIX = 'fcm.map.view:';
const LINZ_ATTRIBUTION = '&copy; LINZ | CC BY 4.0';

export const linzTileUrl = (layer: BaseLayerKey): string => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/linz-map-tile?layer=${layer}&z={z}&x={x}&y={y}`;

const safe = <T,>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };

export const readBaseLayer = (): BaseLayerKey => safe(() => (window.localStorage.getItem(BASE_LAYER_KEY) === 'aerial' ? 'aerial' : 'topographic'), 'topographic');
export const rememberBaseLayer = (layer: BaseLayerKey): void => { safe(() => window.localStorage.setItem(BASE_LAYER_KEY, layer), undefined); };

/** Adds both LINZ base layers (the remembered one shown), the switcher, and keeps remembering the person's choice. */
export function addLinzBaseLayers(map: L.Map, options: { collapsed?: boolean; overlays?: Record<string, L.Layer>; maxZoom?: number } = {}): Record<BaseLayerKey, L.TileLayer> {
  const maxZoom = options.maxZoom ?? 20;
  const layers: Record<BaseLayerKey, L.TileLayer> = {
    topographic: L.tileLayer(linzTileUrl('topographic'), { maxZoom, attribution: LINZ_ATTRIBUTION }),
    aerial: L.tileLayer(linzTileUrl('aerial'), { maxZoom, attribution: LINZ_ATTRIBUTION }),
  };
  layers[readBaseLayer()].addTo(map);
  L.control.layers({ 'LINZ topographic': layers.topographic, 'LINZ aerial': layers.aerial }, options.overlays, { collapsed: options.collapsed ?? true }).addTo(map);
  map.on('baselayerchange', (event) => { rememberBaseLayer((event as L.LayersControlEvent).name === 'LINZ aerial' ? 'aerial' : 'topographic'); });
  return layers;
}

export interface RememberedView { lat: number; lng: number; zoom: number }

export const readRememberedView = (key: string): RememberedView | null => safe(() => {
  const raw = window.sessionStorage.getItem(VIEW_PREFIX + key);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<RememberedView>;
  return Number.isFinite(parsed.lat) && Number.isFinite(parsed.lng) && Number.isFinite(parsed.zoom) ? { lat: parsed.lat as number, lng: parsed.lng as number, zoom: parsed.zoom as number } : null;
}, null);

export const forgetRememberedView = (key: string): void => { safe(() => window.sessionStorage.removeItem(VIEW_PREFIX + key), undefined); };

/** Attach once per map: keeps remembering where the person left this named map. */
export function rememberViewport(map: L.Map, key: string): void {
  map.on('moveend', () => {
    const centre = map.getCenter();
    safe(() => window.sessionStorage.setItem(VIEW_PREFIX + key, JSON.stringify({ lat: Number(centre.lat.toFixed(6)), lng: Number(centre.lng.toFixed(6)), zoom: map.getZoom() })), undefined);
  });
}

/** Restores the last viewport for this key if there is one; otherwise runs the default framing. */
export function restoreViewportOr(map: L.Map, key: string, frame: () => void): boolean {
  const remembered = readRememberedView(key);
  if (remembered) { map.setView([remembered.lat, remembered.lng], remembered.zoom, { animate: false }); return true; }
  frame();
  return false;
}
