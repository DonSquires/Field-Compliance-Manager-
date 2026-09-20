/**
 * DispatchConsolePage.tsx (1568 lines)
 * Real-time dispatch console for creating and managing field jobs
 *
 * Architecture:
 * - Workflow: A(shifts/jobs/resources), B(shift stops), C(agreement-owned sites), D(billing rates)
 * - Three-column layout: Shifts (left) | Stops (center) | Jobs (right); becomes tabs on mobile
 * - Shift card selection → load stops → inspect → create job
 * - Job creation form: type, priority, SLA, briefing, and agreement-owned site
 * - Active service-agreement location filtering
 * - Rate rule matching (Phase D)
 * - Mobile: 3-column layout → tab bar
 * - Supabase queries: active shifts, dispatch jobs, stops, resources, rate rules
 * - Error handling: SLA breach warnings, unrateable job warnings
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import {
  ACTIVE_DISPATCH_JOB_STATUSES,
  schemaDispatchResourceStatus,
  schemaDispatchJobPriority,
  schemaDispatchJobStatus,
  schemaShiftHealth,
  shiftHealthBadge,
} from '../lib/dispatchStatus';
import { shiftStopStatusLabel } from '../lib/shiftStopStatus';
import { resolveDispatchBillingRule, type DispatchBillingRule } from '../lib/dispatchBillingRate';
import { resolveAddressCandidates } from '../lib/locationAddress';
import { supabase } from '../lib/supabase';
import { ALARM_INTAKE_CHANNELS, ALARM_SIGNAL_TYPES, localDateTimeValue, responseLadderWords, type AlarmIntakeChannel, type AlarmSignal, type AlarmSignalType } from '../lib/alarmResponse';
import { ShellLayout } from '../layouts/ShellLayout';
import './DispatchConsolePage.css';

// Type definitions
type JobType = 'alarm_response' | 'event' | 'incident' | 'noise_control' | 'patrol_support' | 'welfare_check';
type JobPriority = 'low' | 'normal' | 'high' | 'urgent';
type JobStatus = 'pending' | 'pending_approval' | 'dispatched' | 'acknowledged' | 'en_route' | 'on_scene' | 'completed' | 'cancelled';
type ShiftStatus = 'scheduled' | 'published' | 'accepted' | 'declined' | 'in_progress' | 'completed' | 'cancelled';
type StopStatus = 'pending' | 'en_route' | 'on_scene' | 'completed' | 'skipped' | 'cancelled';
type MobileTab = 'shifts' | 'stops' | 'jobs';

interface ActiveShift {
  id: string;
  officerUserId: string;
  officerName: string;
  patrolRouteName?: string;
  patrolRouteCode?: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: ShiftStatus;
  shiftHealth: 'on_track' | 'at_risk' | 'critical' | 'breached';
  totalStops: number;
  completedStops: number;
  officerGpsLat?: number;
  officerGpsLng?: number;
  officerLastSeen?: string;
}

interface DispatchJob {
  id: string;
  jobType: JobType;
  priority: JobPriority;
  status: JobStatus;
  briefingNotes: string;
  slaMinutes: number;
  slaRespondBy: string | null;
  slaBreached: boolean;
  siteName: string;
  siteAddress: string | null;
  safetyNotes: string | null;
  accessInstructions: string | null;
  siteId: string;
  shiftId?: string;
  resourceName: string | null;
  expectedDwellMinutes: number | null;
  timingSource: string | null;
  createdAt: string;
  dispatchedAt?: string;
  acknowledgedAt?: string | null;
  enRouteAt?: string | null;
  onSceneAt?: string | null;
  completedAt?: string | null;
}

interface ClientSite {
  id: string;
  name: string;
  address: string;
  gpsLat: number;
  gpsLng: number;
  clientOrganizationId: string;
}

interface ResourceUnit {
  id: string;
  name: string;
  callsign?: string;
  assignedOfficerId?: string;
  status: 'available' | 'busy' | 'offline';
}

interface ShiftStop {
  id: string;
  shiftId: string;
  sequence: number;
  siteName: string;
  arrival?: string;
  departure?: string;
  status: StopStatus;
}

const JOB_STATUS_LABELS: Record<JobStatus, string> = { pending: 'Waiting to dispatch', pending_approval: 'Waiting for approval', dispatched: 'Dispatched', acknowledged: 'Acknowledged', en_route: 'On the way', on_scene: 'On site', completed: 'Completed', cancelled: 'Cancelled' };

const DispatchJobList: React.FC<{ jobs: DispatchJob[]; onOpen: (jobId: string) => void }> = ({ jobs, onOpen }) => (
  <div className="dispatch-job-list-wrap">
    <table className="dispatch-job-list">
      <thead><tr><th>Priority</th><th>Job</th><th>Site</th><th>Status</th><th>Assigned to</th><th>Respond by</th></tr></thead>
      <tbody>{jobs.length === 0 ? <tr><td colSpan={6} className="dispatch-job-list-empty">No active jobs</td></tr> : jobs.map((job) => <tr key={job.id} className={`priority-${job.priority} ${job.slaBreached ? 'is-sla-breached' : ''}`} onClick={() => onOpen(job.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onOpen(job.id); }}>
        <td><span className="dispatch-job-list-priority">{job.priority}</span></td><td>{JOB_TYPES.find((type) => type.id === job.jobType)?.label ?? job.jobType.replaceAll('_', ' ')}</td><td><strong>{job.siteName}</strong><small>{job.siteAddress ?? 'Address not recorded'}</small></td><td>{JOB_STATUS_LABELS[job.status]}</td><td>{job.resourceName ?? 'Unassigned'}</td><td>{job.slaRespondBy ? new Date(job.slaRespondBy).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' }) : 'Not set'}</td>
      </tr>)}</tbody>
    </table>
  </div>
);

// Job types dropdown
const JOB_TYPES: { id: JobType; label: string; icon: string }[] = [
  { id: 'alarm_response', label: 'Alarm Response', icon: '🚨' },
  { id: 'event', label: 'Event', icon: '🎪' },
  { id: 'incident', label: 'Incident', icon: '⚠️' },
  { id: 'noise_control', label: 'Noise Control', icon: '🔊' },
  { id: 'patrol_support', label: 'Patrol Support', icon: '🚗' },
  { id: 'welfare_check', label: 'Welfare Check', icon: '🚧' },
];

const PRIORITIES: { id: JobPriority; label: string; color: string }[] = [
  { id: 'low', label: 'Low', color: '#4CAF50' },
  { id: 'normal', label: 'Normal', color: '#FF9800' },
  { id: 'high', label: 'High', color: '#FF6F00' },
  { id: 'urgent', label: 'Urgent', color: '#EF5350' },
];

// Component: Shift Card
const ShiftCard: React.FC<{
  shift: ActiveShift;
  selected: boolean;
  onClick: () => void;
}> = ({ shift, selected, onClick }) => {
  const badge = shiftHealthBadge(shift.shiftHealth);

  return (
    <button
      type="button"
      className={`dispatch-shift-card ${selected ? 'is-selected' : ''}`}
      onClick={onClick}
    >
      <div className="dispatch-shift-card__header">
        <div className="dispatch-shift-card__officer">{shift.officerName}</div>
        <div
          className={`dispatch-shift-card__badge dispatch-shift-card__badge--${badge.tone}`}
          aria-label={badge.label}
        >
          {badge.label.toUpperCase()}
        </div>
      </div>
      <div className="dispatch-shift-card__route">
        {shift.patrolRouteName && `Route: ${shift.patrolRouteName}`}
      </div>
      <div className="dispatch-shift-card__detail">
        {shift.completedStops}/{shift.totalStops} stops
      </div>
    </button>
  );
};

// Component: Stop Card
const StopCard: React.FC<{ stop: ShiftStop; selected?: boolean; onSelect?: () => void }> = ({ stop, selected, onSelect }) => (
  <div
    role="button"
    tabIndex={0}
    onClick={onSelect}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect?.(); }}
    className={`dispatch-stop-card ${selected ? 'is-selected' : ''}`}
  >
    <div className="dispatch-stop-card__header">
      <div className="dispatch-stop-card__sequence">#{stop.sequence}</div>
      <div className={`dispatch-stop-card__status dispatch-stop-card__status--${stop.status}`}>
        {shiftStopStatusLabel(stop.status).toUpperCase()}
      </div>
    </div>
    <div className="dispatch-stop-card__site">{stop.siteName}</div>
    {stop.arrival && (
      <div className="dispatch-stop-card__meta">
        Arrived: {new Date(stop.arrival).toLocaleTimeString()}
      </div>
    )}
  </div>
);

// Main Component
const DispatchConsolePage: React.FC = () => {
  const location = useLocation();
  const requestedJobId = new URLSearchParams(location.search).get('job');
  const { profile, operatingOrganizationId } = useAuth();
  const operatingBranchId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const {
    selectedAgreement,
    selectedAgreementSites,
    selectedAgreementZones,
    loading: relationshipLoading,
    error: relationshipError,
  } = useServiceRelationships();

  // State: Phase A (Load initial data)
  const [activeShifts, setActiveShifts] = useState<ActiveShift[]>([]);
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [alarmsByJob, setAlarmsByJob] = useState<Record<string, AlarmSignal>>({});
  const [sites, setSites] = useState<ClientSite[]>([]);
  const [resources, setResources] = useState<ResourceUnit[]>([]);
  const [loading, setLoading] = useState(true);

  // State: Phase B (Shift stops)
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [jobDetailId, setJobDetailId] = useState<string | null>(requestedJobId);
  const [jobActionReason, setJobActionReason] = useState('');
  const [jobResourceId, setJobResourceId] = useState('');
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [shiftStops, setShiftStops] = useState<ShiftStop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(false);

  // State: Job form
  const [showNewJob, setShowNewJob] = useState(false);
  const [formJobType, setFormJobType] = useState<JobType>('alarm_response');
  const [formPriority, setFormPriority] = useState<JobPriority>('high');
  const [formSiteId, setFormSiteId] = useState<string>('');
  const [isNewIncidentLocation, setIsNewIncidentLocation] = useState(false);
  const [formLocationAddress, setFormLocationAddress] = useState('');
  const [resolvedLocation, setResolvedLocation] = useState<{ label: string; lat: number; lng: number } | null>(null);
  const [formShiftId, setFormShiftId] = useState<string>('');
  const [formResourceId, setFormResourceId] = useState<string>('');
  const [formSlaMinutes, setFormSlaMinutes] = useState(15);
  const [formNotes, setFormNotes] = useState('');
  const [formAlarmIntakeChannel, setFormAlarmIntakeChannel] = useState<AlarmIntakeChannel>('phone');
  const [formAlarmSignalType, setFormAlarmSignalType] = useState<AlarmSignalType>('burglary');
  const [formAlarmReceivedAt, setFormAlarmReceivedAt] = useState(() => localDateTimeValue(new Date()));
  const [formZoneId, setFormZoneId] = useState<string>('');
  // Harmed party (complainant) for dual-place jobs: place on the job, identity behind the guarded RPC.
  const [formComplainantAddress, setFormComplainantAddress] = useState('');
  const [resolvedComplainant, setResolvedComplainant] = useState<{ label: string; lat: number; lng: number } | null>(null);
  const [formComplainantSiteId, setFormComplainantSiteId] = useState('');
  const [formComplainantName, setFormComplainantName] = useState('');
  const [formComplainantPhone, setFormComplainantPhone] = useState('');
  const [formComplainantNotes, setFormComplainantNotes] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formRequestId, setFormRequestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operatorBusy, setOperatorBusy] = useState(false);

  // State: Phase D (Billing rates)
  const [billingRules, setBillingRules] = useState<DispatchBillingRule[]>([]);
  const [resolvedRate, setResolvedRate] = useState<DispatchBillingRule | null>(null);
  const [isUnrateable, setIsUnrateable] = useState(false);

  // State: Mobile
  const [mobileTab, setMobileTab] = useState<MobileTab>('shifts');
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  // Track mobile viewport
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Load Phase A: Active shifts, jobs, resources. Sites come from the selected
  // service agreement so contract/location access has one canonical owner.
  const loadPhaseA = useCallback(async () => {
    if (!operatingBranchId) {
      setError('Operating branch access could not be confirmed. Dispatch operations are unavailable.');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const activeZoneIds = selectedAgreementZones.length > 0 ? selectedAgreementZones.map((zone) => zone.id) : null;

      const [shiftsRes, jobsRes, resourcesRes, selectedJobRes] = await Promise.all([
        activeZoneIds && activeZoneIds.length > 0
          ? supabase
              .from('shifts')
              .select('*, officer:officer_user_id(display_name), route:patrol_route_id(name, route_code)')
              .in('zone_id', activeZoneIds)
              .in('status', ['published', 'accepted', 'in_progress'])
          : supabase
              .from('shifts')
              .select('*, officer:officer_user_id(display_name), route:patrol_route_id(name, route_code)')
              .eq('organization_id', operatingBranchId)
              .in('status', ['published', 'accepted', 'in_progress']),
        // dispatch_jobs has no zone_id: a zoned agreement scopes its jobs by the agreement itself
        activeZoneIds && activeZoneIds.length > 0 && selectedAgreement
          ? supabase
              .from('dispatch_jobs')
              .select('*, site:client_site_id(name, address, hs_notes, access_instructions), resource:dispatch_resource_id(name)')
              .eq('organization_id', operatingBranchId)
              .eq('service_agreement_id', selectedAgreement.id)
              .in('status', ACTIVE_DISPATCH_JOB_STATUSES as readonly string[])
          : supabase
              .from('dispatch_jobs')
              .select('*, site:client_site_id(name, address, hs_notes, access_instructions), resource:dispatch_resource_id(name)')
              .eq('organization_id', operatingBranchId)
              .in('status', ACTIVE_DISPATCH_JOB_STATUSES as readonly string[]),
        supabase
          .from('dispatch_resources')
          .select('id, name, callsign, status, assigned_officer_id')
          .eq('organization_id', operatingBranchId),
        requestedJobId
          ? supabase.from('dispatch_jobs').select('*, site:client_site_id(name, address, hs_notes, access_instructions), resource:dispatch_resource_id(name)').eq('id', requestedJobId).eq('organization_id', operatingBranchId).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);

      const phaseErrors = [shiftsRes.error, jobsRes.error, resourcesRes.error, selectedJobRes.error].filter(Boolean);
      if (phaseErrors.length) {
        throw new Error(phaseErrors.map((phaseError) => phaseError?.message).join(' · '));
      }

      if (shiftsRes.data) {
        const formatted: ActiveShift[] = shiftsRes.data.map((s: any) => ({
          id: s.id,
          officerUserId: s.officer_user_id,
          officerName: s.officer?.display_name || 'Officer',
          patrolRouteName: s.route?.name,
          patrolRouteCode: s.route?.route_code,
          scheduledStart: s.scheduled_start,
          scheduledEnd: s.scheduled_end,
          status: s.status,
          // shifts.shift_health is a schema-backed enum; map legacy UI labels into
          // the canonical values before rendering a badge.
          shiftHealth: schemaShiftHealth(s.shift_health ?? 'on_track'),
          totalStops: s.total_stops ?? 0,
          completedStops: s.completed_stops ?? 0,
        }));
        setActiveShifts(formatted);
      }

      if (jobsRes.data) {
        const rows = selectedJobRes.data && !jobsRes.data.some((job: { id: string }) => job.id === selectedJobRes.data.id)
          ? [selectedJobRes.data, ...jobsRes.data]
          : jobsRes.data;
        const formatted: DispatchJob[] = rows.map((j: any) => ({
          id: j.id,
          jobType: j.job_type || 'alarm_response',
          priority: j.priority || 'high',
          status: j.status,
          briefingNotes: j.briefing_notes || '',
          slaMinutes: j.sla_minutes || 15,
          slaRespondBy: j.sla_respond_by ?? null,
          slaBreached: j.sla_breached ?? false,
          siteName: j.site?.name || 'Unknown Site',
          siteAddress: j.site?.address ?? null,
          safetyNotes: j.site?.hs_notes ?? null,
          accessInstructions: j.site?.access_instructions ?? null,
          siteId: j.client_site_id,
          shiftId: j.shift_id ?? undefined,
          resourceName: j.resource?.name ?? null,
          expectedDwellMinutes: j.expected_dwell_minutes ?? null,
          timingSource: j.timing_source ?? null,
          createdAt: j.created_at,
          dispatchedAt: j.dispatched_at ?? undefined,
          acknowledgedAt: j.acknowledged_at ?? null,
          enRouteAt: j.en_route_at ?? null,
          onSceneAt: j.on_scene_at ?? null,
          completedAt: j.completed_at ?? null,
        }));
        setJobs(formatted);
        // ATLAS READS: alarm_events (one per alarm-response job; recorded by record_alarm_signal)
        const alarmJobIds = formatted.filter((job) => job.jobType === 'alarm_response').map((job) => job.id);
        if (alarmJobIds.length) {
          const { data: alarmRows } = await supabase.from('alarm_events').select('dispatch_job_id, received_at, signal_type, intake_channel, panel_id, zone_name, zone_number, account_number').in('dispatch_job_id', alarmJobIds);
          setAlarmsByJob(Object.fromEntries(((alarmRows as (AlarmSignal & { dispatch_job_id: string })[] | null) ?? []).map((row) => [row.dispatch_job_id, row])));
        } else setAlarmsByJob({});
      }

      if (resourcesRes.data) {
        setResources(
          resourcesRes.data.map((r: any) => ({
            id: r.id,
            name: r.name,
            callsign: r.callsign,
            assignedOfficerId: r.assigned_officer_id ?? undefined,
            status: schemaDispatchResourceStatus(r.status ?? 'available'),
          }))
        );
      }
    } catch (err) {
      console.error('Failed to load Phase A:', err);
      setError(err instanceof Error ? err.message : 'Failed to load dispatch operations');
    } finally {
      setLoading(false);
    }
  }, [operatingBranchId, requestedJobId, selectedAgreementZones]);

  useEffect(() => {
    if (!requestedJobId) return;
    setJobDetailId(requestedJobId);
    setMobileTab('jobs');
  }, [requestedJobId]);

  useEffect(() => {
    const activeAgreementSites = selectedAgreementSites.filter((site) => site.active);
    setSites(activeAgreementSites.map((site) => ({
      id: site.id,
      name: site.name,
      address: site.address ?? '',
      gpsLat: 0,
      gpsLng: 0,
      clientOrganizationId: site.client_organization_id ?? '',
    })));
    setFormSiteId((current) => current && activeAgreementSites.some((site) => site.id === current) ? current : '');
  }, [selectedAgreementSites]);

  // Load Phase B: Shift stops
  const loadPhaseB = useCallback(async (shiftId: string) => {
    try {
      setStopsLoading(true);

      const { data, error } = await supabase
        .from('shift_stops')
        .select('id, shift_id, stop_order, site_id, zone_id, status, actual_arrived_at, actual_departed_at')
        .eq('shift_id', shiftId)
        .order('stop_order');

      if (error) throw error;
      setShiftStops(
        (data || []).map((row: any) => ({
          id: row.id,
          shiftId: row.shift_id,
          sequence: row.stop_order,
          siteName: row.site_id ?? row.zone_id ?? 'Stop',
          arrival: row.actual_arrived_at,
          departure: row.actual_departed_at,
          status: row.status,
        }))
      );
    } catch (err) {
      console.error('Failed to load Phase B (stops):', err);
    } finally {
      setStopsLoading(false);
    }
  }, []);

  // Load Phase D: Billing rates
  // Canonical schema dimensions: client org, site/zone, job type, priority,
  // and effective dates. The resolver prefers the most specific active rule.
  const loadPhaseD = useCallback(async () => {
    if (!operatingBranchId) return;
    try {
      const { data, error } = await supabase
        .from('rate_rules')
        .select('id, amount, rate_type, client_org_id, site_id, zone_id, job_type, priority, effective_from, effective_to')
        .eq('organization_id', operatingBranchId)
        .eq('rule_kind', 'billing')
        .eq('active', true)
        .order('priority', { ascending: false })
        .limit(100);

      if (error) throw error;
      setBillingRules(
        (data || []).map((row: any) => ({
          id: row.id,
          amount: Number(row.amount),
          rateType: row.rate_type,
          clientOrgId: row.client_org_id ?? null,
          siteId: row.site_id ?? null,
          zoneId: row.zone_id ?? null,
          jobType: row.job_type ?? null,
          priority: Number(row.priority ?? 0),
          effectiveFrom: row.effective_from ?? null,
          effectiveTo: row.effective_to ?? null,
        }))
      );
    } catch (err) {
      console.error('Failed to load Phase D (rates):', err);
      setBillingRules([]);
    }
  }, [operatingBranchId]);

  // Resolve billing rate
  const resolveBillingRate = useCallback(() => {
    if (!formSiteId || !selectedAgreement?.client_organization_id) {
      setIsUnrateable(true);
      setResolvedRate(null);
      return;
    }

    const matched = resolveDispatchBillingRule(billingRules, {
      clientOrgId: selectedAgreement.client_organization_id,
      siteId: formSiteId,
      zoneId: formZoneId || null,
      jobType: formJobType,
    });

    if (matched) {
      setResolvedRate(matched);
      setIsUnrateable(false);
    } else {
      setIsUnrateable(true);
      setResolvedRate(null);
    }
  }, [formSiteId, formZoneId, formJobType, selectedAgreement?.client_organization_id, billingRules]);

  useEffect(() => {
    resolveBillingRate();
  }, [resolveBillingRate]);

  // Create job
  const handleCreateJob = useCallback(async () => {
    if ((!formSiteId && !isNewIncidentLocation) || !operatingBranchId) {
      setError('Select a site or add an incident location');
      return;
    }
    if (isNewIncidentLocation && !resolvedLocation) {
      setError('Resolve the incident address before dispatching');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      if (relationshipLoading) throw new Error('Service agreement access is still loading.');
      if (relationshipError) throw new Error(`Service agreement access could not be verified: ${relationshipError}`);
      if (!selectedAgreement) throw new Error('Select a service agreement before creating a dispatch job.');
      const briefingNotes = formJobType === 'alarm_response'
        ? `[Alarm ${ALARM_SIGNAL_TYPES.find((type) => type.id === formAlarmSignalType)?.label.toLowerCase() ?? formAlarmSignalType}, received ${new Date(formAlarmReceivedAt).toLocaleString('en-NZ')} by ${ALARM_INTAKE_CHANNELS.find((channel) => channel.id === formAlarmIntakeChannel)?.label.toLowerCase() ?? formAlarmIntakeChannel}]${formNotes.trim() ? `\n${formNotes.trim()}` : ''}`
        : formNotes || null;

      const response = isNewIncidentLocation
        ? await supabase.rpc('create_dispatch_intake_job', {
            p_organization_id: operatingBranchId, p_service_agreement_id: selectedAgreement.id, p_client_request_id: formRequestId,
            p_job_type: formJobType, p_priority: schemaDispatchJobPriority(formPriority), p_sla_minutes: formSlaMinutes,
            p_location_name: resolvedLocation!.label, p_location_address: resolvedLocation!.label, p_location_lat: resolvedLocation!.lat, p_location_lng: resolvedLocation!.lng,
            p_dispatch_resource_id: formResourceId || null, p_briefing_notes: briefingNotes, p_shift_id: formShiftId || null,
          })
        : await supabase.rpc('create_dispatch_job', {
          p_organization_id: operatingBranchId,
          p_service_agreement_id: selectedAgreement.id,
          p_client_site_id: formSiteId,
          p_client_request_id: formRequestId,
          p_job_type: formJobType,
          p_priority: schemaDispatchJobPriority(formPriority),
          p_sla_minutes: formSlaMinutes,
          p_dispatch_resource_id: formResourceId || null,
          p_briefing_notes: briefingNotes,
          p_shift_id: formShiftId || null,
        });
      const { data, error } = response;

      if (error) throw error;
      if (!data?.length) throw new Error('The dispatch job was not confirmed after creation.');

      if (formJobType === 'alarm_response') {
        // ATLAS WRITES: record_alarm_signal (the alarm becomes a record; the response clock counts from when it was received)
        const { error: alarmError } = await supabase.rpc('record_alarm_signal', {
          p_dispatch_job_id: (data as Array<{ id: string }>)[0].id, p_received_at: new Date(formAlarmReceivedAt).toISOString(),
          p_signal_type: formAlarmSignalType, p_intake_channel: formAlarmIntakeChannel,
        });
        if (alarmError) setWarning(`Job created, but the alarm time was not recorded: ${alarmError.message}. The response clock is counting from when the job was created.`);
      }

      const complainantAddress = (resolvedComplainant?.label ?? formComplainantAddress).trim();
      const hasComplainant = formJobType === 'noise_control' && Boolean(formComplainantSiteId || complainantAddress || formComplainantName.trim() || formComplainantPhone.trim() || formComplainantNotes.trim());
      if (hasComplainant) {
        // ATLAS WRITES: set_dispatch_job_harmed_party (place on the job; identity only in the protected table)
        const { data: harmedPartyData, error: harmedPartyError } = await supabase.rpc('set_dispatch_job_harmed_party', {
          p_client_request_id: crypto.randomUUID(),
          p_dispatch_job_id: (data as Array<{ id: string }>)[0].id,
          p_harmed_party_site_id: formComplainantSiteId || null,
          p_harmed_party_address: complainantAddress || null,
          p_party_role: 'complainant',
          p_display_name: formComplainantName.trim() || null,
          p_phone: formComplainantPhone.trim() || null,
          p_email: null,
          p_notes: formComplainantNotes.trim() || null,
          p_harmed_party_lat: formComplainantSiteId ? null : resolvedComplainant?.lat ?? null,
          p_harmed_party_lng: formComplainantSiteId ? null : resolvedComplainant?.lng ?? null,
        });
        const harmedPartyReceipt = (harmedPartyData as Array<{ out_harmed_party_site_id: string | null; place_created: boolean; house_action: string | null }> | null)?.[0];
        if (harmedPartyError) setWarning(`Job created, but the complainant details were not saved: ${harmedPartyError.message}. Record them on the job before dispatching.`);
        else if (harmedPartyReceipt?.house_action === 'other_org_house') setWarning('Job created. The complainant place was recorded as a provisional site but its address is already held by another organisation, so it is flagged for ownership review.');
        else if (complainantAddress && !formComplainantSiteId && !harmedPartyReceipt?.out_harmed_party_site_id) setWarning('Job created. The complainant address was not resolved to coordinates, so attendance there will be recorded by time only.');
      }

      setShowNewJob(false);
      setFormJobType('alarm_response');
      setFormPriority('high');
      setFormSiteId('');
      setIsNewIncidentLocation(false);
      setFormLocationAddress('');
      setResolvedLocation(null);
      setFormShiftId('');
      setFormResourceId('');
      setFormSlaMinutes(15);
      setFormNotes('');
      setFormAlarmIntakeChannel('phone');
      setFormAlarmSignalType('burglary');
      setFormAlarmReceivedAt(localDateTimeValue(new Date()));
      setFormZoneId('');
      setFormComplainantAddress('');
      setResolvedComplainant(null);
      setFormComplainantSiteId('');
      setFormComplainantName('');
      setFormComplainantPhone('');
      setFormComplainantNotes('');
      setFormRequestId(crypto.randomUUID());

      await loadPhaseA();
    } catch (err) {
      console.error('Failed to create job:', err);
      setError(err instanceof Error ? err.message : 'Failed to create job');
    } finally {
      setSaving(false);
    }
  }, [operatingBranchId, relationshipLoading, relationshipError, selectedAgreement, formRequestId, formJobType, formPriority, formSiteId, isNewIncidentLocation, resolvedLocation, formShiftId, formResourceId, formSlaMinutes, formNotes, loadPhaseA, formComplainantAddress, resolvedComplainant, formComplainantSiteId, formComplainantName, formComplainantPhone, formComplainantNotes, formAlarmIntakeChannel, formAlarmSignalType, formAlarmReceivedAt]);

  const resolveComplainantLocation = useCallback(async () => {
    try {
      const candidate = (await resolveAddressCandidates(formComplainantAddress, 1))[0];
      if (!candidate) throw new Error('No matching complainant address was found.');
      setResolvedComplainant(candidate);
      setFormComplainantAddress(candidate.label);
      setError(null);
    } catch (err) {
      setResolvedComplainant(null);
      setError(err instanceof Error ? err.message : 'Unable to resolve the complainant address.');
    }
  }, [formComplainantAddress]);

  const resolveIncidentLocation = useCallback(async () => {
    try {
      const candidate = (await resolveAddressCandidates(formLocationAddress, 1))[0];
      if (!candidate) throw new Error('No matching address was found.');
      setResolvedLocation(candidate);
      setFormLocationAddress(candidate.label);
      setError(null);
    } catch (err) {
      setResolvedLocation(null);
      setError(err instanceof Error ? err.message : 'Unable to resolve the incident address.');
    }
  }, [formLocationAddress]);

  const assignResource = useCallback((resourceId: string) => {
    setFormResourceId(resourceId);
    if (!resourceId) {
      setFormShiftId('');
      return;
    }
    const resource = resources.find((item) => item.id === resourceId);
    const matchingShift = activeShifts.find((shift) =>
      shift.officerUserId === resource?.assignedOfficerId && ['accepted', 'in_progress'].includes(shift.status),
    );
    setFormShiftId(matchingShift?.id ?? '');
  }, [activeShifts, resources]);

  const assignableResources = useMemo(() => resources.filter((resource) =>
    resource.status === 'available' && Boolean(resource.assignedOfficerId) && activeShifts.some((shift) =>
      shift.officerUserId === resource.assignedOfficerId && ['accepted', 'in_progress'].includes(shift.status),
    )), [activeShifts, resources]);

  // Initial load
  useEffect(() => {
    loadPhaseA();
    loadPhaseD();
  }, [loadPhaseA, loadPhaseD]);

  // Handle shift selection (Phase B)
  const handleSelectShift = useCallback(
    (shiftId: string) => {
      setSelectedShiftId(shiftId);
      setSelectedStopId(null);
      loadPhaseB(shiftId);
      if (isMobile) setMobileTab('stops');
    },
    [loadPhaseB, isMobile]
  );

  const handleSelectSite = useCallback((siteId: string) => setFormSiteId(siteId), []);

  const operatorAction = async (target: 'stop' | 'shift', action: string) => {
    const reason = window.prompt(`Reason for ${action.replaceAll('_', ' ')}:`)?.trim();
    if (!reason) return;
    const targetId = target === 'stop' ? selectedStopId : selectedShiftId;
    if (!targetId) return;
    setOperatorBusy(true); setError(null);
    const currentStatus = target === 'stop' ? shiftStops.find((stop) => stop.id === targetId)?.status : activeShifts.find((shift) => shift.id === targetId)?.status;
    const rpc = target === 'stop' ? 'manage_shift_stop' : 'manage_active_shift';
    const payload = target === 'stop'
      ? { p_stop_id: targetId, p_expected_status: currentStatus, p_action: action, p_new_order: null, p_reason: reason }
      : { p_shift_id: targetId, p_expected_status: currentStatus, p_action: action, p_notes: null, p_reason: reason };
    const { error: actionError } = await supabase.rpc(rpc, payload);
    if (actionError) setError(actionError.message); else { await loadPhaseA(); if (selectedShiftId) await loadPhaseB(selectedShiftId); }
    setOperatorBusy(false);
  };

  const selectedJob = jobs.find((job) => job.id === jobDetailId) ?? null;
  const openJobDetail = (jobId: string) => { setJobDetailId(jobId); setJobActionReason(''); setJobResourceId(''); setError(null); };
  const closeJobDetail = () => setJobDetailId(null);
  const manageJobFromDetail = async (action: 'amend' | 'reassign' | 'escalate' | 'cancel') => {
    if (!selectedJob || !jobActionReason.trim()) { setError('Write a short reason before changing this job.'); return; }
    if (action === 'reassign' && !jobResourceId) { setError('Choose the person or resource taking this job.'); return; }
    setOperatorBusy(true); setError(null);
    // ATLAS WRITES: manage_dispatch_job (optimistic status check + audit receipt on the server)
    const { error: actionError } = await supabase.rpc('manage_dispatch_job', {
      p_job_id: selectedJob.id, p_expected_status: selectedJob.status, p_action: action,
      p_priority: null, p_briefing_notes: null, p_dispatch_resource_id: action === 'reassign' ? jobResourceId : null, p_reason: jobActionReason.trim(),
    });
    if (actionError) setError(actionError.message);
    else {
      closeJobDetail();
      const outcome = action === 'cancel' ? 'cancelled' : action === 'reassign' ? 'reallocated' : action === 'escalate' ? 'escalated' : 'updated';
      setNotice(`Job ${outcome} with an audit receipt.`);
      await loadPhaseA();
    }
    setOperatorBusy(false);
  };

  const noticeBanner = notice && (
    <div className="dispatch-console-inline-success" role="status">
      {notice} <button type="button" className="btn btn-sm btn-secondary" onClick={() => setNotice(null)}>Dismiss</button>
    </div>
  );

  const jobDetailDialog = selectedJob && (
    <div className="dispatch-job-dialog-backdrop" role="presentation" onMouseDown={closeJobDetail}>
      <section
        className="dispatch-job-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Dispatch details for ${selectedJob.siteName}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className={`dispatch-job-list-priority priority-${selectedJob.priority}`}>{selectedJob.priority}</span>
            <h2>{JOB_TYPES.find((type) => type.id === selectedJob.jobType)?.label ?? selectedJob.jobType.replaceAll('_', ' ')}</h2>
            <p>{selectedJob.siteName}</p>
          </div>
          <button type="button" className="dispatch-job-dialog-close" onClick={closeJobDetail} aria-label="Close job details">×</button>
        </header>

        {error && <div className="dispatch-console-error-box" role="alert">{error}</div>}

        <div className="dispatch-job-dialog-grid">
          <div><strong>Status</strong><span>{JOB_STATUS_LABELS[selectedJob.status]}{selectedJob.slaBreached ? ' · response time breached' : ''}</span></div>
          <div><strong>Respond by</strong><span>{selectedJob.slaRespondBy ? new Date(selectedJob.slaRespondBy).toLocaleString('en-NZ') : `Not set (${selectedJob.slaMinutes} min target)`}</span></div>
          <div><strong>Assigned to</strong><span>{selectedJob.resourceName ?? 'Unassigned'}</span></div>
          <div><strong>Expected attendance</strong><span>{selectedJob.expectedDwellMinutes ?? 5} minutes · {selectedJob.timingSource?.replaceAll('_', ' ') ?? 'dispatch default'}</span></div>
        </div>

        <section className="dispatch-job-dialog-detail">
          <h3>Response so far</h3>
          {(() => {
            const ladder = responseLadderWords(selectedJob, alarmsByJob[selectedJob.id] ?? null);
            return (
              <>
                <p className={`dispatch-response-verdict is-${ladder.verdict.tone}`} role="status">{ladder.verdict.text}</p>
                <ol className="dispatch-response-steps">
                  {ladder.rows.map((row) => <li key={row.label} className={row.words === 'Not yet' ? 'is-pending' : 'is-done'}><span>{row.label}</span><strong>{row.words}</strong></li>)}
                </ol>
                {selectedJob.jobType === 'alarm_response' && !alarmsByJob[selectedJob.id] && <p className="dispatch-console-form-note">Record the alarm time on new alarm jobs so the target counts from the alarm.</p>}
              </>
            );
          })()}
        </section>

        <section className="dispatch-job-dialog-detail">
          <h3>Where and what to do</h3>
          <p><strong>Address</strong>{selectedJob.siteAddress ?? 'Address not recorded'}</p>
          {selectedJob.briefingNotes && <p><strong>Briefing</strong>{selectedJob.briefingNotes}</p>}
          {selectedJob.accessInstructions && <p><strong>Access</strong>{selectedJob.accessInstructions}</p>}
          {selectedJob.safetyNotes && <p className="is-safety"><strong>Safety</strong>{selectedJob.safetyNotes}</p>}
        </section>

        <section className="dispatch-job-dialog-actions">
          <h3>Manage this job</h3>
          <p className="dispatch-console-form-note">Every change needs a short reason. It is saved with the job as an audit receipt.</p>
          <label>
            <span>Reason for the change</span>
            <textarea value={jobActionReason} onChange={(event) => setJobActionReason(event.target.value)} placeholder="Explain what changed and why" rows={2} />
          </label>
          <label>
            <span>Reallocate to</span>
            <select value={jobResourceId} onChange={(event) => setJobResourceId(event.target.value)}>
              <option value="">Choose a currently available resource…</option>
              {assignableResources.map((resource) => (
                <option key={resource.id} value={resource.id}>{resource.callsign ? `${resource.callsign} · ` : ''}{resource.name}</option>
              ))}
            </select>
          </label>
          <div>
            <button type="button" className="btn btn-secondary" disabled={operatorBusy} onClick={() => void manageJobFromDetail('amend')}>Save details note</button>
            <button type="button" className="btn btn-secondary" disabled={operatorBusy || !jobResourceId} onClick={() => void manageJobFromDetail('reassign')}>Reallocate</button>
            <button type="button" className="btn btn-secondary" disabled={operatorBusy} onClick={() => void manageJobFromDetail('escalate')}>Escalate to urgent</button>
            <button type="button" className="btn btn-danger" disabled={operatorBusy} onClick={() => void manageJobFromDetail('cancel')}>Cancel job</button>
          </div>
        </section>
      </section>
    </div>
  );

  const openNewJob = () => { setShowNewJob(true); setError(null); if (isMobile) setMobileTab('jobs'); };

  const newJobPanel = showNewJob && (
    <div className="dispatch-console-form-panel">
      <div className="dispatch-console-form-title">Create New Job</div>

      <div className="dispatch-console-agreement-card">
        <div className="dispatch-console-form-label">Service agreement</div>
        <strong>{selectedAgreement?.name ?? 'No agreement selected'}</strong>
        <div className="dispatch-console-form-note">
          Client: {selectedAgreement?.client_name ?? selectedAgreement?.client_organization_id ?? 'Unavailable'}
        </div>
      </div>

      <div className="dispatch-console-form-field">
        <label className="dispatch-console-form-label">Job Type</label>
        <select value={formJobType} onChange={(e) => setFormJobType(e.target.value as JobType)}>
          {JOB_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </div>

      <div className="dispatch-console-form-field">
        <label className="dispatch-console-form-label">Priority</label>
        <select value={formPriority} onChange={(e) => setFormPriority(e.target.value as JobPriority)}>
          {PRIORITIES.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>

      {formJobType === 'alarm_response' && (
        <>
          <div className="dispatch-console-form-field">
            <label className="dispatch-console-form-label" htmlFor="alarm-signal-type">Alarm signal</label>
            <select id="alarm-signal-type" value={formAlarmSignalType} onChange={(e) => setFormAlarmSignalType(e.target.value as AlarmSignalType)}>
              {ALARM_SIGNAL_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
            </select>
          </div>
          <div className="dispatch-console-form-field">
            <label className="dispatch-console-form-label" htmlFor="alarm-intake-channel">How it reached us</label>
            <select id="alarm-intake-channel" value={formAlarmIntakeChannel} onChange={(e) => setFormAlarmIntakeChannel(e.target.value as AlarmIntakeChannel)}>
              {ALARM_INTAKE_CHANNELS.map((channel) => <option key={channel.id} value={channel.id}>{channel.label}</option>)}
            </select>
          </div>
          <div className="dispatch-console-form-field">
            <label className="dispatch-console-form-label" htmlFor="alarm-received-at">Alarm received at</label>
            <input id="alarm-received-at" type="datetime-local" value={formAlarmReceivedAt} max={localDateTimeValue(new Date())} onChange={(e) => setFormAlarmReceivedAt(e.target.value)} />
            <div className="dispatch-console-form-note">The response target counts from this time, not from when the job is saved.</div>
          </div>
        </>
      )}

      <div className="dispatch-console-form-field">
        <label className="dispatch-console-form-label">Site</label>
        <select value={formSiteId} disabled={isNewIncidentLocation} onChange={(e) => handleSelectSite(e.target.value)}>
          <option value="">Select a site...</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        {!relationshipLoading && sites.length === 0 && (
          <div className="dispatch-console-inline-warning">No active sites are linked to the selected agreement.</div>
        )}
        <label className="dispatch-console-check-row">
          <input type="checkbox" checked={isNewIncidentLocation} onChange={(event) => { setIsNewIncidentLocation(event.target.checked); setFormSiteId(''); setResolvedLocation(null); }} />
          Create location from this dispatch
        </label>
        {isNewIncidentLocation && (
          <div className="dispatch-console-address-row">
            <input value={formLocationAddress} onChange={(event) => { setFormLocationAddress(event.target.value); setResolvedLocation(null); }} placeholder="Incident address" />
            <button type="button" onClick={resolveIncidentLocation} disabled={!formLocationAddress.trim()} className="btn btn-sm btn-secondary">Resolve</button>
          </div>
        )}
        {isNewIncidentLocation && resolvedLocation && <div className="dispatch-console-inline-success">Resolved: {resolvedLocation.label}</div>}
      </div>

      {formJobType === 'noise_control' && (
        <div className="dispatch-console-form-field">
          <label className="dispatch-console-form-label">Complainant place (harmed party · protected)</label>
          <div className="dispatch-console-form-note">The site above is the noise source, where the officer works. Record where the complaint comes from so the officer can assess near it and attend it. Identity is stored behind an audited read — never put it in briefing notes.</div>
          <select value={formComplainantSiteId} onChange={(e) => setFormComplainantSiteId(e.target.value)} aria-label="Complainant place as a known site">
            <option value="">Not a known site — enter the address below</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <div className="dispatch-console-address-row">
            <input value={formComplainantAddress} onChange={(event) => { setFormComplainantAddress(event.target.value); setResolvedComplainant(null); }} placeholder="Complainant address" aria-label="Complainant address" />
            <button type="button" onClick={resolveComplainantLocation} disabled={!formComplainantAddress.trim()} className="btn btn-sm btn-secondary">Resolve</button>
          </div>
          {resolvedComplainant && <div className="dispatch-console-inline-success">Resolved: {resolvedComplainant.label}</div>}
          {!formComplainantSiteId && formComplainantAddress.trim() && resolvedComplainant && <div className="dispatch-console-inline-warning">Resolved address: the complainant place will be recorded as a provisional site (centre from the address, boundary unverified) so attendance there is measured, not assumed.</div>}
          {!formComplainantSiteId && formComplainantAddress.trim() && !resolvedComplainant && <div className="dispatch-console-inline-warning">Unresolved address: resolve it to give the complainant place a centre; otherwise attendance there is recorded by time only.</div>}
          <div className="dispatch-console-address-row">
            <input value={formComplainantName} onChange={(e) => setFormComplainantName(e.target.value)} placeholder="Complainant name (protected)" aria-label="Complainant name" autoComplete="off" />
            <input value={formComplainantPhone} onChange={(e) => setFormComplainantPhone(e.target.value)} placeholder="Complainant phone (protected)" aria-label="Complainant phone" autoComplete="off" />
          </div>
          <input value={formComplainantNotes} onChange={(e) => setFormComplainantNotes(e.target.value)} placeholder="Contact preferences (protected)" aria-label="Complainant contact preferences" />
        </div>
      )}

      <div className="dispatch-console-form-field">
        <label className="dispatch-console-form-label">Dispatch Resource</label>
        <select value={formResourceId} onChange={(e) => assignResource(e.target.value)}>
          <option value="">Leave in unassigned queue</option>
          {assignableResources.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resource.callsign ? `${resource.callsign} · ` : ''}{resource.name}
            </option>
          ))}
        </select>
        {formResourceId && !formShiftId && <div className="dispatch-console-inline-error">No active matching shift is available for this resource.</div>}
      </div>

      <div className="dispatch-console-form-field">
        <label className="dispatch-console-form-label">SLA Minutes</label>
        <input type="number" value={formSlaMinutes} onChange={(e) => setFormSlaMinutes(parseInt(e.target.value))} />
      </div>

      <div className="dispatch-console-form-field">
        <label className="dispatch-console-form-label">Briefing Notes</label>
        <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} />
      </div>

      {resolvedRate && (
        <div className="dispatch-console-rate-banner">
          Billing rule matched: ${resolvedRate.amount.toFixed(2)} · {resolvedRate.rateType.replace(/_/g, ' ')}
        </div>
      )}
      {isUnrateable && (
        <div className="dispatch-console-rate-warning">
          No applicable billing rule found. The job can be created, but billing requires review.
        </div>
      )}

      <div className="dispatch-console-form-actions">
        <button
          type="button"
          className="dispatch-console-primary-button"
          onClick={handleCreateJob}
          disabled={saving || (!formSiteId && !resolvedLocation) || (formJobType === 'alarm_response' && !formAlarmReceivedAt) || (Boolean(formResourceId) && !formShiftId)}
        >
          Create
        </button>
        <button type="button" className="dispatch-console-secondary-button" onClick={() => setShowNewJob(false)}>
          Cancel
        </button>
      </div>
    </div>
  );

  // Mobile: Shift + Stops + Jobs tabs
  if (isMobile) {
    return (
      <ShellLayout
        shell="admin"
        className="dispatch-console-shell"
        pageHeader={
          <header className="dispatch-console-page-header">
            <div>
              <span className="dispatch-console-eyebrow">Operations</span>
              <h1>Dispatch console</h1>
            </div>
            <span className="dispatch-console-page-meta">{jobs.length} active jobs</span>
          </header>
        }
        statusStrip={
          <div className="dispatch-console-status-strip">
            <span>{error ? 'Attention needed' : loading ? 'Refreshing live callout data' : 'Operations steady'}</span>
            <span>{activeShifts.length} shifts · {shiftStops.length} stops</span>
          </div>
        }
      >
        <div className="dispatch-console-mobile-stack">
          <div className="dispatch-console-mobile-tabs" role="tablist" aria-label="Dispatch console sections">
            {(['shifts', 'stops', 'jobs'] as MobileTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                className={`dispatch-console-mobile-tab ${mobileTab === tab ? 'is-active' : ''}`}
                onClick={() => setMobileTab(tab)}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          <div className="dispatch-console-mobile-pane">
            {error && !selectedJob && <div className="dispatch-console-error-box">{error}</div>}
            {noticeBanner}
            {warning && <div className="dispatch-console-inline-warning" role="status">{warning} <button type="button" className="btn btn-sm btn-secondary" onClick={() => setWarning(null)}>Dismiss</button></div>}
            {mobileTab === 'shifts' && (
              <div className="dispatch-console-list dispatch-console-list--stacked">
                <button type="button" className="dispatch-console-primary-button" onClick={openNewJob}>
                  + New Job
                </button>
                {loading ? (
                  <div className="dispatch-console-empty-state">Loading shifts...</div>
                ) : (
                  activeShifts.map((shift) => (
                    <ShiftCard
                      key={shift.id}
                      shift={shift}
                      selected={selectedShiftId === shift.id}
                      onClick={() => handleSelectShift(shift.id)}
                    />
                  ))
                )}
              </div>
            )}

            {mobileTab === 'stops' && (
              <div className="dispatch-console-list dispatch-console-list--stacked">
                {stopsLoading ? (
                  <div className="dispatch-console-empty-state">Loading stops...</div>
                ) : shiftStops.length === 0 ? (
                  <div className="dispatch-console-empty-state">Select a shift to view stops</div>
                ) : (
                  shiftStops.map((stop) => <StopCard key={stop.id} stop={stop} selected={stop.id === selectedStopId} onSelect={() => setSelectedStopId(stop.id)} />)
                )}
              </div>
            )}

            {mobileTab === 'jobs' && (
              <div className="dispatch-console-list dispatch-console-list--stacked">
                {!showNewJob && (
                  <button type="button" className="dispatch-console-primary-button" onClick={openNewJob}>
                    + New Job
                  </button>
                )}
                {newJobPanel}
                {jobs.length === 0 ? (
                  <div className="dispatch-console-empty-state">No active jobs</div>
                ) : (
                  <DispatchJobList jobs={jobs} onOpen={openJobDetail} />
                )}
              </div>
            )}
          </div>
        </div>
        {jobDetailDialog}
      </ShellLayout>
    );
  }

  // Desktop: Three-column layout
  return (
    <ShellLayout
      shell="admin"
      className="dispatch-console-shell"
      pageHeader={
        <header className="dispatch-console-page-header">
          <div>
            <span className="dispatch-console-eyebrow">Operations</span>
            <h1>Dispatch console</h1>
          </div>
          <div className="dispatch-console-page-meta">
            <span>{activeShifts.length} live shifts</span>
            <span>{jobs.length} open jobs</span>
          </div>
        </header>
      }
      statusStrip={
        <div className="dispatch-console-status-strip">
          <span>{error ? 'Action needed on active dispatch work' : 'No critical dispatch issues reported'}</span>
          <span>{shiftStops.length} stop checkpoints tracked</span>
        </div>
      }
    >
      <div className="dispatch-console-board">
        <div className="dispatch-console-column">
          <div className="dispatch-console-column-header">
            <span>Active Shifts</span>
            <strong>({activeShifts.length})</strong>
          </div>
          {error && !selectedJob && <div className="dispatch-console-error-box">{error}</div>}
          {noticeBanner}
          {warning && <div className="dispatch-console-inline-warning" role="status">{warning} <button type="button" className="btn btn-sm btn-secondary" onClick={() => setWarning(null)}>Dismiss</button></div>}
          <button type="button" className="dispatch-console-primary-button" onClick={() => (showNewJob ? setShowNewJob(false) : openNewJob())}>
            {showNewJob ? 'Close new job form' : '+ New Job'}
          </button>
          {loading ? (
            <div className="dispatch-console-empty-state">Loading shifts...</div>
          ) : (
            <div className="dispatch-console-list">
              {activeShifts.map((shift) => (
                <ShiftCard
                  key={shift.id}
                  shift={shift}
                  selected={selectedShiftId === shift.id}
                  onClick={() => handleSelectShift(shift.id)}
                />
              ))}
            </div>
          )}
          {selectedShiftId && <div className="dispatch-operator-actions"><strong>Selected shift</strong><div><button type="button" onClick={() => void operatorAction('shift', 'amend')} disabled={operatorBusy}>Amend shift</button><button type="button" onClick={() => void operatorAction('shift', 'escalate')} disabled={operatorBusy}>Escalate attendance</button><button type="button" onClick={() => void operatorAction('shift', 'cancel')} disabled={operatorBusy}>Cancel shift</button></div></div>}
        </div>

        <div className="dispatch-console-column">
          <div className="dispatch-console-column-header">
            <span>Shift Stops</span>
            <strong>({shiftStops.length})</strong>
          </div>
          {stopsLoading ? (
            <div className="dispatch-console-empty-state">Loading stops...</div>
          ) : selectedShiftId === null ? (
            <div className="dispatch-console-empty-state">Select a shift to view stops</div>
          ) : (
            <div className="dispatch-console-list">
              {shiftStops.map((stop) => (
                <StopCard key={stop.id} stop={stop} selected={stop.id === selectedStopId} onSelect={() => setSelectedStopId(stop.id)} />
              ))}
            </div>
          )}
          {selectedStopId && <div className="dispatch-operator-actions"><strong>Selected stop</strong><div><button type="button" onClick={() => void operatorAction('stop', 'reorder')} disabled={operatorBusy}>Change position</button><button type="button" onClick={() => void operatorAction('stop', 'skip')} disabled={operatorBusy}>Skip stop</button><button type="button" onClick={() => void operatorAction('stop', 'cancel')} disabled={operatorBusy}>Cancel stop</button></div></div>}
        </div>

        <div className="dispatch-console-column">
          <div className="dispatch-console-column-header">
            <span>Active Jobs</span>
            <strong>({jobs.length})</strong>
          </div>

          {newJobPanel}

          <DispatchJobList jobs={jobs} onOpen={openJobDetail} />
        </div>
      </div>
      {jobDetailDialog}
    </ShellLayout>
  );
};

export default DispatchConsolePage;
