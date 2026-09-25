/**
 * Map preferences shared by every Leaflet surface: the base layers, the person's remembered base-layer
 * choice (per browser, localStorage) and the last viewport of a named map (per tab, sessionStorage), so a map
 * comes back the way it was left instead of snapping to its default framing on every render or return.
 */
import L from 'leaflet';

export type BaseLayerKey = 'street' | 'satellite' | 'aerial' | 'topographic';
const BASE_LAYER_KEY = 'fcm.map.baseLayer';
const VIEW_PREFIX = 'fcm.map.view:';

/** Street and satellite answer "which building, which driveway"; LINZ aerial and Topo50 are the official NZ sources. */
const BASE_LAYERS: Array<{ key: BaseLayerKey; label: string; attribution: string }> = [
  { key: 'street', label: 'Street map', attribution: '&copy; Google' },
  { key: 'satellite', label: 'Satellite', attribution: '&copy; Google' },
  { key: 'aerial', label: 'LINZ aerial', attribution: '&copy; LINZ | CC BY 4.0' },
  { key: 'topographic', label: 'LINZ topographic', attribution: '&copy; LINZ | CC BY 4.0' },
];
const DEFAULT_BASE_LAYER: BaseLayerKey = 'street';

export const linzTileUrl = (layer: BaseLayerKey): string => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/linz-map-tile?layer=${layer}&z={z}&x={x}&y={y}`;

const safe = <T,>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };

export const readBaseLayer = (): BaseLayerKey => safe(() => {
  const stored = window.localStorage.getItem(BASE_LAYER_KEY) as BaseLayerKey | null;
  return stored && BASE_LAYERS.some((layer) => layer.key === stored) ? stored : DEFAULT_BASE_LAYER;
}, DEFAULT_BASE_LAYER);
export const rememberBaseLayer = (layer: BaseLayerKey): void => { safe(() => window.localStorage.setItem(BASE_LAYER_KEY, layer), undefined); };

/** Adds every base layer (the remembered one shown), the switcher, and keeps remembering the person's choice. */
export function addLinzBaseLayers(map: L.Map, options: { collapsed?: boolean; overlays?: Record<string, L.Layer>; maxZoom?: number } = {}): Record<BaseLayerKey, L.TileLayer> {
  const maxZoom = options.maxZoom ?? 20;
  const layers = Object.fromEntries(BASE_LAYERS.map((layer) => [layer.key, L.tileLayer(linzTileUrl(layer.key), { maxZoom, attribution: layer.attribution })])) as Record<BaseLayerKey, L.TileLayer>;
  layers[readBaseLayer()].addTo(map);
  L.control.layers(Object.fromEntries(BASE_LAYERS.map((layer) => [layer.label, layers[layer.key]])), options.overlays, { collapsed: options.collapsed ?? true }).addTo(map);
  map.on('baselayerchange', (event) => {
    const chosen = BASE_LAYERS.find((layer) => layer.label === (event as L.LayersControlEvent).name);
    if (chosen) rememberBaseLayer(chosen.key);
  });
  keepPageStillOnClick(map);
  return layers;
}


/**
 * Leaflet's keyboard handler focuses the map container on pointer-down, and the browser scrolls the shell's scrolling pane
 * to reveal the whole map — the pin slides out from under the pointer before mouseup, so the click never lands. Leaflet
 * restores only window scroll, not a nested scroller. Record every scrolling ancestor before the focus and put it back.
 */
export function keepPageStillOnClick(map: L.Map): void {
  const container = map.getContainer();
  let saved: Array<[Element, number, number]> = [];
  const remember = () => {
    saved = [];
    for (let node: Element | null = container.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll' || node === document.scrollingElement) saved.push([node, node.scrollTop, node.scrollLeft]);
    }
  };
  container.addEventListener('pointerdown', remember, true);
  container.addEventListener('mousedown', () => { if (!saved.length) remember(); }, true);
  container.addEventListener('focus', () => { saved.forEach(([node, top, left]) => { if (node.scrollTop !== top) node.scrollTop = top; if (node.scrollLeft !== left) node.scrollLeft = left; }); saved = []; });
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
