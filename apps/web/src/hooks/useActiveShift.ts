/**
 * useActiveShift.ts — Get officer's current active shift
 *
 * Returns the current shift record for an officer, including:
 * - Shift timing and type
 * - Assigned stops (zones/sites)
 * - Vehicle allocation
 * - Patrol route
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
  shift_type: 'patrol' | 'static' | 'mobile' | 'rostered';
  vehicle_id?: string;
  route_id?: string;
  stops: ShiftStop[];
  status: 'scheduled' | 'started' | 'paused' | 'completed';
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
      // Get today's shift
      const today = new Date().toISOString().split('T')[0];
      const now = new Date();

      const { data, error: err } = await supabase
        .from('dispatch_jobs')
        .select(`
          id,
          organization_id,
          officer_user_id,
          job_date,
          job_start_time,
          job_end_time,
          job_type,
          vehicle_id,
          route_id,
          status,
          created_at,
          updated_at,
          dispatch_stops (
            id,
            job_id,
            zone_id,
            client_site_id,
            sequence,
            scheduled_arrival,
            scheduled_departure
          )
        `)
        .eq('officer_user_id', userId)
        .eq('organization_id', organizationId)
        .eq('job_date', today)
        .eq('status', 'started')
        .single();

      if (err && err.code !== 'PGRST116') {
        throw err;
      }

      if (data) {
        const shift: ActiveShift = {
          id: data.id,
          organization_id: data.organization_id,
          officer_user_id: data.officer_user_id,
          shift_date: data.job_date,
          start_time: data.job_start_time,
          end_time: data.job_end_time,
          shift_type: data.job_type,
          vehicle_id: data.vehicle_id,
          route_id: data.route_id,
          status: data.status,
          created_at: data.created_at,
          updated_at: data.updated_at,
          stops: (data.dispatch_stops || []).map((stop: any) => ({
            id: stop.id,
            shift_id: stop.job_id,
            zone_id: stop.zone_id,
            client_site_id: stop.client_site_id,
            seq: stop.sequence,
            arrival_time: stop.scheduled_arrival,
            departure_time: stop.scheduled_departure,
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

  // Fetch on mount and set up polling
  useEffect(() => {
    fetchActiveShift();
    const interval = setInterval(fetchActiveShift, 30000); // Poll every 30 seconds
    return () => clearInterval(interval);
  }, [fetchActiveShift]);

  const getCurrentZone = useCallback(() => {
    if (!shift || !shift.stops.length) return null;
    // Return the first stop's zone (simplified - could check GPS to find actual current stop)
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
