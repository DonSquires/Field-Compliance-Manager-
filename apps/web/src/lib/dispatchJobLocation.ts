/**
 * Where a dispatch job actually is, for the officer's map link.
 *
 * A dispatch job may carry a client site (gps_lat/gps_lng or center_point), only a
 * location zone (center_point, or a boundary we can average), only a harmed-party
 * address, or nothing but free-text briefing notes. The officer must always get a
 * truthful answer: coordinates, an address to search, or "no map location".
 */

export interface GeoPointLike { type?: string; coordinates?: unknown }

export interface DispatchLocationInput {
  site?: { name?: string | null; address?: string | null; gps_lat?: number | null; gps_lng?: number | null; center_point?: GeoPointLike | null } | null;
  zone?: { name?: string | null; center_point?: GeoPointLike | null; boundary?: GeoPointLike | null } | null;
  harmed_party_address?: string | null;
  briefing_notes?: string | null;
}

export type DispatchDestination =
  | { kind: 'coordinates'; lat: number; lng: number; label: string; source: 'site' | 'zone_centre' | 'zone_boundary'; mapsUrl: string }
  | { kind: 'address'; address: string; label: string; source: 'site_address' | 'harmed_party_address' | 'briefing'; mapsUrl: string }
  | { kind: 'none'; label: string };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function pointFrom(geometry: GeoPointLike | null | undefined): { lat: number; lng: number } | null {
  const coordinates = geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [lng, lat] = coordinates as unknown[];
  return finite(lat) && finite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** Average of every vertex in a Polygon/MultiPolygon — good enough to navigate to the area. */
export function boundaryCentre(geometry: GeoPointLike | null | undefined): { lat: number; lng: number } | null {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  let latSum = 0; let lngSum = 0; let count = 0;
  const walk = (node: unknown) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && finite(node[0]) && finite(node[1])) { lngSum += node[0]; latSum += node[1]; count += 1; return; }
    node.forEach(walk);
  };
  walk(geometry.coordinates);
  return count ? { lat: latSum / count, lng: lngSum / count } : null;
}

const STREET = '(?:Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Lane|Ln|Place|Pl|Crescent|Cres|Terrace|Tce|Way|Highway|Hwy|Parade|Pde|Grove|Close|Court|Ct|Boulevard|Blvd|Quay|Square|Sq|Esplanade|Rise|Heights|Valley|View)';
const ADDRESS_PATTERN = new RegExp(`\\b\\d+[A-Za-z]?(?:\\/\\d+)?\\s+[A-Za-z][A-Za-z' -]{1,40}?\\s${STREET}\\b(?:,\\s*[A-Za-z][A-Za-z' -]{1,40}){0,2}`, 'i');

/** A street address written into the briefing ("Attend 12 Gibbons Road, Upper Hutt"), if any. */
export function addressFromBriefing(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const match = notes.match(ADDRESS_PATTERN);
  return match ? match[0].trim().replace(/[.,;]+$/, '') : null;
}

export function directionsUrl(target: { lat: number; lng: number } | string): string {
  const destination = typeof target === 'string' ? target : `${target.lat.toFixed(6)},${target.lng.toFixed(6)}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

export function resolveDispatchDestination(job: DispatchLocationInput): DispatchDestination {
  const siteName = job.site?.name ?? null;
  const zoneName = job.zone?.name ?? null;
  const label = siteName ?? zoneName ?? 'Dispatch location';
  const site = job.site;
  if (site && finite(site.gps_lat) && finite(site.gps_lng)) {
    const point = { lat: site.gps_lat, lng: site.gps_lng };
    return { kind: 'coordinates', ...point, label, source: 'site', mapsUrl: directionsUrl(point) };
  }
  const siteCentre = pointFrom(site?.center_point);
  if (siteCentre) return { kind: 'coordinates', ...siteCentre, label, source: 'site', mapsUrl: directionsUrl(siteCentre) };
  const siteAddress = site?.address?.trim();
  if (siteAddress) return { kind: 'address', address: siteAddress, label, source: 'site_address', mapsUrl: directionsUrl(siteAddress) };
  const harmedAddress = job.harmed_party_address?.trim();
  if (harmedAddress) return { kind: 'address', address: harmedAddress, label, source: 'harmed_party_address', mapsUrl: directionsUrl(harmedAddress) };
  const zoneCentre = pointFrom(job.zone?.center_point);
  if (zoneCentre) return { kind: 'coordinates', ...zoneCentre, label, source: 'zone_centre', mapsUrl: directionsUrl(zoneCentre) };
  const zoneBoundary = boundaryCentre(job.zone?.boundary);
  if (zoneBoundary) return { kind: 'coordinates', ...zoneBoundary, label, source: 'zone_boundary', mapsUrl: directionsUrl(zoneBoundary) };
  const briefingAddress = addressFromBriefing(job.briefing_notes);
  if (briefingAddress) return { kind: 'address', address: briefingAddress, label, source: 'briefing', mapsUrl: directionsUrl(briefingAddress) };
  return { kind: 'none', label };
}

export const DESTINATION_SOURCE_TEXT: Record<string, string> = {
  site: 'Site GPS',
  zone_centre: 'Centre of the zone',
  zone_boundary: 'Middle of the zone boundary',
  site_address: 'Site address',
  harmed_party_address: 'Complainant address',
  briefing: 'Address from the briefing — check before you go',
};
