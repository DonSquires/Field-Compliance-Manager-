import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, ClipboardList, Plus, RefreshCw, Route, X } from 'lucide-react';
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'static' as 'static' | 'patrol', locationId: '', moduleId: '', routeId: '' });

  const load = useCallback(async () => {
    if (agreement.agreement_type !== 'operational' || agreement.invitation_status !== 'accepted') {
      setLocations([]); setModules([]); setRoutes([]); setWorkUnits([]); setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    const [locationResponse, moduleResponse, routeResponse, unitResponse] = await Promise.all([
      supabase.from('service_agreement_locations').select('id,service_agreement_id,site_id,zone_id,status').eq('service_agreement_id', agreement.id).eq('status', 'active'),
      supabase.from('service_agreement_modules').select('id,service_agreement_id,module_key,enabled').eq('service_agreement_id', agreement.id).eq('enabled', true),
      supabase.from('patrol_routes').select('id,name').eq('organization_id', agreement.provider_organization_id).eq('is_active', true).order('name'),
      supabase.from('roster_work_units').select('id,name,work_unit_type,service_type,active,patrol_route_id,service_agreement_location_id,service_agreement_module_id').eq('organization_id', agreement.provider_organization_id).eq('active', true).order('name'),
    ]);
    const failures = [locationResponse.error, moduleResponse.error, routeResponse.error, unitResponse.error].filter(Boolean);
    if (failures.length) setError(failures[0]?.message ?? 'Operational work evidence could not be loaded.');
    const nextLocations = (locationResponse.data as AgreementLocation[]) ?? [];
    const nextModules = (moduleResponse.data as AgreementModule[]) ?? [];
    const nextRoutes = (routeResponse.data as PatrolRoute[]) ?? [];
    const locationIds = new Set(nextLocations.map((location) => location.id));
    const routeIds = new Set(nextRoutes.map((route) => route.id));
    setLocations(nextLocations);
    setModules(nextModules);
    setRoutes(nextRoutes);
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

  const createWorkUnit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(null); setNotice(null);
    const isPatrol = form.type === 'patrol';
    const { data, error: createError } = await supabase.rpc('create_operating_roster_work_unit', {
      p_operating_organization_id: agreement.provider_organization_id,
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
      {workUnits.length === 0 ? <p className="crm-workspace-subtle"><ClipboardList size={14} /> No rosterable work unit is linked to this agreement or provider route yet.</p> : <div className="crm-operational-work-list">{workUnits.map((unit) => <article key={unit.id}><Route size={15} /><div><strong>{unit.name}</strong><span>{unit.work_unit_type.replace('_', ' ')} · {unit.service_type.replaceAll('_', ' ')}</span></div><em>{unit.active ? 'Active' : 'Inactive'}</em></article>)}</div>}
      {showForm && <form className="crm-operational-work-form" onSubmit={createWorkUnit}>
        <label><span>Work unit name</span><input required maxLength={200} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Tahunanui evening patrol" /></label>
        <label><span>Work type</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as 'static' | 'patrol' })}><option value="static">Contracted static coverage</option><option value="patrol">Patrol route</option></select></label>
        {form.type === 'static' ? <>
          <label><span>Covered place</span><select value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })}>{locations.map((location) => <option key={location.id} value={location.id}>{placeName(location)}</option>)}</select></label>
          <label><span>Agreement module</span><select value={selectedStaticModule?.id ?? ''} onChange={(event) => setForm({ ...form, moduleId: event.target.value })}>{staticModules.length === 0 ? <option value="">Enable static guarding in Configure agreement</option> : staticModules.map((module) => <option key={module.id} value={module.id}>{module.module_key.replaceAll('_', ' ')}</option>)}</select></label>
          {staticModules.length === 0 && <p className="crm-workspace-subtle">Static coverage requires the Static Guarding module on this accepted agreement.</p>}
        </> : <>
          <label><span>Patrol route</span><select value={form.routeId} onChange={(event) => setForm({ ...form, routeId: event.target.value })}>{routes.length === 0 ? <option value="">No active patrol route in this operating branch</option> : routes.map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}</select></label>
          {routes.length === 0 && <p className="crm-workspace-subtle">Create or approve an active patrol route for this operating branch before selecting patrol work.</p>}
        </>}
        <footer><span>Uses the governed roster work-unit RPC and writes an audit event.</span><button type="submit" className="btn btn-sm btn-primary" disabled={saving || !canCreate}>{saving ? 'Creating' : 'Create work unit'}</button></footer>
      </form>}
    </>}
  </section>;
}
