import { beforeEach, describe, expect, it, vi } from 'vitest';

// Leaflet needs a DOM window at import time; keep the helper's contract testable without one.
vi.mock('leaflet', () => {
  const tileLayer = () => ({ addTo: vi.fn() });
  const layersControl = { addTo: vi.fn() };
  return { default: { tileLayer, control: { layers: () => layersControl } } };
});

import { addLinzBaseLayers, readBaseLayer, readRememberedView, rememberBaseLayer, rememberViewport, restoreViewportOr } from './mapPreferences';

type Handler = (event: unknown) => void;
const fakeMap = () => {
  const handlers: Record<string, Handler[]> = {};
  const state = { lat: -41.27, lng: 173.28, zoom: 9 };
  const container = document.createElement('div');
  return {
    state,
    getContainer: () => container,
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    fire: (name: string, event?: unknown) => (handlers[name] ?? []).forEach((handler) => handler(event)),
    setView: vi.fn(([lat, lng]: [number, number], zoom: number) => { state.lat = lat; state.lng = lng; state.zoom = zoom; }),
    getCenter: () => ({ lat: state.lat, lng: state.lng }),
    getZoom: () => state.zoom,
  };
};

describe('map preferences', () => {
  beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });

  it('remembers the base layer per browser and shows it first next time', () => {
    expect(readBaseLayer()).toBe('street');
    const map = fakeMap();
    addLinzBaseLayers(map as never);
    map.fire('baselayerchange', { name: 'Satellite' });
    expect(readBaseLayer()).toBe('satellite');
    map.fire('baselayerchange', { name: 'LINZ aerial' });
    expect(readBaseLayer()).toBe('aerial');
    map.fire('baselayerchange', { name: 'Street map' });
    expect(readBaseLayer()).toBe('street');
    rememberBaseLayer('topographic');
    expect(window.localStorage.getItem('fcm.map.baseLayer')).toBe('topographic');
  });

  it('restores the last viewport of a named map in this tab, otherwise frames the default', () => {
    const map = fakeMap();
    rememberViewport(map as never, 'workbench:location_zone:z1');
    const frame = vi.fn();
    expect(restoreViewportOr(map as never, 'workbench:location_zone:z1', frame)).toBe(false);
    expect(frame).toHaveBeenCalledTimes(1);
    map.state.lat = -41.2706; map.state.lng = 173.2840; map.state.zoom = 17;
    map.fire('moveend');
    expect(readRememberedView('workbench:location_zone:z1')).toEqual({ lat: -41.2706, lng: 173.284, zoom: 17 });
    const second = fakeMap();
    const frameAgain = vi.fn();
    expect(restoreViewportOr(second as never, 'workbench:location_zone:z1', frameAgain)).toBe(true);
    expect(frameAgain).not.toHaveBeenCalled();
    expect(second.setView).toHaveBeenCalledWith([-41.2706, 173.284], 17, { animate: false });
    // another place keeps its own memory
    expect(readRememberedView('workbench:client_site:s1')).toBeNull();
  });

  it('ignores corrupt storage rather than breaking the map', () => {
    window.sessionStorage.setItem('fcm.map.view:house:x', '{not json');
    expect(readRememberedView('house:x')).toBeNull();
    window.sessionStorage.setItem('fcm.map.view:house:y', JSON.stringify({ lat: 'a', lng: 1, zoom: 2 }));
    expect(readRememberedView('house:y')).toBeNull();
  });
});
