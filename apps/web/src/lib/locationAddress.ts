import { supabase } from './supabase';

export interface ResolvedAddress {
  label: string;
  source: 'linz_address' | 'google_reverse';
}

export async function resolveAddressForCoordinates(lat: number, lng: number): Promise<ResolvedAddress | null> {
  const { data, error } = await supabase.functions.invoke<{ candidates?: ResolvedAddress[] }>('linz-lookup', {
    body: { action: 'reverse_geocode', lat, lng, max: 1 },
  });
  if (error) throw error;
  return data?.candidates?.[0] ?? null;
}