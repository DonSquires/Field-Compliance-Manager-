import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, MapPin, Plus, RefreshCw, Route, Search, Shield, Users, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { readWorkflowContext, workflowContextQuery } from '../lib/workflowNavigation';
import { plainWords, workUnitTypeLabel } from '../lib/rosterWords';
import './RosterTargetsPage.css';
type UnitType = 'patrol' | 'static' | 'internal';
/** Kinds of work seen in live shifts and work units; the field stays free text so an org can add its own. */
const SERVICE_TYPE_SUGGESTIONS: Record<UnitType, string[]> = {
  patrol: ['patrol', 'noise_control', 'parking_enforcement', 'freedom_camping', 'smoke_complaints', 'alarm_response', 'general'],
  static: ['static_guarding', 'event_security', 'reception'],
  internal: ['administration', 'call_centre', 'ems_on_call', 'training', 'dispatch'],
};
const DEFAULT_SERVICE_TYPE: Record<UnitType, string> = { patrol: 'patrol', static: 'static_guarding', internal: 'administration' };
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
    setLocations((c.data as AgreementLocation[]) ?? []);
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
      serviceType: DEFAULT_SERVICE_TYPE[type],
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
      setNotice(`${workUnitTypeLabel(type)} “${form.name}” created. You can roster shifts against it now.`);
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
  const locationLabel = (l: AgreementLocation) => names.get(l.site_id ?? l.zone_id ?? '') ?? 'Contracted place (name not loaded)';
  const scopedLocations = workflowContext.agreementId ? locations.filter((location) => location.service_agreement_id === workflowContext.agreementId) : locations;
  const scopedModules = workflowContext.agreementId ? modules.filter((module) => module.service_agreement_id === workflowContext.agreementId) : modules;
  const matchingModules = scopedModules.filter((module) => module.service_agreement_id === scopedLocations.find((location) => location.id === form.locationId)?.service_agreement_id);
  const rosterUnit = (unit: Unit) => navigate(`/admin/roster${workflowContextQuery({ ...workflowContext, workUnitId: unit.id })}`);
  const TYPE_TABS: Array<[UnitType, string]> = [['patrol', 'Patrol run'], ['static', 'Static post'], ['internal', 'Office / internal']];
  return (
    <div className="targets-page">
      <header className="targets-header">
        <div>
          <span>Rostering</span>
          <h1>Work units</h1>
          <p>The work a shift can cover: patrol runs from client agreements, static posts at a client’s place, and office or internal work.</p>
        </div>
        <div>
          <button onClick={() => void load()} disabled={loading} aria-label="Refresh work units">
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
          <span>Patrol runs</span>
          <strong>{units.filter((u) => u.work_unit_type === 'patrol').length}</strong>
        </div>
        <div>
          <Shield />
          <span>Static posts</span>
          <strong>{units.filter((u) => u.work_unit_type === 'static').length}</strong>
        </div>
        <div>
          <Building2 />
          <span>Office / internal</span>
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
          <div className="targets-empty targets-empty-guide">
            <Route />
            <strong>{units.length === 0 ? 'No work units yet' : 'No work units match this search'}</strong>
            {units.length === 0 && (
              <>
                <p>A work unit is what a shift covers. There are three kinds, and each comes from somewhere specific:</p>
                <ul>
                  <li><b>Patrol run</b> – built from a client agreement in Client Portfolios (the Patrol run card). Pick it here once it exists.</li>
                  <li><b>Static post</b> – a place covered by a client agreement that includes static guarding.</li>
                  <li><b>Office / internal</b> – your own workplace, team or cost centre. No client involved.</li>
                </ul>
                <div>
                  <button type="button" onClick={() => navigate('/admin/crm')}>Client Portfolios</button>
                  <button type="button" className="is-primary" onClick={() => { reset(); setDialog('unit'); }}><Plus size={15} />New work unit</button>
                </div>
              </>
            )}
          </div>
        ) : (
          visible.map((unit) => (
            <article id={`work-unit-${unit.id}`} className={`type-${unit.work_unit_type}${workflowContext.workUnitId === unit.id ? ' is-focused' : ''}`} key={unit.id}>
              <span>{unit.work_unit_type === 'patrol' ? <Route /> : unit.work_unit_type === 'static' ? <Shield /> : <Building2 />}</span>
              <div>
                <strong>{unit.name}</strong>
                <small>{plainWords(unit.service_type)}</small>
              </div>
              <div>
                <b>{workUnitTypeLabel(unit.work_unit_type)}</b>
                <small>
                  {unit.work_unit_type === 'patrol'
                    ? (names.get(unit.patrol_route_id ?? '') ?? 'Patrol run not loaded')
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
              <button className={workflowContext.workUnitId === unit.id ? 'is-primary' : ''} onClick={() => rosterUnit(unit)} aria-label={`Roster shifts for ${unit.name}`}>
                <Plus size={15} />
                {workflowContext.workUnitId === unit.id ? 'Create assignment' : 'Roster it'}
              </button>
            </article>
          ))
        )}
      </section>
      {dialog === 'unit' && (
        <div className="targets-dialog-backdrop">
          <form className="targets-dialog" onSubmit={createUnit} role="dialog" aria-modal="true" aria-labelledby="unit-title">
            <header>
              <div>
                <span>Work unit</span>
                <h2 id="unit-title">Create work unit</h2>
              </div>
              <button type="button" onClick={() => setDialog(null)} aria-label="Close">
                <X />
              </button>
            </header>
            <div className="target-type-tabs" role="tablist" aria-label="Kind of work unit">
              {TYPE_TABS.map(([v, label]) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={type === v}
                  className={type === v ? 'is-active' : ''}
                  onClick={() => {
                    setType(v);
                    setForm({ ...form, serviceType: DEFAULT_SERVICE_TYPE[v], routeId: '', locationId: '', moduleId: '' });
                  }}
                  key={v}
                >
                  {label}
                </button>
              ))}
            </div>
            <label>
              <span>Name</span>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={type === 'patrol' ? 'e.g. Nelson CBD night patrol' : type === 'static' ? 'e.g. Civic House front desk' : 'e.g. After-hours rosterer'} />
            </label>
            <label>
              <span>Kind of work</span>
              <input required list="work-unit-service-types" value={form.serviceType} onChange={(e) => setForm({ ...form, serviceType: e.target.value })} />
              <datalist id="work-unit-service-types">
                {SERVICE_TYPE_SUGGESTIONS[type].map((value) => <option value={value} key={value}>{plainWords(value)}</option>)}
              </datalist>
              <small>Used for reports and pay rules. Pick a suggestion or type your own.</small>
            </label>
            <label>
              <span>Required skills (comma-separated)</span>
              <input value={form.requiredSkills} onChange={(e) => setForm({ ...form, requiredSkills: e.target.value })} placeholder="e.g. First aid, radio operations" />
            </label>
            {type === 'patrol' && (routes.length === 0 ? (
              <div className="targets-prereq" role="status">
                <strong>No patrol runs to pick from yet.</strong>
                <p>Patrol runs come from a client agreement. Open the client in Client Portfolios and use the Patrol run card, then come back here.</p>
                <button type="button" onClick={() => navigate('/admin/crm')}>Open Client Portfolios</button>
              </div>
            ) : (
              <label>
                <span>Patrol route</span>
                <select required value={form.routeId} onChange={(e) => setForm({ ...form, routeId: e.target.value })}>
                  <option value="">Choose the patrol run this unit covers</option>
                  {routes.map((v) => (
                    <option value={v.id} key={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {type === 'static' && (scopedLocations.length === 0 ? (
              <div className="targets-prereq" role="status">
                <strong>No contracted places to pick from yet.</strong>
                <p>A static post sits at a place covered by a live client agreement. Attach the place to the agreement in Client Portfolios first.</p>
                <button type="button" onClick={() => navigate('/admin/crm')}>Open Client Portfolios</button>
              </div>
            ) : (
              <>
                <label>
                  <span>Contracted location</span>
                  <select
                    required
                    value={form.locationId}
                    onChange={(e) => {
                      const nextLocation = scopedLocations.find((location) => location.id === e.target.value);
                      const nextModules = scopedModules.filter((module) => module.service_agreement_id === nextLocation?.service_agreement_id);
                      setForm({ ...form, locationId: e.target.value, moduleId: nextModules.length === 1 ? nextModules[0].id : '' });
                    }}
                  >
                    <option value="">Choose the place this post guards</option>
                    {scopedLocations.map((v) => (
                      <option value={v.id} key={v.id}>
                        {locationLabel(v)}
                      </option>
                    ))}
                  </select>
                </label>
                {form.locationId && matchingModules.length === 0 && (
                  <div className="targets-prereq is-blocking" role="alert">
                    <strong>This agreement does not include static guarding.</strong>
                    <p>Add the static guarding module to the agreement in Client Portfolios before creating the post.</p>
                  </div>
                )}
                {form.locationId && matchingModules.length === 1 && <p className="targets-auto">Covered by the agreement’s static guarding module.</p>}
                {matchingModules.length > 1 && (
                  <label>
                    <span>Static guarding module</span>
                    <select required value={form.moduleId} onChange={(e) => setForm({ ...form, moduleId: e.target.value })}>
                      <option value="">Choose which static guarding module applies</option>
                      {matchingModules.map((v, index) => (
                        <option value={v.id} key={v.id}>
                          Static guarding module {index + 1}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            ))}
            {type === 'internal' && (workplaces.length === 0 ? (
              <div className="targets-prereq" role="status">
                <strong>No workplaces yet.</strong>
                <p>Office and internal work is rostered against one of your own workplaces. Add one first – it only needs a name.</p>
                <button type="button" onClick={() => { reset(); setDialog('workplace'); }}>Add workplace</button>
              </div>
            ) : (
              <>
                <label>
                  <span>Provider workplace</span>
                  <select required value={form.workplaceId} onChange={(e) => setForm({ ...form, workplaceId: e.target.value })}>
                    <option value="">Choose your workplace</option>
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
            ))}
            <p>{type === 'patrol' ? 'Every stop on the run keeps its own client and contract, so billing follows the place, not the shift.' : type === 'static' ? 'The post is authorised by the client agreement that covers the place.' : 'Office and internal work belongs to your organisation. It is never billed to a client.'}</p>
            <footer>
              <button type="button" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" disabled={busy || (type === 'patrol' && routes.length === 0) || (type === 'static' && (scopedLocations.length === 0 || (!!form.locationId && matchingModules.length === 0))) || (type === 'internal' && workplaces.length === 0)}>
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
