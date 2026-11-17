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

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useOfficerUnsavedWork } from '../context/OfficerUnsavedWorkContext';
import { supabase } from '../lib/supabase';
import { OfficerPatrolStops } from '../components/OfficerPatrolStops';
import { PatrolCheckpointList, type PatrolCheckpoint as Checkpoint, type PatrolCheckpointVisit as CheckpointVisit } from '../components/PatrolCheckpointList';
import { parsePatrolJourney, type PatrolJourney } from '../lib/officerPatrolJourney';
import { PATROL_CHECKPOINT_RECORDED, requestPatrolCapture } from '../lib/patrolCheckpointEvents';
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
  context_status?: 'available' | 'requires_review' | 'recovery_only';
}

interface PatrolSession {
  id: string;
  shift: Shift;
  status: 'in_progress' | 'completed' | 'cancelled';
  started_at: string;
  ended_at?: string | null;
  checkpoints: Checkpoint[];
  visits: CheckpointVisit[];
  journey: PatrolJourney;
}

interface AssignedPatrolRead {
  shift_id: string;
  session: { id: string; status: PatrolSession['status']; started_at: string; ended_at: string | null } | null;
  visits: CheckpointVisit[];
}

async function readAssignedPatrol(shiftId: string): Promise<AssignedPatrolRead> {
  const { data, error } = await supabase.rpc('get_assigned_patrol_session', { p_shift_id: shiftId });
  if (error) throw error;
  const read = data as AssignedPatrolRead | null;
  if (!read || read.shift_id !== shiftId || !Array.isArray(read.visits)
    || (read.session === null && read.visits.length > 0)
    || (read.session !== null && (!read.session?.id || !Number.isFinite(Date.parse(read.session.started_at))
      || !['in_progress', 'completed', 'cancelled'].includes(read.session.status)))
    || read.visits.some((visit) => !visit || typeof visit.id !== 'string'
      || !Number.isFinite(Date.parse(visit.visited_at)) || typeof visit.scan_method !== 'string'
      || (typeof visit.checkpoint_id === 'string') === (typeof visit.route_checkpoint_id === 'string')
      || visit.notes !== null)) {
    throw new Error('The assigned patrol session could not be confirmed.');
  }
  return read;
}

