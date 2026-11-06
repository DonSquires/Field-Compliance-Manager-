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
  MapPin,
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
import { EndShiftDialog, type EndShiftDestination } from '../components/EndShiftDialog';
import type { ActiveShift } from '../hooks/useActiveShift';
import type { UseOfficerSafetyApi } from '../hooks/useOfficerSafety';
import { getDetectionStatusMessage } from '../lib/safetyStatusMessage';
import { claimShiftCoverage } from '../lib/shiftCoverage';
import { serviceTypeLabel } from '../lib/officerServiceLabels';
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

interface AssignedDispatchJob {
  id: string;
  job_type: string;
  priority: string;
  status: string;
  sla_respond_by: string | null;
  site: { name: string; address: string | null } | null;
}

interface AssignedDispatchJobRow extends Omit<AssignedDispatchJob, 'site'> {
  site: AssignedDispatchJob['site'] | AssignedDispatchJob['site'][];
  zone: { name: string } | Array<{ name: string }> | null;
}

type HomeDestination = 'dispatch' | 'patrol' | 'site_guard' | 'freedom_camping' | 'parking' | 'noise_control' | 'biosecurity' | 'smoke_control' | 'map' | 'places' | 'report' | 'modules' | 'schedule' | 'vehicle_lookup' | 'person_search' | 'credentials' | 'leave' | 'timesheet';

interface OfficerHomePageProps {
  shift: ActiveShift | null;
  shiftLoading: boolean;
  shiftError: Error | null;
  safety: UseOfficerSafetyApi;
  onNavigate: (destination: HomeDestination | null) => void;
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

function shiftLaunch(value: string): { destination: HomeDestination; label: string } {
  const normalized = value.toLowerCase();
  if (normalized === 'patrol') return { destination: 'patrol', label: 'Start patrol' };
  if (normalized === 'static' || normalized === 'static_guarding' || normalized === 'site_guard') {
    return { destination: 'site_guard', label: 'Start site guard' };
  }
  if (normalized === 'freedom_camping') return { destination: 'freedom_camping', label: 'Open freedom camping' };
  if (normalized === 'parking' || normalized === 'parking_enforcement') return { destination: 'parking', label: 'Open parking' };
  if (normalized === 'noise_control') return { destination: 'noise_control', label: 'Open noise control' };
  if (normalized === 'biosecurity' || normalized === 'biosecurity_inspection') return { destination: 'biosecurity', label: 'Open biosecurity' };
  if (normalized === 'smoke_control' || normalized === 'smoke_complaint_ooh') return { destination: 'smoke_control', label: 'Open smoke control' };
  return { destination: 'dispatch', label: 'Open dispatch' };
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
    if (!organizationId) {
      setLoading(false);
      return;
    }
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

function useNextDispatchJob(officerId: string | null | undefined) {
  const [job, setJob] = useState<AssignedDispatchJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!officerId) { setJob(null); setLoading(false); return; }
    setLoading(true); setError(null);
    const { data, error: queryError } = await supabase.from('dispatch_jobs')
      .select('id,job_type,priority,status,sla_respond_by,site:client_site_id(name,address),zone:zone_id(name)')
      .eq('assigned_officer_id', officerId)
      .in('status', ['pending', 'dispatched', 'acknowledged', 'en_route', 'on_scene'])
      .order('sla_respond_by', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (queryError) setError(queryError.message);
    else if (!data) setJob(null);
    else {
      const row = data as unknown as AssignedDispatchJobRow;
      const site = Array.isArray(row.site) ? row.site[0] ?? null : row.site;
      const zone = Array.isArray(row.zone) ? row.zone[0] ?? null : row.zone;
      setJob({ ...row, site: site ?? (zone ? { name: zone.name, address: null } : null) });
    }
    setLoading(false);
  }, [officerId]);
  useEffect(() => { void load(); }, [load]);
  return { job, loading, error, reload: load };
}

interface UpcomingShift { id: string; service_type: string; scheduled_start: string; scheduled_end: string; status: string; total_stops: number; }

