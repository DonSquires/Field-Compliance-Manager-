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
  officer_user_id: string;
  status: 'ok' | 'welfare_check_required' | 'escalated';
  gps_latitude: number | null;
  gps_longitude: number | null;
  checked_at: string;
  metadata?: Record<string, any>;
}

interface UseWelfareCheckinOptions {
  intervalMinutes?: number; // Default 30 min
  autoReport?: boolean;
}

export function useWelfareCheckin(userId: string, options: UseWelfareCheckinOptions = {}) {
  const { intervalMinutes = 30, autoReport = true } = options;

  const [checkin, setCheckin] = useState<WelfareCheckin | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastCheckinTime, setLastCheckinTime] = useState<Date | null>(null);

  // Record a welfare check-in
  const recordCheckin = useCallback(async (status: 'ok' | 'welfare_check_required' | 'escalated') => {
    setIsLoading(true);
    try {
      let gps_latitude: number | null = null;
      let gps_longitude: number | null = null;

      // Try to get GPS location if available
      if (navigator.geolocation) {
        try {
          const position = await new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
          });
          gps_latitude = position.coords.latitude;
          gps_longitude = position.coords.longitude;
        } catch (e) {
          console.warn('Could not get GPS position:', e);
        }
      }

      const { data, error } = await supabase
        .from('welfare_checks')
        .insert([{
          officer_user_id: userId,
          status,
          gps_latitude,
          gps_longitude,
          checked_at: new Date().toISOString(),
          metadata: {
            timestamp: Date.now(),
            userAgent: navigator.userAgent,
          },
        }])
        .select()
        .single();

      if (error) throw error;

      setCheckin(data as WelfareCheckin);
      setLastCheckinTime(new Date());
    } catch (err) {
      console.error('Failed to record welfare checkin:', err);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

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
    recordCheckin,
    lastCheckinTime,
    minutesSinceLastCheckin,
    needsCheckin,
  };
}
