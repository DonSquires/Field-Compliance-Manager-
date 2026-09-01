/**
 * OfficerStaticGuardPage.tsx (Officer module: 'site_guard')
 *
 * Canonical schema: shift_stops (materialised stop list per shift, filtered
 * to this officer's own active/accepted shift), joined to client_sites /
 * location_zones for a display name. Distinct from OfficerDispatchPage
 * (dispatch_jobs, ad-hoc jobs) -- static guarding posts are scheduled stops
 * generated from client_site_patrol_config, not dispatch jobs. Previously
 * this module fell back to OfficerDispatchPage, which had no way to show a
 * scheduled static post at all.
 *
 * Status transitions (pending -> en_route -> on_scene -> completed, or
 * skipped/cancelled) go through advance_shift_stop_status, which owns
 * authorization, expected-state checking, and SLA computation server-side.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type StopStatus = 'pending' | 'en_route' | 'on_scene' | 'completed' | 'skipped' | 'cancelled';

interface ShiftStop {
  id: string;
  shift_id: string;
  site_id: string | null;
  zone_id: string | null;
  status: StopStatus;
  sla_status: string;
  sla_arrive_by: string;
  required_dwell_minutes: number;
  officer_notes: string | null;
  site_name?: string;
  zone_name?: string;
}

const NEXT_STATUS: Partial<Record<StopStatus, StopStatus>> = {
  pending: 'en_route',
  en_route: 'on_scene',
  on_scene: 'completed',
};

const STATUS_LABEL: Partial<Record<StopStatus, string>> = {
  pending: 'Start En Route',
  en_route: 'Mark On Scene',
  on_scene: 'Mark Completed',
};

interface GpsState {
  status: 'idle' | 'locating' | 'captured' | 'unavailable';
  lat: number | null;
  lng: number | null;
}

const OfficerStaticGuardPage: React.FC = () => {
  const { profile } = useAuth();
  const [stops, setStops] = useState<ShiftStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [gps, setGps] = useState<GpsState>({ status: 'idle', lat: null, lng: null });

  // ATLAS READS: shifts, shift_stops, client_sites, location_zones
  const loadStops = useCallback(async () => {
    if (!profile?.id || !profile.organizationId) return;
    setLoading(true);
    setError(null);

    const { data: shifts, error: shiftErr } = await supabase
      .from('shifts')
      .select('id')
      .eq('officer_user_id', profile.id)
      .in('status', ['accepted', 'in_progress']);

    if (shiftErr) {
      setError(shiftErr.message);
      setLoading(false);
      return;
    }

    const shiftIds = (shifts ?? []).map((s: { id: string }) => s.id);
    if (shiftIds.length === 0) {
      setStops([]);
      setLoading(false);
      return;
    }

    const { data, error: stopErr } = await supabase
      .from('shift_stops')
      .select('id, shift_id, site_id, zone_id, status, sla_status, sla_arrive_by, required_dwell_minutes, officer_notes, client_sites(name), location_zones(name)')
      .in('shift_id', shiftIds)
      .eq('module_key', 'static_guarding')
      .not('status', 'in', '(completed,skipped,cancelled)')
      .order('sla_arrive_by', { ascending: true });

    if (stopErr) {
      setError(stopErr.message);
    } else {
      setStops(
        ((data as unknown as Array<Record<string, unknown>>) ?? []).map((row) => ({
          id: row.id as string,
          shift_id: row.shift_id as string,
          site_id: row.site_id as string | null,
          zone_id: row.zone_id as string | null,
          status: row.status as StopStatus,
          sla_status: row.sla_status as string,
          sla_arrive_by: row.sla_arrive_by as string,
          required_dwell_minutes: row.required_dwell_minutes as number,
          officer_notes: row.officer_notes as string | null,
          site_name: (row.client_sites as { name: string } | null)?.name,
          zone_name: (row.location_zones as { name: string } | null)?.name,
        })),
      );
    }
    setLoading(false);
  }, [profile?.id, profile?.organizationId]);

  useEffect(() => {
    void loadStops();
  }, [loadStops]);

  const acquireGps = () => {
    if (!navigator.geolocation) {
      setGps({ status: 'unavailable', lat: null, lng: null });
      return;
    }
    setGps({ status: 'locating', lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      (position) => setGps({ status: 'captured', lat: position.coords.latitude, lng: position.coords.longitude }),
      () => setGps({ status: 'unavailable', lat: null, lng: null }),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 8_000 },
    );
  };

  const handleAdvance = async (stop: ShiftStop) => {
    const nextStatus = NEXT_STATUS[stop.status];
    if (!nextStatus) return;
    setBusyId(stop.id);
    setError(null);

    // ATLAS WRITES: shift_stops (via advance_shift_stop_status)
    const { data, error: err } = await supabase.rpc('advance_shift_stop_status', {
      p_stop_id: stop.id,
      p_expected_status: stop.status,
      p_next_status: nextStatus,
      p_officer_notes: notes[stop.id]?.trim() || null,
      p_gps_lat: gps.lat,
      p_gps_lng: gps.lng,
    });

    if (err) {
      setError(err.message);
      await loadStops();
    } else {
      const result = (data as Array<{ id: string; status: StopStatus }> | null)?.[0];
      if (nextStatus === 'completed') {
        setStops(stops.filter((s) => s.id !== stop.id));
      } else {
        setStops(stops.map((s) => (s.id === stop.id ? { ...s, status: result?.status ?? nextStatus } : s)));
      }
    }
    setBusyId(null);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading static guard posts...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Site Guard</h1>
        <p className="subtitle">{stops.length} scheduled post(s) on your shift</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className={`officer-report-gps state-${gps.status}`} style={{ marginBottom: '12px' }}>
        <strong>{gps.status === 'captured' ? 'GPS captured' : gps.status === 'locating' ? 'Locating' : gps.status === 'unavailable' ? 'GPS unavailable' : 'Add GPS evidence'}</strong>
        <button type="button" className="btn btn-secondary btn-sm" onClick={acquireGps} disabled={gps.status === 'locating'}>
          {gps.status === 'captured' ? 'Refresh' : 'Capture'}
        </button>
      </div>

      <div className="contacts-list">
        {stops.length === 0 ? (
          <div className="empty-state">
            <p>No scheduled static posts remaining on this shift.</p>
          </div>
        ) : (
          stops.map((stop) => (
            <div key={stop.id} className="contact-card">
              <div className="contact-header">
                <h3>{stop.site_name || stop.zone_name || 'Static post'}</h3>
                <span className={`badge ${stop.sla_status === 'breached' ? 'is-alert' : ''}`}>{stop.sla_status}</span>
              </div>
              <div className="contact-details">
                <p className="contact-meta">
                  Status: {stop.status.replaceAll('_', ' ')} · Arrive by {new Date(stop.sla_arrive_by).toLocaleTimeString()} · Dwell {stop.required_dwell_minutes}m
                </p>
                {NEXT_STATUS[stop.status] && (
                  <>
                    <textarea
                      rows={2}
                      placeholder="Officer notes (optional, required on completion)"
                      value={notes[stop.id] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [stop.id]: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-block"
                      onClick={() => handleAdvance(stop)}
                      disabled={busyId === stop.id}
                    >
                      {busyId === stop.id ? 'Updating…' : STATUS_LABEL[stop.status]}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerStaticGuardPage;
