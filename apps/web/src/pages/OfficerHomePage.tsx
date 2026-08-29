import React, { useMemo, useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useActiveShift } from '../hooks/useActiveShift';
import { useOfficerSafety } from '../hooks/useOfficerSafety';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { supabase } from '../lib/supabase';
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
      shift.status === 'started' ? '🔴 Active' : shift.status === 'scheduled' ? '⏳ Upcoming' : '✅ Completed';
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
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ margin: '0 0 8px 0', fontSize: 28, fontWeight: 700 }}>Officer Operations</h1>
        <p style={{ margin: 0, color: '#94a3b8', fontSize: 14 }}>
          Check your shift, safety status, and assigned work.
        </p>
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <Card
          title="Shift"
          value={shiftDisplay.status}
          details={shiftDisplay.details}
          color="#7db7e8"
        />
        <Card
          title="Safety"
          value={safetyDisplay.status}
          details={safety.detectionState === 'active' ? `${safety.status} state` : ''}
          color={safetyDisplay.color}
        />
        <Card title="Dispatch" value={dispatchDisplay.count} details={dispatchDisplay.details} color="#72d6a2" />
        <Card
          title="Status"
          value={profile?.email ? '✅ Online' : '⚠️ Offline'}
          details={profile?.displayName ?? 'Officer'}
          color="#E8A060"
        />
      </div>

      {safety.writeStatus === 'error' && safety.lastError && (
        <div style={{ marginTop: 24, padding: 12, background: '#3A0000', border: '1px solid #EF5350', borderRadius: 8 }}>
          <p style={{ margin: 0, color: '#EF5350', fontSize: 12 }}>Error: {safety.lastError}</p>
        </div>
      )}

      <div style={{ marginTop: 32 }}>
        <h2 style={{ margin: '0 0 4px 0', fontSize: 16, fontWeight: 700 }}>Open Shifts</h2>
        <p style={{ margin: '0 0 12px 0', color: '#94a3b8', fontSize: 13 }}>Coverage requests you can claim.</p>

        {openShiftsError && (
          <div style={{ padding: 10, background: '#3A0000', border: '1px solid #EF5350', borderRadius: 8, marginBottom: 12 }}>
            <p style={{ margin: 0, color: '#EF5350', fontSize: 12 }}>{openShiftsError}</p>
          </div>
        )}

        {openShiftsLoading ? (
          <p style={{ color: '#94a3b8', fontSize: 13 }}>Loading open shifts…</p>
        ) : openShifts.length === 0 ? (
          <p style={{ color: '#94a3b8', fontSize: 13 }}>No open shifts need coverage right now.</p>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {openShifts.map((s) => (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: 8,
                  padding: '10px 14px',
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>
                    {new Date(s.shift_date).toLocaleDateString()} · {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)}
                    {s.site_name ? ` · ${s.site_name}` : ''}
                  </div>
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>
                    {s.urgency.toUpperCase()} priority · {s.required_staff_count} staff needed
                    {s.notes ? ` · ${s.notes}` : ''}
                  </div>
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={claimingId === s.id || !profile?.id}
                  onClick={() => profile?.id && claim(s.id, profile.id)}
                >
                  {claimingId === s.id ? 'Claiming…' : 'Claim'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Card({
  title,
  value,
  details,
  color,
}: {
  title: string;
  value: string;
  details?: string;
  color?: string;
}) {
  return (
    <div
      style={{
        background: '#0f172a',
        border: `1px solid ${color || '#334155'}`,
        borderRadius: 12,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ color: '#94a3b8', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
        {title}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#e2e8f0' }}>{value}</div>
      {details && <div style={{ fontSize: 12, color: '#78879a' }}>{details}</div>}
    </div>
  );
}
