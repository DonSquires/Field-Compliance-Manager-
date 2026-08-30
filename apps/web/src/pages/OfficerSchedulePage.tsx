import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, Clock3, MapPin, RefreshCw, ShieldCheck, Users, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { claimShiftCoverage } from '../lib/shiftCoverage';
import { supabase } from '../lib/supabase';
import './OfficerSchedulePage.css';

interface AssignedShift {
  id: string;
  service_type: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  notes: string | null;
  shift_health: string | null;
  total_stops: number;
}

interface CoverageRequest {
  id: string;
  shift_date: string;
  start_time: string;
  end_time: string;
  required_staff_count: number;
  urgency: string;
  notes: string | null;
  site: { name: string } | null;
}

type ScheduleView = 'assigned' | 'coverage';

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' });
}

function localDateIso(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

const OfficerSchedulePage: React.FC = () => {
  const { profile } = useAuth();
  const [view, setView] = useState<ScheduleView>('assigned');
  const [assigned, setAssigned] = useState<AssignedShift[]>([]);
  const [coverage, setCoverage] = useState<CoverageRequest[]>([]);
  const [selectedCoverage, setSelectedCoverage] = useState<CoverageRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSchedule = useCallback(async () => {
    if (!profile?.id || !profile.organizationId) return;
    setLoading(true);
    setError(null);
    const [shiftResponse, coverageResponse] = await Promise.all([
      supabase.from('shifts').select('id, service_type, scheduled_start, scheduled_end, status, notes, shift_health, total_stops').eq('organization_id', profile.organizationId).eq('officer_user_id', profile.id).gte('scheduled_end', new Date().toISOString()).neq('status', 'cancelled').order('scheduled_start', { ascending: true }).limit(40),
      supabase.from('shift_coverage_requests').select('id, shift_date, start_time, end_time, required_staff_count, urgency, notes, site:site_id(name)').eq('organization_id', profile.organizationId).eq('status', 'open').gte('shift_date', localDateIso()).order('shift_date', { ascending: true }).order('start_time', { ascending: true }),
    ]);
    setAssigned((shiftResponse.data as AssignedShift[]) ?? []);
    setCoverage(((coverageResponse.data as Array<Omit<CoverageRequest, 'site'> & { site: { name: string } | Array<{ name: string }> | null }>) ?? []).map((request) => ({
      ...request,
      site: Array.isArray(request.site) ? request.site[0] ?? null : request.site,
    })));
    const failures = [shiftResponse.error && `Assigned shifts: ${shiftResponse.error.message}`, coverageResponse.error && `Open coverage: ${coverageResponse.error.message}`].filter(Boolean);
    if (failures.length) setError(failures.join(' · '));
    setLoading(false);
  }, [profile?.id, profile?.organizationId]);

  useEffect(() => { void loadSchedule(); }, [loadSchedule]);

  const nextShift = useMemo(() => assigned.find((shift) => ['scheduled', 'published', 'accepted'].includes(shift.status)) ?? null, [assigned]);

  const confirmClaim = async () => {
    if (!selectedCoverage) return;
    setClaiming(true);
    setError(null);
    setNotice(null);
    try {
      await claimShiftCoverage(selectedCoverage.id);
      setNotice('Coverage claim confirmed. A roster administrator can now finalize the assignment.');
      setSelectedCoverage(null);
      await loadSchedule();
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : 'The coverage claim was not confirmed.');
    } finally {
      setClaiming(false);
    }
  };

  return (
    <div className="officer-schedule">
      <header className="officer-schedule-header"><div><span>Roster</span><h1>My schedule</h1><p>Confirmed assignments and open coverage available to claim.</p></div><button type="button" onClick={() => void loadSchedule()} disabled={loading} title="Refresh schedule"><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /><span>Refresh</span></button></header>
      {error && <div className="officer-schedule-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)} title="Dismiss"><X size={16} /></button></div>}
      {notice && <div className="officer-schedule-message is-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)} title="Dismiss"><X size={16} /></button></div>}

      <section className="officer-schedule-next"><div><span>Next confirmed assignment</span><strong>{nextShift ? formatDate(nextShift.scheduled_start) : 'No confirmed shift'}</strong><small>{nextShift ? `${formatTime(nextShift.scheduled_start)} - ${formatTime(nextShift.scheduled_end)} · ${nextShift.service_type.replaceAll('_', ' ')}` : 'Open coverage remains available below.'}</small></div><CalendarDays size={24} /></section>

      <div className="officer-schedule-tabs" role="tablist" aria-label="Schedule views"><button type="button" role="tab" aria-selected={view === 'assigned'} className={view === 'assigned' ? 'is-active' : ''} onClick={() => setView('assigned')}>Assigned <span>{assigned.length}</span></button><button type="button" role="tab" aria-selected={view === 'coverage'} className={view === 'coverage' ? 'is-active' : ''} onClick={() => setView('coverage')}>Open coverage <span>{coverage.length}</span></button></div>

      {loading ? <div className="officer-schedule-empty"><RefreshCw size={20} className="is-spinning" />Checking roster</div> : view === 'assigned' ? (
        assigned.length === 0 ? <div className="officer-schedule-empty"><CalendarDays size={23} />No upcoming assigned shifts</div> : <div className="officer-schedule-list">{assigned.map((shift) => <article className="officer-assigned-shift" key={shift.id}><div className="officer-schedule-date"><strong>{formatDate(shift.scheduled_start)}</strong><span>{formatTime(shift.scheduled_start)} - {formatTime(shift.scheduled_end)}</span></div><div><strong>{shift.service_type.replaceAll('_', ' ')}</strong><small>{shift.total_stops} planned stops{shift.notes ? ` · ${shift.notes}` : ''}</small></div><span className={`status-${shift.status}`}>{shift.status.replaceAll('_', ' ')}</span></article>)}</div>
      ) : coverage.length === 0 ? <div className="officer-schedule-empty"><ShieldCheck size={23} />No open coverage right now</div> : <div className="officer-schedule-list">{coverage.map((request) => <article className={`officer-coverage urgency-${request.urgency}`} key={request.id}><div className="officer-schedule-date"><strong>{formatDate(`${request.shift_date}T00:00:00`)}</strong><span>{request.start_time.slice(0, 5)} - {request.end_time.slice(0, 5)}</span></div><div><strong>{request.site?.name ?? 'Location to be confirmed'}</strong><small><Users size={13} /> {request.required_staff_count} needed{request.notes ? ` · ${request.notes}` : ''}</small></div><span>{request.urgency}</span><button type="button" onClick={() => setSelectedCoverage(request)}>Review claim</button></article>)}</div>}

      {selectedCoverage && <div className="officer-schedule-dialog-backdrop"><div className="officer-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="coverage-claim-title"><header><div><span>Coverage commitment</span><h2 id="coverage-claim-title">Claim this shift?</h2></div><button type="button" onClick={() => setSelectedCoverage(null)} title="Close"><X size={18} /></button></header><dl><div><dt>Date</dt><dd>{formatDate(`${selectedCoverage.shift_date}T00:00:00`)}</dd></div><div><dt>Time</dt><dd>{selectedCoverage.start_time.slice(0, 5)} - {selectedCoverage.end_time.slice(0, 5)}</dd></div><div><dt>Location</dt><dd><MapPin size={14} />{selectedCoverage.site?.name ?? 'To be confirmed'}</dd></div><div><dt>Urgency</dt><dd>{selectedCoverage.urgency}</dd></div></dl>{selectedCoverage.notes && <p>{selectedCoverage.notes}</p>}<div className="officer-schedule-dialog-actions"><button type="button" onClick={() => setSelectedCoverage(null)}>Cancel</button><button type="button" onClick={() => void confirmClaim()} disabled={claiming}>{claiming ? <><RefreshCw size={16} className="is-spinning" />Confirming</> : <><CheckCircle2 size={16} />Confirm claim</>}</button></div></div></div>}
    </div>
  );
};

export default OfficerSchedulePage;