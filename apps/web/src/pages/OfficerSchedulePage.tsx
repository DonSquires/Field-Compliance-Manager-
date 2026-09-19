import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, Clock3, MapPin, RefreshCw, ShieldCheck, Users, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { claimShiftCoverage } from '../lib/shiftCoverage';
import { describeLoadFailures } from '../lib/friendlyLoadError';
import { supabase } from '../lib/supabase';
import './OfficerSchedulePage.css';
import './OfficerScheduleActions.css';

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
interface StartPosition { status: 'on_site' | 'near_site' | 'off_site' | 'no_gps' | 'no_place'; place_name?: string | null; distance_m?: number | null; advisory_radius_m?: number; route_shift?: boolean; }
const describeDistance = (metres: number | null | undefined) => metres == null ? 'an unknown distance' : metres >= 1000 ? `about ${(metres / 1000).toFixed(1)} km` : `about ${Math.round(metres)} m`;
interface BreakEntitlement { worked_hours: number; rest_breaks_required: number; meal_breaks_required: number; rest_breaks_taken: number; meal_breaks_taken: number; compliant: boolean; }
interface ActiveBreak { id: string; shift_id: string; break_type: 'rest' | 'meal'; started_at: string; }
interface SwapOfficer { id: string; label: string; }
interface PendingSwap { id: string; original_shift_id: string; status: string; }

