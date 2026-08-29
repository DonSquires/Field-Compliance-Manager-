import React, { useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useActiveShift } from '../hooks/useActiveShift';
import { useOfficerSafety } from '../hooks/useOfficerSafety';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { supabase } from '../lib/supabase';

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
