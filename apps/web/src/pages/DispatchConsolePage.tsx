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
import './DispatchConsolePage.css';

// Type definitions
type JobType = 'alarm_response' | 'event' | 'incident' | 'noise_control' | 'patrol_support' | 'welfare_check';
type JobPriority = 'low' | 'normal' | 'high' | 'urgent';
type AlarmIntakeChannel = 'phone' | 'email';
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
}> = ({ shift, selected, onClick }) => (
  <button
    onClick={onClick}
    style={{
      width: '100%',
      padding: '12px',
      backgroundColor: selected ? 'var(--color-bg-tertiary)' : 'var(--color-bg-secondary)',
      border: selected ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
      borderRadius: '4px',
      cursor: 'pointer',
      textAlign: 'left',
      transition: 'all 0.2s ease',
    }}
    onMouseEnter={(e) => {
      if (!selected) e.currentTarget.style.backgroundColor = 'var(--color-bg-tertiary)';
    }}
    onMouseLeave={(e) => {
      if (!selected) e.currentTarget.style.backgroundColor = 'var(--color-bg-secondary)';
    }}
  >
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
        {shift.officerName}
      </div>
      {(() => {
        const badge = shiftHealthBadge(shift.shiftHealth);
        return (
          <div
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: badge.tone === 'healthy' ? '#4CAF50' : badge.tone === 'degraded' ? '#FF9800' : '#EF5350',
              padding: '2px 6px',
              backgroundColor: badge.tone === 'healthy' ? '#1B5E20' : badge.tone === 'degraded' ? '#1A1200' : '#3A0000',
              borderRadius: '3px',
            }}
          >
            {badge.label.toUpperCase()}
          </div>
        );
      })()}
    </div>
    <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginBottom: '6px' }}>
      {shift.patrolRouteName && `Route: ${shift.patrolRouteName}`}
    </div>
    <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
      {shift.completedStops}/{shift.totalStops} stops
    </div>
  </button>
);

// Component: Stop Card
const StopCard: React.FC<{ stop: ShiftStop; selected?: boolean; onSelect?: () => void }> = ({ stop, selected, onSelect }) => (
  <div
    role="button"
    tabIndex={0}
    onClick={onSelect}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect?.(); }}
    style={{
      padding: '12px',
      backgroundColor: 'var(--color-bg-secondary)',
      border: selected ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
      borderRadius: '4px',
      marginBottom: '8px',
    }}
  >
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '8px',
      }}
    >
      <div style={{ fontSize: '13px', fontWeight: 600 }}>#{stop.sequence}</div>
      <div
        style={{
          fontSize: '11px',
          fontWeight: 600,
          color: stop.status === 'completed' ? '#4CAF50' : stop.status === 'on_scene' ? '#3B82F6' : stop.status === 'en_route' ? '#FF9800' : '#666',
          padding: '2px 6px',
          backgroundColor: stop.status === 'completed' ? '#1B5E20' : stop.status === 'on_scene' ? '#0D1F3C' : stop.status === 'en_route' ? '#231A00' : '#2A2A2A',
          borderRadius: '3px',
        }}
      >
        {shiftStopStatusLabel(stop.status).toUpperCase()}
      </div>
    </div>
    <div style={{ fontSize: '12px', color: 'var(--color-text-primary)' }}>
      {stop.siteName}
    </div>
    {stop.arrival && (
      <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
        Arrived: {new Date(stop.arrival).toLocaleTimeString()}
      </div>
    )}
  </div>
);

