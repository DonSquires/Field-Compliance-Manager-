import { supabase } from './supabase';

type AddressSource = 'linz_address' | 'google_address' | 'google_reverse' | 'google_place' | 'council_registry';

export interface ResolvedAddress {
  label: string;
  source: AddressSource;
}

export interface AddressCandidate extends ResolvedAddress {
  lat: number;
  lng: number;
  address_id?: string | null;
  /** 'address' | 'business' | 'reserve' — a hint for disambiguation, not a hard type. */
  kind?: string;
  /** Present for council_registry hits: the real boundary, ready to accept without a second lookup. */
  boundary?: GeoJSON.Geometry | null;
  agency_id?: string;
}

export async function resolveAddressForCoordinates(lat: number, lng: number): Promise<ResolvedAddress | null> {
  const { data, error } = await supabase.functions.invoke<{ candidates?: ResolvedAddress[] }>('linz-lookup', {
    body: { action: 'reverse_geocode', lat, lng, max: 1 },
  });
  if (error) throw error;
  return data?.candidates?.[0] ?? null;
}

export async function resolveAddressCandidates(query: string, max = 5): Promise<AddressCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  const { data, error } = await supabase.functions.invoke<{ candidates?: AddressCandidate[] }>('linz-lookup', {
    body: { action: 'address_autocomplete', q, max },
  });
  if (error) throw error;
  return (data?.candidates ?? []).filter((candidate) => Number.isFinite(candidate.lat) && Number.isFinite(candidate.lng));
}