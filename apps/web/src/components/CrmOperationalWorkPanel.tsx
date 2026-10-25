import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, ClipboardList, MapPinned, Plus, RefreshCw, Route, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { contractedDaysWords, contractedHoursWords, sentenceCase } from '../lib/rosterWords';

interface AgreementRef {
  id: string;
  name: string;
  agreement_type: string;
  invitation_status: string;
  provider_organization_id: string;
}

interface PlaceRef {
  id: string;
  name: string;
}

interface DeliverySchedule {
  id: string;
  proposal_scope_schedule_id: string | null;
  site_id: string | null;
  zone_id: string | null;
  capability_key: string;
  work_model: string;
  active_days: number[];
  visits_per_shift: number;
  window_start: string | null;
  window_end: string | null;
  dwell_minutes: number;
  response_sla_minutes: number | null;
  officer_instructions: string | null;
}

interface PatrolConfigLink {
  id: string;
  proposal_scope_schedule_id: string | null;
  patrol_route_id: string | null;
}

const describeDays = (days: number[]) => sentenceCase(contractedDaysWords(days));
const describeWindow = (start: string | null, end: string | null) => sentenceCase(contractedHoursWords(start, end));

interface AgreementLocation {
  id: string;
  service_agreement_id: string;
  site_id: string | null;
  zone_id: string | null;
  status: string;
}

interface AgreementModule {
  id: string;
  service_agreement_id: string;
  module_key: string;
  enabled: boolean;
}

interface PatrolRoute {
  id: string;
  name: string;
  organization_id?: string;
}

interface LocationHouse {
  id: string;
  name: string;
}

interface ModuleAssignment {
  id: string;
  location_id: string;
  module_key: string;
  service_agreement_id: string;
  enabled: boolean;
  effective_from: string;
  effective_to: string | null;
  updated_at: string;
}

interface ToolsetForm {
  locationId: string;
  moduleKey: string;
  enabled: boolean;
  effectiveFrom: string;
  effectiveTo: string;
  expectedUpdatedAt: string | null;
}

const describeAssignment = (assignment: ModuleAssignment | undefined) => {
  if (!assignment) return 'Not set at this place';
  const window = assignment.effective_to ? `${assignment.effective_from} to ${assignment.effective_to}` : `from ${assignment.effective_from}`;
  return assignment.enabled ? `On ${window}` : `Off ${window}`;
};

interface WorkUnit {
  id: string;
  name: string;
  work_unit_type: 'patrol' | 'static' | 'internal' | 'workshop';
  service_type: string;
  active: boolean;
  patrol_route_id: string | null;
  service_agreement_location_id: string | null;
  service_agreement_module_id: string | null;
}

interface ContinuityPolicy {
  id: string;
  service_agreement_location_id: string;
  service_agreement_module_id: string;
  continuity_mode: 'none' | 'handoff_only' | 'live_read' | 'live_read_and_receive';
  client_coverage_start: string | null;
  client_coverage_end: string | null;
  provider_coverage_start: string | null;
  provider_coverage_end: string | null;
  share_active_cases: boolean;
  share_open_tasks: boolean;
  share_recent_history_hours: number;
  share_attachments_mode: 'none' | 'redacted' | 'selected_only';
  share_presence_mode: 'none' | 'on_duty_only';
  require_handoff_ack: boolean;
  continuity_retention_hours: number;
}

interface ContinuityForm {
  locationId: string;
  moduleId: string;
  mode: ContinuityPolicy['continuity_mode'];
  clientStart: string;
  clientEnd: string;
  providerStart: string;
  providerEnd: string;
  shareActiveCases: boolean;
  shareOpenTasks: boolean;
  historyHours: number;
  attachmentsMode: ContinuityPolicy['share_attachments_mode'];
  presenceMode: ContinuityPolicy['share_presence_mode'];
  requireAck: boolean;
  retentionHours: number;
}

const emptyContinuityForm: ContinuityForm = {
  locationId: '',
  moduleId: '',
  mode: 'none',
  clientStart: '',
  clientEnd: '',
  providerStart: '',
  providerEnd: '',
  shareActiveCases: false,
  shareOpenTasks: false,
  historyHours: 24,
  attachmentsMode: 'none',
  presenceMode: 'none',
  requireAck: true,
  retentionHours: 24,
};

