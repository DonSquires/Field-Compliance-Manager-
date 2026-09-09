import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Car,
  CheckCircle2,
  ClipboardPlus,
  Clock3,
  Map,
  Navigation,
  Radio,
  RefreshCw,
  Route,
  ShieldCheck,
  Signal,
  SignalZero,
  Siren,
  Users,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { ActiveShift } from '../hooks/useActiveShift';
import type { UseOfficerSafetyApi } from '../hooks/useOfficerSafety';
import { getDetectionStatusMessage } from '../lib/safetyStatusMessage';
import { claimShiftCoverage } from '../lib/shiftCoverage';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface OpenShift {
  id: string;
  shift_date: string;
  start_time: string;
  end_time: string;
  required_staff_count: number;
  urgency: 'low' | 'normal' | 'high' | 'urgent';
  notes: string | null;
  site_name: string | null;
}

type HomeDestination = 'dispatch' | 'patrol' | 'site_guard' | 'map' | 'report' | 'modules' | 'schedule' | 'vehicle_lookup' | 'credentials' | 'leave' | 'timesheet';

interface OfficerHomePageProps {
  shift: ActiveShift | null;
  shiftLoading: boolean;
  shiftError: Error | null;
  safety: UseOfficerSafetyApi;
  onNavigate: (destination: HomeDestination) => void;
  onRefreshShift: () => Promise<void>;
}

function localDateIso(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatShiftTime(value: string): string {
  return new Date(value).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' });
}

function serviceTypeLabel(value: string): { label: string; detail: string } {
  const labels: Record<string, { label: string; detail: string }> = {
    freedom_camping: { label: 'Freedom Camping Patrol', detail: 'Vehicle scans, breaches, and evidence' },
    static_guarding: { label: 'Site Guarding', detail: 'Site security and checkpoints' },
    parking: { label: 'Parking Enforcement', detail: 'Vehicle compliance and enforcement' },
    noise_control: { label: 'Noise Control', detail: 'Assessment and response' },
    biosecurity_inspection: { label: 'Biosecurity Inspection', detail: 'Inspection evidence and notices' },
    smoke_complaint_ooh: { label: 'Smoke Complaint', detail: 'Out-of-hours complaint response' },
  };
  return labels[value] ?? { label: value.replaceAll('_', ' '), detail: 'Field assignment and evidence' };
}

function useConnectionState() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener('online', markOnline);
    window.addEventListener('offline', markOffline);
    return () => {
      window.removeEventListener('online', markOnline);
      window.removeEventListener('offline', markOffline);
    };
  }, []);
  return online;
}

function useOpenShifts(organizationId: string | null | undefined) {
  const [openShifts, setOpenShifts] = useState<OpenShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!organizationId) return;
    try {
      setLoading(true);
      setError(null);
      const { data, error: queryError } = await supabase
        .from('shift_coverage_requests')
        .select('id, shift_date, start_time, end_time, required_staff_count, urgency, notes, site:site_id(name)')
        .eq('organization_id', organizationId)
        .eq('status', 'open')
        .gte('shift_date', localDateIso())
        .order('urgency', { ascending: false })
        .order('shift_date', { ascending: true });

      if (queryError) throw queryError;
      setOpenShifts(
        ((data as any[]) ?? []).map((row) => ({
          id: row.id,
          shift_date: row.shift_date,
          start_time: row.start_time,
          end_time: row.end_time,
          required_staff_count: row.required_staff_count,
          urgency: row.urgency,
          notes: row.notes,
          site_name: row.site?.name ?? null,
        })),
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Open shifts could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const claim = useCallback(async (requestId: string) => {
    try {
      setClaimingId(requestId);
      setError(null);
      setNotice(null);
      await claimShiftCoverage(requestId);
      setOpenShifts((current) => current.filter((shift) => shift.id !== requestId));
      setNotice('Shift claimed. Your roster will update when the assignment is confirmed.');
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : 'The shift could not be claimed.');
    } finally {
      setClaimingId(null);
    }
  }, []);

  return { openShifts, loading, error, notice, claimingId, claim, reload: load };
}

