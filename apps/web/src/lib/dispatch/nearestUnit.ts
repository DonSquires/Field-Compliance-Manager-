/**
 * nearestUnit.ts — dispatch "nearest available unit" suggestion.
 *
 * Rebuilt per docs/ui-baseline.md's verified `DispatchConsolePage.tsx` read
 * (the new-job form's suggestion button): given the selected site and the
 * list of dispatch resources, suggest the nearest AVAILABLE unit with a
 * known GPS fix, excluding whichever resource is already selected.
 */
import { haversineKm } from '../geo';

export interface DispatchSite {
  gpsLat: number | null;
  gpsLng: number | null;
}

export interface DispatchResourceCandidate {
  id: string;
  name: string;
  callsign: string | null;
  status: string;
  gpsLat: number | null;
  gpsLng: number | null;
}

export interface NearestUnitSuggestion {
  resourceId: string;
  label: string;
  distanceKm: number;
}

/**
 * Returns null when the site has no GPS, no resource is available with a
 * GPS fix, or the nearest candidate is already the selected resource —
 * matching the original's `if (!nearest || nearest.r.id === fResourceId) return null;`.
 */
export function findNearestAvailableUnit(
  site: DispatchSite | null | undefined,
  resources: DispatchResourceCandidate[],
  selectedResourceId: string,
): NearestUnitSuggestion | null {
  if (!site || site.gpsLat == null || site.gpsLng == null) return null;

  const candidates = resources
    .filter((r) => r.status === 'available' && r.gpsLat != null && r.gpsLng != null)
    .map((r) => ({
      resource: r,
      km: haversineKm(site.gpsLat as number, site.gpsLng as number, r.gpsLat as number, r.gpsLng as number),
    }))
    .sort((a, b) => a.km - b.km);

  const nearest = candidates[0];
  if (!nearest || nearest.resource.id === selectedResourceId) return null;

  return {
    resourceId: nearest.resource.id,
    label: nearest.resource.callsign ?? nearest.resource.name,
    distanceKm: nearest.km,
  };
}
