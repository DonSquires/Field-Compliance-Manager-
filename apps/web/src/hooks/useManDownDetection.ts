/**
 * useManDownDetection.ts — GPS-based man-down detection
 *
 * Detects if an officer has been stationary (man-down) and triggers
 * automatic escalation and resolution based on supervisor confirmation.
 *
 * Reference: WELFARE_MODULE_INVESTIGATION.md, #150
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface ManDownState {
  isManDown: boolean;
  stationaryDurationMinutes: number;
  lastKnownLocation: { lat: number; lng: number } | null;
  escalated: boolean;
  escalatedAt: string | null;
  resolvedAt: string | null;
}

interface UseManDownDetectionOptions {
  stationaryThresholdMinutes?: number; // Default 15 min = man-down
  checkIntervalSeconds?: number; // Default 30 sec GPS checks
  autoEscalate?: boolean;
  organizationId: string;
}

export function useManDownDetection(
  userId: string,
  options: UseManDownDetectionOptions
) {
  const {
    stationaryThresholdMinutes = 15,
    checkIntervalSeconds = 30,
    autoEscalate = true,
    organizationId,
  } = options;

  const [state, setState] = useState<ManDownState>({
    isManDown: false,
    stationaryDurationMinutes: 0,
    lastKnownLocation: null,
    escalated: false,
    escalatedAt: null,
    resolvedAt: null,
  });

  const [gpsHistory, setGpsHistory] = useState<Array<{ lat: number; lng: number; timestamp: number }>>([]);

  // Calculate distance in meters between two GPS points
  const calculateDistance = useCallback((lat1: number, lng1: number, lat2: number, lng2: number) => {
    const R = 6371000; // Earth radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in meters
  }, []);

  // Check GPS and detect man-down
  const checkManDown = useCallback(async () => {
    if (!navigator.geolocation) return;

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
      });

      const newLocation = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        timestamp: Date.now(),
      };

      setGpsHistory((prev) => [...prev.slice(-100), newLocation]); // Keep last 100 readings

      // Check if stationary (no movement in last N readings)
      let isStationary = false;
      if (state.lastKnownLocation) {
        const distanceMoved = calculateDistance(
          state.lastKnownLocation.lat,
          state.lastKnownLocation.lng,
          newLocation.lat,
          newLocation.lng
        );
        isStationary = distanceMoved < 10; // Less than 10 meters = stationary
      }

      if (isStationary) {
        const newDuration = state.stationaryDurationMinutes + checkIntervalSeconds / 60;

        setState((prev) => ({
          ...prev,
          stationaryDurationMinutes: newDuration,
          lastKnownLocation: newLocation,
          isManDown: newDuration >= stationaryThresholdMinutes,
        }));

        // Auto-escalate if threshold reached
        if (newDuration >= stationaryThresholdMinutes && autoEscalate && !state.escalated) {
          const { error } = await supabase.from('welfare_alerts').insert([{
            organization_id: organizationId,
            officer_user_id: userId,
            alert_type: 'man_down',
            gps_latitude: newLocation.lat,
            gps_longitude: newLocation.lng,
            created_at: new Date().toISOString(),
          }]);

          if (!error) {
            setState((prev) => ({
              ...prev,
              escalated: true,
              escalatedAt: new Date().toISOString(),
            }));
          }
        }
      } else {
        // Movement detected, reset
        setState((prev) => ({
          ...prev,
          stationaryDurationMinutes: 0,
          lastKnownLocation: newLocation,
          isManDown: false,
        }));
      }
    } catch (err) {
      console.warn('GPS check failed:', err);
    }
  }, [userId, organizationId, calculateDistance, state, stationaryThresholdMinutes, autoEscalate, checkIntervalSeconds]);

  // Resolve man-down when officer moves
  const resolveManDown = useCallback(async () => {
    if (!state.escalated) return;

    setState((prev) => ({
      ...prev,
      escalated: false,
      resolvedAt: new Date().toISOString(),
      stationaryDurationMinutes: 0,
      isManDown: false,
    }));

    // Clear escalation in database
    await supabase
      .from('welfare_alerts')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('officer_user_id', userId)
      .eq('alert_type', 'man_down')
      .eq('status', 'active');
  }, [userId, state.escalated]);

  // Set up periodic GPS checks
  useEffect(() => {
    const interval = setInterval(checkManDown, checkIntervalSeconds * 1000);
    return () => clearInterval(interval);
  }, [checkManDown, checkIntervalSeconds]);

  return {
    ...state,
    gpsHistory,
    checkManDown,
    resolveManDown,
  };
}