export function CrmOperationalWorkPanel({
  agreement,
  sites,
  zones,
  onChanged,
}: {
  agreement: AgreementRef;
  sites: PlaceRef[];
  zones: PlaceRef[];
  onChanged?: () => void | Promise<void>;
}) {
  const [locations, setLocations] = useState<AgreementLocation[]>([]);
  const [modules, setModules] = useState<AgreementModule[]>([]);
  const [routes, setRoutes] = useState<PatrolRoute[]>([]);
  const [workUnits, setWorkUnits] = useState<WorkUnit[]>([]);
  const [schedules, setSchedules] = useState<DeliverySchedule[]>([]);
  const [configLinks, setConfigLinks] = useState<PatrolConfigLink[]>([]);
  const [continuityPolicies, setContinuityPolicies] = useState<ContinuityPolicy[]>([]);
  const [houses, setHouses] = useState<LocationHouse[]>([]);
  const [assignments, setAssignments] = useState<ModuleAssignment[]>([]);
  const [toolsetForm, setToolsetForm] = useState<ToolsetForm | null>(null);
  const [savingToolset, setSavingToolset] = useState(false);
  const [buildingRun, setBuildingRun] = useState(false);
  const [savingContinuity, setSavingContinuity] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'static' as 'static' | 'patrol', locationId: '', moduleId: '', routeId: '' });
  const [continuityForm, setContinuityForm] = useState<ContinuityForm>(emptyContinuityForm);

  const load = useCallback(async () => {
    if (agreement.agreement_type !== 'operational') {
      setLocations([]); setModules([]); setRoutes([]); setWorkUnits([]); setSchedules([]); setConfigLinks([]); setContinuityPolicies([]); setHouses([]); setAssignments([]); setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    const [locationResponse, moduleResponse, routeResponse, unitResponse, scheduleResponse] = await Promise.all([
      supabase.from('service_agreement_locations').select('id,service_agreement_id,site_id,zone_id,status').eq('service_agreement_id', agreement.id).eq('status', 'active'),
      supabase.from('service_agreement_modules').select('id,service_agreement_id,module_key,enabled').eq('service_agreement_id', agreement.id).eq('enabled', true),
      // routes and work units belong to the delivering branch, which may be a branch of the agreement holder
      supabase.rpc('get_descendant_organizations', { org_id: agreement.provider_organization_id }).then(async ({ data }) => {
        const houseIds = Array.isArray(data) && data.length ? (data as string[]) : [agreement.provider_organization_id];
        return supabase.from('patrol_routes').select('id,name,organization_id').in('organization_id', houseIds).eq('is_active', true).order('name');
      }),
      supabase.rpc('get_descendant_organizations', { org_id: agreement.provider_organization_id }).then(async ({ data }) => {
        const houseIds = Array.isArray(data) && data.length ? (data as string[]) : [agreement.provider_organization_id];
        return supabase.from('roster_work_units').select('id,name,work_unit_type,service_type,active,patrol_route_id,service_agreement_location_id,service_agreement_module_id').in('organization_id', houseIds).eq('active', true).order('name');
      }),
      // ATLAS READS: service_agreement_delivery_schedules (the accepted quote's places and times)
      supabase.from('service_agreement_delivery_schedules').select('id,proposal_scope_schedule_id,site_id,zone_id,capability_key,work_model,active_days,visits_per_shift,window_start,window_end,dwell_minutes,response_sla_minutes,officer_instructions').eq('service_agreement_id', agreement.id).eq('active', true).order('preferred_stop_order'),
    ]);
    const scheduleRows = ((scheduleResponse.data as DeliverySchedule[]) ?? []).filter((schedule) => schedule.capability_key !== 'alarm_response');
    const scheduleKeys = scheduleRows.map((schedule) => schedule.proposal_scope_schedule_id).filter((key): key is string => Boolean(key));
    // ATLAS READS: client_site_patrol_config (whether each scheduled place is on a patrol run yet)
    const configResponse = scheduleKeys.length
      ? await supabase.from('client_site_patrol_config').select('id,proposal_scope_schedule_id,patrol_route_id').in('proposal_scope_schedule_id', scheduleKeys).eq('active', true)
      : { data: [] as PatrolConfigLink[], error: null };
    const locationIds = ((locationResponse.data as AgreementLocation[]) ?? []).map((location) => location.id);
    const continuityResponse = locationIds.length
      ? await supabase.from('service_agreement_continuity_policies').select('id,service_agreement_location_id,service_agreement_module_id,continuity_mode,client_coverage_start,client_coverage_end,provider_coverage_start,provider_coverage_end,share_active_cases,share_open_tasks,share_recent_history_hours,share_attachments_mode,share_presence_mode,require_handoff_ack,continuity_retention_hours').in('service_agreement_location_id', locationIds)
      : { data: [] as ContinuityPolicy[], error: null };
    // ATLAS READS: client_sites.location_id / location_zones.location_id — the Location house behind each agreement facet
    const facetSiteIds = ((locationResponse.data as AgreementLocation[]) ?? []).map((location) => location.site_id).filter((id): id is string => Boolean(id));
    const facetZoneIds = ((locationResponse.data as AgreementLocation[]) ?? []).map((location) => location.zone_id).filter((id): id is string => Boolean(id));
    const [facetSiteResponse, facetZoneResponse] = await Promise.all([
      facetSiteIds.length ? supabase.from('client_sites').select('id,location_id').in('id', facetSiteIds) : Promise.resolve({ data: [] as { id: string; location_id: string | null }[], error: null }),
      facetZoneIds.length ? supabase.from('location_zones').select('id,location_id').in('id', facetZoneIds) : Promise.resolve({ data: [] as { id: string; location_id: string | null }[], error: null }),
    ]);
    const houseIdList = Array.from(new Set([
      ...((facetSiteResponse.data as { location_id: string | null }[]) ?? []).map((row) => row.location_id),
      ...((facetZoneResponse.data as { location_id: string | null }[]) ?? []).map((row) => row.location_id),
    ].filter((id): id is string => Boolean(id))));
    // ATLAS READS: locations, location_module_assignments — which toolset runs at which house under this agreement
    const [houseResponse, assignmentResponse] = await Promise.all([
      houseIdList.length ? supabase.from('locations').select('id,name').in('id', houseIdList).order('name') : Promise.resolve({ data: [] as LocationHouse[], error: null }),
      houseIdList.length ? supabase.from('location_module_assignments').select('id,location_id,module_key,service_agreement_id,enabled,effective_from,effective_to,updated_at').eq('service_agreement_id', agreement.id).in('location_id', houseIdList) : Promise.resolve({ data: [] as ModuleAssignment[], error: null }),
    ]);
    const failures = [locationResponse.error, moduleResponse.error, routeResponse.error, unitResponse.error, scheduleResponse.error, configResponse.error, continuityResponse.error, facetSiteResponse.error, facetZoneResponse.error, houseResponse.error, assignmentResponse.error].filter(Boolean);
    if (failures.length) setError(failures[0]?.message ?? 'Operational work evidence could not be loaded.');
    const nextLocations = (locationResponse.data as AgreementLocation[]) ?? [];
    const nextModules = (moduleResponse.data as AgreementModule[]) ?? [];
    const nextRoutes = (routeResponse.data as PatrolRoute[]) ?? [];
    const locationIdSet = new Set(nextLocations.map((location) => location.id));
    const routeIds = new Set(nextRoutes.map((route) => route.id));
    setLocations(nextLocations);
    setModules(nextModules);
    setRoutes(nextRoutes);
    setSchedules(scheduleRows);
    setConfigLinks((configResponse.data as PatrolConfigLink[]) ?? []);
    setContinuityPolicies((continuityResponse.data as ContinuityPolicy[]) ?? []);
    setHouses((houseResponse.data as LocationHouse[]) ?? []);
    setAssignments((assignmentResponse.data as ModuleAssignment[]) ?? []);
    setToolsetForm(null);
    setWorkUnits(((unitResponse.data as WorkUnit[]) ?? []).filter((unit) =>
      (unit.service_agreement_location_id && locationIdSet.has(unit.service_agreement_location_id)) ||
      (unit.patrol_route_id && routeIds.has(unit.patrol_route_id))
    ));
    setForm((current) => ({
      ...current,
      locationId: nextLocations.some((location) => location.id === current.locationId) ? current.locationId : (nextLocations[0]?.id ?? ''),
      moduleId: nextModules.some((module) => module.id === current.moduleId) ? current.moduleId : (nextModules.find((module) => module.module_key === 'static_guarding')?.id ?? nextModules[0]?.id ?? ''),
      routeId: nextRoutes.some((route) => route.id === current.routeId) ? current.routeId : (nextRoutes[0]?.id ?? ''),
    }));
    setContinuityForm((current) => ({
      ...current,
      locationId: nextLocations.some((location) => location.id === current.locationId) ? current.locationId : (nextLocations[0]?.id ?? ''),
      moduleId: nextModules.some((module) => module.id === current.moduleId) ? current.moduleId : (nextModules[0]?.id ?? ''),
    }));
    setLoading(false);
  }, [agreement.agreement_type, agreement.id, agreement.invitation_status, agreement.provider_organization_id]);

  useEffect(() => { void load(); }, [load]);

  const placeName = useCallback((location: AgreementLocation) => {
    if (location.site_id) return sites.find((site) => site.id === location.site_id)?.name ?? 'Covered site';
    if (location.zone_id) return zones.find((zone) => zone.id === location.zone_id)?.name ?? 'Covered zone';
    return 'Covered place';
  }, [sites, zones]);

  const staticModules = useMemo(() => modules.filter((module) => module.module_key === 'static_guarding'), [modules]);
  const selectedStaticModule = staticModules.find((module) => module.id === form.moduleId) ?? staticModules[0] ?? null;
  const canCreate = form.type === 'patrol'
    ? Boolean(form.name.trim() && form.routeId)
    : Boolean(form.name.trim() && form.locationId && selectedStaticModule);

  const schedulePlaceName = useCallback((schedule: DeliverySchedule) => {
    if (schedule.site_id) return sites.find((site) => site.id === schedule.site_id)?.name ?? 'Contracted site';
    if (schedule.zone_id) return zones.find((zone) => zone.id === schedule.zone_id)?.name ?? 'Contracted zone';
    return 'Contracted place';
  }, [sites, zones]);

  // The patrol run is the route the scheduled places are attached to (none, one, or a partial attach).
  const patrolRun = useMemo(() => {
    const linkByKey = new Map(configLinks.map((link) => [link.proposal_scope_schedule_id, link]));
    const routed = schedules.filter((schedule) => linkByKey.get(schedule.proposal_scope_schedule_id)?.patrol_route_id);
    const routeId = routed.map((schedule) => linkByKey.get(schedule.proposal_scope_schedule_id)?.patrol_route_id ?? null).find(Boolean) ?? null;
    return { routeId, routeName: routes.find((route) => route.id === routeId)?.name ?? null, routedCount: routed.length, unroutedCount: schedules.length - routed.length };
  }, [configLinks, routes, schedules]);
  const patrolWorkUnits = useMemo(() => workUnits.filter((unit) => unit.patrol_route_id && unit.patrol_route_id === patrolRun.routeId), [patrolRun.routeId, workUnits]);

  const buildPatrolRun = async () => {
    setBuildingRun(true); setError(null); setNotice(null);
    // ATLAS WRITES: create_patrol_route_from_agreement (route + config attachment + contract inheritance, audited)
    const { data, error: buildError } = await supabase.rpc('create_patrol_route_from_agreement', {
      p_client_request_id: crypto.randomUUID(),
      p_service_agreement_id: agreement.id,
      p_name: null,
    });
    const receipt = (Array.isArray(data) ? data[0] : data) as { route_id: string; route_name: string; created: boolean; attached_places: number; skipped_places: number } | null;
    if (buildError || !receipt) setError(buildError?.message ?? 'The patrol run was not confirmed.');
    else {
      setNotice(`${receipt.route_name} ${receipt.created ? 'is built' : 'already existed'} with ${receipt.attached_places} ${receipt.attached_places === 1 ? 'place' : 'places'}${receipt.skipped_places ? ` (${receipt.skipped_places} duplicate schedule${receipt.skipped_places === 1 ? '' : 's'} left off)` : ''}. Next: add a work unit so it can be rostered.`);
      setForm((current) => ({ ...current, type: 'patrol', routeId: receipt.route_id, name: current.name || receipt.route_name }));
      await load();
      await onChanged?.();
    }
    setBuildingRun(false);
  };

  const createWorkUnit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(null); setNotice(null);
    const isPatrol = form.type === 'patrol';
    const { data, error: createError } = await supabase.rpc('create_operating_roster_work_unit', {
      // a patrol work unit is rostered where its run lives (the delivering branch); a static post stays with the agreement holder
      p_operating_organization_id: (isPatrol ? routes.find((route) => route.id === form.routeId)?.organization_id : null) ?? agreement.provider_organization_id,
      p_name: form.name.trim(),
      p_work_unit_type: form.type,
      p_service_type: isPatrol ? 'patrol' : 'static_guarding',
      p_patrol_route_id: isPatrol ? form.routeId : null,
      p_service_agreement_location_id: isPatrol ? null : form.locationId,
      p_service_agreement_module_id: isPatrol ? null : selectedStaticModule?.id ?? null,
      p_workplace_id: null,
      p_team_id: null,
      p_cost_centre_id: null,
    });
    if (createError || !data) setError(createError?.message ?? 'Work unit creation was not confirmed.');
    else {
      setNotice(`${form.name.trim()} is ready for rostering.`);
      setForm({ name: '', type: form.type, locationId: form.locationId, moduleId: form.moduleId, routeId: form.routeId });
      setShowForm(false);
      await load();
      await onChanged?.();
    }
    setSaving(false);
  };

  const agreementModuleKeys = useMemo(
    () => Array.from(new Set(modules.map((module) => module.module_key))).sort(),
    [modules],
  );
  const assignmentFor = useCallback(
    (locationId: string, moduleKey: string) => assignments.find((row) => row.location_id === locationId && row.module_key === moduleKey),
    [assignments],
  );

  const openToolset = (locationId: string, moduleKey: string) => {
    const existing = assignmentFor(locationId, moduleKey);
    setToolsetForm({
      locationId,
      moduleKey,
      enabled: existing ? !existing.enabled : true,
      effectiveFrom: existing?.effective_from ?? new Date().toISOString().slice(0, 10),
      effectiveTo: existing?.effective_to ?? '',
      expectedUpdatedAt: existing?.updated_at ?? null,
    });
    setError(null);
    setNotice(null);
  };

  const saveToolset = async (event: FormEvent) => {
    event.preventDefault();
    if (!toolsetForm) return;
    if (toolsetForm.effectiveTo && toolsetForm.effectiveTo < toolsetForm.effectiveFrom) {
      setError('The end date cannot be before the start date.');
      return;
    }
    setSavingToolset(true); setError(null); setNotice(null);
    // ATLAS WRITES: manage_location_module_assignment (replay-safe, optimistic, audited per-place toolset)
    const { data, error: saveError } = await supabase.rpc('manage_location_module_assignment', {
      p_client_request_id: crypto.randomUUID(),
      p_location_id: toolsetForm.locationId,
      p_service_agreement_id: agreement.id,
      p_module_key: toolsetForm.moduleKey,
      p_expected_updated_at: toolsetForm.expectedUpdatedAt,
      p_enabled: toolsetForm.enabled,
      p_effective_from: toolsetForm.effectiveFrom,
      p_effective_to: toolsetForm.effectiveTo || null,
    });
    const saved = (Array.isArray(data) ? data[0] : data) as ModuleAssignment | null;
    if (saveError || !saved) setError(saveError?.message ?? 'The module change at this place was not confirmed.');
    else {
      const houseName = houses.find((house) => house.id === toolsetForm.locationId)?.name ?? 'this place';
      setNotice(`${toolsetForm.moduleKey.replaceAll('_', ' ')} is now ${saved.enabled ? 'on' : 'off'} at ${houseName}, ${describeAssignment(saved).toLowerCase()}. An audit receipt was recorded. Next: officers at this place see this toolset on their next shift.`);
      setToolsetForm(null);
      await load();
      await onChanged?.();
    }
    setSavingToolset(false);
  };

  const editContinuityPair = (locationId: string, moduleId: string) => {    const policy = continuityPolicies.find((candidate) =>
      candidate.service_agreement_location_id === locationId
      && candidate.service_agreement_module_id === moduleId
    );
    setContinuityForm(policy ? {
      locationId,
      moduleId,
      mode: policy.continuity_mode,
      clientStart: policy.client_coverage_start?.slice(0, 5) ?? '',
      clientEnd: policy.client_coverage_end?.slice(0, 5) ?? '',
      providerStart: policy.provider_coverage_start?.slice(0, 5) ?? '',
      providerEnd: policy.provider_coverage_end?.slice(0, 5) ?? '',
      shareActiveCases: policy.share_active_cases,
      shareOpenTasks: policy.share_open_tasks,
      historyHours: policy.share_recent_history_hours,
      attachmentsMode: policy.share_attachments_mode,
      presenceMode: policy.share_presence_mode,
      requireAck: policy.require_handoff_ack,
      retentionHours: policy.continuity_retention_hours,
    } : { ...emptyContinuityForm, locationId, moduleId });
    setError(null);
    setNotice(null);
  };

  const saveContinuityPolicy = async (event: FormEvent) => {
    event.preventDefault();
    if (!continuityForm.locationId || !continuityForm.moduleId) {
      setError('Choose the agreement place and module before saving continuity.');
      return;
    }
    if (Boolean(continuityForm.clientStart) !== Boolean(continuityForm.clientEnd)
      || Boolean(continuityForm.providerStart) !== Boolean(continuityForm.providerEnd)) {
      setError('Each coverage window needs both a start and an end, or neither for all-day coverage.');
      return;
    }
    if (!Number.isInteger(continuityForm.historyHours)
      || continuityForm.historyHours < 1
      || continuityForm.historyHours > 168
      || !Number.isInteger(continuityForm.retentionHours)
      || continuityForm.retentionHours < 1
      || continuityForm.retentionHours > 168) {
      setError('History and handoff retention must each be a whole number from 1 to 168 hours.');
      return;
    }
    setSavingContinuity(true);
    setError(null);
    setNotice(null);
    const { error: saveError } = await supabase.rpc('manage_service_agreement_continuity_policy', {
      p_service_agreement_location_id: continuityForm.locationId,
      p_service_agreement_module_id: continuityForm.moduleId,
      p_continuity_mode: continuityForm.mode,
      p_client_coverage_start: continuityForm.clientStart || null,
      p_client_coverage_end: continuityForm.clientEnd || null,
      p_provider_coverage_start: continuityForm.providerStart || null,
      p_provider_coverage_end: continuityForm.providerEnd || null,
      p_share_active_cases: continuityForm.shareActiveCases,
      p_share_open_tasks: continuityForm.shareOpenTasks,
      p_share_recent_history_hours: continuityForm.historyHours,
      p_share_attachments_mode: continuityForm.attachmentsMode,
      p_share_presence_mode: continuityForm.presenceMode,
      p_require_handoff_ack: continuityForm.requireAck,
      p_continuity_retention_hours: continuityForm.retentionHours,
    });
    if (saveError) setError(saveError.message);
    else {
      const location = locations.find((candidate) => candidate.id === continuityForm.locationId);
      const module = modules.find((candidate) => candidate.id === continuityForm.moduleId);
      setNotice(`Continuity for ${location ? placeName(location) : 'this place'} · ${module?.module_key.replaceAll('_', ' ') ?? 'module'} is saved with an audit receipt.`);
      await load();
    }
    setSavingContinuity(false);
  };

  if (agreement.agreement_type !== 'operational') return null;

  return <section className="crm-operational-work" aria-label={`Operational work for ${agreement.name}`}>
    <header>
      <div><span>Operational work</span><strong>Work units stay with this client portfolio</strong><p>Create the rosterable target from this agreement without leaving the organization record.</p></div>
      <div><button type="button" onClick={() => void load()} disabled={loading} aria-label="Refresh operational work"><RefreshCw size={15} className={loading ? 'is-spinning' : ''} /></button><button type="button" className="btn btn-sm btn-primary" onClick={() => setShowForm((current) => !current)}>{showForm ? <X size={15} /> : <Plus size={15} />}{showForm ? 'Close' : 'Add work unit'}</button></div>
    </header>
    {error && <p className="crm-workspace-subtle is-error" role="alert">{error}</p>}
    {notice && <p className="crm-workspace-subtle is-success" role="status"><CheckCircle2 size={13} />{notice}</p>}
    {loading ? <p className="crm-workspace-subtle">Loading operational work…</p> : <>
      <section className="crm-patrol-run" aria-label={`Patrol run for ${agreement.name}`}>
        <ol className="crm-patrol-run-steps">
          <li className={schedules.length ? 'is-done' : 'is-next'}>
            <span className="crm-patrol-run-step">1</span>
            <div>
              <strong>Places and times</strong>
              {schedules.length === 0
                ? <p>No scheduled places on this agreement yet. Add delivery schedules in the quote, or raise a variation, and accept it.</p>
                : <ul className="crm-patrol-run-places">{schedules.map((schedule) => <li key={schedule.id}><MapPinned size={14} aria-hidden="true" /><div><strong>{schedulePlaceName(schedule)}</strong><span>{schedule.work_model === 'as_attended_patrol' ? 'As attended' : <>{schedule.visits_per_shift} {schedule.visits_per_shift === 1 ? 'visit' : 'visits'} per shift · {describeWindow(schedule.window_start, schedule.window_end)} · {schedule.dwell_minutes} min on site · {describeDays(schedule.active_days)}</>}</span>{schedule.officer_instructions && <em>{schedule.officer_instructions}</em>}</div></li>)}</ul>}
            </div>
          </li>
          <li className={patrolRun.routeId && patrolRun.unroutedCount === 0 ? 'is-done' : schedules.length ? 'is-next' : 'is-later'}>
            <span className="crm-patrol-run-step">2</span>
            <div>
              <strong>Patrol run</strong>
              {patrolRun.routeId && patrolRun.unroutedCount === 0
                ? <p><Route size={14} aria-hidden="true" /> {patrolRun.routeName ?? 'Patrol run'} · {patrolRun.routedCount} {patrolRun.routedCount === 1 ? 'place' : 'places'}. Shifts on this run get one stop per visit, with the instructions above.</p>
                : schedules.length === 0
                  ? <p>Built from the places above once they exist.</p>
                  : <p>{patrolRun.routeId ? `${patrolRun.unroutedCount} newer ${patrolRun.unroutedCount === 1 ? 'place is' : 'places are'} not on ${patrolRun.routeName ?? 'the run'} yet.` : 'Not built yet. This turns the places above into a route the roster can use.'} <button type="button" className="btn btn-sm btn-primary" onClick={() => void buildPatrolRun()} disabled={buildingRun}>{buildingRun ? 'Building…' : patrolRun.routeId ? 'Add the new places to the run' : 'Build patrol run'}</button></p>}
            </div>
          </li>
          <li className={patrolWorkUnits.length ? 'is-done' : patrolRun.routeId ? 'is-next' : 'is-later'}>
            <span className="crm-patrol-run-step">3</span>
            <div>
              <strong>Work unit for rostering</strong>
              {patrolWorkUnits.length
                ? <p>{patrolWorkUnits.map((unit) => unit.name).join(', ')} — ready to roster in Schedules &amp; Rosters.</p>
                : patrolRun.routeId
                  ? <p>Give the run a rosterable name so officers can be scheduled onto it. <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setForm((current) => ({ ...current, type: 'patrol', routeId: patrolRun.routeId ?? current.routeId, name: current.name || `${patrolRun.routeName ?? agreement.name}` })); setShowForm(true); }}>Add work unit for this run</button></p>
                  : <p>Available after the patrol run is built.</p>}
            </div>
          </li>
        </ol>
      </section>

      <section className="crm-continuity-policy" aria-label={`Operational continuity for ${agreement.name}`}>
        <header>
          <div>
            <span>Shared operational continuity</span>
            <strong>Define what can cross the provider/client boundary</strong>
            <p>The source record stays with its authoring organisation. This policy permits only a time-bounded safe handoff for one agreement place and module.</p>
          </div>
        </header>
        {locations.length === 0 || modules.length === 0 ? (
          <p className="crm-workspace-subtle">Link at least one active place and enable one agreement module before continuity can be configured.</p>
        ) : (
          <form onSubmit={saveContinuityPolicy}>
            <label>
              <span>Agreement place</span>
              <select value={continuityForm.locationId} onChange={(event) => editContinuityPair(event.target.value, continuityForm.moduleId)}>
                {locations.map((location) => <option key={location.id} value={location.id}>{placeName(location)}</option>)}
              </select>
            </label>
            <label>
              <span>Module</span>
              <select value={continuityForm.moduleId} onChange={(event) => editContinuityPair(continuityForm.locationId, event.target.value)}>
                {modules.map((module) => <option key={module.id} value={module.id}>{module.module_key.replaceAll('_', ' ')}</option>)}
              </select>
            </label>
            <label>
              <span>Continuity mode</span>
              <select value={continuityForm.mode} onChange={(event) => setContinuityForm((current) => ({ ...current, mode: event.target.value as ContinuityForm['mode'] }))}>
                <option value="none">Off</option>
                <option value="handoff_only">Handoff acknowledgement only</option>
                <option value="live_read">Publish safe live handoffs</option>
                <option value="live_read_and_receive">Publish and receive safe live handoffs</option>
              </select>
            </label>
            <div className="crm-continuity-window">
              <strong>Provider coverage (NZ time)</strong>
              <input type="time" aria-label="Provider coverage starts" value={continuityForm.providerStart} onChange={(event) => setContinuityForm((current) => ({ ...current, providerStart: event.target.value }))} />
              <input type="time" aria-label="Provider coverage ends" value={continuityForm.providerEnd} onChange={(event) => setContinuityForm((current) => ({ ...current, providerEnd: event.target.value }))} />
            </div>
            <div className="crm-continuity-window">
              <strong>Client coverage (NZ time)</strong>
              <input type="time" aria-label="Client coverage starts" value={continuityForm.clientStart} onChange={(event) => setContinuityForm((current) => ({ ...current, clientStart: event.target.value }))} />
              <input type="time" aria-label="Client coverage ends" value={continuityForm.clientEnd} onChange={(event) => setContinuityForm((current) => ({ ...current, clientEnd: event.target.value }))} />
            </div>
            <label>
              <span>Recent history (hours)</span>
              <input type="number" min={1} max={168} value={continuityForm.historyHours} onChange={(event) => setContinuityForm((current) => ({ ...current, historyHours: Number(event.target.value) }))} />
            </label>
            <label>
              <span>Handoff retention (hours)</span>
              <input type="number" min={1} max={168} value={continuityForm.retentionHours} onChange={(event) => setContinuityForm((current) => ({ ...current, retentionHours: Number(event.target.value) }))} />
            </label>
            <label>
              <span>Attachment sharing</span>
              <select value={continuityForm.attachmentsMode} onChange={(event) => setContinuityForm((current) => ({ ...current, attachmentsMode: event.target.value as ContinuityForm['attachmentsMode'] }))}>
                <option value="none">No attachments</option>
                <option value="redacted">Redacted attachments</option>
                <option value="selected_only">Selected attachments only</option>
              </select>
            </label>
            <label>
              <span>Presence sharing</span>
              <select value={continuityForm.presenceMode} onChange={(event) => setContinuityForm((current) => ({ ...current, presenceMode: event.target.value as ContinuityForm['presenceMode'] }))}>
                <option value="none">No presence</option>
                <option value="on_duty_only">On-duty state only</option>
              </select>
            </label>
            <div className="crm-continuity-checks">
              <label><input type="checkbox" checked={continuityForm.shareActiveCases} onChange={(event) => setContinuityForm((current) => ({ ...current, shareActiveCases: event.target.checked }))} />Active cases</label>
              <label><input type="checkbox" checked={continuityForm.shareOpenTasks} onChange={(event) => setContinuityForm((current) => ({ ...current, shareOpenTasks: event.target.checked }))} />Open tasks</label>
              <label><input type="checkbox" checked={continuityForm.requireAck} onChange={(event) => setContinuityForm((current) => ({ ...current, requireAck: event.target.checked }))} />Require acknowledgement</label>
            </div>
            <footer>
              <span>{continuityPolicies.length} configured {continuityPolicies.length === 1 ? 'pair' : 'pairs'} on this agreement.</span>
              <button type="submit" className="btn btn-sm btn-primary" disabled={savingContinuity}>{savingContinuity ? 'Saving…' : 'Save continuity policy'}</button>
            </footer>
          </form>
        )}
      </section>

      <section className="crm-place-toolsets" aria-label={`Modules at each place for ${agreement.name}`}>
        <header>
          <div>
            <span>Modules at each place</span>
            <strong>Decide which toolset runs at which Location house</strong>
            <p>A module enabled on the agreement is still a choice at every place. Turn it on where officers should carry it, and off where they should not, before anyone is deployed.</p>
          </div>
        </header>
        {houses.length === 0 || agreementModuleKeys.length === 0 ? (
          <p className="crm-workspace-subtle">{houses.length === 0 ? 'No Location house is reachable from this agreement yet. Link an active Site or Zone facet first.' : 'No module is enabled on this agreement yet. Use Configure coverage and modules first.'}</p>
        ) : (
          <ul className="crm-place-toolset-list">
            {houses.map((house) => <li key={house.id}>
              <strong><MapPinned size={14} aria-hidden="true" /> {house.name}</strong>
              <ul>
                {agreementModuleKeys.map((moduleKey) => {
                  const assignment = assignmentFor(house.id, moduleKey);
                  const isEditing = toolsetForm?.locationId === house.id && toolsetForm.moduleKey === moduleKey;
                  return <li key={moduleKey} className={assignment?.enabled ? 'is-on' : assignment ? 'is-off' : 'is-unset'}>
                    <span>{moduleKey.replaceAll('_', ' ')}</span>
                    <em>{describeAssignment(assignment)}</em>
                    {isEditing ? null : <button type="button" className="btn btn-sm btn-secondary" onClick={() => openToolset(house.id, moduleKey)}>{assignment ? (assignment.enabled ? 'Turn off at this place' : 'Turn on at this place') : 'Set at this place'}</button>}
                    {isEditing && toolsetForm && <form className="crm-place-toolset-form" onSubmit={saveToolset}>
                      <p>{toolsetForm.enabled ? `Turn ${moduleKey.replaceAll('_', ' ')} on at ${house.name}.` : `Turn ${moduleKey.replaceAll('_', ' ')} off at ${house.name}.`} Officers working this place will see the change on their next shift.</p>
                      <label><span>Starts</span><input type="date" required value={toolsetForm.effectiveFrom} onChange={(changeEvent) => setToolsetForm((current) => current && { ...current, effectiveFrom: changeEvent.target.value })} /></label>
                      <label><span>Ends (optional)</span><input type="date" value={toolsetForm.effectiveTo} onChange={(changeEvent) => setToolsetForm((current) => current && { ...current, effectiveTo: changeEvent.target.value })} /></label>
                      <footer>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setToolsetForm(null)} disabled={savingToolset}>Keep current setting</button>
                        <button type="submit" className="btn btn-sm btn-primary" disabled={savingToolset}>{savingToolset ? 'Saving…' : toolsetForm.enabled ? 'Confirm turn on' : 'Confirm turn off'}</button>
                      </footer>
                    </form>}
                  </li>;
                })}
              </ul>
            </li>)}
          </ul>
        )}
      </section>
      {workUnits.length === 0 ? <p className="crm-workspace-subtle"><ClipboardList size={14} /> No rosterable work unit is linked to this agreement or provider route yet.</p> : <div className="crm-operational-work-list">{workUnits.map((unit) => <article key={unit.id}><Route size={15} /><div><strong>{unit.name}</strong><span>{unit.work_unit_type.replace('_', ' ')} · {unit.service_type.replaceAll('_', ' ')}</span></div><em>{unit.active ? 'Active' : 'Inactive'}</em></article>)}</div>}
      {showForm && <form className="crm-operational-work-form" onSubmit={createWorkUnit}>
        <label><span>Work unit name</span><input required maxLength={200} aria-label="Work unit name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Tahunanui evening patrol" /></label>
        <label><span>Work type</span><select aria-label="Work type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as 'static' | 'patrol' })}><option value="static">Contracted static coverage</option><option value="patrol">Patrol route</option></select></label>
        {form.type === 'static' ? <>
          <label><span>Covered place</span><select aria-label="Covered place" value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })}>{locations.map((location) => <option key={location.id} value={location.id}>{placeName(location)}</option>)}</select></label>
          <label><span>Agreement module</span><select aria-label="Agreement module" value={selectedStaticModule?.id ?? ''} onChange={(event) => setForm({ ...form, moduleId: event.target.value })}>{staticModules.length === 0 ? <option value="">Enable static guarding in Configure agreement</option> : staticModules.map((module) => <option key={module.id} value={module.id}>{module.module_key.replaceAll('_', ' ')}</option>)}</select></label>
          {staticModules.length === 0 && <p className="crm-workspace-subtle">Static coverage requires the Static Guarding module on this accepted agreement.</p>}
        </> : <>
          <label><span>Patrol route</span><select aria-label="Patrol route" value={form.routeId} onChange={(event) => setForm({ ...form, routeId: event.target.value })}>{routes.length === 0 ? <option value="">No active patrol route in this operating branch</option> : routes.map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}</select></label>
          {routes.length === 0 && <p className="crm-workspace-subtle">No patrol run exists yet. Build one from the agreement places above.</p>}
        </>}
        <footer><span>Uses the governed roster work-unit RPC and writes an audit event.</span><button type="submit" className="btn btn-sm btn-primary" disabled={saving || !canCreate}>{saving ? 'Creating' : 'Create work unit'}</button></footer>
      </form>}
    </>}
  </section>;
}
