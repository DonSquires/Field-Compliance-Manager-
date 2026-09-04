import { supabase } from './supabase';

type Coordinates = { lat: number; lng: number } | null;

export async function recordMobileCheckIn(input: { coordinates: Coordinates; shiftId?: string | null }): Promise<void> {
  if (!supabase) throw new Error('Mobile client configuration is unavailable.');
  const { error } = await supabase.rpc('record_officer_welfare_checkin', {
    p_client_request_id: crypto.randomUUID(),
    p_gps_lat: input.coordinates?.lat ?? null,
    p_gps_lng: input.coordinates?.lng ?? null,
    p_shift_id: input.shiftId ?? null,
    p_notes: 'Officer mobile self check-in',
  });
  if (error) throw error;
}

export async function triggerMobileSos(input: { coordinates: Coordinates; shiftId?: string | null }): Promise<void> {
  if (!supabase) throw new Error('Mobile client configuration is unavailable.');
  const { error } = await supabase.rpc('raise_officer_sos', {
    p_client_request_id: crypto.randomUUID(),
    p_gps_lat: input.coordinates?.lat ?? null,
    p_gps_lng: input.coordinates?.lng ?? null,
    p_shift_id: input.shiftId ?? null,
    p_notes: 'SOS triggered by officer mobile app',
  });
  if (error) throw error;
}