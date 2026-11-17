import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, Clock3, MapPin, RefreshCw, ShieldCheck, Users, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useOfficerUnsavedWork } from '../context/OfficerUnsavedWorkContext';
import { EndShiftDialog, type EndShiftDestination } from '../components/EndShiftDialog';
import { OfficerShiftBreakControl } from '../components/OfficerShiftBreakControl';
import { claimShiftCoverage } from '../lib/shiftCoverage';
import { describeLoadFailures } from '../lib/friendlyLoadError';
import { supabase } from '../lib/supabase';
import { briefingNeedsAcknowledgement, fetchShiftSafetyBriefing, type SafetyBriefing } from '../lib/safetyBriefing';
import { SafetyBriefingDialog } from '../components/ShiftSafetyBriefing';
import { fetchStaticShiftSafety, isStaticGuardingService } from '../lib/officerStaticBriefing';
import './OfficerSchedulePage.css';
import './OfficerScheduleActions.css';

interface AssignedShift {
  id: string;
  service_type: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  notes: string | null;
  instructionsWithheld?: boolean;
  shift_health: string | null;
  total_stops: number;
  ended_reason: string | null;
}
interface StartPosition { status: 'on_site' | 'near_site' | 'off_site' | 'no_gps' | 'no_place' | 'unverified_site'; place_name?: string | null; distance_m?: number | null; advisory_radius_m?: number; route_shift?: boolean; }
const describeDistance = (metres: number | null | undefined) => metres == null ? 'an unknown distance' : metres >= 1000 ? `about ${(metres / 1000).toFixed(1)} km` : `about ${Math.round(metres)} m`;
interface BreakEntitlement { worked_hours: number; rest_breaks_required: number; meal_breaks_required: number; rest_breaks_taken: number; meal_breaks_taken: number; compliant: boolean; }
interface SwapOfficer { id: string; label: string; }
interface PendingSwap { id: string; original_shift_id: string; status: string; }
interface OnCallPeriod { id: string; period_type: string; starts_at: string; ends_at: string; flat_rate: number | null; status: string; notes: string | null; }
interface AssetSummary { id: string; name: string; asset_type: string; registration: string | null; serial_number: string | null; }
interface ShiftAssetLink { id: string; asset_id: string; assigned_at: string; asset: AssetSummary | null; }
type AssetCondition = 'good' | 'minor_issue' | 'major_issue' | 'unserviceable';
type AssetFuelLevel = '' | 'full' | 'three_quarter' | 'half' | 'quarter' | 'empty';interface OvertimeOffer { id: string; roster_slot_id: string; seniority_position: number; status: string; expires_at: string; }

interface RosterSlot { id: string; work_unit_id: string; scheduled_start: string; scheduled_end: string; status: string; linked_shift_id: string | null; notes: string | null; }
interface WorkUnit { id: string; name: string; work_unit_type: 'patrol' | 'static' | 'internal' | 'workshop'; service_type: string; }

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

/** The officer's own view of a shift status (the rosterer's words live in rosterWords). */
const OFFICER_SHIFT_STATUS: Record<string, string> = { scheduled: 'Scheduled', published: 'Waiting for your answer', accepted: 'Accepted', in_progress: 'On shift now', completed: 'Completed', declined: 'Declined', cancelled: 'Cancelled', missed: 'Missed – you did not start this shift' };
export const officerShiftStatusLabel = (status: string): string => OFFICER_SHIFT_STATUS[status] ?? status.replaceAll('_', ' ');

/** Mirrors start_officer_shift: a shift can be started from an hour before its rostered start. */
export const SHIFT_START_WINDOW_MINUTES = 60;
export const startOpensAt = (scheduledStart: string): Date => new Date(new Date(scheduledStart).getTime() - SHIFT_START_WINDOW_MINUTES * 60_000);
export const canStartNow = (scheduledStart: string, now: number = Date.now()): boolean => startOpensAt(scheduledStart).getTime() <= now;
const startOpensWords = (scheduledStart: string): string => {
  const opens = startOpensAt(scheduledStart);
  const sameDay = opens.toDateString() === new Date().toDateString();
  return `You can start from ${sameDay ? '' : `${formatDate(opens.toISOString())}, `}${formatTime(opens.toISOString())}`;
};

