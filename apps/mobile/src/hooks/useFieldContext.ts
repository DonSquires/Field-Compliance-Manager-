import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface MobileProfile {
  organizationId: string;
  displayName: string;
  role: string;
}

interface ActiveAssignment {
  serviceType: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  totalStops: number;
  completedStops: number;
}

export function useFieldContext(userId: string | null) {
  const [profile, setProfile] = useState<MobileProfile | null>(null);
  const [assignment, setAssignment] = useState<ActiveAssignment | null>(null);
  const [loading, setLoading] = useState(Boolean(userId));
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase || !userId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const { data: profileRow, error: profileError } = await supabase
        .from('user_profiles')
        .select('organization_id, display_name, role')
        .eq('id', userId)
        .maybeSingle();
      if (profileError || !profileRow) throw profileError ?? new Error('Your field profile is unavailable.');
      setProfile({ organizationId: profileRow.organization_id, displayName: profileRow.display_name || 'Field officer', role: profileRow.role });

      const now = new Date().toISOString();
      const { data: shiftRow, error: shiftError } = await supabase
        .from('shifts')
        .select('service_type, scheduled_start, scheduled_end, status, total_stops, completed_stops')
        .eq('organization_id', profileRow.organization_id)
        .eq('officer_user_id', userId)
        .in('status', ['accepted', 'in_progress'])
        .lte('scheduled_start', now)
        .gte('scheduled_end', now)
        .order('scheduled_start', { ascending: false })
        .maybeSingle();
      if (shiftError && shiftError.code !== 'PGRST116') throw shiftError;
      setAssignment(shiftRow ? { serviceType: shiftRow.service_type, scheduledStart: shiftRow.scheduled_start, scheduledEnd: shiftRow.scheduled_end, status: shiftRow.status, totalStops: shiftRow.total_stops, completedStops: shiftRow.completed_stops } : null);
    } catch (loadError) {
      setProfile(null);
      setAssignment(null);
      setError(loadError instanceof Error ? loadError.message : 'Field operations could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void refresh(); }, [refresh]);
  return { profile, assignment, loading, error, refresh };
}