const PatrolPage: React.FC = () => {
  const { profile } = useAuth();
  const { search } = useLocation();
  const navigate = useNavigate();
  const requestedShiftId = new URLSearchParams(search).get('shift');
  const requestedShiftRef = useRef(requestedShiftId);
  requestedShiftRef.current = requestedShiftId;
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [session, setSession] = useState<PatrolSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shiftLoadAttempt, setShiftLoadAttempt] = useState(0);
  const [sessionLoadAttempt, setSessionLoadAttempt] = useState(0);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [shiftLoadFailed, setShiftLoadFailed] = useState(false);
  const [shiftWarning, setShiftWarning] = useState<string | null>(null);
  const [activeCheckpointId, setActiveCheckpointId] = useState<string | null>(null);
  const [visitNotes, setVisitNotes] = useState('');
  const [recordingVisit, setRecordingVisit] = useState(false);
  const [startingPatrol, setStartingPatrol] = useState(false);
  const [completingPatrol, setCompletingPatrol] = useState(false);
  const [confirmingCompletion, setConfirmingCompletion] = useState(false);
  const [completionNotes, setCompletionNotes] = useState('');
  const [stopWorkDirty, setStopWorkDirty] = useState(false);
  const onStopWorkDirtyChange = useCallback((dirty: boolean) => setStopWorkDirty(dirty), []);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  useOfficerUnsavedWork(Boolean(visitNotes || completionNotes || recordingVisit || startingPatrol || completingPatrol));

  const loadVisits = useCallback(async (shiftId: string, patrolId: string): Promise<CheckpointVisit[]> => {
    const read = await readAssignedPatrol(shiftId);
    if (read.session?.id !== patrolId) throw new Error('The assigned patrol session changed.');
    return read.visits;
  }, []);

  const loadOrCreateSession = useCallback(
    async (shift: Shift): Promise<PatrolSession> => {
      if (!profile?.organizationId || !profile?.id) throw new Error('Organisation access is unavailable');

      const { session: existing, visits } = await readAssignedPatrol(shift.id);

      // ATLAS READS: get_officer_patrol_journey (assignment-scoped stops and completion requirements)
      const { data: journeyData, error: journeyError } = await supabase.rpc('get_officer_patrol_journey', { p_shift_id: shift.id });
      if (journeyError) throw journeyError;
      const journey = parsePatrolJourney(journeyData, shift.id);
      if ((journey.patrol_id && journey.patrol_id !== existing?.id)
        || (existing?.status === 'in_progress' && journey.patrol_id !== existing.id)) {
        throw new Error('The active patrol session could not be confirmed.');
      }
      const checkpoints = journey.checkpoints;

      if (!existing) {
        return {
          id: '',
          shift,
          status: 'in_progress',
          started_at: '',
          checkpoints,
          visits: [],
          journey,
        };
      }

      return {
        id: existing.id,
        shift,
        status: existing.status as PatrolSession['status'],
        started_at: existing.started_at,
        ended_at: existing.ended_at,
        checkpoints,
        visits,
        journey,
      };
    },
    [profile?.organizationId, profile?.id]
  );

  // ATLAS READS: shifts (today's shifts and in-progress overnight shifts for this officer)
  useEffect(() => {
    let active = true;
    const loadShifts = async () => {
      if (!profile?.id || !profile.organizationId) {
        setShifts([]);
        setSession(null);
        setShiftLoadFailed(true);
        setError('Organisation access could not be confirmed. Patrol data is unavailable.');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);
        setShiftWarning(null);
        setShiftLoadFailed(false);
        setShifts([]);
        setSelectedShiftId(null);
        setSession(null);

        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(now);
        todayEnd.setHours(23, 59, 59, 999);

        const [direct, scoped] = await Promise.all([supabase
          .from('shifts')
          .select(
            'id, service_type, scheduled_start, scheduled_end, status, zone_id, patrol_route_id, zone:zone_id(name), route:patrol_route_id(name, route_code)'
          )
          .eq('officer_user_id', profile.id)
          .lte('scheduled_start', todayEnd.toISOString())
          .gte('scheduled_end', now.toISOString())
          .or(`scheduled_start.gte.${todayStart.toISOString()},and(status.eq.in_progress,scheduled_start.lt.${todayStart.toISOString()})`)
          .in('status', ['published', 'accepted', 'in_progress'])
          .order('scheduled_start', { ascending: true }),
          supabase.rpc('get_assigned_officer_shift_context')]);

        if (direct.error) throw direct.error;
        if (scoped.error || !Array.isArray(scoped.data)) throw scoped.error ?? new Error('Assigned shifts could not be confirmed.');
        if (!active) return;

        const directShifts: Shift[] = ((direct.data as any[]) || []).map((s) => ({
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
        const scopedRows = scoped.data as Shift[];
        const reviewIds = new Set(scopedRows.filter((shift) => shift.context_status === 'requires_review').map((shift) => shift.id));
        if (reviewIds.size) setShiftWarning('Some assigned shifts need operations review; their details are unavailable.');
        const scopedShifts = scopedRows.filter((s) => {
          const start = Date.parse(s.scheduled_start);
          const end = Date.parse(s.scheduled_end);
          return s.context_status !== 'requires_review' && s.context_status !== 'recovery_only'
            && Number.isFinite(start) && Number.isFinite(end) && start <= todayEnd.getTime()
            && end >= now.getTime() && (start >= todayStart.getTime() || s.status === 'in_progress');
        });
        const byId = new Map(scopedShifts.map((shift) => [shift.id, shift]));
        directShifts.filter((shift) => !reviewIds.has(shift.id)).forEach((shift) => byId.set(shift.id, shift));
        const formattedShifts = [...byId.values()].sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start));

        setShifts(formattedShifts);

        const requested = requestedShiftRef.current;
        if (requested) {
          if (formattedShifts.some((shift) => shift.id === requested)) {
            setSelectedShiftId(requested);
          } else {
            setError('The selected shift could not be confirmed here. Open your schedule or contact operations.');
          }
        } else if (formattedShifts.length > 0) {
          setSelectedShiftId((formattedShifts.find((shift) => shift.status === 'in_progress') ?? formattedShifts[0]).id);
        }
      } catch (err) {
        if (!active) return;
        console.error('Failed to load patrol shifts:', err);
        setShiftLoadFailed(true);
        setError('Patrol shifts could not be loaded. Try again or contact operations.');
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadShifts();
    return () => { active = false; };
  }, [profile?.id, profile?.organizationId, shiftLoadAttempt]);

  useEffect(() => {
    if (loading || shiftLoadFailed || !requestedShiftId) return;
    if (shifts.some((shift) => shift.id === requestedShiftId)) {
      setSelectedShiftId(requestedShiftId);
      setError(null);
    } else {
      setSelectedShiftId(null);
      setError('The selected shift could not be confirmed here. Open your schedule or contact operations.');
    }
  }, [requestedShiftId, shifts, loading, shiftLoadFailed]);

  const selectedShift = shifts.find((shift) => shift.id === selectedShiftId);
  useEffect(() => {
    let active = true;
    setSession(null);
    setSessionError(null);
    setActiveCheckpointId(null);
    setVisitNotes('');
    setConfirmingCompletion(false);
    setCompletionNotes('');
    if (!selectedShift) {
      setSessionLoading(false);
      return () => { active = false; };
    }

    setSessionLoading(true);
    void loadOrCreateSession(selectedShift).then((next) => {
      if (active) setSession(next);
    }).catch((err) => {
      console.error('Failed to load patrol session or checkpoints:', err);
      if (active) setSessionError('Patrol session or checkpoints could not be loaded. Try again or contact operations.');
    }).finally(() => {
      if (active) setSessionLoading(false);
    });
    return () => { active = false; };
  }, [selectedShift, sessionLoadAttempt, loadOrCreateSession]);

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

  useEffect(() => {
    if (!session?.id || session.status !== 'in_progress') return;
    const patrolId = session.id;
    const shiftId = session.shift.id;
    let active = true;
    const refresh = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.shiftId !== shiftId) return;
      void loadVisits(shiftId, patrolId).then((visits) => {
        if (!active) return;
        setSession((current) => current?.id === patrolId ? {
          ...current,
          visits: [...current.visits, ...visits.filter((visit) => !current.visits.some((existing) => existing.id === visit.id))],
        } : current);
      }).catch((failure) => {
        console.error('Failed to refresh recorded checkpoints:', failure);
        if (active) setError('A checkpoint may have been recorded, but its receipt could not be refreshed. Reload the patrol or contact operations.');
      });
    };
    window.addEventListener(PATROL_CHECKPOINT_RECORDED, refresh);
    requestPatrolCapture(shiftId);
    return () => { active = false; window.removeEventListener(PATROL_CHECKPOINT_RECORDED, refresh); };
  }, [session?.id, session?.status, session?.shift.id, loadVisits]);

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

      const visits = await loadVisits(session.shift.id, patrol.id);
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

      setSession((current) => current?.id === session.id ? {
        ...current, visits: [...current.visits.filter((v) => v.id !== recorded.id), recorded],
      } : current);
      setNotice(
        result.created
          ? `Checkpoint "${checkpoint.name}" recorded.`
          : `Checkpoint "${checkpoint.name}" was already recorded for this patrol. Draft notes were not saved.`
      );
      if (result.created || !visitNotes.trim()) {
        setActiveCheckpointId(null);
        setVisitNotes('');
      }
      try {
        const visits = await loadVisits(session.shift.id, session.id);
        setSession((current) => current?.id === session.id ? { ...current, visits } : current);
      } catch (refreshError) {
        console.error('Recorded patrol visit could not be refreshed:', refreshError);
        setError('The visit was recorded, but its verification details could not be refreshed. Reload the patrol plan or contact operations.');
      }
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

  const completedCount = session ? session.checkpoints.filter((checkpoint) => session.visits.some((visit) =>
    checkpoint.kind === 'route' ? visit.route_checkpoint_id === checkpoint.id : visit.checkpoint_id === checkpoint.id)).length : 0;
  const totalCount = session?.checkpoints.length ?? 0;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const stopIds = new Set(session?.journey.stops.map((stop) => stop.id) ?? []);
  const otherCheckpoints = session?.checkpoints.filter((checkpoint) => !checkpoint.stop_ids.some((id) => stopIds.has(id))) ?? [];
  const checkpointList = (checkpoints: Checkpoint[], instanceId: string) => session && (
    <PatrolCheckpointList checkpoints={checkpoints} visits={session.visits} activeCheckpointId={activeCheckpointId}
      notes={visitNotes} recording={recordingVisit} instanceId={instanceId}
      onSelect={(id) => {
        if (id !== activeCheckpointId && visitNotes && !window.confirm('Discard the unsubmitted checkpoint notes?')) return;
        if (id !== activeCheckpointId) setVisitNotes('');
        setActiveCheckpointId(id);
      }}
      onNotesChange={setVisitNotes} onRecord={(checkpoint) => void visitCheckpoint(checkpoint)} />
  );

  return (
    <div className="page-container patrol-page">
      <header className="page-header">
        <h1>Patrol shifts and stops</h1>
        <p className="subtitle">Work your assigned places and record patrol checkpoints.</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}
      {shiftWarning && <div className="alert alert-error" role="alert">{shiftWarning}</div>}

      {notice && (
        <div className="alert alert-success" role="status">
          <button className="alert-close" onClick={() => setNotice(null)} aria-label="Close notification">
            ×
          </button>
          {notice}
        </div>
      )}

      {shiftLoadFailed ? (
        <button className="btn btn-secondary" onClick={() => setShiftLoadAttempt((attempt) => attempt + 1)}>Try loading shifts again</button>
      ) : shifts.length === 0 && !requestedShiftId ? (
        <div className="empty-state" style={{ marginTop: '24px' }}>
          <div style={{ fontSize: '32px', marginBottom: '8px' }}>📋</div>
          <h2>No Patrol Shifts Scheduled Today</h2>
          <p>You don't have any active patrol shifts assigned for today.</p>
          <p>For an unfinished shift past its scheduled end, <Link to="/officer/schedule">open your schedule</Link> or contact operations.</p>
        </div>
      ) : (
        <div className="patrol-layout" style={{ marginTop: '20px' }}>
          {/* Shift selector list */}
          <div className="shift-selector">
            <h2 style={{ fontSize: '15px', marginBottom: '12px' }}>Today's and active overnight shifts ({shifts.length})</h2>
            <div className="shift-list">
              {shifts.map((shift) => (
                <button
                  key={shift.id}
                  className={`shift-card ${selectedShiftId === shift.id ? 'active' : ''}`}
                  disabled={recordingVisit || startingPatrol || completingPatrol}
                  onClick={() => {
                    if (shift.id === selectedShiftId) return;
                    if ((visitNotes || completionNotes || stopWorkDirty) && !window.confirm('Leave this patrol and lose unsubmitted stop, checkpoint or closing work?')) return;
                    setStopWorkDirty(false);
                    setSelectedShiftId(shift.id);
                    setError(null);
                    setNotice(null);
                    const params = new URLSearchParams(search);
                    params.set('shift', shift.id);
                    navigate({ search: `?${params.toString()}` }, { replace: true });
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
          {selectedShift && (
            <div className="patrol-session">
              {sessionLoading && <p role="status">Loading patrol session and checkpoints...</p>}
              {sessionError && (
                <div className="alert alert-error" role="alert">
                  <p>{sessionError}</p>
                  <button className="btn btn-secondary" onClick={() => setSessionLoadAttempt((attempt) => attempt + 1)}>Try loading patrol again</button>
                </div>
              )}
              <OfficerPatrolStops key={selectedShift.id} shiftId={selectedShift.id} journey={session?.journey} onDirtyChange={onStopWorkDirtyChange}
                renderCheckpoints={(stopId) => {
                  if (!session) return <p>{sessionLoading ? 'Loading checkpoints...' : 'Checkpoint details are unavailable. Retry loading the patrol plan.'}</p>;
                  const checkpoints = session.checkpoints.filter((checkpoint) => checkpoint.stop_ids.includes(stopId));
                  if (!checkpoints.length) return <p>No site or zone checkpoints are linked to this stop. Route checkpoints are listed separately.</p>;
                  if (!session.id) return <p>Start the patrol session to record these checkpoints: {checkpoints.map((checkpoint) => checkpoint.name).join(', ')}.</p>;
                  if (session.status !== 'in_progress') return <p>This patrol session is closed.</p>;
                  return checkpointList(checkpoints, stopId);
                }} />

              {session && session.shift.id === selectedShiftId && <>
              <div className="patrol-header-card" style={{ marginTop: '16px' }}>
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
              </>}

              {session && session.shift.id === selectedShiftId && <>
              {session.id && session.status === 'in_progress' && (
                <div className="checkpoints-container" style={{ marginTop: '16px' }}>
                  <h3 style={{ fontSize: '15px', marginBottom: '8px' }}>Other patrol checkpoints ({otherCheckpoints.length})</h3>

                  {otherCheckpoints.length === 0 ? (
                    <div className="empty-state" style={{ padding: '24px' }}>
                      <p>{session.checkpoints.length ? 'Site checkpoints are shown with their stops above.' : 'No checkpoints are configured for this patrol.'}</p>
                    </div>
                  ) : (
                    checkpointList(otherCheckpoints, 'other')
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
              </>}
            </div>
          )}
          {!selectedShift && requestedShiftId && <p><Link to="/officer/schedule">Open my schedule</Link></p>}
        </div>
      )}
    </div>
  );
};

export default PatrolPage;
