import React, { useEffect, useRef, useState } from 'react';
import { MapPinOff, ShieldAlert } from 'lucide-react';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import type { ActiveShift } from '../hooks/useActiveShift';
import { supabase } from '../lib/supabase';
import './PlaceContextBanner.css';

interface ShiftPosition { status: 'on_site' | 'near_site' | 'off_site' | 'no_gps' | 'no_place'; place_name?: string | null; distance_m?: number | null; place_count?: number; route_shift?: boolean; }

const movedFar = (a: { lat: number; lng: number } | null, b: { lat: number; lng: number }) => !a || Math.hypot((a.lat - b.lat) * 111_000, (a.lng - b.lng) * 111_000 * Math.cos((b.lat * Math.PI) / 180)) > 30;

/**
 * Officer-side location advisory. Owner ruling (2026-09-19): an officer is told they are outside the
 * geofence only when they try to start a shift outside it (handled on the schedule page) or when they
 * leave the area while on a place-bound shift. Idle officers and patrol runs (whose stops carry their
 * own arrive/depart evidence) are not nagged. Being on site is always a manual action.
 * The judgement is the server's (evaluate_shift_start_position), against the shift's own places, so it
 * holds for shifts rostered by a branch other than the officer's home organisation.
 */
export function OfficerLocationAdvisory({ shift }: { shift: ActiveShift | null }) {
  const { locationStatus, locationError, currentCoordinates } = useServiceRelationships();
  const [position, setPosition] = useState<ShiftPosition | null>(null);
  const lastEvaluated = useRef<{ shiftId: string; coords: { lat: number; lng: number } | null; at: number } | null>(null);

  const active = Boolean(shift && shift.status === 'in_progress');
  const lat = currentCoordinates?.lat ?? null;
  const lng = currentCoordinates?.lng ?? null;
  const shiftId = shift?.id ?? null;

  useEffect(() => {
    if (!shiftId || !active || lat === null || lng === null) { setPosition(null); lastEvaluated.current = null; return; }
    const coords = { lat, lng };
    const previous = lastEvaluated.current;
    const stale = !previous || previous.shiftId !== shiftId || movedFar(previous.coords, coords) || Date.now() - previous.at > 120_000;
    if (!stale) return;
    lastEvaluated.current = { shiftId, coords, at: Date.now() };
    let cancelled = false;
    // ATLAS READS: evaluate_shift_start_position (advisory; the officer is told, never blocked)
    void supabase.rpc('evaluate_shift_start_position', { p_shift_id: shiftId, p_gps_lat: lat, p_gps_lng: lng }).then(({ data }) => {
      if (!cancelled && data) setPosition(data as ShiftPosition);
    });
    return () => { cancelled = true; };
  }, [active, lat, lng, shiftId]);

  if (!shift || !active) return null;

  if (locationStatus === 'unavailable') {
    return <div className="place-context-banner is-unavailable" role="note" aria-label="Location is off" data-place-context-status="unavailable"><MapPinOff size={18} aria-hidden="true" /><div><strong>Location is off</strong><span>{locationError ?? 'Turn location on so your stops and your post can be verified.'}</span></div></div>;
  }

  // Only a place-bound shift (one post, not a patrol run) is judged for leaving the area.
  const placeBound = position && !position.route_shift && (position.place_count ?? 0) === 1;
  if (placeBound && position.status === 'off_site') {
    const place = position.place_name ?? 'your post';
    return <div className="place-context-banner is-outside_geofence" role="alert" aria-label={`Away from ${place}`} data-place-context-status="outside_geofence"><ShieldAlert size={18} aria-hidden="true" /><div><strong>You have left {place}</strong><span>Your shift is at this post. Head back, or tell your supervisor if you were sent elsewhere.</span></div></div>;
  }
  return null;
}