// Component: Job Card
const JobCard: React.FC<{ job: DispatchJob; selected: boolean; onSelect: () => void }> = ({ job, selected, onSelect }) => {
  const priorityColor = PRIORITIES.find((p) => p.id === job.priority)?.color || '#666';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`dispatch-job-card ${job.slaBreached ? 'is-sla-breached' : ''} ${selected ? 'is-selected' : ''}`}
      style={{ '--dispatch-priority': priorityColor } as React.CSSProperties}
    >
      <div className="dispatch-job-card-header">
        <div className="dispatch-job-card-title">
          <strong>{job.siteName}</strong>
          <span>{JOB_TYPES.find((t) => t.id === job.jobType)?.label}</span>
        </div>
        <span className="dispatch-job-priority">{job.priority}</span>
      </div>
      {job.slaBreached && (
        <div className="dispatch-job-breach">SLA breached</div>
      )}
      <div className="dispatch-job-card-sla">Response SLA: {job.slaMinutes} min{job.slaRespondBy ? ` · respond by ${new Date(job.slaRespondBy).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
      {selected && <div className="dispatch-job-details" aria-label={`Dispatch details for ${job.siteName}`}>
        <p><strong>Location</strong>{job.siteAddress ?? 'Address not recorded'}</p>
        <p><strong>Status</strong>{job.status.replaceAll('_', ' ')}</p>
        <p><strong>Assignment</strong>{job.resourceName ?? 'Unassigned'}{job.shiftId ? ` · shift ${job.shiftId.slice(0, 8)}` : ''}</p>
        <p><strong>Expected attendance</strong>{job.expectedDwellMinutes ?? 5} min · {job.timingSource?.replaceAll('_', ' ') ?? 'dispatch default'}</p>
        {job.briefingNotes && <p><strong>Briefing</strong>{job.briefingNotes}</p>}
        {job.accessInstructions && <p><strong>Access</strong>{job.accessInstructions}</p>}
        {job.safetyNotes && <p className="is-safety"><strong>Safety</strong>{job.safetyNotes}</p>}
      </div>}
    </button>
  );
};

// Main Component
const DispatchConsolePage: React.FC = () => {
  const location = useLocation();
  const requestedJobId = new URLSearchParams(location.search).get('job');
  const { profile, operatingOrganizationId } = useAuth();
  const operatingBranchId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const {
    selectedAgreement,
    selectedAgreementSites,
    loading: relationshipLoading,
    error: relationshipError,
  } = useServiceRelationships();

  // State: Phase A (Load initial data)
  const [activeShifts, setActiveShifts] = useState<ActiveShift[]>([]);
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [sites, setSites] = useState<ClientSite[]>([]);
  const [resources, setResources] = useState<ResourceUnit[]>([]);
  const [loading, setLoading] = useState(true);

  // State: Phase B (Shift stops)
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(requestedJobId);
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
  const [formAlarmReceivedAt, setFormAlarmReceivedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [formZoneId, setFormZoneId] = useState<string>('');
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
    if (!operatingBranchId) return;

    try {
      setLoading(true);

      const [shiftsRes, jobsRes, resourcesRes, selectedJobRes] = await Promise.all([
        supabase
          .from('shifts')
          .select('*, officer:officer_user_id(display_name), route:patrol_route_id(name, route_code)')
          .eq('organization_id', operatingBranchId)
          .in('status', ['published', 'accepted', 'in_progress']),
        supabase
          .from('dispatch_jobs')
          .select('*, site:client_site_id(name, address, hs_notes, access_instructions), resource:dispatch_resource_id(name)')
          .eq('organization_id', operatingBranchId)
          .in('status', ACTIVE_DISPATCH_JOB_STATUSES as readonly string[]),
        supabase
          .from('dispatch_resources')
          .select('id, name, callsign, status, assigned_officer_id')
          .eq('organization_id', operatingBranchId),
        requestedJobId
          ? supabase.from('dispatch_jobs').select('*, site:client_site_id(name, address, hs_notes, access_instructions), resource:dispatch_resource_id(name)').eq('id', requestedJobId).maybeSingle()
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
        }));
        setJobs(formatted);
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
  }, [operatingBranchId, requestedJobId]);

  useEffect(() => {
    if (!requestedJobId) return;
    setSelectedJobId(requestedJobId);
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
        ? `[Manual alarm intake: ${formAlarmIntakeChannel}; received ${new Date(formAlarmReceivedAt).toISOString()}]${formNotes.trim() ? `\n${formNotes.trim()}` : ''}`
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
      setFormAlarmReceivedAt(new Date().toISOString().slice(0, 16));
      setFormZoneId('');
      setFormRequestId(crypto.randomUUID());

      await loadPhaseA();
    } catch (err) {
      console.error('Failed to create job:', err);
      setError(err instanceof Error ? err.message : 'Failed to create job');
    } finally {
      setSaving(false);
    }
  }, [operatingBranchId, relationshipLoading, relationshipError, selectedAgreement, formRequestId, formJobType, formPriority, formSiteId, isNewIncidentLocation, resolvedLocation, formShiftId, formResourceId, formSlaMinutes, formNotes, loadPhaseA]);

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

  const operatorAction = async (target: 'job' | 'stop' | 'shift', action: string) => {
    const reason = window.prompt(`Reason for ${action.replaceAll('_', ' ')}:`)?.trim();
    if (!reason) return;
    const targetId = target === 'job' ? selectedJobId : target === 'stop' ? selectedStopId : selectedShiftId;
    if (!targetId) return;
    setOperatorBusy(true); setError(null);
    const currentStatus = target === 'job' ? jobs.find((job) => job.id === targetId)?.status : target === 'stop' ? shiftStops.find((stop) => stop.id === targetId)?.status : activeShifts.find((shift) => shift.id === targetId)?.status;
    const rpc = target === 'job' ? 'manage_dispatch_job' : target === 'stop' ? 'manage_shift_stop' : 'manage_active_shift';
    const payload = target === 'job' ? { p_job_id: targetId, p_expected_status: currentStatus, p_action: action, p_reason: reason } : target === 'stop' ? { p_stop_id: targetId, p_expected_status: currentStatus, p_action: action, p_reason: reason } : { p_shift_id: targetId, p_expected_status: currentStatus, p_action: action, p_reason: reason };
    const { error: actionError } = await supabase.rpc(rpc, payload);
    if (actionError) setError(actionError.message); else { await loadPhaseA(); if (selectedShiftId) await loadPhaseB(selectedShiftId); }
    setOperatorBusy(false);
  };

  // Mobile: Shift + Stops + Jobs tabs
  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '12px', paddingBottom: '12px' }}>
        {/* Tab Bar */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '8px',
            padding: '12px',
            backgroundColor: 'var(--color-bg-secondary)',
            borderRadius: '4px',
          }}
        >
          {(['shifts', 'stops', 'jobs'] as MobileTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setMobileTab(tab)}
              style={{
                padding: '8px',
                backgroundColor: mobileTab === tab ? 'var(--color-primary)' : 'transparent',
                color: mobileTab === tab ? 'white' : 'var(--color-text-secondary)',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 500,
                fontSize: '12px',
              }}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', paddingLeft: '12px', paddingRight: '12px' }}>
          {mobileTab === 'shifts' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button
                onClick={() => setShowNewJob(!showNewJob)}
                style={{
                  width: '100%',
                  padding: '12px',
                  backgroundColor: 'var(--color-primary)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                + New Job
              </button>
              {loading ? (
                <div>Loading shifts...</div>
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
            <div>
              {stopsLoading ? (
                <div>Loading stops...</div>
              ) : shiftStops.length === 0 ? (
                <div style={{ color: 'var(--color-text-secondary)' }}>Select a shift to view stops</div>
              ) : (
                shiftStops.map((stop) => <StopCard key={stop.id} stop={stop} />)
              )}
            </div>
          )}

          {mobileTab === 'jobs' && (
            <div>
              {jobs.length === 0 ? (
                <div style={{ color: 'var(--color-text-secondary)' }}>No active jobs</div>
              ) : (
                jobs.map((job) => <JobCard key={job.id} job={job} selected={job.id === selectedJobId} onSelect={() => setSelectedJobId(job.id)} />)
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Desktop: Three-column layout
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', height: '100%' }}>
      {/* Column 1: Shifts */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          overflowY: 'auto',
          paddingRight: '12px',
        }}
      >
        <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
          Active Shifts ({activeShifts.length})
        </div>
        {error && (
          <div
            style={{
              padding: '12px',
              backgroundColor: '#3A0000',
              color: '#EF5350',
              borderRadius: '4px',
              fontSize: '12px',
            }}
          >
            {error}
          </div>
        )}
        <button
          onClick={() => setShowNewJob(!showNewJob)}
          style={{
            padding: '12px',
            backgroundColor: 'var(--color-primary)',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          + New Job
        </button>
        {loading ? (
          <div style={{ color: 'var(--color-text-secondary)' }}>Loading shifts...</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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

      {/* Column 2: Stops */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          overflowY: 'auto',
          paddingRight: '12px',
        }}
      >
        <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
          Shift Stops ({shiftStops.length})
        </div>
        {stopsLoading ? (
          <div style={{ color: 'var(--color-text-secondary)' }}>Loading stops...</div>
        ) : selectedShiftId === null ? (
          <div style={{ color: 'var(--color-text-secondary)' }}>Select a shift to view stops</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {shiftStops.map((stop) => (
              <StopCard key={stop.id} stop={stop} selected={stop.id === selectedStopId} onSelect={() => setSelectedStopId(stop.id)} />
            ))}
          </div>
        )}
        {selectedStopId && <div className="dispatch-operator-actions"><strong>Selected stop</strong><div><button type="button" onClick={() => void operatorAction('stop', 'reorder')} disabled={operatorBusy}>Change position</button><button type="button" onClick={() => void operatorAction('stop', 'skip')} disabled={operatorBusy}>Skip stop</button><button type="button" onClick={() => void operatorAction('stop', 'cancel')} disabled={operatorBusy}>Cancel stop</button></div></div>}
      </div>

      {/* Column 3: Jobs + Form */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          overflowY: 'auto',
        }}
      >
        <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
          Active Jobs ({jobs.length})
        </div>

        {showNewJob && (
          <div
            style={{
              padding: '12px',
              backgroundColor: 'var(--color-bg-secondary)',
              border: '2px solid var(--color-primary)',
              borderRadius: '4px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: '13px' }}>Create New Job</div>

            <div style={{ padding: '8px', backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '3px', fontSize: '11px' }}>
              <div style={{ color: 'var(--color-text-secondary)', marginBottom: '3px' }}>Service agreement</div>
              <strong>{selectedAgreement?.name ?? 'No agreement selected'}</strong>
              <div style={{ color: 'var(--color-text-secondary)', marginTop: '3px' }}>
                Client: {selectedAgreement?.client_name ?? selectedAgreement?.client_organization_id ?? 'Unavailable'}
              </div>
            </div>

            {/* Job Type */}
            <div>
              <label style={{ fontSize: '11px', fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                Job Type
              </label>
              <select
                value={formJobType}
                onChange={(e) => setFormJobType(e.target.value as JobType)}
                style={{
                  width: '100%',
                  padding: '6px',
                  marginTop: '4px',
                  backgroundColor: 'var(--color-bg-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '3px',
                  color: 'var(--color-text-primary)',
                  fontSize: '12px',
                }}
              >
                {JOB_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Priority */}
            <div>
              <label style={{ fontSize: '11px', fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                Priority
              </label>
              <select
                value={formPriority}
                onChange={(e) => setFormPriority(e.target.value as JobPriority)}
                style={{
                  width: '100%',
                  padding: '6px',
                  marginTop: '4px',
                  backgroundColor: 'var(--color-bg-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '3px',
                  color: 'var(--color-text-primary)',
                  fontSize: '12px',
                }}
              >
                {PRIORITIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            {formJobType === 'alarm_response' && (
              <>
                <div>
                  <label style={{ fontSize: '11px', fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                    Intake channel
                  </label>
                  <select
                    value={formAlarmIntakeChannel}
                    onChange={(e) => setFormAlarmIntakeChannel(e.target.value as AlarmIntakeChannel)}
                    style={{ width: '100%', padding: '6px', marginTop: '4px', backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '3px', color: 'var(--color-text-primary)', fontSize: '12px' }}
                  >
                    <option value="phone">Phone call</option>
                    <option value="email">Email</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: '11px', fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                    Alarm received at
                  </label>
                  <input
                    type="datetime-local"
                    value={formAlarmReceivedAt}
                    onChange={(e) => setFormAlarmReceivedAt(e.target.value)}
                    style={{ width: '100%', padding: '6px', marginTop: '4px', backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '3px', color: 'var(--color-text-primary)', fontSize: '12px', boxSizing: 'border-box' }}
                  />
                </div>
              </>
            )}

            {/* Site */}
            <div>
              <label style={{ fontSize: '11px', fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                Site
              </label>
              <select
                value={formSiteId}
                disabled={isNewIncidentLocation}
                onChange={(e) => handleSelectSite(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px',
                  marginTop: '4px',
                  backgroundColor: 'var(--color-bg-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '3px',
                  color: 'var(--color-text-primary)',
                  fontSize: '12px',
                }}
              >
                <option value="">Select a site...</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {!relationshipLoading && sites.length === 0 && (
                <div style={{ marginTop: '4px', color: '#FF9800', fontSize: '10px' }}>
                  No active sites are linked to the selected agreement.
                </div>
              )}
              <label style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '8px', fontSize: '11px', color: 'var(--color-text-secondary)' }}>
                <input type="checkbox" checked={isNewIncidentLocation} onChange={(event) => { setIsNewIncidentLocation(event.target.checked); setFormSiteId(''); setResolvedLocation(null); }} />
                Create location from this dispatch
              </label>
              {isNewIncidentLocation && (
                <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                  <input value={formLocationAddress} onChange={(event) => { setFormLocationAddress(event.target.value); setResolvedLocation(null); }} placeholder="Incident address" style={{ flex: 1, minWidth: 0, padding: '6px', backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '3px', color: 'var(--color-text-primary)', fontSize: '12px' }} />
                  <button type="button" onClick={resolveIncidentLocation} disabled={!formLocationAddress.trim()} className="btn btn-sm btn-secondary">Resolve</button>
                </div>
              )}
              {isNewIncidentLocation && resolvedLocation && <div style={{ marginTop: '4px', color: '#72D6A2', fontSize: '10px' }}>Resolved: {resolvedLocation.label}</div>}
            </div>

            {/* SLA Minutes */}
            <div>
              <label style={{ fontSize: '11px', fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                Dispatch Resource
              </label>
              <select
                value={formResourceId}
                onChange={(e) => assignResource(e.target.value)}
                style={{ width: '100%', padding: '6px', marginTop: '4px', backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '3px', color: 'var(--color-text-primary)', fontSize: '12px' }}
              >
                <option value="">Leave in unassigned queue</option>
                {assignableResources.map((resource) => (
                  <option key={resource.id} value={resource.id}>
                    {resource.callsign ? `${resource.callsign} · ` : ''}{resource.name}
                  </option>
                ))}
              </select>
              {formResourceId && !formShiftId && <div style={{ marginTop: '4px', color: '#EF5350', fontSize: '10px' }}>No active matching shift is available for this resource.</div>}
            </div>

            {/* SLA Minutes */}
            <div>
              <label style={{ fontSize: '11px', fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                SLA Minutes
              </label>
              <input
                type="number"
                value={formSlaMinutes}
                onChange={(e) => setFormSlaMinutes(parseInt(e.target.value))}
                style={{
                  width: '100%',
                  padding: '6px',
                  marginTop: '4px',
                  backgroundColor: 'var(--color-bg-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '3px',
                  color: 'var(--color-text-primary)',
                  fontSize: '12px',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Notes */}
            <div>
              <label style={{ fontSize: '11px', fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                Briefing Notes
              </label>
              <textarea
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px',
                  marginTop: '4px',
                  backgroundColor: 'var(--color-bg-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '3px',
                  color: 'var(--color-text-primary)',
                  fontSize: '12px',
                  fontFamily: 'inherit',
                  minHeight: '60px',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Rate Warning */}
            {resolvedRate && (
              <div style={{ padding: '6px', backgroundColor: '#0F2A14', color: '#72D6A2', borderRadius: '3px', fontSize: '11px' }}>
                Billing rule matched: ${resolvedRate.amount.toFixed(2)} · {resolvedRate.rateType.replace(/_/g, ' ')}
              </div>
            )}
            {isUnrateable && (
              <div
                style={{
                  padding: '6px',
                  backgroundColor: '#3A0000',
                  color: '#EF5350',
                  borderRadius: '3px',
                  fontSize: '11px',
                }}
              >
                No applicable billing rule found. The job can be created, but billing requires review.
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                onClick={handleCreateJob}
                disabled={saving || (!formSiteId && !resolvedLocation) || (formJobType === 'alarm_response' && !formAlarmReceivedAt) || (Boolean(formResourceId) && !formShiftId)}
                style={{
                  flex: 1,
                  padding: '8px',
                  backgroundColor: 'var(--color-primary)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '3px',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                  fontSize: '12px',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                Create
              </button>
              <button
                onClick={() => setShowNewJob(false)}
                style={{
                  flex: 1,
                  padding: '8px',
                  backgroundColor: 'transparent',
                  color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: '12px',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Jobs List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {jobs.map((job) => (
              <JobCard key={job.id} job={job} selected={job.id === selectedJobId} onSelect={() => setSelectedJobId(job.id)} />
          ))}
        </div>
        {selectedJobId && <div className="dispatch-operator-actions"><strong>Selected job</strong><div><button type="button" onClick={() => void operatorAction('job', 'amend')} disabled={operatorBusy}>Amend details</button><button type="button" onClick={() => void operatorAction('job', 'reassign')} disabled={operatorBusy}>Reassign</button><button type="button" onClick={() => void operatorAction('job', 'escalate')} disabled={operatorBusy}>Escalate</button><button type="button" onClick={() => void operatorAction('job', 'cancel')} disabled={operatorBusy}>Cancel job</button></div></div>}
      </div>
    </div>
  );
};

export default DispatchConsolePage;
