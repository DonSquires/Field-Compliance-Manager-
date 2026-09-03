import { supabase } from './supabase';

type Coordinates = { lat: number; lng: number } | null;

export async function recordMobileCheckIn(input: { organizationId: string; officerId: string; coordinates: Coordinates }): Promise<void> {
  if (!supabase) throw new Error('Mobile client configuration is unavailable.');
  const checkedInAt = new Date().toISOString();
  const { error: checkInError } = await supabase.from('welfare_checks').insert({
    organization_id: input.organizationId,
    officer_user_id: input.officerId,
    status: 'ok',
    gps_lat: input.coordinates?.lat ?? null,
    gps_lng: input.coordinates?.lng ?? null,
    checked_in_at: checkedInAt,
    notes: 'Officer mobile self check-in',
  });
  if (checkInError) throw checkInError;

  const { error: settingsError } = await supabase.from('officer_welfare_settings').upsert({
    organization_id: input.organizationId,
    officer_user_id: input.officerId,
    last_checkin_at: checkedInAt,
  }, { onConflict: 'officer_user_id,organization_id' });
  if (settingsError) throw settingsError;
}

export async function triggerMobileSos(input: { organizationId: string; officerId: string; coordinates: Coordinates }): Promise<void> {
  if (!supabase) throw new Error('Mobile client configuration is unavailable.');
  const triggeredAt = new Date().toISOString();
  const { error } = await supabase.from('welfare_alerts').insert({
    organization_id: input.organizationId,
    officer_user_id: input.officerId,
    alert_type: 'sos',
    status: 'pending',
    triggered_at: triggeredAt,
    last_activity_at: triggeredAt,
    gps_lat: input.coordinates?.lat ?? null,
    gps_lng: input.coordinates?.lng ?? null,
    escalation_level: 1,
    notes: 'SOS triggered by officer mobile app',
  });
  if (error) throw error;
}