const OfficerSchedulePage: React.FC = () => {
  const location=useLocation();
  const requestedSlotId=new URLSearchParams(location.search).get('slot');
  const requestedShiftId=new URLSearchParams(location.search).get('shift');
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
  const [breakSaving, setBreakSaving] = useState(false);
  const [swapRequest, setSwapRequest] = useState<AssignedShift | null>(null);
  const [swapReason, setSwapReason] = useState('');
  const [startingShiftId, setStartingShiftId] = useState<string | null>(null);
  const startRequests = useRef(new Map<string, string>());
  const [startBriefing, setStartBriefing] = useState<{ shift: AssignedShift; briefing: SafetyBriefing } | null>(null);
  const [startAdvisory, setStartAdvisory] = useState<{ shift: AssignedShift; position: StartPosition; coords: { lat: number | null; lng: number | null }; reason: string; stillOn: AssignedShift | null } | null>(null);
  const [endingShift, setEndingShift] = useState<AssignedShift | null>(null);
  const navigate = useNavigate();
  const endShiftDestination = (destination: EndShiftDestination, shift: AssignedShift) => {
    const route = destination === 'stops' ? (isStaticGuardingService(shift.service_type) ? '/officer/site_guard' : '/officer/patrol') : destination === 'home' ? '/officer' : `/officer/${destination}`;
    setEndingShift(null);
    navigate(destination === 'stops' ? `${route}?shift=${encodeURIComponent(shift.id)}` : route);
  };
  const [swapOfficers, setSwapOfficers] = useState<SwapOfficer[]>([]);
  const [swapOfficerId, setSwapOfficerId] = useState('');
  const [pendingSwaps, setPendingSwaps] = useState<PendingSwap[]>([]);
  const [cancelSwap, setCancelSwap] = useState<PendingSwap | null>(null);
  const [cancelSwapReason, setCancelSwapReason] = useState('');
  const [onCallPeriods, setOnCallPeriods] = useState<OnCallPeriod[]>([]);
  const [overtimeOffers, setOvertimeOffers] = useState<OvertimeOffer[]>([]);
  const [workResponse, setWorkResponse] = useState<{ kind: 'on_call' | 'overtime'; id: string; expectedStatus: string; response: 'accepted' | 'declined'; title: string } | null>(null);
  const [workDeclineReason, setWorkDeclineReason] = useState('');
  const [adHocWorkUnits, setAdHocWorkUnits] = useState<WorkUnit[]>([]);
  const [adHocWorkUnitId, setAdHocWorkUnitId] = useState('');
  const [adHocNotes, setAdHocNotes] = useState('');
  const [startingAdHoc, setStartingAdHoc] = useState(false);
  const [activeShiftId, setActiveShiftId] = useState<string | null>(null);
  const [shiftAssets, setShiftAssets] = useState<ShiftAssetLink[]>([]);
  const [availableAssets, setAvailableAssets] = useState<AssetSummary[]>([]);
  const [assetToAssign, setAssetToAssign] = useState('');
  const [assetSaving, setAssetSaving] = useState(false);
  const [returningAsset, setReturningAsset] = useState<ShiftAssetLink | null>(null);
  const [returnCondition, setReturnCondition] = useState<AssetCondition>('good');
  const [returnOdometer, setReturnOdometer] = useState('');
  const [returnFuel, setReturnFuel] = useState<AssetFuelLevel>('');
  const [returnDefects, setReturnDefects] = useState('');
  useOfficerUnsavedWork(Boolean(
    startingAdHoc || adHocWorkUnitId || adHocNotes
    || (responding && declineReason) || (workResponse && workDeclineReason)
    || (swapRequest && (swapReason || swapOfficerId)) || (cancelSwap && cancelSwapReason)
    || startAdvisory?.reason
    || (returningAsset && (returnCondition !== 'good' || returnOdometer || returnFuel || returnDefects)),
  ));

  const loadSchedule = useCallback(async () => {
    if (!profile?.id || !profile.organizationId) {
      setAssigned([]);
      setSlots([]);
      setWorkUnits([]);
      setCoverage([]);
      setOnCallPeriods([]);
      setOvertimeOffers([]);
      setAdHocWorkUnits([]);
      setAdHocWorkUnitId('');
      setActiveShiftId(null);
      setShiftAssets([]);
      setAvailableAssets([]);
      setError('Organisation access could not be confirmed. Schedule data is unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const now = new Date().toISOString();
    const [shiftResponse, overdueShiftResponse, coverageResponse, staffResponse, officerResponse, swapResponse, onCallResponse, adHocUnitsResponse] = await Promise.all([
      supabase.from('shifts').select('id, service_type, scheduled_start, scheduled_end, status, shift_health, total_stops, ended_reason').eq('officer_user_id', profile.id).gte('scheduled_end', now).neq('status', 'cancelled').order('scheduled_start', { ascending: true }).limit(40),
      supabase.from('shifts').select('id, scheduled_start, scheduled_end, status, total_stops').eq('officer_user_id', profile.id).eq('status', 'in_progress').lt('scheduled_end', now).order('scheduled_start', { ascending: true }).limit(40),
      supabase.from('shift_coverage_requests').select('id, shift_date, start_time, end_time, required_staff_count, urgency, notes, site:site_id(name)').eq('organization_id', profile.organizationId).eq('status', 'open').gte('shift_date', localDateIso()).order('shift_date', { ascending: true }).order('start_time', { ascending: true }),
      supabase.from('staff_profiles').select('id').eq('organization_id', profile.organizationId).or(`user_id.eq.${profile.id},id.eq.${profile.id}`).limit(1).maybeSingle(),
      supabase.from('staff_profiles').select('id,user_id,work_ready').eq('organization_id', profile.organizationId).eq('work_ready', true),
      supabase.from('shift_swaps').select('id,original_shift_id,status').eq('requested_by', profile.id).eq('status', 'pending'),
      supabase.from('on_call_periods').select('id,period_type,starts_at,ends_at,flat_rate,status,notes').eq('officer_user_id', profile.id).eq('status', 'pending').gte('ends_at', new Date().toISOString()).order('starts_at').limit(20),
      supabase.from('roster_work_units').select('id, name, work_unit_type, service_type').eq('organization_id', profile.organizationId).eq('active', true).order('name').limit(100),
    ]);
    setPendingSwaps((swapResponse.data as PendingSwap[]) ?? []);
    const candidateRows = Array.isArray(officerResponse.data) ? officerResponse.data as Array<{ id: string; user_id: string | null; work_ready: boolean }> : [];
    const candidateUsers = candidateRows.map((row) => row.user_id).filter((id): id is string => Boolean(id) && id !== profile.id);
    const userResponse = candidateUsers.length ? await supabase.from('user_profiles').select('id,display_name,email').in('id', candidateUsers) : { data: [], error: null };
    const userLabels = new Map(((userResponse.data as Array<{ id: string; display_name: string | null; email: string | null }> | null) ?? []).map((user) => [user.id, user.display_name || user.email || user.id]));
    setSwapOfficers(candidateRows.filter((row) => row.user_id && row.user_id !== profile.id).map((row) => ({ id: row.id, label: userLabels.get(row.user_id as string) ?? row.id })));
    const upcomingRows = (shiftResponse.data as Omit<AssignedShift, 'notes'>[] | null) ?? [];
    // Static-post instructions are private to the post briefing; only other assignments show their notes here.
    const nonStaticIds = upcomingRows.filter((shift) => !isStaticGuardingService(shift.service_type)).map((shift) => shift.id);
    const shiftNotesResponse = nonStaticIds.length
      ? await supabase.from('shifts').select('id,notes').eq('officer_user_id', profile.id).not('service_type', 'ilike', '%static%').not('service_type', 'ilike', '%site_guard%').in('id', nonStaticIds)
      : { data: [], error: null };
    const shiftNotes = new Map(((shiftNotesResponse.data as Array<{ id: string; notes: string | null }> | null) ?? []).map((shift) => [shift.id, shift.notes]));
    const assignedById = new Map<string, AssignedShift>(upcomingRows.map((shift) => [shift.id, { ...shift, notes: shiftNotes.get(shift.id) ?? null }]));
    for (const shift of (overdueShiftResponse.data as Pick<AssignedShift, 'id' | 'scheduled_start' | 'scheduled_end' | 'status' | 'total_stops'>[]) ?? []) {
      if (!assignedById.has(shift.id)) assignedById.set(shift.id, { ...shift, service_type: 'Unfinished', notes: null, shift_health: null, ended_reason: null, instructionsWithheld: true });
    }
    const assignedRows = [...assignedById.values()].sort((left, right) => left.scheduled_start.localeCompare(right.scheduled_start)).slice(0, 40);
    setAssigned(assignedRows);
    setOnCallPeriods((onCallResponse.data as OnCallPeriod[]) ?? []);
    setAdHocWorkUnits((adHocUnitsResponse.data as WorkUnit[]) ?? []);
    if (!adHocUnitsResponse.data?.some((unit: { id: string }) => unit.id === adHocWorkUnitId)) setAdHocWorkUnitId('');
    const activeShift = assignedRows.find((shift) => shift.status === 'in_progress');
    let assetError: { message: string } | null = null;
    if (activeShift) {
      const [entitlementResponse, assetResponse, availableResponse] = await Promise.all([
        supabase.rpc('get_shift_break_entitlement', { p_shift_id: activeShift.id }),
        supabase.from('shift_assets').select('id, asset_id, assigned_at, asset:asset_id(id, name, asset_type, registration, serial_number)').eq('shift_id', activeShift.id).is('returned_at', null).order('assigned_at'),
        supabase.from('assets').select('id, name, asset_type, registration, serial_number').eq('organization_id', profile.organizationId).eq('status', 'available').order('asset_type').order('name').limit(100),
      ]);
      const entitlement = (Array.isArray(entitlementResponse.data) ? entitlementResponse.data[0] : entitlementResponse.data) as BreakEntitlement | null;
      if (entitlement) setBreakEntitlement({ [activeShift.id]: entitlement });
      setActiveShiftId(activeShift.id);
      setShiftAssets(((assetResponse.data as Array<Omit<ShiftAssetLink, 'asset'> & { asset: AssetSummary | AssetSummary[] | null }>) ?? []).map((link) => ({
        ...link,
        asset: Array.isArray(link.asset) ? link.asset[0] ?? null : link.asset,
      })));
      setAvailableAssets((availableResponse.data as AssetSummary[]) ?? []);
      assetError = assetResponse.error ?? availableResponse.error;
    } else { setBreakEntitlement({}); setActiveShiftId(null); setShiftAssets([]); setAvailableAssets([]); }
    const staffId = (staffResponse.data as { id: string } | null)?.id;
    let slotError: { message: string } | null = null;
    if (staffId) {
      const [slotResponse, overtimeResponse] = await Promise.all([
        supabase.from('roster_slots').select('id, work_unit_id, scheduled_start, scheduled_end, status, linked_shift_id').eq('staff_id', staffId).gte('scheduled_end', new Date().toISOString()).neq('status', 'cancelled').order('scheduled_start').limit(40),
        supabase.from('overtime_offers').select('id,roster_slot_id,seniority_position,status,expires_at').eq('staff_id', staffId).eq('status', 'offered').gte('expires_at', new Date().toISOString()).order('expires_at').limit(20),
      ]);
      const rows = (slotResponse.data as Omit<RosterSlot, 'notes'>[]) ?? [];
      setOvertimeOffers((overtimeResponse.data as OvertimeOffer[]) ?? []);
      slotError = slotResponse.error ?? overtimeResponse.error;
      const ids = Array.from(new Set(rows.map((slot) => slot.work_unit_id)));
      const slotNotes = new Map<string, string | null>();
      if (ids.length) {
        const unitsResponse = await supabase.from('roster_work_units').select('id, name, work_unit_type, service_type').in('id', ids);
        const units = (unitsResponse.data as WorkUnit[]) ?? [];
        setWorkUnits(units);
        slotError = slotError ?? unitsResponse.error;
        const nonStaticSlotIds = rows.filter((slot) => {
          const unit = units.find((item) => item.id === slot.work_unit_id);
          return !slot.linked_shift_id && unit && unit.work_unit_type !== 'static' && !isStaticGuardingService(unit.service_type);
        }).map((slot) => slot.id);
        if (nonStaticSlotIds.length) {
          const notesResponse = await supabase.from('roster_slots')
            .select('id,notes,work_unit:roster_work_units!inner(work_unit_type,service_type)')
            .eq('staff_id', staffId).is('linked_shift_id', null).in('id', nonStaticSlotIds)
            .not('work_unit.work_unit_type', 'eq', 'static')
            .not('work_unit.service_type', 'ilike', '%static%')
            .not('work_unit.service_type', 'ilike', '%site_guard%');
          slotError = slotError ?? notesResponse.error;
          for (const slot of (notesResponse.data as Array<{ id: string; notes: string | null }> | null) ?? []) {
            slotNotes.set(slot.id, slot.notes);
          }
        }
      } else setWorkUnits([]);
      setSlots(rows.map((slot) => ({ ...slot, notes: slotNotes.get(slot.id) ?? null })));
    } else { setSlots([]); setWorkUnits([]); setOvertimeOffers([]); }
    setCoverage(((coverageResponse.data as Array<Omit<CoverageRequest, 'site'> & { site: { name: string } | Array<{ name: string }> | null }>) ?? []).map((request) => ({
      ...request,
      site: Array.isArray(request.site) ? request.site[0] ?? null : request.site,
    })));
    const failure = describeLoadFailures([
      ['assigned shifts', shiftResponse.error],
      ['unfinished shifts', overdueShiftResponse.error],
      ['assignment instructions', shiftNotesResponse.error],
      ['open coverage', coverageResponse.error],
      ['your roster profile', staffResponse.error],
      ['on-call assignments', onCallResponse.error],
      ['available work units', adHocUnitsResponse.error],
      ['shift equipment', assetError],
      ['roster slots', slotError],
    ]);
    if (failure) setError(failure);
    setLoading(false);
  }, [profile?.id, profile?.organizationId]);

  useEffect(() => { void loadSchedule(); }, [loadSchedule]);
  useEffect(()=>{if(requestedSlotId)document.getElementById(`officer-roster-slot-${requestedSlotId}`)?.scrollIntoView({block:'center'});},[requestedSlotId,slots]);
  useEffect(() => {
    if (!requestedShiftId || !assigned.some((shift) => shift.id === requestedShiftId)) return;
    const slot = slots.find((item) => item.linked_shift_id === requestedShiftId);
    document.getElementById(slot ? `officer-roster-slot-${slot.id}` : `officer-shift-${requestedShiftId}`)?.scrollIntoView({ block: 'center' });
  }, [requestedShiftId, assigned, slots]);

  const workforceSlots = useMemo(() => slots.filter((slot) => !slot.linked_shift_id), [slots]);
  const nextShift = useMemo(() => [...assigned, ...workforceSlots].filter((item) => ['draft', 'scheduled', 'published', 'accepted'].includes(item.status)).sort((left, right) => left.scheduled_start.localeCompare(right.scheduled_start))[0] ?? null, [assigned, workforceSlots]);
  const nextAssignmentLabel = nextShift ? ('service_type' in nextShift ? (workUnits.find((unit) => unit.id === slots.find((slot) => slot.linked_shift_id === nextShift.id)?.work_unit_id)?.name ?? nextShift.service_type) : workUnits.find((unit) => unit.id === nextShift.work_unit_id)?.name ?? 'Internal assignment') : null;
  // The hero only calls a shift "confirmed" once the officer has accepted it; an unanswered one says so.
  const nextShiftHeading = !nextShift || nextShift.status === 'accepted' ? 'Your next confirmed shift' : nextShift.status === 'published' ? 'Your next shift · waiting for your answer' : 'Your next shift';

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

  const assignAsset = async () => {
    if (!activeShiftId || !assetToAssign) return;
    setAssetSaving(true); setError(null); setNotice(null);
    const { error: assignError } = await supabase.rpc('assign_shift_asset', { p_client_request_id: crypto.randomUUID(), p_shift_id: activeShiftId, p_asset_id: assetToAssign });
    if (assignError) setError(describeLoadFailures([['equipment sign-out', assignError]]) ?? 'Equipment could not be signed out.');
    else { setNotice('Equipment signed out to your shift.'); setAssetToAssign(''); await loadSchedule(); }
    setAssetSaving(false);
  };

  const confirmReturnAsset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!returningAsset) return;
    const odometer = returnOdometer.trim() ? Number(returnOdometer.trim()) : null;
    if (odometer !== null && (!Number.isFinite(odometer) || odometer < 0)) { setError('Odometer reading must be a whole number of kilometres.'); return; }
    if (returnCondition !== 'good' && !returnDefects.trim()) { setError('Describe the fault so the workshop knows what to look at.'); return; }
    setAssetSaving(true); setError(null); setNotice(null);
    const { error: returnError } = await supabase.rpc('return_shift_asset', {
      p_link_id: returningAsset.id,
      p_condition: returnCondition,
      p_odometer_reading: odometer === null ? null : Math.round(odometer),
      p_fuel_level: returnFuel || null,
      p_defects_noted: returnDefects.trim() || null,
    });
    if (returnError) setError(describeLoadFailures([['equipment return', returnError]]) ?? 'Equipment return could not be confirmed.');
    else {
      setNotice(returnCondition === 'major_issue' || returnCondition === 'unserviceable'
        ? `${returningAsset.asset?.name ?? 'Equipment'} returned and sent to maintenance.`
        : `${returningAsset.asset?.name ?? 'Equipment'} returned and back in the available pool.`);
      setReturningAsset(null); setReturnCondition('good'); setReturnOdometer(''); setReturnFuel(''); setReturnDefects('');
      await loadSchedule();
    }
    setAssetSaving(false);
  };

  const startAdHocShift = async (event: React.FormEvent) => {
    event.preventDefault();
    const unit = adHocWorkUnits.find((candidate) => candidate.id === adHocWorkUnitId);
    if (!unit) {
      setError('Choose the work unit for this unscheduled shift.');
      return;
    }
    setStartingAdHoc(true); setError(null); setNotice(null);
    const { data, error: startError } = await supabase.rpc('start_ad_hoc_officer_shift', {
      p_work_unit_id: unit.id,
      p_module_key: unit.service_type,
      p_notes: adHocNotes.trim() || null,
    });
    if (startError || !data || typeof data.id !== 'string' || !['scheduled', 'in_progress'].includes(data.status)) {
      setError(describeLoadFailures([['unscheduled shift start', startError]]) ?? 'The unscheduled shift was not started.');
    } else {
      if (data.status === 'scheduled') {
        await loadSchedule();
        await startShift({
          id: data.id, service_type: data.service_type, scheduled_start: data.scheduled_start,
          scheduled_end: data.scheduled_end, status: data.status, notes: data.notes,
          shift_health: data.shift_health, total_stops: data.total_stops, ended_reason: data.ended_reason,
        });
      } else setNotice(`${unit.name} shift started now. Record your work as you go, then use End shift when you are finished.`);
      setAdHocWorkUnitId('');
      setAdHocNotes('');
      await loadSchedule();
    }
    setStartingAdHoc(false);
  };

  const respondToAdditionalWork = async (event: React.FormEvent) => {    event.preventDefault();
    if (!workResponse) return;
    setClaiming(true);
    setError(null);
    setNotice(null);
    const args = {
      p_expected_status: workResponse.expectedStatus,
      p_response: workResponse.response,
      p_decline_reason: workResponse.response === 'declined' ? workDeclineReason.trim() : null,
    };
    const { data, error: responseError } = workResponse.kind === 'on_call'
      ? await supabase.rpc('respond_to_on_call_period', { ...args, p_period_id: workResponse.id })
      : await supabase.rpc('respond_to_overtime_offer', { ...args, p_offer_id: workResponse.id });
    if (responseError || !data) {
      setError(responseError?.message ?? 'Your response receipt was not confirmed.');
    } else {
      setNotice(`${workResponse.title} ${workResponse.response === 'accepted' ? 'accepted' : 'declined with your reason recorded'}.`);
      setWorkResponse(null);
      setWorkDeclineReason('');
      await loadSchedule();
    }
    setClaiming(false);
  };

  const currentPosition = () => new Promise<{ lat: number | null; lng: number | null }>((resolve) => {
    if (!navigator.geolocation) { resolve({ lat: null, lng: null }); return; }
    navigator.geolocation.getCurrentPosition((position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }), () => resolve({ lat: null, lng: null }), { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 });
  });

  const submitStart = async (shift: AssignedShift, coords: { lat: number | null; lng: number | null }, reason: string | null) => {
    // ATLAS WRITES: start_officer_shift (records the start position and any off-site reason in its audit row; one shift at a time — an earlier in-progress shift is stopped and named in the receipt)
    const requestId = startRequests.current.get(shift.id) ?? crypto.randomUUID();
    startRequests.current.set(shift.id, requestId);
    const response = await supabase.rpc(shift.service_type === 'static_guarding' ? 'start_officer_static_shift' : 'start_officer_shift', { p_client_request_id: requestId, p_shift_id: shift.id, p_expected_status: shift.status, p_gps_lat: coords.lat, p_gps_lng: coords.lng, p_off_site_reason: reason });
    const receipt = (response.data as Array<{ shift_id: string; shift_status: string; started_at: string; position_status: string | null; place_name: string | null; distance_m: number | null; superseded_shift_id: string | null; superseded_service_type: string | null }> | null)?.[0];
    if (response.error || !receipt || receipt.shift_id !== shift.id || receipt.shift_status !== 'in_progress' || !Number.isFinite(Date.parse(receipt.started_at))) setError(describeLoadFailures([['shift start', response.error]]) ?? 'Shift start was not confirmed.');
    else {
      const at = new Date(receipt.started_at).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' });
      const where = receipt.position_status === 'on_site' ? ` at ${receipt.place_name}` : receipt.position_status === 'near_site' ? `, ${describeDistance(receipt.distance_m)} from ${receipt.place_name}` : receipt.position_status === 'off_site' ? `, recorded as away from ${receipt.place_name} (${describeDistance(receipt.distance_m)})` : receipt.position_status === 'no_gps' ? ' without a GPS position' : '';
      const stopped = receipt.superseded_shift_id ? ` Your earlier ${(receipt.superseded_service_type ?? 'other').replaceAll('_', ' ')} shift was ended at ${at}; anything left open on it is on record.` : '';
      setNotice(`Shift started at ${at}${where}.${stopped}`);
      setStartAdvisory(null);
      await loadSchedule();
    }
  };

  const continueStart = async (shift: AssignedShift) => {
    const coords = await currentPosition();
    // ATLAS READS: evaluate_shift_start_position — advisory only; the officer is told, never blocked
    const { data, error: positionError } = await supabase.rpc(shift.service_type === 'static_guarding' ? 'evaluate_static_shift_position' : 'evaluate_shift_start_position', { p_shift_id: shift.id, p_gps_lat: coords.lat, p_gps_lng: coords.lng });
    if (positionError || !data) { setError(positionError?.message ?? 'Start position could not be checked. Retry or contact operations.'); return; }
    const position = (data ?? { status: 'no_place' }) as StartPosition;
    // One shift at a time: starting this one ends the shift the officer is still on, so it is confirmed first.
    const stillOn = assigned.find((item) => item.status === 'in_progress' && item.id !== shift.id) ?? null;
    if (stillOn || position.status === 'off_site' || position.status === 'no_gps' || position.status === 'unverified_site') setStartAdvisory({ shift, position, coords, reason: '', stillOn });
    else await submitStart(shift, coords, null);
  };

  const loadShiftSafety = (shift: AssignedShift) => isStaticGuardingService(shift.service_type)
    ? fetchStaticShiftSafety(shift.id) : fetchShiftSafetyBriefing(shift.id);

  const startShift = async (shift: AssignedShift) => {
    setStartingShiftId(shift.id); setError(null); setNotice(null);
    // The place's hazards are read and confirmed before the shift starts ("I've read these risks – start shift").
    try {
      const briefing = await loadShiftSafety(shift);
      if (briefingNeedsAcknowledgement(briefing)) { setStartBriefing({ shift, briefing }); setStartingShiftId(null); return; }
    } catch (briefingError) {
      setError(`The safety briefing for this shift could not be loaded (${briefingError instanceof Error ? briefingError.message : 'unknown error'}). Ask your supervisor about site risks before you start.`);
      setStartingShiftId(null);
      return;
    }
    await continueStart(shift);
    setStartingShiftId(null);
  };

  return (
    <div className="officer-schedule">
      <header className="officer-schedule-header"><div><span>Roster</span><h1>My schedule</h1><p>Your shifts, plus open shifts you can pick up.</p></div><button type="button" onClick={() => void loadSchedule()} disabled={loading} title="Refresh schedule"><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /><span>Refresh</span></button></header>
      {error && <div className="officer-schedule-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)} title="Dismiss"><X size={16} /></button></div>}
      {notice && <div className="officer-schedule-message is-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)} title="Dismiss"><X size={16} /></button></div>}
      {responseReceipt && <section className="officer-schedule-receipt" aria-label="Roster response recorded"><div><span>Roster response recorded</span><strong>{responseReceipt.slotStatus.replaceAll('_',' ')}</strong><small>Roster slot {responseReceipt.slotId.slice(0,8)}{responseReceipt.shiftId ? ` · field shift ${responseReceipt.shiftId.slice(0,8)} ${responseReceipt.shiftStatus?.replaceAll('_',' ') ?? ''}` : ' · internal work, no field shift'}</small></div><button type="button" onClick={() => setResponseReceipt(null)} title="Dismiss receipt"><X size={16}/></button></section>}

      {(onCallPeriods.length > 0 || overtimeOffers.length > 0) && <section className="officer-additional-work" aria-labelledby="additional-work-title"><div><span>Response required</span><h2 id="additional-work-title">On-call and overtime offers</h2><p>Accept only work you can cover. Declines require a reason so the roster team can safely offer it elsewhere.</p></div>{onCallPeriods.map((period) => <article key={period.id}><div><strong>{period.period_type.replaceAll('_', ' ')} on-call</strong><small>{formatDate(period.starts_at)}, {formatTime(period.starts_at)} - {formatDate(period.ends_at)}, {formatTime(period.ends_at)}{period.flat_rate != null ? ` · $${Number(period.flat_rate).toFixed(2)} flat rate` : ''}{period.notes ? ` · ${period.notes}` : ''}</small></div><div><button type="button" onClick={() => setWorkResponse({ kind: 'on_call', id: period.id, expectedStatus: period.status, response: 'declined', title: 'On-call period' })}>Decline</button><button type="button" onClick={() => setWorkResponse({ kind: 'on_call', id: period.id, expectedStatus: period.status, response: 'accepted', title: 'On-call period' })}>Accept</button></div></article>)}{overtimeOffers.map((offer) => { const slot = slots.find((item) => item.id === offer.roster_slot_id); const unit = workUnits.find((item) => item.id === slot?.work_unit_id); return <article key={offer.id}><div><strong>Overtime offer{unit ? ` · ${unit.name}` : ''}</strong><small>{slot ? `${formatDate(slot.scheduled_start)}, ${formatTime(slot.scheduled_start)} - ${formatTime(slot.scheduled_end)} · ` : ''}Seniority position {offer.seniority_position} · respond before {formatTime(offer.expires_at)}</small></div><div><button type="button" onClick={() => setWorkResponse({ kind: 'overtime', id: offer.id, expectedStatus: offer.status, response: 'declined', title: 'Overtime offer' })}>Decline</button><button type="button" onClick={() => setWorkResponse({ kind: 'overtime', id: offer.id, expectedStatus: offer.status, response: 'accepted', title: 'Overtime offer' })}>Accept</button></div></article>; })}</section>}
      {activeShiftId && <section className="officer-shift-assets" aria-labelledby="shift-assets-title"><div><span>On this shift</span><h2 id="shift-assets-title">Vehicles and equipment</h2><p>Sign out what you are carrying, and hand it back with its condition so the next officer knows what they are getting.</p></div>{shiftAssets.length === 0 ? <p className="officer-shift-assets-empty">Nothing signed out to this shift yet.</p> : shiftAssets.map((link) => <article key={link.id}><div><strong>{link.asset?.name ?? 'Unnamed asset'}</strong><small>{[link.asset?.asset_type.replaceAll('_', ' '), link.asset?.registration, link.asset?.serial_number].filter(Boolean).join(' · ') || 'No identifiers recorded'} · signed out {formatTime(link.assigned_at)}</small></div><button type="button" onClick={() => { setReturningAsset(link); setReturnCondition('good'); setReturnOdometer(''); setReturnFuel(''); setReturnDefects(''); }}>Return</button></article>)}{availableAssets.length === 0 ? <p className="officer-shift-assets-empty">No equipment is currently available to sign out.</p> : <div className="officer-shift-assets-assign"><label htmlFor="officer-asset-select">Sign out equipment</label><select id="officer-asset-select" value={assetToAssign} onChange={(event) => setAssetToAssign(event.target.value)} disabled={assetSaving}><option value="">Choose a vehicle or item</option>{availableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · {asset.asset_type.replaceAll('_', ' ')}{asset.registration ? ` · ${asset.registration}` : ''}</option>)}</select><button type="button" onClick={() => void assignAsset()} disabled={assetSaving || !assetToAssign}>{assetSaving ? 'Working…' : 'Sign out'}</button></div>}</section>}

      <section className="officer-schedule-next"><div><span>{nextShiftHeading}</span><strong>{nextShift ? formatDate(nextShift.scheduled_start) : 'No confirmed shift'}</strong><small>{nextShift ? `${formatTime(nextShift.scheduled_start)} - ${formatTime(nextShift.scheduled_end)} · ${nextAssignmentLabel?.replaceAll('_', ' ')}` : 'Open shifts you can pick up are listed below.'}</small></div><CalendarDays size={24} /></section>

      {!activeShiftId && adHocWorkUnits.length > 0 && <details className="officer-ad-hoc-shift"><summary>Start an unscheduled shift</summary><p>Use this only when your supervisor has asked you to begin work that is not on your roster. You can only have one active shift.</p><form onSubmit={startAdHocShift}><label htmlFor="ad-hoc-work-unit">Work unit</label><select id="ad-hoc-work-unit" value={adHocWorkUnitId} onChange={(event) => setAdHocWorkUnitId(event.target.value)} disabled={startingAdHoc}><option value="">Choose the work you are starting</option>{adHocWorkUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name} · {unit.service_type.replaceAll('_', ' ')}</option>)}</select><label htmlFor="ad-hoc-notes">Context for the roster record <span>(optional)</span></label><textarea id="ad-hoc-notes" rows={2} value={adHocNotes} onChange={(event) => setAdHocNotes(event.target.value)} disabled={startingAdHoc} placeholder="Who asked you to start, or what needs attention?" /><button type="submit" disabled={startingAdHoc || !adHocWorkUnitId}>{startingAdHoc ? 'Starting…' : 'Start unscheduled shift'}</button></form></details>}

      <div className="officer-schedule-tabs" role="tablist" aria-label="Schedule views"><button type="button" role="tab" aria-selected={view === 'assigned'} className={view === 'assigned' ? 'is-active' : ''} onClick={() => setView('assigned')}>Assigned <span>{assigned.length + workforceSlots.length}</span></button><button type="button" role="tab" aria-selected={view === 'coverage'} className={view === 'coverage' ? 'is-active' : ''} onClick={() => setView('coverage')}>Open coverage <span>{coverage.length}</span></button></div>

      {loading ? <div className="officer-schedule-empty"><RefreshCw size={20} className="is-spinning" />Checking roster</div> : view === 'assigned' ? (
        assigned.length + workforceSlots.length === 0 ? <div className="officer-schedule-empty"><CalendarDays size={23} />No upcoming assigned shifts</div> : <div className="officer-schedule-list">
          {assigned.map((shift) => {
            const slot = slots.find((item) => item.linked_shift_id === shift.id);
            const unit = slot ? workUnits.find((item) => item.id === slot.work_unit_id) : undefined;
            const entitlement = breakEntitlement[shift.id];
            const pendingSwap = pendingSwaps.find((item) => item.original_shift_id === shift.id);
            return <article id={slot ? `officer-roster-slot-${slot.id}` : `officer-shift-${shift.id}`} className={`officer-assigned-shift ${slot?.id === requestedSlotId || shift.id === requestedShiftId ? 'is-context-focus' : ''}`} key={shift.id}>
              <div className="officer-schedule-date"><strong>{formatDate(shift.scheduled_start)}</strong><span>{formatTime(shift.scheduled_start)} - {formatTime(shift.scheduled_end)}</span></div>
              <div><strong>{unit?.name ?? shift.service_type.replaceAll('_', ' ')}</strong><small>{unit ? `${shift.service_type.replaceAll('_', ' ')} · ` : ''}{shift.total_stops} planned {shift.total_stops === 1 ? 'stop' : 'stops'}{!isStaticGuardingService(shift.service_type) && shift.notes ? ` · ${shift.notes}` : ''}{shift.instructionsWithheld ? ' · Briefing notes are not shown here; ask operations.' : ''}{shift.ended_reason === 'superseded_by_next_shift' ? ' · ended when your next shift started' : ''}</small></div>
              <span className={`status-${shift.status}`}>{officerShiftStatusLabel(shift.status)}</span>
              {!shift.instructionsWithheld && isStaticGuardingService(shift.service_type) && <button type="button" onClick={() => navigate(`/officer/site_guard?shift=${encodeURIComponent(shift.id)}`)}>Open assigned site and job</button>}
              {shift.status === 'in_progress' && !shift.instructionsWithheld && <button type="button" className="officer-swap-button" onClick={() => navigate(`/officer/report?shift=${encodeURIComponent(shift.id)}`)}>Record incident or report</button>}
              {pendingSwap ? <button type="button" className="officer-swap-button" onClick={() => setCancelSwap(pendingSwap)}>Cancel pending swap</button> : slot?.status === 'published' && <ScheduleResponseActions onRespond={(response) => setResponding({ slot, response })} />}
              {!pendingSwap && ['scheduled', 'published', 'accepted'].includes(shift.status) && <><button type="button" className="officer-swap-button" onClick={() => setSwapRequest(shift)}>Request swap</button>{canStartNow(shift.scheduled_start) ? <button type="button" className="officer-swap-button" onClick={() => void startShift(shift)} disabled={startingShiftId === shift.id}>{startingShiftId === shift.id ? 'Starting…' : 'Start shift'}</button> : <small className="officer-start-opens">{startOpensWords(shift.scheduled_start)}</small>}</>}
              {shift.status === 'in_progress' && <div className="officer-break-controls"><small>{entitlement ? `${entitlement.rest_breaks_taken}/${entitlement.rest_breaks_required} rest · ${entitlement.meal_breaks_taken}/${entitlement.meal_breaks_required} meal` : 'Break entitlement loading'}</small><OfficerShiftBreakControl shiftId={shift.id} /><button type="button" className="officer-end-shift-button" onClick={() => setEndingShift(shift)}>End shift</button></div>}
            </article>;
          })}
          {workforceSlots.map((slot) => { const unit = workUnits.find((item) => item.id === slot.work_unit_id); return <article id={`officer-roster-slot-${slot.id}`} className={`officer-assigned-shift officer-internal-slot ${slot.id===requestedSlotId?'is-context-focus':''}`} key={slot.id}><div className="officer-schedule-date"><strong>{formatDate(slot.scheduled_start)}</strong><span>{formatTime(slot.scheduled_start)} - {formatTime(slot.scheduled_end)}</span></div><div><strong>{unit?.name ?? 'Internal assignment'}</strong><small>{unit?.service_type.replaceAll('_', ' ')}{slot.notes ? ` · ${slot.notes}` : ''}</small></div><span className={`status-${slot.status}`}>{slot.status}</span>{slot.status === 'published' && <ScheduleResponseActions onRespond={(response) => setResponding({ slot, response })} />}</article>; })}
        </div>
      ) : coverage.length === 0 ? <div className="officer-schedule-empty"><ShieldCheck size={23} />No open coverage right now</div> : <div className="officer-schedule-list">{coverage.map((request) => <article className={`officer-coverage urgency-${request.urgency}`} key={request.id}><div className="officer-schedule-date"><strong>{formatDate(`${request.shift_date}T00:00:00`)}</strong><span>{request.start_time.slice(0, 5)} - {request.end_time.slice(0, 5)}</span></div><div><strong>{request.site?.name ?? 'Location to be confirmed'}</strong><small><Users size={13} /> {request.required_staff_count} needed{request.notes ? ` · ${request.notes}` : ''}</small></div><span>{request.urgency}</span><button type="button" onClick={() => setSelectedCoverage(request)}>Review claim</button></article>)}</div>}

      {returningAsset && <div className="officer-schedule-dialog-backdrop"><form className="officer-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-return-title" onSubmit={confirmReturnAsset}><header><div><span>Equipment</span><h2 id="asset-return-title">Return {returningAsset.asset?.name ?? 'equipment'}</h2></div><button type="button" onClick={() => setReturningAsset(null)} title="Close"><X size={18}/></button></header><p>This records a post-shift check against the item. Anything worse than a minor issue sends it to maintenance instead of back into the available pool.</p><label><span>Condition</span><select value={returnCondition} onChange={(event) => setReturnCondition(event.target.value as AssetCondition)}><option value="good">Good — ready for the next shift</option><option value="minor_issue">Minor issue — still usable</option><option value="major_issue">Major issue — send to maintenance</option><option value="unserviceable">Unserviceable — do not issue</option></select></label><label><span>Odometer reading (km, optional)</span><input type="number" min="0" step="1" inputMode="numeric" value={returnOdometer} onChange={(event) => setReturnOdometer(event.target.value)} /></label><label><span>Fuel level (optional)</span><select value={returnFuel} onChange={(event) => setReturnFuel(event.target.value as AssetFuelLevel)}><option value="">Not applicable</option><option value="full">Full</option><option value="three_quarter">Three quarters</option><option value="half">Half</option><option value="quarter">Quarter</option><option value="empty">Empty</option></select></label><label><span>Defects or damage{returnCondition === 'good' ? ' (optional)' : ''}</span><textarea rows={3} required={returnCondition !== 'good'} value={returnDefects} onChange={(event) => setReturnDefects(event.target.value)} /></label><div className="officer-schedule-dialog-actions"><button type="button" onClick={() => setReturningAsset(null)}>Back</button><button type="submit" disabled={assetSaving}>{assetSaving ? 'Saving...' : 'Confirm return'}</button></div></form></div>}

      {workResponse && <div className="officer-schedule-dialog-backdrop"><form className="officer-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="additional-work-response-title" onSubmit={respondToAdditionalWork}><header><div><span>Additional work</span><h2 id="additional-work-response-title">{workResponse.response === 'accepted' ? `Accept ${workResponse.title.toLowerCase()}?` : `Decline ${workResponse.title.toLowerCase()}?`}</h2></div><button type="button" onClick={() => { setWorkResponse(null); setWorkDeclineReason(''); }} title="Close"><X size={18}/></button></header><p>{workResponse.response === 'accepted' ? 'This confirms the assignment to the roster team. Check the dates and availability before continuing.' : 'Tell the roster team why you cannot cover this work so they can make a safe replacement decision.'}</p>{workResponse.response === 'declined' && <label><span>Decline reason</span><textarea required rows={4} value={workDeclineReason} onChange={(event) => setWorkDeclineReason(event.target.value)} /></label>}<div className="officer-schedule-dialog-actions"><button type="button" onClick={() => { setWorkResponse(null); setWorkDeclineReason(''); }}>Back</button><button type="submit" disabled={claiming || (workResponse.response === 'declined' && !workDeclineReason.trim())}>{claiming ? 'Saving...' : workResponse.response === 'accepted' ? 'Confirm acceptance' : 'Confirm decline'}</button></div></form></div>}
      {selectedCoverage && <div className="officer-schedule-dialog-backdrop"><div className="officer-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="coverage-claim-title"><header><div><span>Coverage commitment</span><h2 id="coverage-claim-title">Claim this shift?</h2></div><button type="button" onClick={() => setSelectedCoverage(null)} title="Close"><X size={18} /></button></header><dl><div><dt>Date</dt><dd>{formatDate(`${selectedCoverage.shift_date}T00:00:00`)}</dd></div><div><dt>Time</dt><dd>{selectedCoverage.start_time.slice(0, 5)} - {selectedCoverage.end_time.slice(0, 5)}</dd></div><div><dt>Location</dt><dd><MapPin size={14} />{selectedCoverage.site?.name ?? 'To be confirmed'}</dd></div><div><dt>Urgency</dt><dd>{selectedCoverage.urgency}</dd></div></dl>{selectedCoverage.notes && <p>{selectedCoverage.notes}</p>}<div className="officer-schedule-dialog-actions"><button type="button" onClick={() => setSelectedCoverage(null)}>Cancel</button><button type="button" onClick={() => void confirmClaim()} disabled={claiming}>{claiming ? <><RefreshCw size={16} className="is-spinning" />Confirming</> : <><CheckCircle2 size={16} />Confirm claim</>}</button></div></div></div>}
      {endingShift && <EndShiftDialog shiftId={endingShift.id} shiftStatus={endingShift.status} serviceType={endingShift.service_type} recoveryReadiness={Boolean(endingShift.instructionsWithheld)} stopsUnavailableReason={endingShift.instructionsWithheld ? 'Stops for this earlier shift cannot be opened here yet. Contact operations to finish them.' : undefined} dispatchUnavailableReason={endingShift.instructionsWithheld ? 'Dispatch jobs for this earlier shift cannot be opened here yet. Contact operations to finish them.' : undefined} onClose={() => setEndingShift(null)} onNavigate={(destination) => endShiftDestination(destination, endingShift)} onEnded={async ({ completed_at }) => { setEndingShift(null); setNotice(`Shift ended at ${new Date(completed_at).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}. Record your worked time on the timesheet when you are ready.`); await loadSchedule(); }} />}
      {startBriefing && <SafetyBriefingDialog briefing={startBriefing.briefing} title={`Before you start: risks on this shift`} acknowledgeLabel="I've read these risks – start shift" onClose={() => setStartBriefing(null)} onReload={async () => { const next = await loadShiftSafety(startBriefing.shift); setStartBriefing({ shift: startBriefing.shift, briefing: next }); return next; }} onAcknowledged={async () => { const { shift } = startBriefing; setStartBriefing(null); setStartingShiftId(shift.id); await continueStart(shift); setStartingShiftId(null); }} />}
      {startAdvisory && <div className="officer-schedule-dialog-backdrop"><div className="officer-schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="start-advisory-title">
        <header><h2 id="start-advisory-title">{startAdvisory.stillOn ? "You're still on another shift" : 'Attendance needs review'}</h2><button type="button" onClick={() => setStartAdvisory(null)} title="Close"><X size={18} /></button></header>
        {startAdvisory.stillOn && <p>Starting this shift ends your previous in-progress shift. Unfinished work remains on record. Choose Not yet to finish it properly first.</p>}
        {startAdvisory.position.status !== 'on_site' && <><p>{startAdvisory.position.status === 'no_gps' ? 'GPS is unavailable.' : startAdvisory.position.status === 'unverified_site' ? 'This site has no verified boundary.' : 'GPS does not confirm you are at the assigned place.'} Available GPS and your explanation are recorded for operations review, not as verified attendance.</p><label><span>Attendance explanation {startAdvisory.shift.service_type === 'static_guarding' ? '(required)' : '(optional)'}</span><textarea rows={3} value={startAdvisory.reason} onChange={(event) => setStartAdvisory({ ...startAdvisory, reason: event.target.value })} /></label></>}
        <div className="officer-schedule-dialog-actions"><button type="button" onClick={() => setStartAdvisory(null)}>Not yet</button><button type="button" disabled={startingShiftId === startAdvisory.shift.id || (startAdvisory.shift.service_type === 'static_guarding' && startAdvisory.position.status !== 'on_site' && !startAdvisory.reason.trim())} onClick={() => { setStartingShiftId(startAdvisory.shift.id); void submitStart(startAdvisory.shift, startAdvisory.coords, startAdvisory.reason.trim() || null).finally(() => setStartingShiftId(null)); }}>Start shift{startAdvisory.stillOn ? ' and end previous shift' : ''}</button></div>
      </div></div>}
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