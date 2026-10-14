/**
 * PatrolPage.tsx (Officer field module: 'patrol')
 *
 * Canonical schema:
 * - shifts (officer_user_id, scheduled_start/end, zone_id, patrol_route_id)
 * - patrols (session: shift_id, zone_id, status in_progress/completed, started_at, ended_at)
 * - patrol_checkpoints & patrol_route_checkpoints (checkpoint definitions)
 * - patrol_checkpoint_visits (proof of attendance, GPS coordinates, scan method, notes)
 *
 * The patrol lifecycle is governed server-side. This page never writes those
 * tables directly; it calls start_patrol_session, record_patrol_checkpoint_visit
 * and complete_patrol_session, which enforce assignment, GPS proximity and
 * accuracy, mandatory-checkpoint completion, idempotency and audit logging.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { countCompletedCheckpoints } from '../lib/checkpointVisit';
import { OfficerPatrolStops } from '../components/OfficerPatrolStops';
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
  kind: 'route' | 'site';
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
  checkpoint_id?: string | null;
  route_checkpoint_id?: string | null;
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
  const [startingPatrol, setStartingPatrol] = useState(false);
  const [completingPatrol, setCompletingPatrol] = useState(false);
  const [confirmingCompletion, setConfirmingCompletion] = useState(false);
  const [completionNotes, setCompletionNotes] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
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
              kind: 'route' as const,
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
            return zoneCheckpoints.map((c) => ({ ...c, kind: 'site' as const }));
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

        return (orgCheckpoints || []).map((c) => ({ ...c, kind: 'site' as const }));
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
      .select('id, checkpoint_id, route_checkpoint_id, visited_at, scan_method, notes')
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
      if (!profile?.id || !profile.organizationId) {
        setShifts([]);
        setSession(null);
        setError('Organisation access could not be confirmed. Patrol data is unavailable.');
        setLoading(false);
        return;
      }

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
    if (!session || startingPatrol) return;

    try {
      setStartingPatrol(true);
      setError(null);
      setNotice(null);

      // ATLAS CALLS: start_patrol_session (validates assignment, idempotent, audited)
      const { data, error: startErr } = await supabase.rpc('start_patrol_session', {
        p_shift_id: session.shift.id,
      });

      if (startErr) throw startErr;

      const patrol = (Array.isArray(data) ? data[0] : data) as
        | { id: string; status: string; started_at: string }
        | null;
      if (!patrol?.id) throw new Error('Patrol session could not be opened. Please try again.');

      const visits = await loadVisits(patrol.id);
      setSession({
        ...session,
        id: patrol.id,
        status: patrol.status as PatrolSession['status'],
        started_at: patrol.started_at,
        visits,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start patrol');
    } finally {
      setStartingPatrol(false);
    }
  };

  const requestPosition = () =>
    new Promise<GeolocationPosition>((resolve, reject) => {
      if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
        reject(new Error('This device cannot provide GPS, which is required to prove attendance at a checkpoint.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, (positionError) => {
        reject(
          new Error(
            positionError.code === positionError.PERMISSION_DENIED
              ? 'Location permission is blocked. Allow location access to record a checkpoint visit.'
              : 'A GPS fix could not be obtained. Move to open sky and try again.'
          )
        );
      }, { timeout: 10000, enableHighAccuracy: true });
    });

  const visitCheckpoint = async (checkpoint: Checkpoint) => {
    if (!session?.id || recordingVisit) return;

    try {
      setRecordingVisit(true);
      setError(null);
      setNotice(null);

      const position = await requestPosition();

      // ATLAS CALLS: record_patrol_checkpoint_visit
      // Proximity, accuracy and duplicate suppression are enforced server-side.
      const { data, error: visitErr } = await supabase.rpc('record_patrol_checkpoint_visit', {
        p_patrol_id: session.id,
        p_checkpoint_kind: checkpoint.kind,
        p_checkpoint_id: checkpoint.id,
        p_gps_lat: position.coords.latitude,
        p_gps_lng: position.coords.longitude,
        p_gps_accuracy: position.coords.accuracy,
        p_notes: visitNotes.trim() || null,
      });

      if (visitErr) throw visitErr;

      const result = (Array.isArray(data) ? data[0] : data) as
        | { visit_id: string; created: boolean; visited_at: string; scan_method: string; notes: string | null }
        | null;
      if (!result?.visit_id) throw new Error('The checkpoint visit was not recorded. Please try again.');

      const recorded: CheckpointVisit = {
        id: result.visit_id,
        checkpoint_id: checkpoint.kind === 'site' ? checkpoint.id : null,
        route_checkpoint_id: checkpoint.kind === 'route' ? checkpoint.id : null,
        visited_at: result.visited_at,
        scan_method: result.scan_method,
        notes: result.notes,
      };

      setSession({
        ...session,
        visits: [...session.visits.filter((v) => v.id !== recorded.id), recorded],
      });
      setNotice(
        result.created
          ? `Checkpoint "${checkpoint.name}" recorded.`
          : `Checkpoint "${checkpoint.name}" was already recorded for this patrol.`
      );
      setActiveCheckpointId(null);
      setVisitNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record checkpoint visit');
    } finally {
      setRecordingVisit(false);
    }
  };

  const completePatrol = async () => {
    if (!session?.id || completingPatrol) return;

    try {
      setCompletingPatrol(true);
      setError(null);
      setNotice(null);

      // ATLAS CALLS: complete_patrol_session (enforces mandatory checkpoints, audited)
      const { data, error: completeErr } = await supabase.rpc('complete_patrol_session', {
        p_patrol_id: session.id,
        p_notes: completionNotes.trim() || null,
      });

      if (completeErr) throw completeErr;

      const patrol = (Array.isArray(data) ? data[0] : data) as
        | { id: string; status: string; ended_at: string | null }
        | null;
      if (!patrol?.id) throw new Error('The patrol session was not closed. Please try again.');

      setSession({
        ...session,
        status: patrol.status as PatrolSession['status'],
        ended_at: patrol.ended_at,
      });
      setConfirmingCompletion(false);
      setCompletionNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete patrol');
    } finally {
      setCompletingPatrol(false);
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

      {notice && (
        <div className="alert alert-success" role="status">
          <button className="alert-close" onClick={() => setNotice(null)} aria-label="Close notification">
            ×
          </button>
          {notice}
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
                  <button
                    className="btn btn-primary"
                    style={{ padding: '12px 24px', fontSize: '15px' }}
                    onClick={startPatrol}
                    disabled={startingPatrol}
                  >
                    {startingPatrol ? 'Starting…' : '▶️ Start Patrol Session'}
                  </button>
                </div>
              )}

              <OfficerPatrolStops key={session.shift.id} shiftId={session.shift.id} />

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
                        const visit = session.visits.find((v) =>
                          checkpoint.kind === 'route'
                            ? v.route_checkpoint_id === checkpoint.id
                            : v.checkpoint_id === checkpoint.id
                        );
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
                                <p style={{ margin: '6px 0 0 0', fontSize: '11px', color: 'var(--color-text-secondary)' }}>
                                  Your location is captured and checked against this checkpoint. You must be inside
                                  the checkpoint radius for the visit to be accepted.
                                </p>
                                <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                                  <button
                                    className="btn btn-primary btn-sm"
                                    disabled={recordingVisit}
                                    onClick={() => visitCheckpoint(checkpoint)}
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
                    {confirmingCompletion ? (
                      <div style={{ padding: '12px', background: 'var(--color-bg-primary)', borderRadius: '8px', border: '1px solid var(--color-border)' }}>
                        <h4 style={{ margin: '0 0 4px 0', fontSize: '14px' }}>Complete this patrol session?</h4>
                        <p style={{ margin: '0 0 10px 0', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                          {completedCount} of {totalCount} checkpoints recorded. Mandatory checkpoints must be
                          recorded before the session can close.
                        </p>
                        <div className="form-group">
                          <label style={{ fontSize: '11px' }}>Closing notes (optional)</label>
                          <input
                            type="text"
                            placeholder="e.g. Route completed, no incidents to report"
                            value={completionNotes}
                            onChange={(e) => setCompletionNotes(e.target.value)}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                          <button className="btn btn-primary btn-sm" disabled={completingPatrol} onClick={completePatrol}>
                            {completingPatrol ? 'Completing…' : 'Confirm & Complete'}
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            disabled={completingPatrol}
                            onClick={() => {
                              setConfirmingCompletion(false);
                              setCompletionNotes('');
                            }}
                          >
                            Keep patrolling
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button className="btn btn-primary btn-block" onClick={() => setConfirmingCompletion(true)}>
                        Complete Patrol Session
                      </button>
                    )}
                  </div>
                </div>
              )}

              {session.status === 'completed' && (
                <div className="completion-summary" style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: '10px', marginTop: '16px' }}>
                  <div className="success-icon" style={{ color: 'var(--color-success)' }}>✓</div>
                  <h3 style={{ margin: '8px 0' }}>Patrol Completed</h3>
                  <p style={{ margin: '0 0 8px 0', color: 'var(--color-text-secondary)', fontSize: '14px' }}>
                    {completedCount} of {totalCount} checkpoints visited.
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
