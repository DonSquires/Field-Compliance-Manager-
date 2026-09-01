/**
 * OfficerOnCallPage.tsx (Officer module: 'on_call')
 *
 * Canonical schema: on_call_periods (own pending/accepted assignments),
 * callout_shifts (minimum-pay callout timeline), travel_allowances.
 * on_call_periods has admin-only INSERT/UPDATE, so accept/decline goes
 * through respond_to_on_call_period(); callout_shifts/travel_allowances
 * are SELECT-only, so milestone logging and travel claims go through
 * log_callout_milestone()/submit_travel_allowance().
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

type PeriodStatus = 'pending' | 'accepted' | 'declined' | 'completed';
type Milestone = 'received' | 'departed' | 'arrived' | 'work_started' | 'work_ended' | 'returned';

interface OnCallPeriod {
  id: string;
  period_type: string;
  starts_at: string;
  ends_at: string;
  flat_rate: number | null;
  status: PeriodStatus;
}

interface CalloutShift {
  id: string;
  on_call_period_id: string;
  callout_received_at: string | null;
  departed_at: string | null;
  arrived_at: string | null;
  work_started_at: string | null;
  work_ended_at: string | null;
  returned_at: string | null;
}

const NEXT_MILESTONE: Record<string, Milestone> = {
  none: 'received',
  received: 'departed',
  departed: 'arrived',
  arrived: 'work_started',
  work_started: 'work_ended',
  work_ended: 'returned',
};

const MILESTONE_LABEL: Record<Milestone, string> = {
  received: 'Log Callout Received',
  departed: 'Log Departed',
  arrived: 'Log Arrived on Site',
  work_started: 'Log Work Started',
  work_ended: 'Log Work Ended',
  returned: 'Log Returned',
};

function currentStage(callout: CalloutShift | undefined): string {
  if (!callout) return 'none';
  if (callout.returned_at) return 'returned';
  if (callout.work_ended_at) return 'work_ended';
  if (callout.work_started_at) return 'work_started';
  if (callout.arrived_at) return 'arrived';
  if (callout.departed_at) return 'departed';
  return 'received';
}

const OfficerOnCallPage: React.FC = () => {
  const { profile } = useAuth();
  const [periods, setPeriods] = useState<OnCallPeriod[]>([]);
  const [callouts, setCallouts] = useState<Record<string, CalloutShift>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [travelForm, setTravelForm] = useState<Record<string, { journey_type: string; distance_km: string }>>({});

  // ATLAS READS: on_call_periods, callout_shifts
  const load = useCallback(async () => {
    if (!profile?.id) return;
    setLoading(true);
    setError(null);
    const [periodResponse, calloutResponse] = await Promise.all([
      supabase
        .from('on_call_periods')
        .select('id, period_type, starts_at, ends_at, flat_rate, status')
        .eq('officer_user_id', profile.id)
        .in('status', ['pending', 'accepted'])
        .order('starts_at', { ascending: true })
        .limit(50),
      supabase
        .from('callout_shifts')
        .select('id, on_call_period_id, callout_received_at, departed_at, arrived_at, work_started_at, work_ended_at, returned_at')
        .eq('officer_user_id', profile.id)
        .is('returned_at', null),
    ]);
    setPeriods((periodResponse.data as OnCallPeriod[]) ?? []);
    const byPeriod: Record<string, CalloutShift> = {};
    for (const c of (calloutResponse.data as CalloutShift[]) ?? []) byPeriod[c.on_call_period_id] = c;
    setCallouts(byPeriod);
    const failures = [periodResponse.error?.message, calloutResponse.error?.message].filter(Boolean);
    if (failures.length) setError(failures.join(' · '));
    setLoading(false);
  }, [profile?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRespond = async (periodId: string, decision: 'accepted' | 'declined') => {
    setBusyId(periodId);
    setError(null);
    const { error: err } = await supabase.rpc('respond_to_on_call_period', { p_period_id: periodId, p_decision: decision });
    if (err) setError(err.message);
    else await load();
    setBusyId(null);
  };

  const handleMilestone = async (periodId: string, milestone: Milestone) => {
    setBusyId(periodId);
    setError(null);
    const { error: err } = await supabase.rpc('log_callout_milestone', { p_on_call_period_id: periodId, p_milestone: milestone });
    if (err) setError(err.message);
    else await load();
    setBusyId(null);
  };

  const handleTravelSubmit = async (periodId: string, calloutId: string) => {
    const form = travelForm[periodId];
    if (!form?.journey_type) return;
    setBusyId(periodId);
    setError(null);
    const { error: err } = await supabase.rpc('submit_travel_allowance', {
      p_callout_shift_id: calloutId,
      p_journey_type: form.journey_type,
      p_distance_km: form.distance_km ? parseFloat(form.distance_km) : null,
    });
    if (err) setError(err.message);
    else setTravelForm({ ...travelForm, [periodId]: { journey_type: '', distance_km: '' } });
    setBusyId(null);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading on-call assignments...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>On-Call</h1>
        <p className="subtitle">{periods.length} assignment(s)</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      <div className="contacts-list">
        {periods.length === 0 ? (
          <div className="empty-state">
            <p>No pending or active on-call assignments.</p>
          </div>
        ) : (
          periods.map((period) => {
            const callout = callouts[period.id];
            const stage = currentStage(callout);
            const next = NEXT_MILESTONE[stage];
            return (
              <div key={period.id} className="contact-card">
                <div className="contact-header">
                  <h3>{period.period_type.replaceAll('_', ' ')}</h3>
                  <span className="badge">{period.status}</span>
                </div>
                <div className="contact-details">
                  <p className="contact-meta">
                    {new Date(period.starts_at).toLocaleString()} – {new Date(period.ends_at).toLocaleString()}
                    {period.flat_rate != null && ` · Flat rate $${period.flat_rate}`}
                  </p>
                  {period.status === 'pending' && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button type="button" className="btn btn-primary" disabled={busyId === period.id} onClick={() => handleRespond(period.id, 'accepted')}>
                        Accept
                      </button>
                      <button type="button" className="btn btn-secondary" disabled={busyId === period.id} onClick={() => handleRespond(period.id, 'declined')}>
                        Decline
                      </button>
                    </div>
                  )}
                  {period.status === 'accepted' && next && (
                    <button type="button" className="btn btn-primary btn-block" disabled={busyId === period.id} onClick={() => handleMilestone(period.id, next)}>
                      {MILESTONE_LABEL[next]}
                    </button>
                  )}
                  {period.status === 'accepted' && callout && stage === 'returned' && (
                    <div className="form-group">
                      <label>Submit travel allowance</label>
                      <select
                        value={travelForm[period.id]?.journey_type ?? ''}
                        onChange={(e) => setTravelForm({ ...travelForm, [period.id]: { ...travelForm[period.id], journey_type: e.target.value, distance_km: travelForm[period.id]?.distance_km ?? '' } })}
                      >
                        <option value="">Select journey type…</option>
                        <option value="outbound">Outbound</option>
                        <option value="return">Return</option>
                        <option value="round_trip">Round trip</option>
                      </select>
                      <input
                        type="number"
                        placeholder="Distance (km)"
                        value={travelForm[period.id]?.distance_km ?? ''}
                        onChange={(e) => setTravelForm({ ...travelForm, [period.id]: { journey_type: travelForm[period.id]?.journey_type ?? '', distance_km: e.target.value } })}
                      />
                      <button type="button" className="btn btn-secondary btn-block" disabled={busyId === period.id} onClick={() => handleTravelSubmit(period.id, callout.id)}>
                        Submit Travel Claim
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default OfficerOnCallPage;
