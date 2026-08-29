/**
 * PatrolPage.tsx
 *
 * Canonical schema: shifts (officer_user_id, scheduled_start/end, zone_id) ->
 * patrols (session: shift_id, zone_id, status in_progress/completed) ->
 * patrol_checkpoints (per organization + zone/site) -> patrol_checkpoint_visits
 * (proof of attendance). There is no shift_name/shift_type/assigned_to column
 * and no location_zones.patrol_checkpoint flag — those were a screen-first
 * guess and have been removed.
 */

import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface Shift {
  id: string;
  service_type: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  zone_id: string | null;
}

interface Checkpoint {
  id: string;
  name: string;
  description: string | null;
}

interface CheckpointVisit {
  checkpoint_id: string;
  visited_at: string;
}

interface PatrolSession {
  id: string;
  shift: Shift;
  status: 'in_progress' | 'completed' | 'cancelled';
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
          .select('id, service_type, scheduled_start, scheduled_end, status, zone_id')
          .eq('officer_user_id', profile.id)
          .gte('scheduled_start', todayStart.toISOString())
          .lte('scheduled_start', todayEnd.toISOString())
          .in('status', ['published', 'accepted', 'in_progress'])
          .order('scheduled_start', { ascending: true });

        if (err) throw err;
        setShifts((data as Shift[]) || []);

