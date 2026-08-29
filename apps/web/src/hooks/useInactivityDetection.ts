/**
 * useInactivityDetection.ts — Detect user inactivity and trigger logout
 *
 * Monitors user interaction (mouse, keyboard, touch) and logs out
 * after a configurable period of inactivity for security.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';

interface UseInactivityDetectionOptions {
  timeoutMinutes?: number; // Default 30 min
  onWarning?: (minutesRemaining: number) => void;
  onLogout?: () => void;
}

export function useInactivityDetection(options: UseInactivityDetectionOptions = {}) {
  const { timeoutMinutes = 30, onWarning, onLogout } = options;
  const { signOut } = useAuth();

  const [isInactive, setIsInactive] = useState(false);
  const [minutesRemaining, setMinutesRemaining] = useState(timeoutMinutes);
  const [lastActivityTime, setLastActivityTime] = useState(Date.now());

  // Reset inactivity timer
  const recordActivity = useCallback(() => {
    setLastActivityTime(Date.now());
    setIsInactive(false);
    setMinutesRemaining(timeoutMinutes);
  }, [timeoutMinutes]);

  // Set up activity listeners
  useEffect(() => {
    const events = ['mousedown', 'keydown', 'touchstart', 'click', 'scroll'];
    events.forEach((event) => {
      document.addEventListener(event, recordActivity);
    });

    return () => {
      events.forEach((event) => {
        document.removeEventListener(event, recordActivity);
      });
    };
  }, [recordActivity]);

  // Check inactivity periodically
  useEffect(() => {
    const checkInterval = setInterval(() => {
      const elapsed = (Date.now() - lastActivityTime) / 1000 / 60; // Minutes
      const remaining = timeoutMinutes - elapsed;

      if (remaining <= 0) {
        // Logout
        setIsInactive(true);
        signOut();
        if (onLogout) onLogout();
      } else if (remaining <= 5 && onWarning) {
        // Warn if less than 5 minutes remaining
        setMinutesRemaining(Math.ceil(remaining));
        onWarning(Math.ceil(remaining));
      }
    }, 60000); // Check every minute

    return () => clearInterval(checkInterval);
  }, [lastActivityTime, timeoutMinutes, signOut, onWarning, onLogout]);

  return {
    isInactive,
    minutesRemaining,
    recordActivity,
  };
}
