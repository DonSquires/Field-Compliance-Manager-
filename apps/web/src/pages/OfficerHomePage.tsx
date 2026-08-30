import React, { useMemo, useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useActiveShift } from '../hooks/useActiveShift';
import { useOfficerSafety } from '../hooks/useOfficerSafety';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { supabase } from '../lib/supabase';
import { ProfessionalHeader } from '../components/ProfessionalHeader';
import './PageStyles.css';

// shift_coverage_requests: real table + real trg_notify_shift_coverage_open_created
// trigger, but Atlas shows zero app-layer readers/writers -- present and wired
// server-side (a notification fires on insert), never surfaced to officers.
interface OpenShift {
  id: string;
  shift_date: string;
  start_time: string;
  end_time: string;
  required_staff_count: number;
  urgency: string;
  notes: string | null;
  site_name: string | null;
}

function useOpenShifts(organizationId: string | null | undefined) {
  const [openShifts, setOpenShifts] = useState<OpenShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!organizationId) return;
    try {
      setLoading(true);
      setError(null);
      const { data, error: err } = await supabase
        .from('shift_coverage_requests')
        .select('id, shift_date, start_time, end_time, required_staff_count, urgency, notes, site:site_id(name)')
        .eq('organization_id', organizationId)
        .eq('status', 'open')
        .order('urgency', { ascending: false })
        .order('shift_date', { ascending: true });

      if (err) throw err;
      setOpenShifts(
        ((data as any[]) || []).map((row) => ({
          id: row.id,
          shift_date: row.shift_date,
          start_time: row.start_time,
          end_time: row.end_time,
          required_staff_count: row.required_staff_count,
          urgency: row.urgency,
          notes: row.notes,
          site_name: row.site?.name ?? null,
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load open shifts');
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    load();
  }, [load]);

  const claim = useCallback(
    async (requestId: string, officerId: string) => {
      try {
        setClaimingId(requestId);
        setError(null);
        // .select() + empty-result check matters here: a bare .update() returns
        // no error even when the .eq('status','open') guard matches zero rows
        // (i.e. someone else already claimed it) -- without this check the UI
        // would silently report success on a claim that never actually happened.
        const { data, error: err } = await supabase
          .from('shift_coverage_requests')
          .update({ status: 'claimed', claimed_by: officerId, claimed_at: new Date().toISOString() })
          .eq('id', requestId)
          .eq('status', 'open')
          .select('id');

        if (err) throw err;
        if (!data || data.length === 0) {
          setError('This shift was already claimed by someone else.');
          setOpenShifts((prev) => prev.filter((s) => s.id !== requestId));
          return;
        }
        setOpenShifts((prev) => prev.filter((s) => s.id !== requestId));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to claim shift');
      } finally {
        setClaimingId(null);
      }
    },
    []
  );

  return { openShifts, loading, error, claimingId, claim };
}

export function OfficerHomePage() {
  const { profile } = useAuth();
  const { isModuleEnabled } = useEnabledModules(profile?.organizationId);
  
  const { shift, isLoading: shiftLoading, error: shiftError } = useActiveShift(
    profile?.id ?? '',
    profile?.organizationId ?? ''
  );

  const safetyEnabled = isModuleEnabled('welfare', { safetyRelevant: true });

  const safety = useOfficerSafety({
    officerId: profile?.id ?? null,
    organizationId: profile?.organizationId ?? null,
    orgManDownEnabled: safetyEnabled,
  });

  const shiftDisplay = useMemo(() => {
    if (shiftLoading) return { status: 'Loading...', details: '' };
    if (shiftError) return { status: 'Error', details: shiftError.message };
    if (!shift) return { status: 'No shift', details: 'Not scheduled today' };
    const start = shift.start_time.slice(0, 5);
    const end = shift.end_time.slice(0, 5);
    const status =
      shift.status === 'in_progress'
        ? '🔴 Active'
        : shift.status === 'scheduled' || shift.status === 'published' || shift.status === 'accepted'
          ? '⏳ Upcoming'
          : '✅ Completed';
    return {
      status: `${status} • ${start}–${end}`,
      details: shift.shift_type ? `${shift.shift_type.toUpperCase()}` : '',
    };
  }, [shift, shiftLoading, shiftError]);

  const safetyDisplay = useMemo(() => {
    if (safety.detectionState === 'unknown') return { status: 'Unknown', color: '#94a3b8' };
    if (safety.detectionState !== 'active')
      return { status: `Disabled (${safety.detectionState.replace('_', ' ')})`, color: '#FF9800' };
    if (safety.activeAlert) {
      const alertKind = safety.activeAlert.kind.toUpperCase();
      return { status: `🚨 ${alertKind}`, color: '#FF1744' };
    }
    return { status: `✅ OK (${safety.minutesRemaining}m)`, color: '#4CAF50' };
  }, [safety.detectionState, safety.activeAlert, safety.minutesRemaining]);

  const dispatchDisplay = useMemo(() => {
    if (!shift || !shift.stops) return { count: '—', details: 'No stops assigned' };
    return { count: String(shift.stops.length), details: `stops scheduled` };
  }, [shift]);

  const { openShifts, loading: openShiftsLoading, error: openShiftsError, claimingId, claim } = useOpenShifts(
    profile?.organizationId
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: 'var(--color-bg-secondary)' }}>
      {/* Professional Header */}
      <ProfessionalHeader
        title="Officer Dashboard"
        subtitle="Check your shift, safety status, and available work"
      />

      {/* Main Content */}
      <main style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: '1280px', margin: '0 auto', padding: 'var(--space-8)' }}>
          {/* Status Cards Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 'var(--space-4)',
              marginBottom: 'var(--space-8)',
            }}
          >
            <div className="card" style={{ borderLeft: `4px solid var(--color-primary)` }}>
              <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
                Shift Status
              </div>
              <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 'var(--font-bold)', color: 'var(--color-primary)' }}>
                {shiftDisplay.status}
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-2)' }}>
                {shiftDisplay.details}
              </div>
            </div>

            <div className="card" style={{ borderLeft: `4px solid ${safetyDisplay.color}` }}>
              <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
                Safety Status
              </div>
              <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 'var(--font-bold)', color: safetyDisplay.color }}>
                {safetyDisplay.status}
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-2)' }}>
                {safety.detectionState === 'active' ? `${safety.status} state` : 'Normal operations'}
              </div>
            </div>

            <div className="card" style={{ borderLeft: `4px solid var(--color-warning)` }}>
              <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
                Dispatch Items
              </div>
              <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 'var(--font-bold)', color: 'var(--color-warning)' }}>
                {dispatchDisplay.count}
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-2)' }}>
                {dispatchDisplay.details}
              </div>
            </div>

            <div className="card" style={{ borderLeft: `4px solid var(--color-primary)` }}>
              <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
                Connection
              </div>
              <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 'var(--font-bold)', color: profile?.email ? 'var(--color-success)' : 'var(--color-error)' }}>
                {profile?.email ? 'Online' : 'Offline'}
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-2)' }}>
                {profile?.displayName ?? 'Officer'}
              </div>
            </div>
          </div>

          {/* Error Alert */}
          {safety.writeStatus === 'error' && safety.lastError && (
            <div className="alert alert-error" style={{ marginBottom: 'var(--space-6)' }} role="alert">
              <button
                className="alert-close"
                onClick={() => console.log('dismiss')}
                aria-label="Close alert"
              >
                ×
              </button>
              Safety System Error: {safety.lastError}
            </div>
          )}

          {/* Open Shifts Section */}
          <div>
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <h2 style={{ margin: 0, fontSize: 'var(--text-2xl)', fontWeight: 'var(--font-bold)' }}>
                Available Shifts
              </h2>
              <p style={{ margin: 'var(--space-2) 0 0 0', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
                Coverage requests you can claim to earn additional hours
              </p>
            </div>

            {openShiftsError && (
              <div className="alert alert-error" style={{ marginBottom: 'var(--space-4)' }} role="alert">
                {openShiftsError}
              </div>
            )}

            {openShiftsLoading ? (
              <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                <div className="spinner" style={{ margin: '0 auto var(--space-4)' }} />
                <p>Loading available shifts...</p>
              </div>
            ) : openShifts.length === 0 ? (
              <div className="card" style={{ padding: 'var(--space-8)', textAlign: 'center', backgroundColor: 'var(--color-neutral-50)' }}>
                <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
                  No additional shifts available right now
                </p>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                {openShifts.map((s) => (
                  <div
                    key={s.id}
                    className="card"
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      backgroundColor: 'var(--color-neutral-50)',
                      borderLeft: `4px solid ${s.urgency === 'high' ? 'var(--color-error)' : s.urgency === 'medium' ? 'var(--color-warning)' : 'var(--color-primary)'}`,
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--font-semibold)', color: 'var(--color-text-primary)', marginBottom: 'var(--space-1)' }}>
                        {new Date(s.shift_date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} · {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)}
                        {s.site_name && <span style={{ color: 'var(--color-text-secondary)' }}> at {s.site_name}</span>}
                      </div>
                      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                        <span style={{ fontWeight: 'var(--font-semibold)', textTransform: 'uppercase', fontSize: 'var(--text-xs)' }}>
                          {s.urgency.toUpperCase()}
                        </span>
                        {' · '}
                        {s.required_staff_count} staff needed
                        {s.notes && ` · ${s.notes}`}
                      </div>
                    </div>
                    <button
                      className="btn btn-primary"
                      disabled={claimingId === s.id || !profile?.id}
                      onClick={() => profile?.id && claim(s.id, profile.id)}
                      style={{ flexShrink: 0, marginLeft: 'var(--space-4)' }}
                    >
                      {claimingId === s.id ? 'Claiming…' : 'Claim Shift'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default OfficerHomePage;
