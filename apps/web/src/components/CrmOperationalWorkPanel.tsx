import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, ClipboardList, MapPinned, Plus, RefreshCw, Route, X } from 'lucide-react';
import { supabase } from '../lib/supabase';

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

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const describeDays = (days: number[]) => days.length >= 7 ? 'Every day' : days.length === 0 ? 'No days set' : days.map((day) => DAY_LABELS[day - 1] ?? day).join(', ');
const describeWindow = (start: string | null, end: string | null) => start ? `${start.slice(0, 5)}${end ? `–${end.slice(0, 5)}` : ''}` : 'Any time in shift';

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

interface WorkUnit {
  id: string;
  name: string;
  work_unit_type: 'patrol' | 'static' | 'internal';
  service_type: string;
  active: boolean;
  patrol_route_id: string | null;
  service_agreement_location_id: string | null;
  service_agreement_module_id: string | null;
}

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
  const [buildingRun, setBuildingRun] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'static' as 'static' | 'patrol', locationId: '', moduleId: '', routeId: '' });

  const load = useCallback(async () => {
    if (agreement.agreement_type !== 'operational' || agreement.invitation_status !== 'accepted') {
      setLocations([]); setModules([]); setRoutes([]); setWorkUnits([]); setSchedules([]); setConfigLinks([]); setLoading(false);
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
    const failures = [locationResponse.error, moduleResponse.error, routeResponse.error, unitResponse.error, scheduleResponse.error, configResponse.error].filter(Boolean);
    if (failures.length) setError(failures[0]?.message ?? 'Operational work evidence could not be loaded.');
    const nextLocations = (locationResponse.data as AgreementLocation[]) ?? [];
    const nextModules = (moduleResponse.data as AgreementModule[]) ?? [];
    const nextRoutes = (routeResponse.data as PatrolRoute[]) ?? [];
    const locationIds = new Set(nextLocations.map((location) => location.id));
    const routeIds = new Set(nextRoutes.map((route) => route.id));
    setLocations(nextLocations);
    setModules(nextModules);
    setRoutes(nextRoutes);
    setSchedules(scheduleRows);
    setConfigLinks((configResponse.data as PatrolConfigLink[]) ?? []);
    setWorkUnits(((unitResponse.data as WorkUnit[]) ?? []).filter((unit) =>
      (unit.service_agreement_location_id && locationIds.has(unit.service_agreement_location_id)) ||
      (unit.patrol_route_id && routeIds.has(unit.patrol_route_id))
    ));
    setForm((current) => ({
      ...current,
      locationId: nextLocations.some((location) => location.id === current.locationId) ? current.locationId : (nextLocations[0]?.id ?? ''),
      moduleId: nextModules.some((module) => module.id === current.moduleId) ? current.moduleId : (nextModules.find((module) => module.module_key === 'static_guarding')?.id ?? nextModules[0]?.id ?? ''),
      routeId: nextRoutes.some((route) => route.id === current.routeId) ? current.routeId : (nextRoutes[0]?.id ?? ''),
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

  if (agreement.agreement_type !== 'operational' || agreement.invitation_status !== 'accepted') return null;

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
                : <ul className="crm-patrol-run-places">{schedules.map((schedule) => <li key={schedule.id}><MapPinned size={14} aria-hidden="true" /><div><strong>{schedulePlaceName(schedule)}</strong><span>{schedule.visits_per_shift} {schedule.visits_per_shift === 1 ? 'visit' : 'visits'} per shift · {describeWindow(schedule.window_start, schedule.window_end)} · {schedule.dwell_minutes} min on site · {describeDays(schedule.active_days)}</span>{schedule.officer_instructions && <em>{schedule.officer_instructions}</em>}</div></li>)}</ul>}
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
