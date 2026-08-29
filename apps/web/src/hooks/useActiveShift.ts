/**
 * useActiveShift.ts — Get officer's current live shift from the schema
 *
 * Canonical source is the shifts table, not the dispatch_jobs table.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface ShiftStop {
  id: string;
  shift_id: string;
  zone_id?: string;
  client_site_id?: string;
  seq: number;
  arrival_time?: string;
  departure_time?: string;
}

export interface ActiveShift {
  id: string;
  organization_id: string;
  officer_user_id: string;
  shift_date: string;
  start_time: string;
  end_time: string;
  shift_type: 'patrol' | 'static' | 'mobile' | 'rostered' | string;
  vehicle_id?: string;
  route_id?: string;
  stops: ShiftStop[];
  status: 'scheduled' | 'published' | 'accepted' | 'declined' | 'in_progress' | 'completed' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export function useActiveShift(userId: string, organizationId: string) {
  const [shift, setShift] = useState<ActiveShift | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchActiveShift = useCallback(async () => {
    if (!userId || !organizationId) return;

    setIsLoading(true);
    setError(null);

    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const { data, error: err } = await supabase
        .from('shifts')
        .select(`
          id,
          organization_id,
          officer_user_id,
          service_type,
          scheduled_start,
          scheduled_end,
          status,
          patrol_route_id,
          zone_id,
          created_at,
          updated_at,
          shift_stops (
            id,
            shift_id,
            zone_id,
            site_id,
            stop_order,
            actual_arrived_at,
            actual_departed_at
          )
        `)
        .eq('officer_user_id', userId)
        .eq('organization_id', organizationId)
        .gte('scheduled_start', todayStart.toISOString())
        .lte('scheduled_start', todayEnd.toISOString())
        .in('status', ['accepted', 'in_progress'])
        .order('scheduled_start', { ascending: false })
        .maybeSingle();

      if (err && err.code !== 'PGRST116') {
        throw err;
      }

      if (data) {
        const shift: ActiveShift = {
          id: data.id,
          organization_id: data.organization_id,
          officer_user_id: data.officer_user_id,
          shift_date: data.scheduled_start,
          start_time: data.scheduled_start,
          end_time: data.scheduled_end,
          shift_type: data.service_type ?? 'patrol',
          vehicle_id: undefined,
          route_id: data.patrol_route_id,
          status: data.status,
          created_at: data.created_at,
          updated_at: data.updated_at,
          stops: (data.shift_stops || []).map((stop: any) => ({
            id: stop.id,
            shift_id: stop.shift_id,
            zone_id: stop.zone_id,
            client_site_id: stop.site_id,
            seq: stop.stop_order,
            arrival_time: stop.actual_arrived_at,
            departure_time: stop.actual_departed_at,
          })),
        };
        setShift(shift);
      } else {
        setShift(null);
      }
    } catch (err) {
      console.error('Error fetching active shift:', err);
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, [userId, organizationId]);

  useEffect(() => {
    fetchActiveShift();
    const interval = setInterval(fetchActiveShift, 30000);
    return () => clearInterval(interval);
  }, [fetchActiveShift]);

  const getCurrentZone = useCallback(() => {
    if (!shift || !shift.stops.length) return null;
    return shift.stops[0].zone_id || shift.stops[0].client_site_id;
  }, [shift]);

  return {
    shift,
    isLoading,
    error,
    refetch: fetchActiveShift,
    getCurrentZone,
  };
}