        if (data && data.length > 0) {
          setSelectedShiftId(data[0].id);
          await loadOrCreateSession(data[0] as Shift);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load shifts');
      } finally {
        setLoading(false);
      }
    };

    loadShifts();
  }, [profile?.id]);

  const loadOrCreateSession = async (shift: Shift) => {
    if (!profile?.organizationId || !profile?.id) return;

    try {
      // ATLAS READS: patrols (existing session for this shift)
      const { data: existing, error: existingErr } = await supabase
        .from('patrols')
        .select('id, status')
        .eq('shift_id', shift.id)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingErr) throw existingErr;

      let patrolId = existing?.id ?? null;
      let status: PatrolSession['status'] = (existing?.status as PatrolSession['status']) ?? 'in_progress';

      if (!patrolId) {
        // Not started yet — just load checkpoints for preview, no session row yet.
        const checkpoints = await loadCheckpoints(shift.zone_id);
        setSession({ id: '', shift, status: 'in_progress', checkpoints, visits: [] });
        return;
      }

      const checkpoints = await loadCheckpoints(shift.zone_id);
      const visits = await loadVisits(patrolId);
      setSession({ id: patrolId, shift, status, checkpoints, visits });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load patrol session');
    }
  };

  const loadCheckpoints = async (zoneId: string | null): Promise<Checkpoint[]> => {
    if (!zoneId || !profile?.organizationId) return [];

    // ATLAS READS: patrol_checkpoints
    const { data, error: err } = await supabase
      .from('patrol_checkpoints')
      .select('id, name, description')
      .eq('organization_id', profile.organizationId)
      .eq('zone_id', zoneId)
      .eq('active', true);

    if (err) throw err;
    return (data as Checkpoint[]) || [];
  };

  const loadVisits = async (patrolId: string): Promise<CheckpointVisit[]> => {
    // ATLAS READS: patrol_checkpoint_visits
    const { data, error: err } = await supabase
      .from('patrol_checkpoint_visits')
      .select('checkpoint_id, visited_at')
      .eq('patrol_id', patrolId);

    if (err) throw err;
    return (data as CheckpointVisit[]) || [];
  };

  const startPatrol = async () => {
    if (!session || !profile?.organizationId || !profile?.id) return;

    try {
      // ATLAS WRITES: patrols
      const { data, error } = await supabase
        .from('patrols')
        .insert([
          {
            organization_id: profile.organizationId,
            shift_id: session.shift.id,
            officer_user_id: profile.id,
            zone_id: session.shift.zone_id,
            status: 'in_progress',
          },
        ])
        .select()
        .single();

      if (error) throw error;

      setSession({ ...session, id: data.id, status: 'in_progress' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start patrol');
    }
  };

  const visitCheckpoint = async (checkpointId: string) => {
    if (!session || !session.id || !profile?.organizationId || !profile?.id) return;

    try {
      // ATLAS WRITES: patrol_checkpoint_visits
      const { error } = await supabase.from('patrol_checkpoint_visits').insert([
        {
          organization_id: profile.organizationId,
          patrol_id: session.id,
          checkpoint_id: checkpointId,
          officer_user_id: profile.id,
          scan_method: 'manual_code',
        },
      ]);

      if (error) throw error;

      setSession({
        ...session,
        visits: [...session.visits, { checkpoint_id: checkpointId, visited_at: new Date().toISOString() }],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record checkpoint visit');
    }
  };

  const completePatrol = async () => {
    if (!session || !session.id) return;

    try {
      // ATLAS WRITES: patrols
      const { error } = await supabase
        .from('patrols')
        .update({ status: 'completed', ended_at: new Date().toISOString() })
        .eq('id', session.id);

      if (error) throw error;

      setSession({ ...session, status: 'completed' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete patrol');
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading patrol data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container patrol-page">
      <header className="page-header">
        <h1>Field Patrol</h1>
        <p className="subtitle">Checkpoint patrol and zone inspection</p>
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
        <div className="empty-state">
          <div className="empty-icon">📋</div>
          <h2>No active shifts</h2>
          <p>You don't have any patrol shifts assigned for today.</p>
        </div>
      ) : (
        <div className="patrol-layout">
          <div className="shift-selector">
            <h2>Today's Shifts</h2>
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
                    })}
                  </div>
                  <div className="shift-name">{shift.service_type}</div>
                  <div className="shift-badge">{shift.status}</div>
                </button>
              ))}
            </div>
          </div>

          {session && (
            <div className="patrol-session">
              <div className="session-header">
                <h2>{session.shift.service_type}</h2>
                <span className={`status-badge status-${session.status}`}>
                  {session.status.replace(/_/g, ' ')}
                </span>
              </div>

              {!session.id && (
                <div className="session-actions">
                  <button className="btn btn-primary" onClick={startPatrol}>
                    Start Patrol
                  </button>
                </div>
              )}

              {session.id && session.status === 'in_progress' && (
                <div className="checkpoints-container">
                  <h3>Patrol Checkpoints</h3>
                  {session.checkpoints.length === 0 ? (
                    <div className="empty-state">
                      <p>No checkpoints configured for this zone.</p>
                    </div>
                  ) : (
                    <div className="checkpoints-list">
                      {session.checkpoints.map((checkpoint, idx) => {
                        const visit = session.visits.find((v) => v.checkpoint_id === checkpoint.id);
                        return (
                          <div key={checkpoint.id} className={`checkpoint-item ${visit ? 'completed' : ''}`}>
                            <div className="checkpoint-number">{idx + 1}</div>
                            <div className="checkpoint-content">
                              <h4>{checkpoint.name}</h4>
                              {checkpoint.description && <p>{checkpoint.description}</p>}
                              {visit ? (
                                <p className="checkpoint-time">
                                  ✓ Visited at {new Date(visit.visited_at).toLocaleTimeString()}
                                </p>
                              ) : (
                                <button
                                  className="btn btn-sm btn-secondary"
                                  onClick={() => visitCheckpoint(checkpoint.id)}
                                >
                                  Mark Visited
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <button className="btn btn-primary btn-block" onClick={completePatrol}>
                    Complete Patrol
                  </button>
                </div>
              )}

              {session.status === 'completed' && (
                <div className="completion-summary">
                  <div className="success-icon">✓</div>
                  <h3>Patrol Complete</h3>
                  <p>{session.visits.length} checkpoint(s) recorded.</p>
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