export function OfficerHomePage({ shift, shiftLoading, shiftError, safety, onNavigate, onRefreshShift }: OfficerHomePageProps) {
  const { profile } = useAuth();
  const online = useConnectionState();
  const { openShifts, loading: openShiftsLoading, error: openShiftsError, notice, claimingId, claim, reload } = useOpenShifts(profile?.organizationId);
  const firstName = profile?.displayName?.split(' ')[0] || 'Officer';

  const shiftProgress = useMemo(() => {
    const total = shift?.stops.length ?? 0;
    const completed = shift?.stops.filter((stop) => Boolean(stop.departure_time)).length ?? 0;
    return { total, completed, percent: total ? Math.round((completed / total) * 100) : 0 };
  }, [shift]);

  const safetyLabel = safety.activeAlert
    ? safety.activeAlert.kind === 'sos' ? 'SOS active' : `${safety.activeAlert.kind.replace('_', ' ')} alert`
    : safety.status === 'ok' ? `Check-in in ${safety.minutesRemaining} min` : safety.status.replace('_', ' ');

  return (
    <div className="officer-home">
      <header className="officer-home-heading">
        <div>
          <span className="officer-kicker">Field operations</span>
          <h1>{shift ? `On shift, ${firstName}` : `Ready when needed, ${firstName}`}</h1>
          <p>{shift ? 'Your assignment, safety state, and next actions.' : 'No active shift. Safety controls and open coverage remain available.'}</p>
        </div>
        <div className={`officer-connectivity ${online ? 'is-online' : 'is-offline'}`}>
          {online ? <Signal size={16} aria-hidden="true" /> : <SignalZero size={16} aria-hidden="true" />}
          {online ? 'Online' : 'Offline'}
        </div>
      </header>

      {shiftError && (
        <div className="officer-notice is-error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>Shift status could not be verified: {shiftError.message}</span>
          <button type="button" onClick={() => void onRefreshShift()} disabled={shiftLoading}>Try again</button>
        </div>
      )}

      <div className="officer-home-grid">
        <section className={`officer-shift-panel ${shift ? 'has-shift' : 'is-standby'}`}>
          <div className="officer-panel-heading">
            <div>
              <span className="officer-kicker">Current assignment</span>
              <h2>{shiftLoading ? 'Checking roster' : shift ? serviceTypeLabel(shift.shift_type).label : 'Standby'}</h2>
              {shift && <p className="officer-shift-service-detail">{serviceTypeLabel(shift.shift_type).detail}</p>}
            </div>
            <span className={`officer-shift-state state-${shift?.status ?? 'standby'}`}>
              {shiftLoading ? 'Loading' : shift?.status.replace('_', ' ') ?? 'No active shift'}
            </span>
          </div>

          {shift ? (
            <>
              <div className="officer-shift-time">
                <Clock3 size={20} aria-hidden="true" />
                <strong>{formatShiftTime(shift.start_time)} - {formatShiftTime(shift.end_time)}</strong>
              </div>
              <div className="officer-progress-row">
                <div><span>Route progress</span><strong>{shiftProgress.completed} of {shiftProgress.total} stops</strong></div>
                <span>{shiftProgress.percent}%</span>
              </div>
              <div className="officer-progress-track"><span style={{ width: `${shiftProgress.percent}%` }} /></div>
              <button type="button" className="officer-primary-action" onClick={() => onNavigate(shift.shift_type === 'patrol' ? 'patrol' : shift.shift_type === 'static_guarding' ? 'site_guard' : 'dispatch')}>
                <Navigation size={18} aria-hidden="true" /> {shift.shift_type === 'patrol' ? 'Start patrol' : shift.shift_type === 'static_guarding' ? 'Start site guard' : 'Open dispatch'} <ArrowRight size={17} aria-hidden="true" />
              </button>
            </>
          ) : (
            <div className="officer-standby-copy">
              <CalendarDays size={26} aria-hidden="true" />
              <div><strong>No shift assigned</strong><span>You are not currently rostered for a shift. Contact your supervisor if this is incorrect.</span></div>
              <button type="button" onClick={() => onNavigate('schedule')}>View schedule</button>
            </div>
          )}
        </section>

        <section className={`officer-safety-panel safety-${safety.status}`}>
          <div className="officer-panel-heading">
            <div>
              <span className="officer-kicker">Personal safety</span>
              <h2>{safetyLabel}</h2>
            </div>
            {safety.activeAlert ? <Siren size={25} aria-hidden="true" /> : <ShieldCheck size={25} aria-hidden="true" />}
          </div>
          <p>{getDetectionStatusMessage(safety.detectionState)}</p>
          {safety.lastError && <div className="officer-safety-error" role="alert">Not confirmed: {safety.lastError}</div>}
          <button type="button" className="officer-checkin" onClick={() => void safety.checkIn()} disabled={safety.writeStatus === 'pending'}>
            {safety.writeStatus === 'pending' ? <RefreshCw size={18} className="is-spinning" aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}
            {safety.activeAlert ? 'Check in and clear alert' : 'Check in now'}
          </button>
        </section>
      </div>

      <section className="officer-quick-actions" aria-labelledby="quick-actions-heading">
        <div className="officer-section-heading">
          <div><span className="officer-kicker">Work tools</span><h2 id="quick-actions-heading">Quick actions</h2></div>
          {!shift && <button type="button" className="fc-icon-button" onClick={() => void onRefreshShift()} disabled={shiftLoading} title="Refresh shift status"><RefreshCw size={17} className={shiftLoading ? 'is-spinning' : ''} aria-hidden="true" /><span className="sr-only">Refresh shift status</span></button>}
        </div>
        <div className="officer-action-grid">
          {shift ? <>
            <QuickAction icon={<Route />} label="Patrol" detail="Route and checkpoints" onClick={() => onNavigate('patrol')} />
            <QuickAction icon={<Radio />} label="Dispatch" detail="Assigned jobs" onClick={() => onNavigate('dispatch')} />
            <QuickAction icon={<Map />} label="Live map" detail="Sites and zones" onClick={() => onNavigate('map')} />
          </> : <>
            <QuickAction icon={<CalendarDays />} label="My schedule" detail="Assignments and offers" onClick={() => onNavigate('schedule')} />
            <QuickAction icon={<Car />} label="Vehicle lookup" detail="Registry and compliance history" onClick={() => onNavigate('vehicle_lookup')} />
            <QuickAction icon={<BadgeCheck />} label="My credentials" detail="Current licences and evidence" onClick={() => onNavigate('credentials')} />
            <QuickAction icon={<CalendarDays />} label="Request leave" detail="Submit a leave request" onClick={() => onNavigate('leave')} />
            <QuickAction icon={<Clock3 />} label="Submit timesheet" detail="Record time for approval" onClick={() => onNavigate('timesheet')} />
          </>}
          <QuickAction icon={<ClipboardPlus />} label="Field report" detail="Record an incident" onClick={() => onNavigate('report')} />
        </div>
        <button type="button" className="officer-all-modules" onClick={() => onNavigate('modules')}>All enabled modules <ArrowRight size={16} aria-hidden="true" /></button>
      </section>

      <section className="officer-open-shifts" aria-labelledby="open-shifts-heading">
        <div className="officer-section-heading">
          <div><span className="officer-kicker">Coverage</span><h2 id="open-shifts-heading">Open shifts</h2></div>
          <button type="button" className="fc-icon-button" onClick={() => void reload()} disabled={openShiftsLoading} title="Refresh open shifts">
            <RefreshCw size={17} className={openShiftsLoading ? 'is-spinning' : ''} aria-hidden="true" />
            <span className="sr-only">Refresh open shifts</span>
          </button>
        </div>

        {openShiftsError && <div className="officer-notice is-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /> {openShiftsError}</div>}
        {notice && <div className="officer-notice is-success" role="status"><CheckCircle2 size={18} aria-hidden="true" /> {notice}</div>}
        {openShiftsLoading ? (
          <div className="officer-shift-empty"><RefreshCw size={20} className="is-spinning" aria-hidden="true" /> Checking coverage</div>
        ) : openShifts.length === 0 ? (
          <div className="officer-shift-empty"><Users size={20} aria-hidden="true" /> No open coverage right now</div>
        ) : (
          <div className="officer-open-shift-list">
            {openShifts.map((openShift) => (
              <article className={`officer-open-shift urgency-${openShift.urgency}`} key={openShift.id}>
                <div className="officer-open-date"><strong>{new Date(`${openShift.shift_date}T00:00:00`).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric' })}</strong><span>{openShift.start_time.slice(0, 5)} - {openShift.end_time.slice(0, 5)}</span></div>
                <div className="officer-open-detail"><strong>{openShift.site_name ?? 'Location to be confirmed'}</strong><span>{openShift.required_staff_count} officer{openShift.required_staff_count === 1 ? '' : 's'} needed{openShift.notes ? ` · ${openShift.notes}` : ''}</span></div>
                <span className="officer-urgency">{openShift.urgency}</span>
                <button type="button" disabled={claimingId === openShift.id || !profile?.id} onClick={() => profile?.id && void claim(openShift.id)}>{claimingId === openShift.id ? 'Claiming' : 'Claim shift'}</button>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function QuickAction({ icon, label, detail, onClick }: { icon: React.ReactNode; label: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" className="officer-quick-action" onClick={onClick}>
      <span>{icon}</span>
      <div><strong>{label}</strong><small>{detail}</small></div>
      <ArrowRight size={16} aria-hidden="true" />
    </button>
  );
}