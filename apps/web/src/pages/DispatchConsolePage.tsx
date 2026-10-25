/**
 * DispatchConsolePage.tsx (1568 lines)
 * Real-time dispatch console for creating and managing field jobs
 *
 * Architecture:
 * - Workflow: A(shifts/jobs/resources), B(shift stops), C(agreement-owned places), D(billing rates)
 * - Three-column layout: Shifts (left) | Stops (center) | Jobs (right); becomes tabs on mobile
 * - Shift card selection → load stops → inspect → create job
 * - Job creation form: type, priority, SLA, briefing, and agreement-owned Site or Zone
 * - Active service-agreement location filtering
 * - Rate rule matching (Phase D)
 * - Mobile: 3-column layout → tab bar
 * - Supabase queries: active shifts, dispatch jobs, stops, resources, rate rules
 * - Error handling: SLA breach warnings, unrateable job warnings
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { MapPin } from 'lucide-react';
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
import { BillingBasisChip, BillingBasisFields, ClientReferenceField, DispatchJobBillingPanel, saveJobBillingBasis, saveJobClientReference, useExtraWorkOrders, type BillingBasis, type BillingFormChoice } from '../components/DispatchBillingBasis';
import { COMMERCIAL_MODEL_HELP, commercialModelLabel, loadCommercialModels, useAgreementCommercialModels, usesContractExtra, type CommercialModel } from '../lib/commercialModel';
import { localToday } from '../lib/agreementTerm';
import { resolveDispatchBillingRule, type DispatchBillingRule } from '../lib/dispatchBillingRate';
import { findNearestAvailableUnit } from '../lib/dispatch/nearestUnit';
import { resolveAddressCandidates } from '../lib/locationAddress';
import { supabase } from '../lib/supabase';
import { agreementOptionSuffix } from '../lib/agreementTerm';
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
  actualStart?: string;
  notes?: string;
  updatedAt: string;
  serviceAgreementId?: string;
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
  siteId: string | null;
  zoneId: string | null;
  shiftId?: string;
  shiftStopId?: string;
  resourceName: string | null;
  expectedDwellMinutes: number | null;
  timingSource: string | null;
  createdAt: string;
  dispatchedAt?: string;
  acknowledgedAt?: string | null;
  enRouteAt?: string | null;
  onSceneAt?: string | null;
  completedAt?: string | null;
  serviceAgreementId: string | null;
  billingBasis: BillingBasis | null;
  extraWorkOrderId: string | null;
  commercialModel?: CommercialModel | null;
  clientOrderReference?: string | null;
}

interface ClientSite {
  id: string;
  name: string;
  address: string;
  gpsLat: number | null;
  gpsLng: number | null;
  clientOrganizationId: string;
}

interface DispatchZone {
  id: string;
  name: string;
}

interface ResourceUnit {
  id: string;
  name: string;
  callsign?: string;
  assignedOfficerId?: string;
  status: 'available' | 'busy' | 'offline';
  gpsLat: number | null;
  gpsLng: number | null;
  gpsRecordedAt: string | null;
}

interface DirectOfficer {
  id: string;
  displayName: string;
}

interface DispatchWorkUnit {
  id: string;
  name: string;
  serviceType: string;
}

interface ShiftStop {
  id: string;
  shiftId: string;
  sequence: number;
  siteName: string;
  updatedAt: string;
  arrival?: string;
  departure?: string;
  status: StopStatus;
}

type RunsheetAction =
  | 'amend'
  | 'escalate'
  | 'cancel_shift'
  | 'reorder'
  | 'skip'
  | 'cancel_stop';

interface RunsheetActionDraft {
  target: 'shift' | 'stop';
  action: RunsheetAction;
  clientRequestId: string;
  reason: string;
  notes: string;
  newOrder: number | null;
}

const JOB_STATUS_LABELS: Record<JobStatus, string> = { pending: 'Waiting to dispatch', pending_approval: 'Waiting for approval', dispatched: 'Dispatched', acknowledged: 'Acknowledged', en_route: 'On the way', on_scene: 'On site', completed: 'Completed', cancelled: 'Cancelled' };

const DispatchJobList: React.FC<{ jobs: DispatchJob[]; onOpen: (jobId: string) => void }> = ({ jobs, onOpen }) => (
  <div className="dispatch-job-list-wrap">
    <table className="dispatch-job-list">
      <thead><tr><th>Priority</th><th>Job</th><th>Place</th><th>Status</th><th>Assigned to</th><th>Respond by</th></tr></thead>
      <tbody>{jobs.length === 0 ? <tr><td colSpan={6} className="dispatch-job-list-empty">No active jobs</td></tr> : jobs.map((job) => <tr key={job.id} className={`priority-${job.priority} ${job.slaBreached ? 'is-sla-breached' : ''}`} onClick={() => onOpen(job.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onOpen(job.id); }}>
        <td><span className="dispatch-job-list-priority">{job.priority}</span></td><td>{JOB_TYPES.find((type) => type.id === job.jobType)?.label ?? job.jobType.replaceAll('_', ' ')} <BillingBasisChip job={job} /></td><td><strong>{job.siteName}</strong><small>{job.siteAddress ?? 'Address or route point not recorded'}</small></td><td>{JOB_STATUS_LABELS[job.status]}</td><td>{job.resourceName ?? 'Unassigned'}</td><td>{job.slaRespondBy ? new Date(job.slaRespondBy).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' }) : 'Not set'}</td>
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
    agreements,
    selectAgreement,
    selectedAgreement,
    selectedAgreementSites,
    selectedAgreementZones,
    loading: relationshipLoading,
    error: relationshipError,
  } = useServiceRelationships();
  // Jobs are created under an agreement this branch holds; the house-wide context also carries sibling branches' agreements.
  const branchAgreements = useMemo(() => agreements.filter((agreement) => agreement.provider_organization_id === operatingBranchId), [agreements, operatingBranchId]);
  useEffect(() => {
    if (relationshipLoading || !branchAgreements.length) return;
    if (!selectedAgreement || selectedAgreement.provider_organization_id !== operatingBranchId) selectAgreement(branchAgreements[0].id);
  }, [branchAgreements, operatingBranchId, relationshipLoading, selectAgreement, selectedAgreement]);

  // State: Phase A (Load initial data)
  const [activeShifts, setActiveShifts] = useState<ActiveShift[]>([]);
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [alarmsByJob, setAlarmsByJob] = useState<Record<string, AlarmSignal>>({});
  const [sites, setSites] = useState<ClientSite[]>([]);
  const [zones, setZones] = useState<DispatchZone[]>([]);
  const [resources, setResources] = useState<ResourceUnit[]>([]);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // State: Phase B (Shift stops)
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [jobDetailId, setJobDetailId] = useState<string | null>(requestedJobId);
  const [jobActionReason, setJobActionReason] = useState('');
  const [jobResourceId, setJobResourceId] = useState('');
  const [jobSlaMinutes, setJobSlaMinutes] = useState(15);
  const [jobDwellMinutes, setJobDwellMinutes] = useState(5);
  const [jobTimingSource, setJobTimingSource] = useState('dispatcher_override');
  const [jobTimingReason, setJobTimingReason] = useState('');
  const [jobRunsheetReason, setJobRunsheetReason] = useState('');
  const [jobRunsheetRequestId, setJobRunsheetRequestId] = useState(() => crypto.randomUUID());
  const [showRunsheetInsertConfirm, setShowRunsheetInsertConfirm] = useState(false);
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
  const [formDirectOfficerId, setFormDirectOfficerId] = useState('');
  const [formWorkUnitId, setFormWorkUnitId] = useState('');
  const [directOfficers, setDirectOfficers] = useState<DirectOfficer[]>([]);
  const [dispatchWorkUnits, setDispatchWorkUnits] = useState<DispatchWorkUnit[]>([]);
  const [formSlaMinutes, setFormSlaMinutes] = useState(15);
  const [formNotes, setFormNotes] = useState('');
  const [formAlarmIntakeChannel, setFormAlarmIntakeChannel] = useState<AlarmIntakeChannel>('phone');
  const [formAlarmSignalType, setFormAlarmSignalType] = useState<AlarmSignalType>('burglary');
  const [formAlarmReceivedAt, setFormAlarmReceivedAt] = useState(() => localDateTimeValue(new Date()));
  const [formZoneId, setFormZoneId] = useState<string>('');
  const [formBilling, setFormBilling] = useState<BillingFormChoice>('');
  const [formExtraOrderId, setFormExtraOrderId] = useState('');
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
  const [runsheetAction, setRunsheetAction] = useState<RunsheetActionDraft | null>(null);

  const { orders: agreementExtraOrders } = useExtraWorkOrders(selectedAgreement?.id);
  const selectedAgreementIds = useMemo(() => (selectedAgreement ? [selectedAgreement.id] : []), [selectedAgreement]);
  const { models: selectedAgreementModels, loading: selectedModelLoading, error: selectedModelError } = useAgreementCommercialModels(selectedAgreementIds);
  const selectedCommercialModel = selectedAgreement ? selectedAgreementModels.get(selectedAgreement.id) ?? null : null;
  const formUsesContractExtra = usesContractExtra(selectedCommercialModel);
  const [formClientReference, setFormClientReference] = useState('');

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
  const loadPhaseA = useCallback(async (background = false) => {
    if (!operatingBranchId) {
      setError('Operating branch access could not be confirmed. Dispatch operations are unavailable.');
      setLoading(false);
      return;
    }

    try {
      if (!background) setLoading(true);
      const activeZoneIds = selectedAgreementZones.length > 0 ? selectedAgreementZones.map((zone) => zone.id) : null;

      const [shiftsRes, jobsRes, resourcesRes, selectedJobRes, officersRes, workUnitsRes] = await Promise.all([
        activeZoneIds && activeZoneIds.length > 0
          ? supabase
              .from('shifts')
              .select('*, officer:officer_user_id(display_name), route:patrol_route_id(name, route_code), agreement_location:service_agreement_location_id(service_agreement_id), agreement_module:service_agreement_module_id(service_agreement_id)')
              .eq('organization_id', operatingBranchId)
              .in('zone_id', activeZoneIds)
              .in('status', ['published', 'accepted', 'in_progress'])
          : supabase
              .from('shifts')
              .select('*, officer:officer_user_id(display_name), route:patrol_route_id(name, route_code), agreement_location:service_agreement_location_id(service_agreement_id), agreement_module:service_agreement_module_id(service_agreement_id)')
              .eq('organization_id', operatingBranchId)
              .in('status', ['published', 'accepted', 'in_progress']),
        // dispatch_jobs has no zone_id: a zoned agreement scopes its jobs by the agreement itself
        activeZoneIds && activeZoneIds.length > 0 && selectedAgreement
          ? supabase
              .from('dispatch_jobs')
              .select('*, site:client_site_id(name, address, hs_notes, access_instructions), zone:zone_id(name, zone_type), resource:dispatch_resource_id(name)')
              .eq('organization_id', operatingBranchId)
              .eq('service_agreement_id', selectedAgreement.id)
              .in('status', ACTIVE_DISPATCH_JOB_STATUSES as readonly string[])
          : supabase
              .from('dispatch_jobs')
              .select('*, site:client_site_id(name, address, hs_notes, access_instructions), zone:zone_id(name, zone_type), resource:dispatch_resource_id(name)')
              .eq('organization_id', operatingBranchId)
              .in('status', ACTIVE_DISPATCH_JOB_STATUSES as readonly string[]),
        supabase
          .from('dispatch_resources')
          .select('id, name, callsign, status, assigned_officer_id')
          .eq('organization_id', operatingBranchId),
        requestedJobId
          ? supabase.from('dispatch_jobs').select('*, site:client_site_id(name, address, hs_notes, access_instructions), zone:zone_id(name, zone_type), resource:dispatch_resource_id(name)').eq('id', requestedJobId).eq('organization_id', operatingBranchId).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        supabase.rpc('get_manageable_user_identities', { p_operating_organization_id: operatingBranchId }),
        supabase.from('roster_work_units').select('id,name,service_type').eq('organization_id', operatingBranchId).eq('active', true).order('name'),
      ]);

      const phaseErrors = [shiftsRes.error, jobsRes.error, resourcesRes.error, selectedJobRes.error, officersRes.error, workUnitsRes.error].filter(Boolean);
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
          actualStart: s.actual_start ?? undefined,
          notes: s.notes ?? undefined,
          updatedAt: s.updated_at,
          serviceAgreementId: s.agreement_location?.service_agreement_id ?? s.agreement_module?.service_agreement_id ?? undefined,
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
          siteName: j.site?.name || j.zone?.name || 'Unknown place',
          siteAddress: j.site?.address ?? (j.zone ? 'Zone or service area' : null),
          safetyNotes: j.site?.hs_notes ?? null,
          accessInstructions: j.site?.access_instructions ?? null,
          siteId: j.client_site_id ?? null,
          zoneId: j.zone_id ?? null,
          shiftId: j.shift_id ?? undefined,
          shiftStopId: j.shift_stop_id ?? undefined,
          resourceName: j.resource?.name ?? null,
          expectedDwellMinutes: j.expected_dwell_minutes ?? null,
          timingSource: j.timing_source ?? null,
          createdAt: j.created_at,
          dispatchedAt: j.dispatched_at ?? undefined,
          acknowledgedAt: j.acknowledged_at ?? null,
          enRouteAt: j.en_route_at ?? null,
          onSceneAt: j.on_scene_at ?? null,
          completedAt: j.completed_at ?? null,
          serviceAgreementId: j.service_agreement_id ?? null,
          billingBasis: j.billing_basis ?? null,
          extraWorkOrderId: j.extra_work_order_id ?? null,
          clientOrderReference: j.client_order_reference ?? null,
        }));
        const { models: jobModels, error: modelError } = await loadCommercialModels(formatted.map((job) => job.serviceAgreementId ?? ''));
        if (modelError) throw new Error(`Billing models could not be loaded: ${modelError}`);
        for (const job of formatted) job.commercialModel = job.serviceAgreementId ? jobModels.get(job.serviceAgreementId) ?? null : null;
        setJobs(formatted);
        // ATLAS READS: alarm_events (one per alarm-response job; recorded by record_alarm_signal)
        const alarmJobIds = formatted.filter((job) => job.jobType === 'alarm_response').map((job) => job.id);
        if (alarmJobIds.length) {
          const { data: alarmRows } = await supabase.from('alarm_events').select('dispatch_job_id, received_at, signal_type, intake_channel, panel_id, zone_name, zone_number, account_number').in('dispatch_job_id', alarmJobIds);
          setAlarmsByJob(Object.fromEntries(((alarmRows as (AlarmSignal & { dispatch_job_id: string })[] | null) ?? []).map((row) => [row.dispatch_job_id, row])));
        } else setAlarmsByJob({});
      }

      if (resourcesRes.data) {
        const officerIds = [...new Set(resourcesRes.data.map((resource: any) => resource.assigned_officer_id).filter(Boolean))] as string[];
        const positions = new Map<string, { gps_lat: number; gps_lng: number; recorded_at: string }>();
        if (officerIds.length) {
          const freshAfter = new Date(Date.now() - 5 * 60_000).toISOString();
          const { data: gpsRows, error: gpsError } = await supabase
            .from('officer_gps_log')
            .select('officer_id,gps_lat,gps_lng,recorded_at')
            .eq('organization_id', operatingBranchId)
            .in('officer_id', officerIds)
            .gte('recorded_at', freshAfter)
            .order('recorded_at', { ascending: false })
            .limit(500);
          if (gpsError) setPositionError('Live officer positions are unavailable; nearest-unit suggestions are hidden.');
          else {
            setPositionError(null);
            for (const row of gpsRows ?? []) {
              if (!positions.has(row.officer_id)) positions.set(row.officer_id, { gps_lat: Number(row.gps_lat), gps_lng: Number(row.gps_lng), recorded_at: row.recorded_at });
            }
          }
        } else setPositionError(null);
        setResources(resourcesRes.data.map((r: any) => {
          const position = r.assigned_officer_id ? positions.get(r.assigned_officer_id) : null;
          return ({
            id: r.id,
            name: r.name,
            callsign: r.callsign,
            assignedOfficerId: r.assigned_officer_id ?? undefined,
            status: schemaDispatchResourceStatus(r.status ?? 'available'),
            gpsLat: position?.gps_lat ?? null,
            gpsLng: position?.gps_lng ?? null,
            gpsRecordedAt: position?.recorded_at ?? null,
          });
        }));
      }
      setDirectOfficers(
        ((officersRes.data as Array<{ id: string; display_name: string | null; email: string | null; role: string; deactivated_at: string | null }> | null) ?? [])
          .filter((officer) => !officer.deactivated_at && ['officer', 'admin_officer'].includes(officer.role))
          .map((officer) => ({ id: officer.id, displayName: officer.display_name || officer.email || 'Officer' })),
      );
      setDispatchWorkUnits(
        ((workUnitsRes.data as Array<{ id: string; name: string; service_type: string }> | null) ?? [])
          .map((unit) => ({ id: unit.id, name: unit.name, serviceType: unit.service_type })),
      );
    } catch (err) {
      console.error('Failed to load Phase A:', err);
      setError(err instanceof Error ? err.message : 'Failed to load dispatch operations');
    } finally {
      setLoading(false);
    }
  }, [operatingBranchId, requestedJobId, selectedAgreement, selectedAgreementZones]);

  useEffect(() => {
    if (!requestedJobId) return;
    setJobDetailId(requestedJobId);
    setMobileTab('jobs');
  }, [requestedJobId]);

  useEffect(() => {
    let cancelled = false;
    const activeAgreementSites = selectedAgreementSites.filter((site) => site.active);
    const activeAgreementZones = selectedAgreementZones.filter((zone) => zone.is_active);
    setSites(activeAgreementSites.map((site) => ({
      id: site.id,
      name: site.name,
      address: site.address ?? '',
      gpsLat: null,
      gpsLng: null,
      clientOrganizationId: site.client_organization_id ?? '',
    })));
    const siteIds = activeAgreementSites.map((site) => site.id);
    if (siteIds.length) {
      void supabase.from('client_sites').select('id,gps_lat,gps_lng').in('id', siteIds).then(({ data, error }) => {
        if (cancelled || error || !data) return;
        const coordinates = new Map(data.map((site) => [site.id, { gpsLat: site.gps_lat == null ? null : Number(site.gps_lat), gpsLng: site.gps_lng == null ? null : Number(site.gps_lng) }]));
        setSites((current) => current.map((site) => ({ ...site, ...coordinates.get(site.id) })));
      });
    }
    setZones(activeAgreementZones.map((zone) => ({ id: zone.id, name: zone.name })));
    setFormSiteId((current) => current && activeAgreementSites.some((site) => site.id === current) ? current : '');
    setFormZoneId((current) => current && activeAgreementZones.some((zone) => zone.id === current) ? current : '');
    return () => { cancelled = true; };
  }, [selectedAgreementSites, selectedAgreementZones]);

  // Load Phase B: Shift stops
  const loadPhaseB = useCallback(async (shiftId: string, background = false) => {
    try {
      if (!background) setStopsLoading(true);

      const { data, error } = await supabase
        .from('shift_stops')
        .select('id, shift_id, stop_order, site_id, zone_id, status, actual_arrived_at, actual_departed_at, updated_at, site:site_id(name), zone:zone_id(name)')
        .eq('shift_id', shiftId)
        .order('stop_order');

      if (error) throw error;
      setShiftStops(
        (data || []).map((row: any) => ({
          id: row.id,
          shiftId: row.shift_id,
          sequence: row.stop_order,
          siteName: (Array.isArray(row.site) ? row.site[0]?.name : row.site?.name) ?? (Array.isArray(row.zone) ? row.zone[0]?.name : row.zone?.name) ?? 'Place unavailable',
          updatedAt: row.updated_at,
          arrival: row.actual_arrived_at,
          departure: row.actual_departed_at,
          status: row.status,
        }))
      );
    } catch (err) {
      console.error('Failed to load Phase B (stops):', err);
      setError(err instanceof Error ? err.message : 'The selected patrol run sheet could not be refreshed.');
    } finally {
      if (!background) setStopsLoading(false);
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
    if ((!formSiteId && !formZoneId) || !selectedAgreement?.client_organization_id) {
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
    if ((!formSiteId && !formZoneId && !isNewIncidentLocation) || !operatingBranchId) {
      setError('Select a site or zone, or add an incident location');
      return;
    }
    if (isNewIncidentLocation && !resolvedLocation) {
      setError('Resolve the incident address before dispatching');
      return;
    }
    if (selectedAgreement && selectedModelLoading) {
      setError('The agreement billing model is still loading. Try again in a moment.');
      return;
    }
    if (selectedModelError) {
      setError(`The agreement billing model could not be loaded: ${selectedModelError}`);
      return;
    }
    if (formUsesContractExtra && !formBilling) {
      setError('Choose billing for this job: Contracted work, Extra, or Decide later.');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      if (relationshipLoading) throw new Error('Service agreement access is still loading.');
      if (relationshipError) throw new Error(`Service agreement access could not be verified: ${relationshipError}`);
      if (!selectedAgreement) throw new Error('Select a service agreement before creating a dispatch job.');
      const directWorkUnit = dispatchWorkUnits.find((unit) => unit.id === formWorkUnitId);
      if (formDirectOfficerId && (!formSiteId || formZoneId || isNewIncidentLocation)) {
        throw new Error('Direct officer queueing requires an agreement-linked site. Use the ordinary queue for a zone or provisional incident location.');
      }
      if (formDirectOfficerId && !directWorkUnit) {
        throw new Error('Choose the work unit that authorizes this direct officer job.');
      }
      const briefingNotes = formJobType === 'alarm_response'
        ? `[Alarm ${ALARM_SIGNAL_TYPES.find((type) => type.id === formAlarmSignalType)?.label.toLowerCase() ?? formAlarmSignalType}, received ${new Date(formAlarmReceivedAt).toLocaleString('en-NZ')} by ${ALARM_INTAKE_CHANNELS.find((channel) => channel.id === formAlarmIntakeChannel)?.label.toLowerCase() ?? formAlarmIntakeChannel}]${formNotes.trim() ? `\n${formNotes.trim()}` : ''}`
        : formNotes || null;

      const response = formDirectOfficerId
        ? await supabase.rpc('queue_dispatch_job_for_officer', {
            p_organization_id: operatingBranchId,
            p_service_agreement_id: selectedAgreement.id,
            p_client_site_id: formSiteId,
            p_client_request_id: formRequestId,
            p_officer_user_id: formDirectOfficerId,
            p_work_unit_id: directWorkUnit!.id,
            p_module_key: directWorkUnit!.serviceType,
            p_job_type: formJobType,
            p_priority: schemaDispatchJobPriority(formPriority),
            p_sla_minutes: formSlaMinutes,
            p_briefing_notes: briefingNotes,
          })
        : isNewIncidentLocation
        ? await supabase.rpc('create_dispatch_intake_job', {
            p_organization_id: operatingBranchId, p_service_agreement_id: selectedAgreement.id, p_client_request_id: formRequestId,
            p_job_type: formJobType, p_priority: schemaDispatchJobPriority(formPriority), p_sla_minutes: formSlaMinutes,
            p_location_name: resolvedLocation!.label, p_location_address: resolvedLocation!.label, p_location_lat: resolvedLocation!.lat, p_location_lng: resolvedLocation!.lng,
            p_dispatch_resource_id: formResourceId || null, p_briefing_notes: briefingNotes, p_shift_id: formShiftId || null,
          })
        : await supabase.rpc('create_dispatch_job_for_place', {
          p_organization_id: operatingBranchId,
          p_service_agreement_id: selectedAgreement.id,
          p_client_site_id: formSiteId || null,
          p_zone_id: formZoneId || null,
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

      const createdJobId = (data as Array<{ id: string }>)[0].id;
      if (formUsesContractExtra && (formBilling === 'contract' || formBilling === 'extra')) {
        const { error: billingError } = await saveJobBillingBasis(createdJobId, formBilling, formExtraOrderId, null);
        if (billingError) setWarning(`Job created, but its billing was not set: ${billingError.message}. Open the job and set billing before it is invoiced.`);
      }
      if (selectedCommercialModel === 'per_request' && formClientReference.trim()) {
        const { error: referenceError } = await saveJobClientReference(createdJobId, formClientReference.trim(), null);
        if (referenceError) setWarning(`Job created, but the client reference was not saved: ${referenceError.message}. Open the job and add it before it is invoiced.`);
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
      setFormDirectOfficerId('');
      setFormWorkUnitId('');
      setFormSlaMinutes(15);
      setFormNotes('');
      setFormAlarmIntakeChannel('phone');
      setFormAlarmSignalType('burglary');
      setFormAlarmReceivedAt(localDateTimeValue(new Date()));
      setFormZoneId('');
      setFormBilling('');
      setFormExtraOrderId('');
      setFormClientReference('');
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
  }, [operatingBranchId, relationshipLoading, relationshipError, selectedAgreement, formRequestId, formJobType, formPriority, formSiteId, formZoneId, isNewIncidentLocation, resolvedLocation, formShiftId, formResourceId, formDirectOfficerId, formWorkUnitId, dispatchWorkUnits, formSlaMinutes, formNotes, loadPhaseA, formComplainantAddress, resolvedComplainant, formComplainantSiteId, formComplainantName, formComplainantPhone, formComplainantNotes, formAlarmIntakeChannel, formAlarmSignalType, formAlarmReceivedAt, formBilling, formExtraOrderId, selectedModelLoading, selectedModelError, formUsesContractExtra, selectedCommercialModel, formClientReference]);

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

  const nearestUnit = useMemo(() => {
    const site = sites.find((candidate) => candidate.id === formSiteId);
    const target = isNewIncidentLocation && resolvedLocation
      ? { gpsLat: resolvedLocation.lat, gpsLng: resolvedLocation.lng }
      : site;
    if (!target || target.gpsLat == null || target.gpsLng == null) return null;
    const now = Date.now();
    const freshResources = assignableResources.filter((resource) => {
      if (resource.gpsLat == null || resource.gpsLng == null || !resource.gpsRecordedAt) return false;
      const age = now - new Date(resource.gpsRecordedAt).getTime();
      return age >= 0 && age <= 5 * 60_000;
    }).map((resource) => ({
      id: resource.id,
      name: resource.name,
      callsign: resource.callsign ?? null,
      status: resource.status,
      gpsLat: resource.gpsLat,
      gpsLng: resource.gpsLng,
    }));
    return findNearestAvailableUnit(target, freshResources, '');
  }, [assignableResources, formSiteId, isNewIncidentLocation, resolvedLocation, sites]);

  // Initial load, then every 30 s and whenever the tab comes back: officers acknowledge, arrive and complete
  // from their own app, and SLA clocks run, so the console must not sit on a stale picture.
  useEffect(() => {
    loadPhaseA();
    loadPhaseD();
    const interval = window.setInterval(() => void loadPhaseA(true), 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void loadPhaseA(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  }, [loadPhaseA, loadPhaseD]);

  useEffect(() => {
    if (!selectedShiftId) return;
    const refreshStops = () => void loadPhaseB(selectedShiftId, true);
    const interval = window.setInterval(refreshStops, 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') refreshStops(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  }, [selectedShiftId, loadPhaseB]);

  // Handle shift selection (Phase B)
  const handleSelectShift = useCallback(
    (shiftId: string) => {
      setSelectedShiftId(shiftId);
      setSelectedStopId(null);
      setRunsheetAction(null);
      loadPhaseB(shiftId);
      if (isMobile) setMobileTab('stops');
    },
    [loadPhaseB, isMobile]
  );

  const handleSelectStop = useCallback((stopId: string) => {
    setSelectedStopId(stopId);
    setRunsheetAction(null);
  }, []);

  const handleSelectPlace = useCallback((place: string) => {
    const [kind, id] = place.split(':', 2);
    setFormSiteId(kind === 'site' ? id : '');
    setFormZoneId(kind === 'zone' ? id : '');
  }, []);

  const selectedShift = activeShifts.find((shift) => shift.id === selectedShiftId) ?? null;
  const selectedStop = shiftStops.find((stop) => stop.id === selectedStopId) ?? null;

  const openRunsheetAction = (target: 'shift' | 'stop', action: RunsheetAction) => {
    const notes = target === 'shift' && action === 'amend' ? selectedShift?.notes ?? '' : '';
    setRunsheetAction({
      target,
      action,
      clientRequestId: crypto.randomUUID(),
      reason: '',
      notes,
      newOrder: target === 'stop' && action === 'reorder' ? selectedStop?.sequence ?? null : null,
    });
    setError(null);
    setNotice(null);
  };

  const closeRunsheetAction = () => {
    if (!operatorBusy) setRunsheetAction(null);
  };

  const submitRunsheetAction = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!runsheetAction || !runsheetAction.reason.trim()) {
      setError('Write a short operational reason before changing the run sheet.');
      return;
    }
    if (runsheetAction.target === 'stop' && runsheetAction.action === 'reorder') {
      if (!selectedStop || !runsheetAction.newOrder || runsheetAction.newOrder === selectedStop.sequence) {
        setError('Choose a different route position for this stop.');
        return;
      }
    }
    if (runsheetAction.target === 'shift' && runsheetAction.action === 'amend' && !runsheetAction.notes.trim()) {
      setError('Write the updated shift note.');
      return;
    }

    setOperatorBusy(true);
    setError(null);

    if (runsheetAction.target === 'stop') {
      if (!selectedStop) {
        setError('The selected stop is no longer available.');
        setOperatorBusy(false);
        return;
      }
      const action = runsheetAction.action === 'cancel_stop' ? 'cancel' : runsheetAction.action;
      // ATLAS CALLS: manage_shift_stop (replay-safe route change with audit receipt)
      const { data, error: actionError } = await supabase.rpc('manage_shift_stop', {
        p_client_request_id: runsheetAction.clientRequestId,
        p_stop_id: selectedStop.id,
        p_expected_status: selectedStop.status,
        p_expected_updated_at: selectedStop.updatedAt,
        p_action: action,
        p_new_order: action === 'reorder' ? runsheetAction.newOrder : null,
        p_reason: runsheetAction.reason.trim(),
      });
      if (actionError) setError(actionError.message);
      else {
        const replayed = Boolean((data as { replayed?: boolean } | null)?.replayed);
        const outcome = action === 'reorder'
          ? `moved from position ${selectedStop.sequence} to ${runsheetAction.newOrder}`
          : action === 'skip' ? 'marked skipped' : 'cancelled';
        setNotice(`Stop ${outcome} with an audit receipt${replayed ? ' (replayed safely)' : ''}.`);
        setRunsheetAction(null);
        await loadPhaseB(selectedStop.shiftId);
      }
    } else {
      if (!selectedShift) {
        setError('The selected shift is no longer available.');
        setOperatorBusy(false);
        return;
      }
      const action = runsheetAction.action === 'cancel_shift' ? 'cancel' : runsheetAction.action;
      // ATLAS CALLS: manage_active_shift (replay-safe shift control with audit receipt)
      const { data, error: actionError } = await supabase.rpc('manage_active_shift', {
        p_client_request_id: runsheetAction.clientRequestId,
        p_shift_id: selectedShift.id,
        p_expected_status: selectedShift.status,
        p_expected_updated_at: selectedShift.updatedAt,
        p_action: action,
        p_notes: action === 'amend' ? runsheetAction.notes.trim() : null,
        p_reason: runsheetAction.reason.trim(),
      });
      if (actionError) setError(actionError.message);
      else {
        const replayed = Boolean((data as { replayed?: boolean } | null)?.replayed);
        const outcome = action === 'amend' ? 'notes updated' : action === 'escalate' ? 'attendance escalated' : 'cancelled';
        setNotice(`Shift ${outcome} with an audit receipt${replayed ? ' (replayed safely)' : ''}.`);
        setRunsheetAction(null);
        await loadPhaseA();
        if (action === 'cancel') {
          setSelectedShiftId(null);
          setSelectedStopId(null);
          setShiftStops([]);
        } else {
          await loadPhaseB(selectedShift.id);
        }
      }
    }
    setOperatorBusy(false);
  };

  const runsheetActionLabel = runsheetAction?.action === 'amend'
    ? 'Amend shift'
    : runsheetAction?.action === 'escalate'
      ? 'Escalate attendance'
      : runsheetAction?.action === 'cancel_shift'
        ? 'Cancel shift'
        : runsheetAction?.action === 'reorder'
          ? 'Change stop position'
          : runsheetAction?.action === 'skip'
            ? 'Skip stop'
            : 'Cancel stop';

  const renderRunsheetAction = (target: 'shift' | 'stop') => {
    if (!runsheetAction || runsheetAction.target !== target) return null;
    return (
      <form className="dispatch-runsheet-action" aria-label={runsheetActionLabel} onSubmit={(event) => void submitRunsheetAction(event)}>
        <div className="dispatch-runsheet-action__heading">
          <div>
            <strong>{runsheetActionLabel}</strong>
            <span>{target === 'shift' ? selectedShift?.officerName : selectedStop?.siteName}</span>
          </div>
          <button type="button" className="dispatch-runsheet-action__close" onClick={closeRunsheetAction} disabled={operatorBusy} aria-label={`Close ${runsheetActionLabel}`}>Close</button>
        </div>
        {runsheetAction.action === 'reorder' && (
          <label>
            <span>New route position</span>
            <select
              value={runsheetAction.newOrder ?? ''}
              onChange={(event) => setRunsheetAction((current) => current ? { ...current, newOrder: Number(event.target.value) } : current)}
              disabled={operatorBusy}
            >
              {shiftStops.map((stop, index) => <option key={stop.id} value={index + 1}>Position {index + 1}{stop.id === selectedStop?.id ? ' (current)' : ''}</option>)}
            </select>
          </label>
        )}
        {runsheetAction.action === 'amend' && (
          <label>
            <span>Updated shift note</span>
            <textarea
              value={runsheetAction.notes}
              maxLength={4000}
              rows={3}
              onChange={(event) => setRunsheetAction((current) => current ? { ...current, notes: event.target.value } : current)}
              disabled={operatorBusy}
            />
          </label>
        )}
        <label>
          <span>Operational reason</span>
          <textarea
            value={runsheetAction.reason}
            maxLength={1000}
            rows={2}
            onChange={(event) => setRunsheetAction((current) => current ? { ...current, reason: event.target.value } : current)}
            placeholder="Why is this change necessary?"
            disabled={operatorBusy}
          />
        </label>
        <p>This changes the live officer run sheet and writes a before-and-after audit receipt. It does not rewrite completed attendance.</p>
        <div className="dispatch-runsheet-action__footer">
          <button type="button" onClick={closeRunsheetAction} disabled={operatorBusy}>Keep current run sheet</button>
          <button type="submit" disabled={operatorBusy}>{operatorBusy ? 'Applying change' : `Confirm ${runsheetActionLabel.toLowerCase()}`}</button>
        </div>
      </form>
    );
  };

  const shiftOperatorPanel = selectedShift && (
    <div className="dispatch-operator-actions">
      <strong>Selected shift · {selectedShift.officerName}</strong>
      <span>{selectedShift.status.replaceAll('_', ' ')} · {selectedShift.completedStops}/{selectedShift.totalStops} stops complete</span>
      <div>
        <button type="button" onClick={() => openRunsheetAction('shift', 'amend')} disabled={operatorBusy}>Amend shift</button>
        <button type="button" onClick={() => openRunsheetAction('shift', 'escalate')} disabled={operatorBusy}>Escalate attendance</button>
        <button type="button" onClick={() => openRunsheetAction('shift', 'cancel_shift')} disabled={operatorBusy || Boolean(selectedShift.actualStart)}>Cancel shift</button>
      </div>
      {selectedShift.actualStart && <small>A started shift cannot be cancelled. Amend its note or escalate attendance instead.</small>}
      {renderRunsheetAction('shift')}
    </div>
  );

  const stopOperatorPanel = selectedStop && (
    <div className="dispatch-operator-actions">
      <strong>Selected stop · {selectedStop.siteName}</strong>
      <span>Position {selectedStop.sequence} · {shiftStopStatusLabel(selectedStop.status)}</span>
      <div>
        <button type="button" onClick={() => openRunsheetAction('stop', 'reorder')} disabled={operatorBusy || selectedStop.status !== 'pending'}>Change position</button>
        <button type="button" onClick={() => openRunsheetAction('stop', 'skip')} disabled={operatorBusy || Boolean(selectedStop.arrival) || ['completed', 'skipped', 'cancelled'].includes(selectedStop.status)}>Skip stop</button>
        <button type="button" onClick={() => openRunsheetAction('stop', 'cancel_stop')} disabled={operatorBusy || Boolean(selectedStop.arrival) || ['completed', 'skipped', 'cancelled'].includes(selectedStop.status)}>Cancel stop</button>
      </div>
      {selectedStop.arrival && <small>Attendance has already started at this place, so its route position and closure state are preserved.</small>}
      {renderRunsheetAction('stop')}
    </div>
  );

  const selectedJob = jobs.find((job) => job.id === jobDetailId) ?? null;
  const jobTimingLocked = selectedJob ? ['completed', 'cancelled'].includes(selectedJob.status) : true;
  const runsheetInsertUnavailable = !selectedJob
    ? 'Open a dispatch job first.'
    : selectedJob.shiftStopId
      ? 'This job is already on a run sheet.'
      : selectedJob.shiftId && selectedJob.shiftId !== selectedShift?.id
        ? 'This job is already assigned to another shift.'
        : !['pending', 'dispatched', 'acknowledged'].includes(selectedJob.status)
          ? 'Only pending, dispatched or acknowledged jobs can be added.'
          : !selectedShift
            ? 'Select the receiving run sheet in the Shifts column first.'
            : !selectedShift.serviceAgreementId
              ? 'The selected run sheet has no service-agreement anchor and cannot receive a dispatch job.'
              : selectedAgreement && selectedShift.serviceAgreementId !== selectedAgreement.id
                ? 'The selected run sheet belongs to a different service agreement.'
                : null;
  const openJobDetail = (jobId: string) => {
    const job = jobs.find((candidate) => candidate.id === jobId);
    setJobDetailId(jobId);
    setJobActionReason('');
    setJobResourceId('');
    setJobSlaMinutes(job?.slaMinutes ?? 15);
    setJobDwellMinutes(job?.expectedDwellMinutes ?? 5);
    setJobTimingSource(job?.timingSource ?? 'dispatcher_override');
    setJobTimingReason('');
    setJobRunsheetReason('');
    setJobRunsheetRequestId(crypto.randomUUID());
    setShowRunsheetInsertConfirm(false);
    setError(null);
    setNotice(null);
  };
  const closeJobDetail = () => {
    setJobDetailId(null);
    setShowRunsheetInsertConfirm(false);
  };
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
  const manageJobTiming = async () => {
    if (!selectedJob) return;
    if (jobTimingLocked) {
      setError('Response timing cannot change after a job is completed or cancelled.');
      return;
    }
    if (!Number.isInteger(jobSlaMinutes) || jobSlaMinutes < 1 || jobSlaMinutes > 1440) {
      setError('Response target must be a whole number from 1 to 1,440 minutes.');
      return;
    }
    if (!Number.isInteger(jobDwellMinutes) || jobDwellMinutes < 1 || jobDwellMinutes > 240) {
      setError('Expected attendance must be a whole number from 1 to 240 minutes.');
      return;
    }
    if (!jobTimingReason.trim()) {
      setError('Explain why the response timing is changing.');
      return;
    }
    setOperatorBusy(true);
    setError(null);
    const { error: timingError } = await supabase.rpc('manage_dispatch_job_timing', {
      p_job_id: selectedJob.id,
      p_expected_status: selectedJob.status,
      p_sla_minutes: jobSlaMinutes,
      p_expected_dwell_minutes: jobDwellMinutes,
      p_timing_source: jobTimingSource,
      p_reason: jobTimingReason.trim(),
    });
    if (timingError) setError(timingError.message);
    else {
      setNotice('Response timing updated with an audit receipt.');
      setJobTimingReason('');
      await loadPhaseA();
    }
    setOperatorBusy(false);
  };
  const insertJobIntoSelectedRunsheet = async () => {
    if (!selectedJob || !selectedShift || runsheetInsertUnavailable) {
      setError(runsheetInsertUnavailable ?? 'Choose an eligible job and run sheet.');
      return;
    }
    if (!jobRunsheetReason.trim()) {
      setError('Explain why this job is being inserted into the officer run sheet.');
      return;
    }

    setOperatorBusy(true);
    setError(null);
    try {
      // ATLAS CALLS: insert_adhoc_stop (governed dispatch-to-run-sheet insertion with replay and audit receipt)
      const { data, error: insertError } = await supabase.rpc('insert_adhoc_stop', {
        p_client_request_id: jobRunsheetRequestId,
        p_dispatch_job_id: selectedJob.id,
        p_shift_id: selectedShift.id,
        p_expected_job_status: selectedJob.status,
        p_expected_shift_updated_at: selectedShift.updatedAt,
        p_reason: jobRunsheetReason.trim(),
      });
      if (insertError) {
        setError(insertError.message);
        return;
      }

      const receipt = data?.[0];
      if (!receipt) throw new Error('The run-sheet insertion completed without a receipt.');
      setNotice(
        receipt.created
          ? `Job added to ${selectedShift.officerName}'s run sheet as stop ${receipt.stop_order}. The officer route and supervisor view now share the same job.`
          : `This job was already on ${selectedShift.officerName}'s run sheet. The existing stop was retained.`,
      );
      setShowRunsheetInsertConfirm(false);
      setJobRunsheetReason('');
      setJobRunsheetRequestId(crypto.randomUUID());
      await loadPhaseA();
      await loadPhaseB(selectedShift.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The dispatch job could not be added to the selected run sheet.');
    } finally {
      setOperatorBusy(false);
    }
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
        {notice && <div className="dispatch-console-inline-success" role="status">{notice}</div>}

        <div className="dispatch-job-dialog-grid">
          <div><strong>Status</strong><span>{JOB_STATUS_LABELS[selectedJob.status]}{selectedJob.slaBreached ? ' · response time breached' : ''}</span></div>
          <div><strong>Respond by</strong><span>{selectedJob.slaRespondBy ? new Date(selectedJob.slaRespondBy).toLocaleString('en-NZ') : `Not set (${selectedJob.slaMinutes} min target)`}</span></div>
          <div><strong>Assigned to</strong><span>{selectedJob.resourceName ?? 'Unassigned'}</span></div>
          <div><strong>Expected attendance</strong><span>{selectedJob.expectedDwellMinutes ?? 5} minutes · {selectedJob.timingSource?.replaceAll('_', ' ') ?? 'dispatch default'}</span></div>
        </div>

        <DispatchJobBillingPanel job={selectedJob} onSaved={async (message) => { setNotice(message); await loadPhaseA(); }} />

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
          <h3>Add to officer run sheet</h3>
          {selectedShift ? (
            <p className="dispatch-console-form-note">
              Selected run sheet: <strong>{selectedShift.officerName}</strong> · {JOB_STATUS_LABELS[selectedJob.status]} job · {selectedShift.totalStops} current stops.
            </p>
          ) : (
            <p className="dispatch-console-form-note">Select the receiving officer run sheet in the Shifts column. The server will verify the organization, agreement, place, module, officer and current state before changing either record.</p>
          )}
          {runsheetInsertUnavailable && <p className="dispatch-console-form-note" role="status">{runsheetInsertUnavailable}</p>}
          {!showRunsheetInsertConfirm ? (
            <div>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={operatorBusy || Boolean(runsheetInsertUnavailable)}
                onClick={() => setShowRunsheetInsertConfirm(true)}
              >
                Add to selected run sheet
              </button>
            </div>
          ) : (
            <div className="dispatch-runsheet-insert-confirm" role="group" aria-label="Confirm run-sheet insertion">
              <p>
                This appends <strong>{selectedJob.siteName}</strong> to <strong>{selectedShift?.officerName}</strong>&apos;s prioritized route,
                assigns the job to that officer, marks it dispatched, invalidates the old route solution and writes an audit receipt.
              </p>
              <label>
                <span>Reason for the insertion</span>
                <textarea
                  value={jobRunsheetReason}
                  onChange={(event) => setJobRunsheetReason(event.target.value)}
                  placeholder="Why must this job join the current run sheet?"
                  rows={2}
                  disabled={operatorBusy}
                />
              </label>
              <div>
                <button type="button" className="btn btn-primary" disabled={operatorBusy || !jobRunsheetReason.trim()} onClick={() => void insertJobIntoSelectedRunsheet()}>
                  Confirm and add stop
                </button>
                <button type="button" className="btn btn-secondary" disabled={operatorBusy} onClick={() => setShowRunsheetInsertConfirm(false)}>
                  Keep job separate
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="dispatch-job-dialog-actions dispatch-job-timing-actions">
          <h3>Response timing</h3>
          <p className="dispatch-console-form-note">Adjust the response target or expected attendance only when the operational plan changes. The reason is retained in the audit receipt.</p>
          {jobTimingLocked && <p className="dispatch-console-form-note" role="status">This job is closed. Its response timing is retained as part of the completed record.</p>}
          <div className="dispatch-job-timing-grid">
            <label>
              <span>Respond within (minutes)</span>
              <input type="number" min={1} max={1440} step={1} value={jobSlaMinutes} onChange={(event) => setJobSlaMinutes(Number(event.target.value))} disabled={operatorBusy || jobTimingLocked} />
            </label>
            <label>
              <span>Expected attendance (minutes)</span>
              <input type="number" min={1} max={240} step={1} value={jobDwellMinutes} onChange={(event) => setJobDwellMinutes(Number(event.target.value))} disabled={operatorBusy || jobTimingLocked} />
            </label>
            <label>
              <span>Timing source</span>
              <select value={jobTimingSource} onChange={(event) => setJobTimingSource(event.target.value)} disabled={operatorBusy || jobTimingLocked}>
                <option value="dispatcher_override">Dispatcher override</option>
                <option value="site_service">Site service setting</option>
                <option value="patrol_schedule">Patrol schedule</option>
                <option value="bob_pattern">Bob pattern recommendation</option>
              </select>
            </label>
          </div>
          <label>
            <span>Reason for timing change</span>
            <textarea value={jobTimingReason} onChange={(event) => setJobTimingReason(event.target.value)} placeholder="What changed in the operational plan?" rows={2} disabled={operatorBusy || jobTimingLocked} />
          </label>
          <div>
            <button type="button" className="btn btn-secondary" disabled={operatorBusy || jobTimingLocked} onClick={() => void manageJobTiming()}>Update response timing</button>
          </div>
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
        <label className="dispatch-console-form-label" htmlFor="dispatch-agreement">Service agreement</label>
        {branchAgreements.length > 1 ? (
          <select id="dispatch-agreement" value={selectedAgreement?.id ?? ''} onChange={(event) => selectAgreement(event.target.value || null)}>
            {branchAgreements.map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.name}{agreement.client_name ? ` · ${agreement.client_name}` : ''}{agreementOptionSuffix(agreement)}</option>)}
          </select>
        ) : (
          <strong id="dispatch-agreement">{branchAgreements[0]?.name ?? (relationshipLoading ? 'Loading agreements…' : 'This branch holds no service agreement yet')}</strong>
        )}
        <div className="dispatch-console-form-note">
          {branchAgreements.length ? `Client: ${selectedAgreement?.client_name ?? selectedAgreement?.client_organization_id ?? 'Unavailable'}` : 'Jobs are created under an agreement this branch holds. Set one up in Client Portfolios first.'}
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
        <label className="dispatch-console-form-label" htmlFor="dispatch-place">Site or Zone</label>
        <select id="dispatch-place" value={formSiteId ? `site:${formSiteId}` : formZoneId ? `zone:${formZoneId}` : ''} disabled={isNewIncidentLocation} onChange={(e) => handleSelectPlace(e.target.value)}>
          <option value="">Select a site or zone...</option>
          {sites.length > 0 && <optgroup label="Sites">{sites.map((site) => (
            <option key={site.id} value={`site:${site.id}`}>{site.name}</option>
          ))}</optgroup>}
          {zones.length > 0 && <optgroup label="Zones">{zones.map((zone) => (
            <option key={zone.id} value={`zone:${zone.id}`}>{zone.name}</option>
          ))}</optgroup>}
        </select>
        {!relationshipLoading && sites.length === 0 && zones.length === 0 && (
          <div className="dispatch-console-inline-warning">No active sites or zones are linked to the selected agreement.</div>
        )}
        <label className="dispatch-console-check-row">
          <input type="checkbox" checked={isNewIncidentLocation} onChange={(event) => { setIsNewIncidentLocation(event.target.checked); setFormSiteId(''); setFormZoneId(''); setResolvedLocation(null); }} />
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
        <label className="dispatch-console-form-label">Queue directly to an officer</label>
        <select
          value={formDirectOfficerId}
          onChange={(event) => {
            setFormDirectOfficerId(event.target.value);
            if (event.target.value) {
              setFormResourceId('');
              setFormShiftId('');
            } else setFormWorkUnitId('');
          }}
        >
          <option value="">No direct officer handoff</option>
          {directOfficers.map((officer) => <option key={officer.id} value={officer.id}>{officer.displayName}</option>)}
        </select>
        {formDirectOfficerId && (
          <>
            <label className="dispatch-console-form-label" htmlFor="dispatch-work-unit">Authorizing work unit</label>
            <select id="dispatch-work-unit" value={formWorkUnitId} onChange={(event) => setFormWorkUnitId(event.target.value)}>
              <option value="">Choose an active work unit...</option>
              {dispatchWorkUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name} · {unit.serviceType.replaceAll('_', ' ')}</option>)}
            </select>
            <div className="dispatch-console-form-note">The officer receives this job immediately. They must start or already have an in-progress shift before recording attendance. Direct handoff is available only for an agreement-linked site.</div>
          </>
        )}
      </div>

      {!formDirectOfficerId && (
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
          {positionError && <div className="dispatch-console-inline-warning" role="status">{positionError}</div>}
          {nearestUnit && (formResourceId === nearestUnit.resourceId ? (
            <div className="dispatch-console-form-note" role="status">{nearestUnit.label} is the closest available unit with a GPS fix from the last 5 minutes ({nearestUnit.distanceKm.toFixed(1)} km straight-line).</div>
          ) : (
            <div className="dispatch-console-form-note" role="status">Closest available unit with a recent GPS fix: {nearestUnit.label} · {nearestUnit.distanceKm.toFixed(1)} km straight-line. <button type="button" className="btn btn-sm btn-secondary" onClick={() => assignResource(nearestUnit.resourceId)}><MapPin size={14} aria-hidden="true" /> Assign nearest</button></div>
          ))}
          {!nearestUnit && !formResourceId && (formSiteId || resolvedLocation) && <div className="dispatch-console-form-note" role="status">No proximity suggestion: a mapped place centre and a unit GPS fix from the last 5 minutes are needed. You can assign manually or leave the job unassigned.</div>}
        </div>
      )}

      <div className="dispatch-console-form-field">
        <label className="dispatch-console-form-label">SLA Minutes</label>
        <input type="number" value={formSlaMinutes} onChange={(e) => setFormSlaMinutes(parseInt(e.target.value))} />
      </div>

      <div className="dispatch-console-form-field">
        <label className="dispatch-console-form-label">Briefing Notes</label>
        <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} />
      </div>

      {selectedModelLoading ? <div className="dispatch-console-form-note" role="status">Loading the agreement billing model…</div>
        : selectedModelError ? <div className="dispatch-console-inline-error" role="alert">The agreement billing model could not be loaded: {selectedModelError}</div>
        : formUsesContractExtra
          ? <BillingBasisFields idPrefix="dispatch-new-job" choice={formBilling} orderId={formExtraOrderId} orders={agreementExtraOrders} day={localToday()} onChange={(next) => { setFormBilling(next.choice); setFormExtraOrderId(next.orderId); }} />
          : <>
            <div className="dispatch-console-form-field">
              <span className="dispatch-console-form-label">Billing</span>
              <div><span className={`dispatch-billing-chip is-rated`}>{commercialModelLabel(selectedCommercialModel)}</span></div>
              <div className="dispatch-console-form-note">{COMMERCIAL_MODEL_HELP[selectedCommercialModel as CommercialModel]}</div>
            </div>
            {selectedCommercialModel === 'per_request' && <ClientReferenceField idPrefix="dispatch-new-job" value={formClientReference} onChange={setFormClientReference} />}
          </>}

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
          disabled={saving || !selectedAgreement || selectedAgreement.provider_organization_id !== operatingBranchId || (!formSiteId && !formZoneId && !resolvedLocation) || (formJobType === 'alarm_response' && !formAlarmReceivedAt) || (Boolean(formResourceId) && !formShiftId) || (Boolean(formDirectOfficerId) && (!formWorkUnitId || !formSiteId || Boolean(formZoneId) || isNewIncidentLocation))}
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
                {shiftOperatorPanel}
              </div>
            )}

            {mobileTab === 'stops' && (
              <div className="dispatch-console-list dispatch-console-list--stacked">
                {stopsLoading ? (
                  <div className="dispatch-console-empty-state">Loading stops...</div>
                ) : shiftStops.length === 0 ? (
                  <div className="dispatch-console-empty-state">Select a shift to view stops</div>
                ) : (
                  shiftStops.map((stop) => <StopCard key={stop.id} stop={stop} selected={stop.id === selectedStopId} onSelect={() => handleSelectStop(stop.id)} />)
                )}
                {stopOperatorPanel}
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
          {shiftOperatorPanel}
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
                <StopCard key={stop.id} stop={stop} selected={stop.id === selectedStopId} onSelect={() => handleSelectStop(stop.id)} />
              ))}
            </div>
          )}
          {stopOperatorPanel}
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
