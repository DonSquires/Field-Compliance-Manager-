/**
 * useWelfareCheckin.ts — Officer welfare check-in tracking
 *
 * Tracks officer welfare status with GPS, tracks check-in timing,
 * and records to welfare_checks table.
 *
 * Reference: docs/WELFARE_MODULE_INVESTIGATION.md
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface WelfareCheckin {
  id: string;
  organization_id: string;
  officer_user_id: string;
  shift_id: string | null;
  status: 'ok' | 'overdue' | 'man_down' | 'sos';
  notes: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  checked_in_at: string;
}

interface UseWelfareCheckinOptions {
  organizationId?: string | null;
  intervalMinutes?: number; // Default 30 min
  autoReport?: boolean;
}

export function useWelfareCheckin(userId: string, options: UseWelfareCheckinOptions = {}) {
  const { organizationId = null, intervalMinutes = 30, autoReport = true } = options;

  const [checkin, setCheckin] = useState<WelfareCheckin | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckinTime, setLastCheckinTime] = useState<Date | null>(null);

  // Record a welfare check-in
  const recordCheckin = useCallback(async (status: WelfareCheckin['status']) => {
    if (!userId || !organizationId) {
      setError('Officer and organization are required before recording welfare check-in.');
      return false;
    }
    setIsLoading(true);
    setError(null);
    try {
      let gps_lat: number | null = null;
      let gps_lng: number | null = null;

      // Try to get GPS location if available
      if (typeof navigator !== 'undefined' && navigator.geolocation) {
        try {
          const position = await new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
          });
          gps_lat = position.coords.latitude;
          gps_lng = position.coords.longitude;
        } catch (e) {
          console.warn('Could not get GPS position:', e);
        }
      }

      const { data, error } = await supabase
        .from('welfare_checks')
        .insert({
          organization_id: organizationId,
          officer_user_id: userId,
          status,
          gps_lat,
          gps_lng,
          checked_in_at: new Date().toISOString(),
          notes: 'Officer welfare check-in',
        })
        .select()
        .single();

      if (error) throw error;
      if (!data) throw new Error('Welfare check-in was not confirmed.');

      setCheckin(data as WelfareCheckin);
      setLastCheckinTime(new Date());
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to record welfare check-in.';
      setError(message);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [organizationId, userId]);

  // Auto-report if enabled and interval has passed
  useEffect(() => {
    if (!autoReport) return;

    const interval = setInterval(() => {
      const now = new Date();
      if (!lastCheckinTime || now.getTime() - lastCheckinTime.getTime() > intervalMinutes * 60 * 1000) {
        recordCheckin('ok');
      }
    }, 60 * 1000); // Check every minute

    return () => clearInterval(interval);
  }, [autoReport, intervalMinutes, lastCheckinTime, recordCheckin]);

  const minutesSinceLastCheckin = lastCheckinTime
    ? Math.floor((Date.now() - lastCheckinTime.getTime()) / 60000)
    : null;

  const needsCheckin = minutesSinceLastCheckin !== null && minutesSinceLastCheckin >= intervalMinutes;

  return {
    checkin,
    isLoading,
    error,
    recordCheckin,
    lastCheckinTime,
    minutesSinceLastCheckin,
    needsCheckin,
  };
}
