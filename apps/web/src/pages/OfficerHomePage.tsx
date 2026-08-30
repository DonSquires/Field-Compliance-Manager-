import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
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

type HomeDestination = 'dispatch' | 'patrol' | 'map' | 'report' | 'modules' | 'schedule';

interface OfficerHomePageProps {
  shift: ActiveShift | null;
  shiftLoading: boolean;
  shiftError: Error | null;
  safety: UseOfficerSafetyApi;
  onNavigate: (destination: HomeDestination) => void;
}

function localDateIso(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatShiftTime(value: string): string {
  return new Date(value).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' });
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

  const claim = useCallback(async (requestId: string, officerId: string) => {
    try {
      setClaimingId(requestId);
      setError(null);
      setNotice(null);
      const { data, error: updateError } = await supabase
        .from('shift_coverage_requests')
        .update({ status: 'claimed', claimed_by: officerId, claimed_at: new Date().toISOString() })
        .eq('id', requestId)
        .eq('status', 'open')
        .select('id');

      if (updateError) throw updateError;
      if (!data?.length) {
        setError('This shift was already claimed by another officer.');
        setOpenShifts((current) => current.filter((shift) => shift.id !== requestId));
        return;
      }
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

export function OfficerHomePage({ shift, shiftLoading, shiftError, safety, onNavigate }: OfficerHomePageProps) {
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
        </div>
      )}

      <div className="officer-home-grid">
        <section className={`officer-shift-panel ${shift ? 'has-shift' : 'is-standby'}`}>
          <div className="officer-panel-heading">
            <div>
              <span className="officer-kicker">Current assignment</span>
              <h2>{shiftLoading ? 'Checking roster' : shift ? shift.shift_type.replace('_', ' ') : 'Standby'}</h2>
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
              <button type="button" className="officer-primary-action" onClick={() => onNavigate(shift.shift_type === 'patrol' ? 'patrol' : 'dispatch')}>
                <Navigation size={18} aria-hidden="true" /> Open assignment <ArrowRight size={17} aria-hidden="true" />
              </button>
            </>
          ) : (
            <div className="officer-standby-copy">
              <CalendarDays size={26} aria-hidden="true" />
              <div><strong>No accepted or active shift today</strong><span>Review your schedule or claim available coverage below.</span></div>
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
        </div>
        <div className="officer-action-grid">
          <QuickAction icon={<Route />} label="Patrol" detail="Route and checkpoints" onClick={() => onNavigate('patrol')} />
          <QuickAction icon={<Radio />} label="Dispatch" detail="Assigned jobs" onClick={() => onNavigate('dispatch')} />
          <QuickAction icon={<Map />} label="Live map" detail="Sites and zones" onClick={() => onNavigate('map')} />
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
                <button type="button" disabled={claimingId === openShift.id || !profile?.id} onClick={() => profile?.id && void claim(openShift.id, profile.id)}>{claimingId === openShift.id ? 'Claiming' : 'Claim shift'}</button>
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