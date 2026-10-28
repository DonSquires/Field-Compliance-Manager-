import type * as GeoJSON from 'geojson';

export interface FieldPoint {
  lat: number;
  lng: number;
  accuracy: number;
  captured_at: string;
  confirmed_lat: number;
  confirmed_lng: number;
}

export interface PlaceSite {
  id: string;
  name: string;
  active: boolean;
  site_type: string | null;
  lat: number | null;
  lng: number | null;
  gps_lat: number | null;
  gps_lng: number | null;
  boundary_status: string;
  boundary: GeoJSON.Geometry | null;
  boundary_verification: string;
  risk_level: string | null;
  site_brief: string | null;
  access_instructions: string | null;
  hs_notes: string | null;
  configuration_version: number;
}

export interface PlaceZone {
  id: string;
  name: string;
  active: boolean;
  module_key: string;
  lat: number | null;
  lng: number | null;
  boundary: GeoJSON.Geometry | null;
  boundary_verification: string;
  boundary_status: string;
  is_verification_point: boolean;
  radius_meters: number | null;
  verified_at: string | null;
  verified_by: string | null;
  capture: FieldPoint | null;
  configuration_version: number;
}

export interface FieldPlace {
  id: string;
  name: string;
  address: string | null;
  notes: string | null;
  updated_at: string;
  organization_id: string;
  canonical_place_id: string;
  sites: PlaceSite[];
  zones: PlaceZone[];
}

export interface FieldPlaceWorkspace {
  clients: Array<{ id: string; name: string }>;
  places: FieldPlace[];
  total: number;
}

export function placeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
  return 'The request failed. Check your connection and permissions, then retry.';
}

export function latestFieldVerification(place: FieldPlace): PlaceZone | undefined {
  return place.zones.filter(zone => zone.is_verification_point && zone.active && zone.boundary_verification === 'verified' && zone.verified_at)
    .sort((a, b) => (b.verified_at ?? '').localeCompare(a.verified_at ?? ''))[0];
}