interface RosterSlot { id: string; work_unit_id: string; scheduled_start: string; scheduled_end: string; status: string; linked_shift_id: string | null; notes: string | null; }
interface WorkUnit { id: string; name: string; work_unit_type: 'patrol' | 'static' | 'internal'; service_type: string; }

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
  const location=useLocation();
  const requestedSlotId=new URLSearchParams(location.search).get('slot');
  const { profile } = useAuth();
  const [view, setView] = useState<ScheduleView>('assigned');
  const [assigned, setAssigned] = useState<AssignedShift[]>([]);
  const [slots, setSlots] = useState<RosterSlot[]>([]);
  const [workUnits, setWorkUnits] = useState<WorkUnit[]>([]);
  const [coverage, setCoverage] = useState<CoverageRequest[]>([]);
  const [selectedCoverage, setSelectedCoverage] = useState<CoverageRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [responseReceipt, setResponseReceipt] = useState<{ slotId: string; slotStatus: string; shiftId: string | null; shiftStatus: string | null } | null>(null);
  const [responding, setResponding] = useState<{ slot: RosterSlot; response: 'accept' | 'decline' } | null>(null);
  const [declineReason, setDeclineReason] = useState('');
  const [breakEntitlement, setBreakEntitlement] = useState<Record<string, BreakEntitlement>>({});
  const [activeBreak, setActiveBreak] = useState<ActiveBreak | null>(null);
  const [breakSaving, setBreakSaving] = useState(false);
  const [swapRequest, setSwapRequest] = useState<AssignedShift | null>(null);
  const [swapReason, setSwapReason] = useState('');
  const [startingShiftId, setStartingShiftId] = useState<string | null>(null);
  const [startAdvisory, setStartAdvisory] = useState<{ shift: AssignedShift; position: StartPosition; coords: { lat: number | null; lng: number | null }; reason: string } | null>(null);
  const [swapOfficers, setSwapOfficers] = useState<SwapOfficer[]>([]);
  const [swapOfficerId, setSwapOfficerId] = useState('');
  const [pendingSwaps, setPendingSwaps] = useState<PendingSwap[]>([]);
  const [cancelSwap, setCancelSwap] = useState<PendingSwap | null>(null);
  const [cancelSwapReason, setCancelSwapReason] = useState('');

  const loadSchedule = useCallback(async () => {
    if (!profile?.id || !profile.organizationId) {
      setAssigned([]);
      setSlots([]);
      setWorkUnits([]);
      setCoverage([]);
      setError('Organisation access could not be confirmed. Schedule data is unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const [shiftResponse, coverageResponse, staffResponse, officerResponse, swapResponse] = await Promise.all([
      supabase.from('shifts').select('id, service_type, scheduled_start, scheduled_end, status, notes, shift_health, total_stops').eq('officer_user_id', profile.id).gte('scheduled_end', new Date().toISOString()).neq('status', 'cancelled').order('scheduled_start', { ascending: true }).limit(40),
      supabase.from('shift_coverage_requests').select('id, shift_date, start_time, end_time, required_staff_count, urgency, notes, site:site_id(name)').eq('organization_id', profile.organizationId).eq('status', 'open').gte('shift_date', localDateIso()).order('shift_date', { ascending: true }).order('start_time', { ascending: true }),
      supabase.from('staff_profiles').select('id').eq('organization_id', profile.organizationId).or(`user_id.eq.${profile.id},id.eq.${profile.id}`).limit(1).maybeSingle(),
      supabase.from('staff_profiles').select('id,user_id,work_ready').eq('organization_id', profile.organizationId).eq('work_ready', true),
      supabase.from('shift_swaps').select('id,original_shift_id,status').eq('requested_by', profile.id).eq('status', 'pending'),
    ]);
    setPendingSwaps((swapResponse.data as PendingSwap[]) ?? []);
    const candidateRows = Array.isArray(officerResponse.data) ? officerResponse.data as Array<{ id: string; user_id: string | null; work_ready: boolean }> : [];
    const candidateUsers = candidateRows.map((row) => row.user_id).filter((id): id is string => Boolean(id) && id !== profile.id);
    const userResponse = candidateUsers.length ? await supabase.from('user_profiles').select('id,display_name,email').in('id', candidateUsers) : { data: [], error: null };
    const userLabels = new Map(((userResponse.data as Array<{ id: string; display_name: string | null; email: string | null }> | null) ?? []).map((user) => [user.id, user.display_name || user.email || user.id]));
    setSwapOfficers(candidateRows.filter((row) => row.user_id && row.user_id !== profile.id).map((row) => ({ id: row.id, label: userLabels.get(row.user_id as string) ?? row.id })));
    setAssigned((shiftResponse.data as AssignedShift[]) ?? []);
    const activeShift = ((shiftResponse.data as AssignedShift[]) ?? []).find((shift) => shift.status === 'in_progress');
    if (activeShift) {
      const [entitlementResponse, breakResponse] = await Promise.all([
        supabase.rpc('get_shift_break_entitlement', { p_shift_id: activeShift.id }),
        supabase.from('shift_breaks').select('id, shift_id, break_type, started_at').eq('shift_id', activeShift.id).is('ended_at', null).maybeSingle(),
      ]);
      const entitlement = (Array.isArray(entitlementResponse.data) ? entitlementResponse.data[0] : entitlementResponse.data) as BreakEntitlement | null;
      if (entitlement) setBreakEntitlement({ [activeShift.id]: entitlement });
      setActiveBreak((breakResponse.data as ActiveBreak | null) ?? null);
    } else { setActiveBreak(null); setBreakEntitlement({}); }
    const staffId = (staffResponse.data as { id: string } | null)?.id;
    let slotError: { message: string } | null = null;
    if (staffId) {
      const slotResponse = await supabase.from('roster_slots').select('id, work_unit_id, scheduled_start, scheduled_end, status, linked_shift_id, notes').eq('staff_id', staffId).gte('scheduled_end', new Date().toISOString()).neq('status', 'cancelled').order('scheduled_start').limit(40);
      const rows = (slotResponse.data as RosterSlot[]) ?? [];
      setSlots(rows);
      slotError = slotResponse.error;
      const ids = Array.from(new Set(rows.map((slot) => slot.work_unit_id)));
      if (ids.length) {
        const unitsResponse = await supabase.from('roster_work_units').select('id, name, work_unit_type, service_type').in('id', ids);
        setWorkUnits((unitsResponse.data as WorkUnit[]) ?? []);
        slotError = slotError ?? unitsResponse.error;
      } else setWorkUnits([]);
    } else { setSlots([]); setWorkUnits([]); }
    setCoverage(((coverageResponse.data as Array<Omit<CoverageRequest, 'site'> & { site: { name: string } | Array<{ name: string }> | null }>) ?? []).map((request) => ({
      ...request,
      site: Array.isArray(request.site) ? request.site[0] ?? null : request.site,
    })));
    const failure = describeLoadFailures([
      ['assigned shifts', shiftResponse.error],
      ['open coverage', coverageResponse.error],
      ['your roster profile', staffResponse.error],
      ['roster slots', slotError],
    ]);
    if (failure) setError(failure);
    setLoading(false);
  }, [profile?.id, profile?.organizationId]);

  useEffect(() => { void loadSchedule(); }, [loadSchedule]);
  useEffect(()=>{if(requestedSlotId)document.getElementById(`officer-roster-slot-${requestedSlotId}`)?.scrollIntoView({block:'center'});},[requestedSlotId,slots]);

  const workforceSlots = useMemo(() => slots.filter((slot) => !slot.linked_shift_id), [slots]);
  const nextShift = useMemo(() => [...assigned, ...workforceSlots].filter((item) => ['draft', 'scheduled', 'published', 'accepted'].includes(item.status)).sort((left, right) => left.scheduled_start.localeCompare(right.scheduled_start))[0] ?? null, [assigned, workforceSlots]);
  const nextAssignmentLabel = nextShift ? ('service_type' in nextShift ? nextShift.service_type : workUnits.find((unit) => unit.id === nextShift.work_unit_id)?.name ?? 'Internal assignment') : null;

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

  const respondToSlot = async () => {
    if (!responding) return;
    setClaiming(true); setError(null);
    const { data, error: responseError } = await supabase.rpc('respond_to_roster_slot', {
      p_slot_id: responding.slot.id,
      p_expected_status: responding.slot.status,
      p_response: responding.response,
      p_decline_reason: responding.response === 'decline' ? declineReason.trim() : null,
    });
    const receipt = (data as Array<{ slot_id: string; slot_status: string; shift_id: string | null; shift_status: string | null }> | null)?.[0];
    if (responseError || !receipt) setError(responseError?.message ?? 'Assignment response receipt was not confirmed.');
    else { setResponseReceipt({ slotId: receipt.slot_id, slotStatus: receipt.slot_status, shiftId: receipt.shift_id, shiftStatus: receipt.shift_status });setNotice(responding.response === 'accept' ? 'Assignment accepted and confirmed.' : 'Assignment declined with your recorded reason.'); setResponding(null); setDeclineReason(''); await loadSchedule(); }
    setClaiming(false);
  };

  const startBreak = async (shiftId: string, breakType: 'rest' | 'meal') => {
    setBreakSaving(true); setError(null); setNotice(null);
    const { data, error: breakError } = await supabase.rpc('start_shift_break', { p_client_request_id: crypto.randomUUID(), p_shift_id: shiftId, p_break_type: breakType });
    if (breakError || !data) setError(describeLoadFailures([['break', breakError]]) ?? 'Break could not be started.');
    else { setActiveBreak(data as ActiveBreak); setNotice(`${breakType === 'meal' ? 'Meal' : 'Rest'} break started and recorded.`); }
    setBreakSaving(false);
  };

  const endBreak = async () => {
    if (!activeBreak) return;
    setBreakSaving(true); setError(null); setNotice(null);
    const { error: breakError } = await supabase.rpc('end_shift_break', { p_break_id: activeBreak.id, p_notes: null });
    if (breakError) setError(describeLoadFailures([['break', breakError]]) ?? 'Break could not be ended.');
    else { setActiveBreak(null); setNotice('Break ended and duration recorded.'); await loadSchedule(); }
    setBreakSaving(false);
  };

  const requestSwap = async () => {
    if (!swapRequest || !swapReason.trim()) return;
    setBreakSaving(true); setError(null); setNotice(null);
    const { error: swapError } = await supabase.rpc('request_shift_swap', { p_client_request_id: crypto.randomUUID(), p_shift_id: swapRequest.id, p_swap_with_staff_id: swapOfficerId || null, p_swap_type: swapOfficerId ? 'direct' : 'open', p_reason: swapReason.trim() });
    if (swapError) setError(describeLoadFailures([['shift swap', swapError]]) ?? 'Shift swap request could not be submitted.');
    else { setNotice(`${swapOfficerId ? 'Direct' : 'Open'} shift swap request submitted for roster review.`); setSwapRequest(null); setSwapReason(''); setSwapOfficerId(''); }
    setBreakSaving(false);
  };

  const cancelPendingSwap = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!cancelSwap || !cancelSwapReason.trim()) return;
    setBreakSaving(true); setError(null); setNotice(null);
    const { error: cancelError } = await supabase.rpc('cancel_shift_swap', { p_swap_id: cancelSwap.id, p_expected_status: cancelSwap.status, p_reason: cancelSwapReason.trim() });
    if (cancelError) setError(describeLoadFailures([['shift swap cancellation', cancelError]]) ?? 'Shift swap cancellation could not be confirmed.');
    else { setNotice('Pending shift swap cancelled.'); setCancelSwap(null); setCancelSwapReason(''); await loadSchedule(); }
    setBreakSaving(false);
  };

  const currentPosition = () => new Promise<{ lat: number | null; lng: number | null }>((resolve) => {
    if (!navigator.geolocation) { resolve({ lat: null, lng: null }); return; }
    navigator.geolocation.getCurrentPosition((position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }), () => resolve({ lat: null, lng: null }), { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 });
  });

  const submitStart = async (shift: AssignedShift, coords: { lat: number | null; lng: number | null }, reason: string | null) => {
    // ATLAS WRITES: start_officer_shift (records the start position and any off-site reason in its audit row)
    const response = await supabase.rpc('start_officer_shift', { p_client_request_id: crypto.randomUUID(), p_shift_id: shift.id, p_expected_status: shift.status, p_gps_lat: coords.lat, p_gps_lng: coords.lng, p_off_site_reason: reason });
    const receipt = (response.data as Array<{ shift_id: string; shift_status: string; started_at: string; position_status: string | null; place_name: string | null; distance_m: number | null }> | null)?.[0];
    if (response.error || !receipt) setError(describeLoadFailures([['shift start', response.error]]) ?? 'Shift start was not confirmed.');
    else {
      const at = new Date(receipt.started_at).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' });
      const where = receipt.position_status === 'on_site' ? ` at ${receipt.place_name}` : receipt.position_status === 'near_site' ? `, ${describeDistance(receipt.distance_m)} from ${receipt.place_name}` : receipt.position_status === 'off_site' ? `, recorded as away from ${receipt.place_name} (${describeDistance(receipt.distance_m)})` : receipt.position_status === 'no_gps' ? ' without a GPS position' : '';
      setNotice(`Shift started at ${at}${where}.`);
      setStartAdvisory(null);
      await loadSchedule();
    }
  };

  const startShift = async (shift: AssignedShift) => {
    setStartingShiftId(shift.id); setError(null); setNotice(null);
    const coords = await currentPosition();
    // ATLAS READS: evaluate_shift_start_position — advisory only; the officer is told, never blocked
    const { data } = await supabase.rpc('evaluate_shift_start_position', { p_shift_id: shift.id, p_gps_lat: coords.lat, p_gps_lng: coords.lng });
    const position = (data ?? { status: 'no_place' }) as StartPosition;
    if (position.status === 'off_site' || position.status === 'no_gps') setStartAdvisory({ shift, position, coords, reason: '' });
    else await submitStart(shift, coords, null);
    setStartingShiftId(null);
  };

  return (
    <div className="officer-schedule">
      <header className="officer-schedule-header"><div><span>Roster</span><h1>My schedule</h1><p>Your shifts, plus open shifts you can pick up.</p></div><button type="button" onClick={() => void loadSchedule()} disabled={loading} title="Refresh schedule"><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /><span>Refresh</span></button></header>
      {error && <div className="officer-schedule-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)} title="Dismiss"><X size={16} /></button></div>}
      {notice && <div className="officer-schedule-message is-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)} title="Dismiss"><X size={16} /></button></div>}
      {responseReceipt && <section className="officer-schedule-receipt" aria-label="Roster response recorded"><div><span>Roster response recorded</span><strong>{responseReceipt.slotStatus.replaceAll('_',' ')}</strong><small>Roster slot {responseReceipt.slotId.slice(0,8)}{responseReceipt.shiftId ? ` · field shift ${responseReceipt.shiftId.slice(0,8)} ${responseReceipt.shiftStatus?.replaceAll('_',' ') ?? ''}` : ' · internal work, no field shift'}</small></div><button type="button" onClick={() => setResponseReceipt(null)} title="Dismiss receipt"><X size={16}/></button></section>}

      <section className="officer-schedule-next"><div><span>Your next confirmed shift</span><strong>{nextShift ? formatDate(nextShift.scheduled_start) : 'No confirmed shift'}</strong><small>{nextShift ? `${formatTime(nextShift.scheduled_start)} - ${formatTime(nextShift.scheduled_end)} · ${nextAssignmentLabel?.replaceAll('_', ' ')}` : 'Open shifts you can pick up are listed below.'}</small></div><CalendarDays size={24} /></section>

      <div className="officer-schedule-tabs" role="tablist" aria-label="Schedule views"><button type="button" role="tab" aria-selected={view === 'assigned'} className={view === 'assigned' ? 'is-active' : ''} onClick={() => setView('assigned')}>Assigned <span>{assigned.length + workforceSlots.length}</span></button><button type="button" role="tab" aria-selected={view === 'coverage'} className={view === 'coverage' ? 'is-active' : ''} onClick={() => setView('coverage')}>Open coverage <span>{coverage.length}</span></button></div>

      {loading ? <div className="officer-schedule-empty"><RefreshCw size={20} className="is-spinning" />Checking roster</div> : view === 'assigned' ? (
        assigned.length + workforceSlots.length === 0 ? <div className="officer-schedule-empty"><CalendarDays size={23} />No upcoming assigned shifts</div> : <div className="officer-schedule-list">
          {assigned.map((shift) => { const slot = slots.find((item) => item.linked_shift_id === shift.id); const entitlement = breakEntitlement[shift.id]; const pendingSwap = pendingSwaps.find((item) => item.original_shift_id === shift.id); return <article id={slot?`officer-roster-slot-${slot.id}`:undefined} className={`officer-assigned-shift ${slot?.id===requestedSlotId?'is-context-focus':''}`} key={shift.id}><div className="officer-schedule-date"><strong>{formatDate(shift.scheduled_start)}</strong><span>{formatTime(shift.scheduled_start)} - {formatTime(shift.scheduled_end)}</span></div><div><strong>{shift.service_type.replaceAll('_', ' ')}</strong><small>{shift.total_stops} planned stops{shift.notes ? ` · ${shift.notes}` : ''}</small></div><span className={`status-${shift.status}`}>{shift.status.replaceAll('_', ' ')}</span>{pendingSwap ? <button type="button" className="officer-swap-button" onClick={() => setCancelSwap(pendingSwap)}>Cancel pending swap</button> : slot?.status === 'published' && <ScheduleResponseActions onRespond={(response) => setResponding({ slot, response })} />}{!pendingSwap && ['scheduled', 'published', 'accepted'].includes(shift.status) && <><button type="button" className="officer-swap-button" onClick={() => setSwapRequest(shift)}>Request swap</button><button type="button" className="officer-swap-button" onClick={() => void startShift(shift)} disabled={startingShiftId === shift.id}>{startingShiftId === shift.id ? 'Starting…' : 'Start shift'}</button></>}{shift.status === 'in_progress' && <div className="officer-break-controls"><small>{entitlement ? `${entitlement.rest_breaks_taken}/${entitlement.rest_breaks_required} rest · ${entitlement.meal_breaks_taken}/${entitlement.meal_breaks_required} meal` : 'Break entitlement loading'}</small>{activeBreak?.shift_id === shift.id ? <button type="button" onClick={() => void endBreak()} disabled={breakSaving}>End {activeBreak.break_type} break</button> : <><button type="button" onClick={() => void startBreak(shift.id, 'rest')} disabled={breakSaving}>Start rest break</button><button type="button" onClick={() => void startBreak(shift.id, 'meal')} disabled={breakSaving}>Start meal break</button></>}</div>}</article>; })}
          {workforceSlots.map((slot) => { const unit = workUnits.find((item) => item.id === slot.work_unit_id); return <article id={`officer-roster-slot-${slot.id}`} className={`officer-assigned-shift officer-internal-slot ${slot.id===requestedSlotId?'is-context-focus':''}`} key={slot.id}><div className="officer-schedule-date"><strong>{formatDate(slot.scheduled_start)}</strong><span>{formatTime(slot.scheduled_start)} - {formatTime(slot.scheduled_end)}</span></div><div><strong>{unit?.name ?? 'Internal assignment'}</strong><small>{unit?.service_type.replaceAll('_', ' ')}{slot.notes ? ` · ${slot.notes}` : ''}</small></div><span className={`status-${slot.status}`}>{slot.status}</span>{slot.status === 'published' && <ScheduleResponseActions onRespond={(response) => setResponding({ slot, response })} />}</article>; })}
        </div>
      ) : coverage.length === 0 ? <div className="officer-schedule-empty"><ShieldCheck size={23} />No open coverage right now</div> : <div className="officer-schedule-list">{coverage.map((request) => <article className={`officer-coverage urgency-${request.urgency}`} key={request.id}><div className="officer-schedule-date"><strong>{formatDate(`${request.shift_date}T00:00:00`)}</strong><span>{request.start_time.slice(0, 5)} - {request.end_time.slice(0, 5)}</span></div><div><strong>{request.site?.name ?? 'Location to be confirmed'}</strong><small><Users size={13} /> {request.required_staff_count} needed{request.notes ? ` · ${request.notes}` : ''}</small></div><span>{request.urgency}</span><button type="button" onClick={() => setSelectedCoverage(request)}>Review claim</button></article>)}</div>}

      {selectedCoverage && <div className="officer-schedule-dialog-backdrop"><div className="officer-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="coverage-claim-title"><header><div><span>Coverage commitment</span><h2 id="coverage-claim-title">Claim this shift?</h2></div><button type="button" onClick={() => setSelectedCoverage(null)} title="Close"><X size={18} /></button></header><dl><div><dt>Date</dt><dd>{formatDate(`${selectedCoverage.shift_date}T00:00:00`)}</dd></div><div><dt>Time</dt><dd>{selectedCoverage.start_time.slice(0, 5)} - {selectedCoverage.end_time.slice(0, 5)}</dd></div><div><dt>Location</dt><dd><MapPin size={14} />{selectedCoverage.site?.name ?? 'To be confirmed'}</dd></div><div><dt>Urgency</dt><dd>{selectedCoverage.urgency}</dd></div></dl>{selectedCoverage.notes && <p>{selectedCoverage.notes}</p>}<div className="officer-schedule-dialog-actions"><button type="button" onClick={() => setSelectedCoverage(null)}>Cancel</button><button type="button" onClick={() => void confirmClaim()} disabled={claiming}>{claiming ? <><RefreshCw size={16} className="is-spinning" />Confirming</> : <><CheckCircle2 size={16} />Confirm claim</>}</button></div></div></div>}
      {startAdvisory && <div className="officer-schedule-dialog-backdrop"><div className="officer-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="start-advisory-title"><header><div><span>Before you start</span><h2 id="start-advisory-title">{startAdvisory.position.status === 'no_gps' ? 'No GPS position' : `You're not at ${startAdvisory.position.place_name ?? 'the shift location'}`}</h2></div><button type="button" onClick={() => setStartAdvisory(null)} title="Close"><X size={18} /></button></header><p>{startAdvisory.position.status === 'no_gps' ? 'Your location could not be read, so the start will be recorded without a position. Turn location on if you can, or start anyway and say where you are.' : `You are ${describeDistance(startAdvisory.position.distance_m)} from ${startAdvisory.position.place_name ?? 'the shift location'}${startAdvisory.position.route_shift ? ' (the nearest stop on this run)' : ''}. You can still start; the start is recorded as away from site and your supervisor can see that. If there is a reason, say so.`}</p><label><span>Reason (optional)</span><textarea rows={3} value={startAdvisory.reason} onChange={(event) => setStartAdvisory({ ...startAdvisory, reason: event.target.value })} placeholder="e.g. Starting from the depot, travelling to site now" /></label><div className="officer-schedule-dialog-actions"><button type="button" onClick={() => setStartAdvisory(null)}>Not yet</button><button type="button" disabled={startingShiftId === startAdvisory.shift.id} onClick={() => { setStartingShiftId(startAdvisory.shift.id); void submitStart(startAdvisory.shift, startAdvisory.coords, startAdvisory.reason.trim() || null).finally(() => setStartingShiftId(null)); }}>Start anyway</button></div></div></div>}
      {responding && <div className="officer-schedule-dialog-backdrop"><div className="officer-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="assignment-response-title"><header><div><span>Roster response</span><h2 id="assignment-response-title">{responding.response === 'accept' ? 'Accept assignment?' : 'Decline assignment?'}</h2></div><button type="button" onClick={() => setResponding(null)} title="Close"><X size={18} /></button></header><p>{responding.response === 'accept' ? 'Accepting makes this shift yours. It moves to your assigned shifts and your supervisor is told.' : 'Declining hands the shift back to the roster team so they can cover it. Tell them why you cannot take it.'}</p>{responding.response === 'decline' && <label><span>Decline reason</span><textarea required rows={4} value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} /></label>}<div className="officer-schedule-dialog-actions"><button type="button" onClick={() => setResponding(null)}>Back</button><button type="button" onClick={() => void respondToSlot()} disabled={claiming || (responding.response === 'decline' && !declineReason.trim())}>{claiming ? 'Saving' : responding.response === 'accept' ? 'Confirm acceptance' : 'Confirm decline'}</button></div></div></div>}
      {swapRequest && <div className="officer-schedule-dialog-backdrop"><div className="officer-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="shift-swap-title"><header><div><span>Roster change</span><h2 id="shift-swap-title">Request shift swap?</h2></div><button type="button" onClick={() => setSwapRequest(null)} title="Close"><X size={18} /></button></header><p>{formatDate(swapRequest.scheduled_start)} · {formatTime(swapRequest.scheduled_start)} - {formatTime(swapRequest.scheduled_end)}. This opens the shift for roster review; the shift remains assigned until approved.</p><label><span>Replacement officer (optional)</span><select value={swapOfficerId} onChange={(event) => setSwapOfficerId(event.target.value)}><option value="">Open coverage request</option>{swapOfficers.map((officer) => <option key={officer.id} value={officer.id}>{officer.label}</option>)}</select></label><label><span>Reason</span><textarea required rows={4} value={swapReason} onChange={(event) => setSwapReason(event.target.value)} placeholder="Why can you no longer work this shift?" /></label><div className="officer-schedule-dialog-actions"><button type="button" onClick={() => setSwapRequest(null)}>Cancel</button><button type="button" onClick={() => void requestSwap()} disabled={breakSaving || !swapReason.trim()}>Submit swap request</button></div></div></div>}
      {cancelSwap && <div className="officer-schedule-dialog-backdrop"><form className="officer-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-swap-title" onSubmit={cancelPendingSwap}><header><div><span>Roster change</span><h2 id="cancel-swap-title">Cancel pending swap?</h2></div><button type="button" onClick={() => setCancelSwap(null)} title="Close"><X size={18} /></button></header><p>The shift will remain assigned to you and the pending swap request will be withdrawn.</p><label><span>Cancellation reason</span><textarea required rows={4} value={cancelSwapReason} onChange={(event) => setCancelSwapReason(event.target.value)} /></label><div className="officer-schedule-dialog-actions"><button type="button" onClick={() => setCancelSwap(null)}>Back</button><button type="submit" disabled={breakSaving || !cancelSwapReason.trim()}>Cancel swap request</button></div></form></div>}
    </div>
  );
};

export default OfficerSchedulePage;

function ScheduleResponseActions({ onRespond }: { onRespond: (response: 'accept' | 'decline') => void }) {
  return <div className="officer-schedule-response"><button type="button" onClick={() => onRespond('accept')}>Accept</button><button type="button" onClick={() => onRespond('decline')}>Decline</button></div>;
}