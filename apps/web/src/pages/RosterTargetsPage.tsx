import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, MapPin, Plus, RefreshCw, Route, Search, Shield, Users, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { readWorkflowContext, workflowContextQuery } from '../lib/workflowNavigation';
import './RosterTargetsPage.css';
type UnitType = 'patrol' | 'static' | 'internal';
interface Unit {
  id: string;
  name: string;
  work_unit_type: UnitType;
  service_type: string;
  active: boolean;
  patrol_route_id: string | null;
  service_agreement_location_id: string | null;
  service_agreement_module_id: string | null;
  workplace_id: string | null;
  team_id: string | null;
  cost_centre_id: string | null;
  required_skill_names: string[];
}
interface Option {
  id: string;
  name: string;
  [key: string]: unknown;
}
interface AgreementLocation {
  id: string;
  service_agreement_id: string;
  site_id: string | null;
  zone_id: string | null;
}
interface Module {
  id: string;
  service_agreement_id: string;
  module_key: string;
}
const RosterTargetsPage: React.FC = () => {
  const { profile, operatingOrganizationId } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const workflowContext = readWorkflowContext(location.search);
  const [units, setUnits] = useState<Unit[]>([]);
  const [routes, setRoutes] = useState<Option[]>([]);
  const [locations, setLocations] = useState<AgreementLocation[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [sites, setSites] = useState<Option[]>([]);
  const [zones, setZones] = useState<Option[]>([]);
  const [workplaces, setWorkplaces] = useState<Option[]>([]);
  const [teams, setTeams] = useState<Option[]>([]);
  const [costs, setCosts] = useState<Array<Option & { code: string }>>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'unit' | 'workplace' | 'cost' | null>(null);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<UnitType>('patrol');
  const [form, setForm] = useState({
    name: '',
    serviceType: 'patrol',
    routeId: '',
    locationId: '',
    moduleId: '',
    workplaceId: '',
    teamId: '',
    costId: '',
    address: '',
    code: '',
    requiredSkills: '',
  });
  const load = useCallback(async () => {
    const org = operatingOrganizationId ?? profile?.organizationId;
    if (!org) {
      setError('Organisation access could not be confirmed. Work units are unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const responses = await Promise.all([supabase.from('roster_work_units').select('id,name,work_unit_type,service_type,active,patrol_route_id,service_agreement_location_id,service_agreement_module_id,workplace_id,team_id,cost_centre_id,required_skill_names').eq('organization_id', org).order('name'), supabase.from('patrol_routes').select('id,name').eq('organization_id', org).eq('is_active', true).order('name'), supabase.from('service_agreement_locations').select('id,service_agreement_id,site_id,zone_id').eq('status', 'active'), supabase.from('service_agreement_modules').select('id,service_agreement_id,module_key').eq('enabled', true).eq('module_key', 'static_guarding'), supabase.from('client_sites').select('id,name').eq('active', true), supabase.from('location_zones').select('id,name').eq('is_active', true), supabase.from('organization_workplaces').select('id,name').eq('organization_id', org).eq('active', true).order('name'), supabase.from('teams').select('id,name').eq('organization_id', org).eq('status', 'active').order('name'), supabase.from('cost_centres').select('id,code,name').eq('organization_id', org).eq('active', true).order('code')]);
    const [a, b, c, d, e, f, g, h, i] = responses;
    setUnits((a.data as Unit[]) ?? []);
    setRoutes((b.data as Option[]) ?? []);
    setModules((d.data as Module[]) ?? []);
    setSites((e.data as Option[]) ?? []);
    setZones((f.data as Option[]) ?? []);
    setWorkplaces((g.data as Option[]) ?? []);
    setTeams((h.data as Option[]) ?? []);
    setCosts((i.data as Array<Option & { code: string }>) ?? []);
    const failures = responses.filter((r) => r.error).map((r) => r.error?.message);
    if (failures.length) setError(failures.join(' · '));
    setLoading(false);
  }, [operatingOrganizationId, profile?.organizationId]);
  useEffect(() => {
    void load();
  }, [load]);
  const names = useMemo(() => new Map([...routes, ...sites, ...zones, ...workplaces, ...teams, ...costs].map((v) => [v.id, v.name])), [costs, routes, sites, teams, workplaces, zones]);
  const visible = units.filter((u) => !search || `${u.name} ${u.service_type} ${u.work_unit_type}`.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => {
    if (!workflowContext.workUnitId || loading) return;
    const requestedUnit = units.find((unit) => unit.id === workflowContext.workUnitId);
    if (!requestedUnit) return;
    setSearch('');
    requestAnimationFrame(() => {
      document.getElementById(`work-unit-${requestedUnit.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [loading, units, workflowContext.workUnitId]);
  const reset = () =>
    setForm({
      name: '',
      serviceType: type === 'internal' ? 'administration' : type === 'static' ? 'static_guarding' : 'patrol',
      routeId: '',
      locationId: '',
      moduleId: '',
      workplaceId: '',
      teamId: '',
      costId: '',
      address: '',
      code: '',
      requiredSkills: '',
    });
  const createUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const activeOperatingOrganizationId = operatingOrganizationId ?? profile?.organizationId;
    if (!activeOperatingOrganizationId) return;
    const { data, error: rpcError } = await supabase.rpc('create_operating_roster_work_unit', {
      p_operating_organization_id: activeOperatingOrganizationId,
      p_name: form.name,
      p_work_unit_type: type,
      p_service_type: form.serviceType,
      p_patrol_route_id: type === 'patrol' ? form.routeId : null,
      p_service_agreement_location_id: type === 'static' ? form.locationId : null,
      p_service_agreement_module_id: type === 'static' ? form.moduleId : null,
      p_workplace_id: type === 'internal' ? form.workplaceId : null,
      p_team_id: type === 'internal' && form.teamId ? form.teamId : null,
      p_cost_centre_id: type === 'internal' && form.costId ? form.costId : null,
    });
    if (rpcError || !data) setError(rpcError?.message ?? 'Work unit creation was not confirmed.');
    else {
      const createdUnit = Array.isArray(data) ? data[0] : data;
      const requiredSkills = form.requiredSkills.split(',').map((skill) => skill.trim()).filter(Boolean);
      if (requiredSkills.length && createdUnit?.id) {
        const { error: skillError } = await supabase.rpc('manage_roster_work_unit_skill_requirements', { p_work_unit_id: createdUnit.id, p_required_skill_names: requiredSkills });
        if (skillError) { setError(skillError.message); setBusy(false); return; }
      }
      setNotice(`${type} work unit created.`);
      setDialog(null);
      reset();
      await load();
    }
    setBusy(false);
  };
  const createReference = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const isWorkplace = dialog === 'workplace';
    const activeOperatingOrganizationId = operatingOrganizationId ?? profile?.organizationId;
    if (!activeOperatingOrganizationId) return;
    const { error: rpcError } = await supabase.rpc(isWorkplace ? 'create_operating_organization_workplace' : 'create_operating_cost_centre', isWorkplace ? { p_operating_organization_id: activeOperatingOrganizationId, p_name: form.name, p_address: form.address || null } : { p_operating_organization_id: activeOperatingOrganizationId, p_code: form.code, p_name: form.name });
    if (rpcError) setError(rpcError.message);
    else {
      setNotice(`${isWorkplace ? 'Workplace' : 'Cost centre'} created.`);
      setDialog(null);
      reset();
      await load();
    }
    setBusy(false);
  };
  const locationLabel = (l: AgreementLocation) => names.get(l.site_id ?? l.zone_id ?? '') ?? `Agreement location ${l.id.slice(0, 8)}`;
  const scopedLocations = workflowContext.agreementId ? locations.filter((location) => location.service_agreement_id === workflowContext.agreementId) : locations;
  const scopedModules = workflowContext.agreementId ? modules.filter((module) => module.service_agreement_id === workflowContext.agreementId) : modules;
  const matchingModules = scopedModules.filter((module) => module.service_agreement_id === scopedLocations.find((location) => location.id === form.locationId)?.service_agreement_id);
  return (
    <div className="targets-page">
      <header className="targets-header">
        <div>
          <span>Roster architecture</span>
          <h1>Work units</h1>
          <p>Reusable typed work targets for patrol routes, contracted static posts, and internal teams.</p>
        </div>
        <div>
          <button onClick={() => void load()} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'is-spinning' : ''} />
          </button>
          <button
            className="is-primary"
            onClick={() => {
              reset();
              setDialog('unit');
            }}
          >
            <Plus size={16} />
            New work unit
          </button>
        </div>
      </header>
      {error && (
        <div className="targets-message is-error" role="alert">
          <AlertTriangle size={17} />
          <span>{error}</span>
          <button onClick={() => setError(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="targets-message is-success" role="status">
          <CheckCircle2 size={17} />
          <span>{notice}</span>
          <button onClick={() => setNotice(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      <section className="targets-summary">
        <div>
          <Route />
          <span>Patrol</span>
          <strong>{units.filter((u) => u.work_unit_type === 'patrol').length}</strong>
        </div>
        <div>
          <Shield />
          <span>Static</span>
          <strong>{units.filter((u) => u.work_unit_type === 'static').length}</strong>
        </div>
        <div>
          <Building2 />
          <span>Internal</span>
          <strong>{units.filter((u) => u.work_unit_type === 'internal').length}</strong>
        </div>
      </section>
      <div className="targets-tools">
        <label>
          <Search size={15} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search work units" />
        </label>
        <div>
          <button
            onClick={() => {
              reset();
              setDialog('workplace');
            }}
          >
            <MapPin size={15} />
            Add workplace
          </button>
          <button
            onClick={() => {
              reset();
              setDialog('cost');
            }}
          >
            <Building2 size={15} />
            Add cost centre
          </button>
        </div>
      </div>
      <section className="targets-list">
        {loading ? (
          <div className="targets-empty">
            <RefreshCw className="is-spinning" />
            Loading work units
          </div>
        ) : visible.length === 0 ? (
          <div className="targets-empty">
            <Route />
            No work units configured
          </div>
        ) : (
          visible.map((unit) => (
            <article id={`work-unit-${unit.id}`} className={`type-${unit.work_unit_type}${workflowContext.workUnitId === unit.id ? ' is-focused' : ''}`} key={unit.id}>
              <span>{unit.work_unit_type === 'patrol' ? <Route /> : unit.work_unit_type === 'static' ? <Shield /> : <Building2 />}</span>
              <div>
                <strong>{unit.name}</strong>
                <small>{unit.service_type.replaceAll('_', ' ')}</small>
              </div>
              <div>
                <b>{unit.work_unit_type}</b>
                <small>
                  {unit.work_unit_type === 'patrol'
                    ? names.get(unit.patrol_route_id ?? '')
                    : unit.work_unit_type === 'static'
                      ? locationLabel(
                          locations.find((l) => l.id === unit.service_agreement_location_id) ?? {
                            id: unit.service_agreement_location_id ?? '',
                            service_agreement_id: '',
                            site_id: null,
                            zone_id: null,
                          },
                        )
                      : [names.get(unit.workplace_id ?? ''), names.get(unit.team_id ?? ''), names.get(unit.cost_centre_id ?? '')].filter(Boolean).join(' · ')}
                </small>
                    {unit.required_skill_names?.length > 0 && <small>Required skills: {unit.required_skill_names.join(', ')}</small>}
              </div>
              {workflowContext.workUnitId === unit.id && (
                <button className="is-primary" onClick={() => navigate(`/admin/roster${workflowContextQuery(workflowContext)}`)}>
                  <Plus size={15} />
                  Create assignment
                </button>
              )}
            </article>
          ))
        )}
      </section>
      {dialog === 'unit' && (
        <div className="targets-dialog-backdrop">
          <form className="targets-dialog" onSubmit={createUnit} role="dialog" aria-modal="true" aria-labelledby="unit-title">
            <header>
              <div>
                <span>Typed roster target</span>
                <h2 id="unit-title">Create work unit</h2>
              </div>
              <button type="button" onClick={() => setDialog(null)}>
                <X />
              </button>
            </header>
            <div className="target-type-tabs">
              {(['patrol', 'static', 'internal'] as UnitType[]).map((v) => (
                <button
                  type="button"
                  className={type === v ? 'is-active' : ''}
                  onClick={() => {
                    setType(v);
                    setForm({
                      ...form,
                      serviceType: v === 'internal' ? 'administration' : v === 'static' ? 'static_guarding' : 'patrol',
                    });
                  }}
                  key={v}
                >
                  {v}
                </button>
              ))}
            </div>
            <label>
              <span>Name</span>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              <span>Service type</span>
              <input required value={form.serviceType} onChange={(e) => setForm({ ...form, serviceType: e.target.value })} />
            </label>
            <label>
              <span>Required skills (comma-separated)</span>
              <input value={form.requiredSkills} onChange={(e) => setForm({ ...form, requiredSkills: e.target.value })} placeholder="e.g. First aid, radio operations" />
            </label>
            {type === 'patrol' && (
              <label>
                <span>Patrol route</span>
                <select required value={form.routeId} onChange={(e) => setForm({ ...form, routeId: e.target.value })}>
                  <option value="">Select route</option>
                  {routes.map((v) => (
                    <option value={v.id} key={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {type === 'static' && (
              <>
                <label>
                  <span>Contracted location</span>
                  <select
                    required
                    value={form.locationId}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        locationId: e.target.value,
                        moduleId: '',
                      })
                    }
                  >
                    <option value="">Select active agreement location</option>
                    {scopedLocations.map((v) => (
                      <option value={v.id} key={v.id}>
                        {locationLabel(v)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Static guarding module</span>
                  <select required value={form.moduleId} onChange={(e) => setForm({ ...form, moduleId: e.target.value })}>
                    <option value="">Select matching module</option>
                    {matchingModules.map((v) => (
                      <option value={v.id} key={v.id}>
                        Static guarding · {v.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {type === 'internal' && (
              <>
                <label>
                  <span>Provider workplace</span>
                  <select required value={form.workplaceId} onChange={(e) => setForm({ ...form, workplaceId: e.target.value })}>
                    <option value="">Select workplace</option>
                    {workplaces.map((v) => (
                      <option value={v.id} key={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="targets-grid">
                  <label>
                    <span>Team (optional)</span>
                    <select value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}>
                      <option value="">No team</option>
                      {teams.map((v) => (
                        <option value={v.id} key={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Cost centre (optional)</span>
                    <select value={form.costId} onChange={(e) => setForm({ ...form, costId: e.target.value })}>
                      <option value="">No cost centre</option>
                      {costs.map((v) => (
                        <option value={v.id} key={v.id}>
                          {v.code} · {v.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </>
            )}
            <p>{type === 'patrol' ? 'Client and contract attribution remains at each generated stop-module attendance.' : type === 'static' ? 'The selected agreement location and static module jointly authorize this contracted post.' : 'Internal work is provider-owned and never linked to a client agreement.'}</p>
            <footer>
              <button type="button" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" disabled={busy}>
                {busy ? 'Creating' : 'Create work unit'}
              </button>
            </footer>
          </form>
        </div>
      )}
      {(dialog === 'workplace' || dialog === 'cost') && (
        <div className="targets-dialog-backdrop">
          <form className="targets-dialog is-small" onSubmit={createReference} role="dialog" aria-modal="true" aria-labelledby="reference-title">
            <header>
              <div>
                <span>Internal roster reference</span>
                <h2 id="reference-title">Add {dialog === 'workplace' ? 'workplace' : 'cost centre'}</h2>
              </div>
              <button type="button" onClick={() => setDialog(null)}>
                <X />
              </button>
            </header>
            {dialog === 'cost' && (
              <label>
                <span>Code</span>
                <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
              </label>
            )}
            <label>
              <span>Name</span>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            {dialog === 'workplace' && (
              <label>
                <span>Address</span>
                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </label>
            )}
            <footer>
              <button type="button" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" disabled={busy}>
                {busy ? 'Saving' : 'Save'}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
};
export default RosterTargetsPage;
