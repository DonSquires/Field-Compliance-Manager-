/**
 * PatrolPage.tsx (Officer field module: 'patrol')
 *
 * Canonical schema:
 * - shifts (officer_user_id, scheduled_start/end, zone_id, patrol_route_id)
 * - patrols (session: shift_id, zone_id, status in_progress/completed, started_at, ended_at)
 * - patrol_checkpoints & patrol_route_checkpoints (checkpoint definitions)
 * - patrol_checkpoint_visits (proof of attendance, GPS coordinates, scan method, notes)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { countCompletedCheckpoints, evaluateCheckpointVisit, mapCheckpointVisitScanMethod } from '../lib/checkpointVisit';
import './PageStyles.css';

interface Shift {
  id: string;
  service_type: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  zone_id: string | null;
  patrol_route_id: string | null;
  zone_name: string | null;
  route_name: string | null;
  route_code: string | null;
}

interface Checkpoint {
  id: string;
  name: string;
  description: string | null;
  qr_code?: string | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  radius_meters?: number | null;
  sequence?: number;
}

interface CheckpointVisit {
  id?: string;
  checkpoint_id: string;
  visited_at: string;
  scan_method?: string;
  notes?: string | null;
  gps_distance_from_checkpoint?: number | null;
  within_radius?: boolean | null;
}

interface PatrolSession {
  id: string;
  shift: Shift;
  status: 'in_progress' | 'completed' | 'cancelled';
  started_at: string;
  ended_at?: string | null;
  checkpoints: Checkpoint[];
  visits: CheckpointVisit[];
}

const PatrolPage: React.FC = () => {
  const { profile } = useAuth();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [session, setSession] = useState<PatrolSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCheckpointId, setActiveCheckpointId] = useState<string | null>(null);
  const [visitNotes, setVisitNotes] = useState('');
  const [recordingVisit, setRecordingVisit] = useState(false);
  const [elapsedMinutes, setElapsedMinutes] = useState(0);

  // ATLAS READS: patrol_checkpoints, patrol_route_checkpoints
  const loadCheckpointsForShift = useCallback(
    async (shift: Shift): Promise<Checkpoint[]> => {
      if (!profile?.organizationId) return [];

      try {
        // Priority 1: Route checkpoints if shift has patrol_route_id
        if (shift.patrol_route_id) {
          const { data: routeCheckpoints } = await supabase
            .from('patrol_route_checkpoints')
            .select('id, name, description, gps_lat, gps_lng, qr_code_data, geofence_radius_meters, sequence_order')
            .eq('patrol_route_id', shift.patrol_route_id)
            .order('sequence_order', { ascending: true });

          if (routeCheckpoints && routeCheckpoints.length > 0) {
            return routeCheckpoints.map((c) => ({
              id: c.id,
              name: c.name,
              description: c.description,
              qr_code: c.qr_code_data,
              gps_lat: c.gps_lat,
              gps_lng: c.gps_lng,
              radius_meters: c.geofence_radius_meters,
              sequence: c.sequence_order,
            }));
          }
        }

        // Priority 2: Zone checkpoints if shift has zone_id
        if (shift.zone_id) {
          const { data: zoneCheckpoints } = await supabase
            .from('patrol_checkpoints')
            .select('id, name, description, qr_code, gps_lat, gps_lng, radius_meters')
            .eq('organization_id', profile.organizationId)
            .eq('zone_id', shift.zone_id)
            .eq('active', true)
            .order('name', { ascending: true });

          if (zoneCheckpoints && zoneCheckpoints.length > 0) {
            return zoneCheckpoints;
          }
        }

        // Priority 3: Organization-wide active checkpoints
        const { data: orgCheckpoints } = await supabase
          .from('patrol_checkpoints')
          .select('id, name, description, qr_code, gps_lat, gps_lng, radius_meters')
          .eq('organization_id', profile.organizationId)
          .eq('active', true)
          .order('name', { ascending: true })
          .limit(20);

        return orgCheckpoints || [];
      } catch (err) {
        console.error('Failed to load checkpoints:', err);
        return [];
      }
    },
    [profile?.organizationId]
  );

  const loadVisits = useCallback(async (patrolId: string): Promise<CheckpointVisit[]> => {
    // ATLAS READS: patrol_checkpoint_visits
    const { data, error: err } = await supabase
      .from('patrol_checkpoint_visits')
      .select('id, checkpoint_id, visited_at, scan_method, notes')
      .eq('patrol_id', patrolId)
      .order('visited_at', { ascending: true });

    if (err) throw err;
    return (data as CheckpointVisit[]) || [];
  }, []);

  const loadOrCreateSession = useCallback(
    async (shift: Shift) => {
      if (!profile?.organizationId || !profile?.id) return;

      try {
        // ATLAS READS: patrols (existing session for this shift)
        const { data: existing, error: existingErr } = await supabase
          .from('patrols')
          .select('id, status, started_at, ended_at')
          .eq('shift_id', shift.id)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existingErr) throw existingErr;

        const checkpoints = await loadCheckpointsForShift(shift);

        if (!existing) {
          // Not started yet
          setSession({
            id: '',
            shift,
            status: 'in_progress',
            started_at: '',
            checkpoints,
            visits: [],
          });
          return;
        }

        const visits = await loadVisits(existing.id);
        setSession({
          id: existing.id,
          shift,
          status: existing.status as PatrolSession['status'],
          started_at: existing.started_at,
          ended_at: existing.ended_at,
          checkpoints,
          visits,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load patrol session');
      }
    },
    [profile?.organizationId, profile?.id, loadCheckpointsForShift, loadVisits]
  );

  // ATLAS READS: shifts (today's shifts for this officer)
  useEffect(() => {
    const loadShifts = async () => {
      if (!profile?.id) return;

      try {
        setLoading(true);
        setError(null);

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        const { data, error: err } = await supabase
          .from('shifts')
          .select(
            'id, service_type, scheduled_start, scheduled_end, status, zone_id, patrol_route_id, zone:zone_id(name), route:patrol_route_id(name, route_code)'
          )
          .eq('officer_user_id', profile.id)
          .gte('scheduled_start', todayStart.toISOString())
          .lte('scheduled_start', todayEnd.toISOString())
          .in('status', ['published', 'accepted', 'in_progress'])
          .order('scheduled_start', { ascending: true });

        if (err) throw err;

        const formattedShifts: Shift[] = ((data as any[]) || []).map((s) => ({
          id: s.id,
          service_type: s.service_type,
          scheduled_start: s.scheduled_start,
          scheduled_end: s.scheduled_end,
          status: s.status,
          zone_id: s.zone_id,
          patrol_route_id: s.patrol_route_id,
          zone_name: s.zone?.name ?? null,
          route_name: s.route?.name ?? null,
          route_code: s.route?.route_code ?? null,
        }));

        setShifts(formattedShifts);

        if (formattedShifts.length > 0) {
          setSelectedShiftId(formattedShifts[0].id);
          await loadOrCreateSession(formattedShifts[0]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load shifts');
      } finally {
        setLoading(false);
      }
    };

    loadShifts();
  }, [profile?.id, loadOrCreateSession]);

  // Patrol duration timer
  useEffect(() => {
    if (!session?.started_at || session.status !== 'in_progress') return;

    const updateTimer = () => {
      const diffMs = Date.now() - new Date(session.started_at).getTime();
      setElapsedMinutes(Math.max(0, Math.floor(diffMs / 60000)));
    };

    updateTimer();
    const interval = setInterval(updateTimer, 30000);
    return () => clearInterval(interval);
  }, [session?.started_at, session?.status]);

  const startPatrol = async () => {
    if (!session || !profile?.organizationId || !profile?.id) return;

    try {
      const now = new Date().toISOString();
      // ATLAS WRITES: patrols
      const { data, error: insertErr } = await supabase
        .from('patrols')
        .insert([
          {
            organization_id: profile.organizationId,
            shift_id: session.shift.id,
            officer_user_id: profile.id,
            zone_id: session.shift.zone_id,
            status: 'in_progress',
            started_at: now,
          },
        ])
        .select('id, status, started_at')
        .single();

      if (insertErr) throw insertErr;

      setSession({
        ...session,
        id: data.id,
        status: 'in_progress',
        started_at: data.started_at,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start patrol');
    }
  };

  const visitCheckpoint = async (checkpointId: string) => {
    if (!session || !session.id || !profile?.organizationId || !profile?.id) return;

    try {
      setRecordingVisit(true);
      setError(null);

      let lat: number | null = null;
      let lng: number | null = null;
      let gpsPrecisionMetres: number | null = null;

      // Attempt GPS capture if browser geolocation available
      if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
        try {
          const pos = await new Promise<GeolocationPosition>((res, rej) => {
            navigator.geolocation.getCurrentPosition(res, rej, { timeout: 4000, enableHighAccuracy: true });
          });
          lat = pos.coords.latitude;
          lng = pos.coords.longitude;
          gpsPrecisionMetres = pos.coords.accuracy ?? null;
        } catch {
          // GPS optional for manual visit confirmation
        }
      }

      const checkpoint = session.checkpoints.find((item) => item.id === checkpointId);
      const evaluation = evaluateCheckpointVisit({
        checkpointLat: checkpoint?.gps_lat ?? null,
        checkpointLng: checkpoint?.gps_lng ?? null,
        officerLat: lat,
        officerLng: lng,
        checkpointRadiusMetres: checkpoint?.radius_meters ?? 0,
        gpsPrecisionMetres,
        allowManualFallback: true,
      });

      const recordedNotes = [
        visitNotes.trim(),
        evaluation.reason === 'gps_missing_manual_allowed'
          ? 'Manual visit approved: GPS unavailable and manual fallback was allowed.'
          : evaluation.reason === 'gps_inaccurate'
            ? 'GPS not accepted: position accuracy was worse than the checkpoint radius.'
            : evaluation.reason === 'gps_outside_radius'
              ? `GPS outside checkpoint radius (${evaluation.distanceMetres?.toFixed(1) ?? 'n/a'} m).`
              : undefined,
      ].filter(Boolean).join(' ') || null;

      const scanMethod = mapCheckpointVisitScanMethod({
        mode: evaluation.mode,
        accepted: evaluation.accepted,
      });

      if (!evaluation.accepted) {
        throw new Error(
          evaluation.reason === 'gps_inaccurate'
            ? 'GPS accuracy is too poor for this checkpoint.'
            : 'GPS position is outside the checkpoint radius.'
        );
      }

      // ATLAS WRITES: patrol_checkpoint_visits
      const { data, error: visitErr } = await supabase
        .from('patrol_checkpoint_visits')
        .insert([
          {
            organization_id: profile.organizationId,
            patrol_id: session.id,
            checkpoint_id: checkpointId,
            officer_user_id: profile.id,
            scan_method: scanMethod,
            gps_lat: lat,
            gps_lng: lng,
            gps_accuracy: gpsPrecisionMetres,
            gps_distance_from_checkpoint: evaluation.distanceMetres,
            within_radius: evaluation.withinRadius,
            notes: recordedNotes,
          },
        ])
        .select('id, checkpoint_id, visited_at, scan_method, notes')
        .single();

      if (visitErr) throw visitErr;

      setSession({
        ...session,
        visits: [...session.visits, data as CheckpointVisit],
      });
      setActiveCheckpointId(null);
      setVisitNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record checkpoint visit');
    } finally {
      setRecordingVisit(false);
    }
  };

  const completePatrol = async () => {
    if (!session || !session.id) return;

    try {
      const now = new Date().toISOString();
      // ATLAS WRITES: patrols
      const { error: updateErr } = await supabase
        .from('patrols')
        .update({ status: 'completed', ended_at: now })
        .eq('id', session.id);

      if (updateErr) throw updateErr;

      setSession({ ...session, status: 'completed', ended_at: now });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete patrol');
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading patrol schedules and checkpoints...</p>
        </div>
      </div>
    );
  }

  const completedCount = session ? countCompletedCheckpoints(session.visits) : 0;
  const totalCount = session?.checkpoints.length ?? 0;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div className="page-container patrol-page">
      <header className="page-header">
        <h1>Field Patrol & Checkpoints</h1>
        <p className="subtitle">Execute assigned route patrols, verify attendance, record checkpoints</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      {shifts.length === 0 ? (
        <div className="empty-state" style={{ marginTop: '24px' }}>
          <div style={{ fontSize: '32px', marginBottom: '8px' }}>📋</div>
          <h2>No Patrol Shifts Scheduled Today</h2>
          <p>You don't have any active patrol shifts assigned for today.</p>
        </div>
      ) : (
        <div className="patrol-layout" style={{ marginTop: '20px' }}>
          {/* Shift selector list */}
          <div className="shift-selector">
            <h2 style={{ fontSize: '15px', marginBottom: '12px' }}>Today's Shifts ({shifts.length})</h2>
            <div className="shift-list">
              {shifts.map((shift) => (
                <button
                  key={shift.id}
                  className={`shift-card ${selectedShiftId === shift.id ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedShiftId(shift.id);
                    loadOrCreateSession(shift);
                  }}
                >
                  <div className="shift-time">
                    {new Date(shift.scheduled_start).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    –{' '}
                    {new Date(shift.scheduled_end).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                  <div className="shift-name" style={{ fontWeight: 600, marginTop: '2px' }}>
                    {shift.route_name || shift.zone_name || shift.service_type.toUpperCase()}
                  </div>
                  {shift.route_code && (
                    <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                      Route: {shift.route_code}
                    </div>
                  )}
                  <span className="badge badge-info" style={{ marginTop: '6px' }}>
                    {shift.status.toUpperCase()}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Active Patrol Content */}
          {session && (
            <div className="patrol-session">
              <div className="patrol-header-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: '18px' }}>
                      {session.shift.route_name || session.shift.zone_name || session.shift.service_type}
                    </h2>
                    <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
                      {new Date(session.shift.scheduled_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{' '}
                      – {new Date(session.shift.scheduled_end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      {session.shift.route_code ? ` · Code ${session.shift.route_code}` : ''}
                    </div>
                  </div>

                  <span className={`badge ${session.status === 'completed' ? 'badge-success' : session.id ? 'badge-warning' : 'badge-info'}`}>
                    {session.id ? session.status.replace(/_/g, ' ').toUpperCase() : 'NOT STARTED'}
                  </span>
                </div>

                {/* Progress bar and timer if started */}
                {session.id && (
                  <div style={{ marginTop: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                      <span>Checkpoints: {completedCount} / {totalCount} completed ({progressPercent}%)</span>
                      {session.status === 'in_progress' && (
                        <span>⏱️ Elapsed: {elapsedMinutes}m</span>
                      )}
                    </div>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
                    </div>
                  </div>
                )}
              </div>

              {!session.id && (
                <div style={{ marginTop: '16px' }}>
                  <button className="btn btn-primary" style={{ padding: '12px 24px', fontSize: '15px' }} onClick={startPatrol}>
                    ▶️ Start Patrol Session
                  </button>
                </div>
              )}

              {session.id && session.status === 'in_progress' && (
                <div className="checkpoints-container" style={{ marginTop: '16px' }}>
                  <h3 style={{ fontSize: '15px', marginBottom: '8px' }}>Route Checkpoints ({session.checkpoints.length})</h3>

                  {session.checkpoints.length === 0 ? (
                    <div className="empty-state" style={{ padding: '24px' }}>
                      <p>No designated checkpoints configured for this route or zone.</p>
                    </div>
                  ) : (
                    <div className="checkpoints-list">
                      {session.checkpoints.map((checkpoint, idx) => {
                        const visit = session.visits.find((v) => v.checkpoint_id === checkpoint.id);
                        const isSelected = activeCheckpointId === checkpoint.id;

                        return (
                          <div
                            key={checkpoint.id}
                            className={`checkpoint-item ${visit ? 'completed' : ''}`}
                            style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                                <div className="checkpoint-number">{checkpoint.sequence ?? idx + 1}</div>
                                <div>
                                  <h4 style={{ margin: 0, fontSize: '14px' }}>{checkpoint.name}</h4>
                                  {checkpoint.description && (
                                    <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                                      {checkpoint.description}
                                    </p>
                                  )}
                                </div>
                              </div>

                              <div>
                                {visit ? (
                                  <span className="badge badge-success">
                                    ✓ Visited {new Date(visit.visited_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                ) : (
                                  <button
                                    className="btn btn-sm btn-secondary"
                                    onClick={() => setActiveCheckpointId(isSelected ? null : checkpoint.id)}
                                  >
                                    {isSelected ? 'Cancel' : 'Record Visit'}
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Visit notes & confirmation form */}
                            {!visit && isSelected && (
                              <div style={{ marginTop: '8px', padding: '10px', background: 'var(--color-bg-primary)', borderRadius: '6px', border: '1px solid var(--color-border)' }}>
                                <div className="form-group">
                                  <label style={{ fontSize: '11px' }}>Officer Observations / Notes (Optional)</label>
                                  <input
                                    type="text"
                                    placeholder="e.g. Site secure, gates locked, no unauthorized vehicles"
                                    value={visitNotes}
                                    onChange={(e) => setVisitNotes(e.target.value)}
                                  />
                                </div>
                                <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                                  <button
                                    className="btn btn-primary btn-sm"
                                    disabled={recordingVisit}
                                    onClick={() => visitCheckpoint(checkpoint.id)}
                                  >
                                    {recordingVisit ? 'Recording…' : '✓ Confirm & Record Visit'}
                                  </button>
                                  <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => {
                                      setActiveCheckpointId(null);
                                      setVisitNotes('');
                                    }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}

                            {visit?.notes && (
                              <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', paddingLeft: '32px' }}>
                                Note: {visit.notes}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div style={{ marginTop: '24px' }}>
                    <button className="btn btn-primary btn-block" onClick={completePatrol}>
                      Complete Patrol Session
                    </button>
                  </div>
                </div>
              )}

              {session.status === 'completed' && (
                <div className="completion-summary" style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: '10px', marginTop: '16px' }}>
                  <div className="success-icon" style={{ color: 'var(--color-success)' }}>✓</div>
                  <h3 style={{ margin: '8px 0' }}>Patrol Completed</h3>
                  <p style={{ margin: '0 0 8px 0', color: 'var(--color-text-secondary)', fontSize: '14px' }}>
                    {session.visits.length} of {session.checkpoints.length} checkpoints visited.
                  </p>
                  {session.ended_at && (
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                      Ended at {new Date(session.ended_at).toLocaleTimeString()}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default PatrolPage;