/** The officer's next rostered shift that has not started — what standby is actually waiting for. */
function useNextRosteredShift(officerId: string | null | undefined, active: boolean) {
  const [next, setNext] = useState<UpcomingShift | null>(null);
  const load = useCallback(async () => {
    if (!officerId || active) { setNext(null); return; }
    // ATLAS READS: shifts
    const { data } = await supabase.from('shifts')
      .select('id,service_type,scheduled_start,scheduled_end,status,total_stops')
      .eq('officer_user_id', officerId)
      .in('status', ['scheduled', 'published', 'accepted'])
      .gte('scheduled_end', new Date().toISOString())
      .order('scheduled_start', { ascending: true })
      .limit(1);
    setNext(((data as UpcomingShift[] | null) ?? [])[0] ?? null);
  }, [active, officerId]);
  useEffect(() => { void load(); }, [load]);
  return next;
}

const describeUpcoming = (shift: UpcomingShift) => {
  const start = new Date(shift.scheduled_start);
  const day = start.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = `${start.toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })} – ${new Date(shift.scheduled_end).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}`;
  return { day, time, isToday: start.toDateString() === new Date().toDateString() };
};

export function OfficerHomePage({ shift, shiftLoading, shiftError, safety, onNavigate, onRefreshShift }: OfficerHomePageProps) {
  const { profile } = useAuth();
  const online = useConnectionState();
  const { openShifts, loading: openShiftsLoading, error: openShiftsError, notice, claimingId, claim, reload } = useOpenShifts(profile?.organizationId);
  const { job: nextDispatchJob, loading: nextDispatchLoading, error: nextDispatchError, reload: reloadNextDispatch } = useNextDispatchJob(profile?.id);
  const nextRostered = useNextRosteredShift(profile?.id, Boolean(shift) || shiftLoading);
  const firstName = profile?.displayName?.split(' ')[0] || 'Officer';
  const activeShiftLaunch = shift ? shiftLaunch(shift.shift_type) : null;
  const started = shift?.status === 'in_progress';
  const [endingShift, setEndingShift] = useState(false);
  const [endedNotice, setEndedNotice] = useState<string | null>(null);
  const endShiftDestination = (destination: EndShiftDestination) => {
    setEndingShift(false);
    if (destination === 'stops') onNavigate(activeShiftLaunch?.destination ?? 'patrol');
    else if (destination === 'debrief') onNavigate('schedule');
    else if (destination === 'home') onNavigate(null);
    else onNavigate(destination);
  };

  const shiftProgress = useMemo(() => {
    const total = shift?.stops.length ?? 0;
    const completed = shift?.stops.filter((stop) => Boolean(stop.departure_time)).length ?? 0;
    return { total, completed, percent: total ? Math.round((completed / total) * 100) : 0 };
  }, [shift]);

  const sentence = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  const shiftSiteNames = [...new Set((shift?.stops ?? []).map((stop) => stop.site_name).filter((name): name is string => Boolean(name)))];
  const safetyLabel = safety.activeAlert
    ? safety.activeAlert.kind === 'sos' ? 'SOS active' : sentence(`${safety.activeAlert.kind.replaceAll('_', ' ')} alert`)
    : safety.status === 'ok' ? `Check-in in ${safety.minutesRemaining} min` : sentence(safety.status.replaceAll('_', ' '));

  return (
    <div className="officer-home">
      <header className="officer-home-heading">
        <div>
          <span className="officer-kicker">Field operations</span>
          <h1>{started ? `On shift, ${firstName}` : shift ? `Shift today, ${firstName}` : `Ready when needed, ${firstName}`}</h1>
          <p>{started ? 'Your assignment, safety state, and next actions.' : shift ? `Your shift starts at ${formatShiftTime(shift.start_time)}. Start it from your schedule when you arrive.` : 'No active shift. Safety controls and open coverage remain available.'}</p>
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

      {nextDispatchError ? <div className="officer-notice is-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><span>Your assigned jobs could not be checked: {nextDispatchError}</span><button type="button" onClick={() => void reloadNextDispatch()} disabled={nextDispatchLoading}>Try again</button></div> : nextDispatchJob ? <section className={`officer-next-job priority-${nextDispatchJob.priority}`} aria-labelledby="next-job-heading"><div><span className="officer-kicker">Your next job</span><h2 id="next-job-heading">{nextDispatchJob.job_type.replaceAll('_', ' ')}</h2><p>{nextDispatchJob.site?.name ?? 'Site details to be confirmed'}{nextDispatchJob.site?.address ? ` · ${nextDispatchJob.site.address}` : ''}</p><small>{nextDispatchJob.status.replaceAll('_', ' ')}{nextDispatchJob.sla_respond_by ? ` · respond by ${new Date(nextDispatchJob.sla_respond_by).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}` : ''}</small></div><button type="button" className="officer-primary-action" onClick={() => onNavigate('dispatch')}><Radio size={18} aria-hidden="true" /> Open and acknowledge job <ArrowRight size={17} aria-hidden="true" /></button></section> : null}
      {endedNotice && <div className="officer-notice is-success" role="status"><CheckCircle2 size={18} aria-hidden="true" /><span>{endedNotice}</span><button type="button" onClick={() => onNavigate('timesheet')}>Open timesheet</button></div>}
      {endingShift && shift && <EndShiftDialog shiftId={shift.id} shiftStatus={shift.status} serviceType={shift.shift_type} onClose={() => setEndingShift(false)} onNavigate={endShiftDestination} onEnded={async ({ completed_at }) => { setEndingShift(false); setEndedNotice(`Shift ended at ${new Date(completed_at).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}. You are off duty. Record your worked time when you are ready.`); await onRefreshShift(); }} />}

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
              {shiftSiteNames.length > 0 && <div className="officer-shift-time">
                <MapPin size={20} aria-hidden="true" />
                <strong>{shiftSiteNames.join(' · ')}</strong>
              </div>}
              {shiftProgress.total > 1 && <>
                <div className="officer-progress-row">
                  <div><span>Route progress</span><strong>{shiftProgress.completed} of {shiftProgress.total} stops</strong></div>
                  <span>{shiftProgress.percent}%</span>
                </div>
                <div className="officer-progress-track"><span style={{ width: `${shiftProgress.percent}%` }} /></div>
              </>}
              {started ? (
                <button type="button" className="officer-primary-action" onClick={() => activeShiftLaunch && onNavigate(activeShiftLaunch.destination)}>
                  <Navigation size={18} aria-hidden="true" /> {activeShiftLaunch?.label ?? 'Open assignment'} <ArrowRight size={17} aria-hidden="true" />
                </button>
              ) : (
                <button type="button" className="officer-primary-action" onClick={() => onNavigate('schedule')}>
                  <CalendarDays size={18} aria-hidden="true" /> Open schedule to start <ArrowRight size={17} aria-hidden="true" />
                </button>
              )}
              {shift.status === 'in_progress' && <button type="button" className="officer-end-shift" onClick={() => setEndingShift(true)}>End shift</button>}
            </>
          ) : nextRostered ? (
            <div className="officer-standby-copy is-next-shift">
              <CalendarDays size={26} aria-hidden="true" />
              <div>
                <strong>{nextRostered.status === 'published' ? 'A shift is waiting for your answer' : `Your next shift is ${describeUpcoming(nextRostered).isToday ? 'today' : describeUpcoming(nextRostered).day}`}</strong>
                <span>{describeUpcoming(nextRostered).day} · {describeUpcoming(nextRostered).time} · {serviceTypeLabel(nextRostered.service_type).label}{nextRostered.total_stops ? ` · ${nextRostered.total_stops} planned ${nextRostered.total_stops === 1 ? 'stop' : 'stops'}` : ''}</span>
                <span>{nextRostered.status === 'published' ? 'Accept or decline it on your schedule.' : describeUpcoming(nextRostered).isToday ? 'Start it from your schedule when you are on site.' : 'Nothing to do until then. It will appear here on the day.'}</span>
              </div>
              <button type="button" onClick={() => onNavigate('schedule')}>{nextRostered.status === 'published' ? 'Answer now' : 'Open schedule'}</button>
            </div>
          ) : (
            <div className="officer-standby-copy">
              <CalendarDays size={26} aria-hidden="true" />
              <div><strong>No shift rostered</strong><span>You have nothing scheduled. Open shifts you can pick up appear below and on your schedule; contact your supervisor if this looks wrong.</span></div>
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

      {!profile?.organizationId ? <div className="officer-notice is-error" role="status"><AlertTriangle size={18} aria-hidden="true" /> Coverage is unavailable until organisation access is confirmed.</div> : openShiftsError && <div className="officer-notice is-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><span>Open shifts could not be checked: {openShiftsError}</span><button type="button" className="btn-secondary" onClick={() => void reload()} disabled={openShiftsLoading}>Try again</button></div>}

      <details className="officer-home-more">
      <summary>More tools, open shifts and status</summary>
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
            <QuickAction icon={<BadgeCheck />} label="My credentials" detail="Current licences and evidence" onClick={() => onNavigate('credentials')} />
            <QuickAction icon={<CalendarDays />} label="Request leave" detail="Submit a leave request" onClick={() => onNavigate('leave')} />
            <QuickAction icon={<Clock3 />} label="Submit timesheet" detail="Record time for approval" onClick={() => onNavigate('timesheet')} />
          </>}
          <QuickAction icon={<Car />} label="Vehicle lookup" detail="Registry and compliance history" onClick={() => onNavigate('vehicle_lookup')} />
          <QuickAction icon={<Map />} label="Places" detail="Add or verify with GPS" onClick={() => onNavigate('places')} />
          <QuickAction icon={<Users />} label="Person search" detail="Authorized notice and permit checks" onClick={() => onNavigate('person_search')} />
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
                <div className="officer-open-detail"><strong>{openShift.site_name ?? 'Location to be confirmed'}</strong><span>{openShift.required_staff_count} officer{openShift.required_staff_count === 1 ? '' : 's'} needed · {openShift.start_time.slice(0, 5)}-{openShift.end_time.slice(0, 5)}{openShift.notes ? ` · ${openShift.notes}` : ''}</span></div>
                <span className="officer-urgency">{openShift.urgency}</span>
                <button type="button" disabled={claimingId === openShift.id || !profile?.id} onClick={() => profile?.id && void claim(openShift.id)}>{claimingId === openShift.id ? 'Claiming' : 'Claim shift'}</button>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="officer-brief" aria-labelledby="officer-brief-heading">
        <div className="officer-brief-heading">
          <div><span className="officer-kicker">At a glance</span><h2 id="officer-brief-heading">Operational brief</h2></div>
          <span className="officer-brief-time">Live field state</span>
        </div>
        <div className="officer-brief-grid">
          <BriefSignal label="Assignment" value={shift ? serviceTypeLabel(shift.shift_type).label : nextRostered ? `Next: ${describeUpcoming(nextRostered).day}` : 'Standby'} detail={shift ? shift.status.replace('_', ' ') : nextRostered ? (nextRostered.status === 'published' ? 'Waiting for you to accept' : `${describeUpcoming(nextRostered).time} · ${serviceTypeLabel(nextRostered.service_type).label}`) : 'Nothing rostered yet'} tone={shift ? 'active' : 'quiet'} />
          <BriefSignal label="Route" value={shift ? `${shiftProgress.completed}/${shiftProgress.total} stops` : 'No route'} detail={shift ? `${shiftProgress.percent}% complete` : 'Open your schedule'} tone={shift ? 'active' : 'quiet'} />
          <BriefSignal label="Safety" value={safetyLabel} detail={safety.activeAlert ? 'Action required' : 'Check-in state confirmed'} tone={safety.activeAlert ? 'alert' : 'active'} />
          <BriefSignal label="Evidence" value={online ? 'Connected' : 'Queued locally'} detail={online ? 'Ready to submit evidence' : 'Will sync when online'} tone={online ? 'active' : 'warning'} />
        </div>
      </section>
      </details>
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

function BriefSignal({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'active' | 'quiet' | 'warning' | 'alert' }) {
  return (
    <div className={`officer-brief-signal tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}