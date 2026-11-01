import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, MapPin, Plus, RefreshCw, Route, Search, Settings2, Shield, Users, Wrench, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { readWorkflowContext, workflowContextQuery } from '../lib/workflowNavigation';
import { plainWords, workUnitTypeLabel } from '../lib/rosterWords';
import './RosterTargetsPage.css';
type UnitType = 'patrol' | 'static' | 'internal' | 'workshop';
/** Kinds of work seen in live shifts and work units; the field stays free text so an org can add its own. */
const SERVICE_TYPE_SUGGESTIONS: Record<UnitType, string[]> = {
  patrol: ['patrol', 'noise_control', 'parking_enforcement', 'freedom_camping', 'smoke_complaints', 'alarm_response', 'general'],
  static: ['static_guarding', 'event_security', 'reception'],
  internal: ['administration', 'call_centre', 'ems_on_call', 'training', 'dispatch'],
  workshop: ['fabrication', 'maintenance'],
};
const DEFAULT_SERVICE_TYPE: Record<UnitType, string> = { patrol: 'patrol', static: 'static_guarding', internal: 'administration', workshop: 'fabrication' };
interface WorkshopOrderOption { id: string; order_number: string; title: string; kind: 'fabrication' | 'maintenance'; client_organization_id: string; client_name: string | null; status: string; }
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
  workshop_work_order_id: string | null;
  required_skill_ids: string[];
  required_skill_names: string[];
  updated_at: string;
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
interface RosterSkill {
  id: string;
  skill_name: string;
  skill_category: string | null;
}
interface SkillDialog {
  unit: Unit;
  selectedIds: string[];
  requestId: string;
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
  const [skills, setSkills] = useState<RosterSkill[]>([]);
  const [workshopOrders, setWorkshopOrders] = useState<WorkshopOrderOption[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'unit' | 'workplace' | 'cost' | null>(null);
  const [skillDialog, setSkillDialog] = useState<SkillDialog | null>(null);
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
    workOrderId: '',
    requiredSkillIds: [] as string[],
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
    const responses = await Promise.all([
      supabase.from('roster_work_units').select('id,name,work_unit_type,service_type,active,patrol_route_id,service_agreement_location_id,service_agreement_module_id,workplace_id,team_id,cost_centre_id,workshop_work_order_id,required_skill_ids,required_skill_names,updated_at').eq('organization_id', org).order('name'),
      supabase.from('patrol_routes').select('id,name').eq('organization_id', org).eq('is_active', true).order('name'),
      supabase.from('service_agreement_locations').select('id,service_agreement_id,site_id,zone_id').eq('status', 'active'),
      supabase.from('service_agreement_modules').select('id,service_agreement_id,module_key').eq('enabled', true).eq('module_key', 'static_guarding'),
      supabase.from('client_sites').select('id,name,boundary_verification').eq('active', true),
      supabase.from('location_zones').select('id,name').eq('is_active', true),
      supabase.from('organization_workplaces').select('id,name').eq('organization_id', org).eq('active', true).order('name'),
      supabase.from('teams').select('id,name').eq('organization_id', org).eq('status', 'active').order('name'),
      supabase.from('cost_centres').select('id,code,name').eq('organization_id', org).eq('active', true).order('code'),
      supabase.from('roster_skill_catalog').select('id,skill_name,skill_category').eq('organization_id', org).eq('active', true).order('skill_name'),
      supabase.from('workshop_work_order_summary').select('id,order_number,title,kind,client_organization_id,client_name,status').eq('organization_id', org).not('client_organization_id', 'is', null).in('status', ['draft', 'approved', 'in_progress']).order('order_number'),
    ]);
    const [a, b, c, d, e, f, g, h, i, j, k] = responses;
    setUnits((a.data as Unit[]) ?? []);
    setRoutes((b.data as Option[]) ?? []);
    setLocations((c.data as AgreementLocation[]) ?? []);
    setModules((d.data as Module[]) ?? []);
    setSites((e.data as Option[]) ?? []);
    setZones((f.data as Option[]) ?? []);
    setWorkplaces((g.data as Option[]) ?? []);
    setTeams((h.data as Option[]) ?? []);
    setCosts((i.data as Array<Option & { code: string }>) ?? []);
    setSkills((j.data as RosterSkill[]) ?? []);
    setWorkshopOrders((k.data as WorkshopOrderOption[]) ?? []);
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
      workOrderId: '',
      requiredSkillIds: [],
    });
  const createUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const activeOperatingOrganizationId = operatingOrganizationId ?? profile?.organizationId;
    if (!activeOperatingOrganizationId) {
      setError('Organisation access could not be confirmed. Work unit creation is unavailable.');
      setBusy(false);
      return;
    }
    try {
      const { data, error: rpcError } = type === 'workshop' ? await supabase.rpc('create_operating_workshop_roster_work_unit', {
        p_operating_organization_id: activeOperatingOrganizationId,
        p_name: form.name,
        p_work_order_id: form.workOrderId,
        p_workplace_id: form.workplaceId,
        p_team_id: form.teamId || null,
        p_cost_centre_id: form.costId || null,
      }) : await supabase.rpc('create_operating_roster_work_unit', {
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
      if (rpcError || !data) {
        setError(rpcError?.message ?? 'Work unit creation was not confirmed.');
        return;
      }
      const createdUnit = (Array.isArray(data) ? data[0] : data) as Unit;
      if (form.requiredSkillIds.length) {
        if (!createdUnit?.id || !createdUnit.updated_at) {
          setError('The work unit was created, but its required skills could not be confirmed. Open Required skills on its card to finish setup.');
          setDialog(null);
          reset();
          await load();
          return;
        }
        const { error: skillError } = await supabase.rpc('manage_roster_work_unit_skill_ids', {
          p_client_request_id: crypto.randomUUID(),
          p_work_unit_id: createdUnit.id,
          p_expected_updated_at: createdUnit.updated_at,
          p_required_skill_ids: form.requiredSkillIds,
        });
        if (skillError) {
          setError(`The work unit was created, but its required skills were not saved: ${skillError.message} Open Required skills on its card to finish setup.`);
          setDialog(null);
          reset();
          await load();
          return;
        }
      }
      setNotice(type === 'workshop' && workshopOrders.find((order) => order.id === form.workOrderId)?.status === 'draft'
        ? 'Manufacturing & maintenance work unit created. Approve its work order in Workshop before rostering labour.'
        : form.requiredSkillIds.length
        ? `${workUnitTypeLabel(type)} “${form.name}” created with required skills. Staff must hold them before assignment.`
        : `${workUnitTypeLabel(type)} “${form.name}” created. You can roster shifts against it now.`);
      setDialog(null);
      reset();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Work unit creation failed before it could be confirmed.');
    } finally {
      setBusy(false);
    }
  };
  const toggleSkill = (skillId: string, selectedIds: string[]) =>
    selectedIds.includes(skillId) ? selectedIds.filter((id) => id !== skillId) : [...selectedIds, skillId];
  const saveSkillRequirements = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!skillDialog) return;
    setBusy(true);
    setError(null);
    try {
      const { error: skillError } = await supabase.rpc('manage_roster_work_unit_skill_ids', {
        p_client_request_id: skillDialog.requestId,
        p_work_unit_id: skillDialog.unit.id,
        p_expected_updated_at: skillDialog.unit.updated_at,
        p_required_skill_ids: skillDialog.selectedIds,
      });
      if (skillError) {
        setError(skillError.message);
        return;
      }
      setNotice('Required skills updated with an audit receipt. New and changed roster assignments now require current staff skills.');
      setSkillDialog(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Required skills could not be saved.');
    } finally {
      setBusy(false);
    }
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
  /** manage_officer_static_post needs a site with a verified boundary; a zone or an unverified site means no arrive/depart. */
  const attendanceBlocker = (unit: Unit): string | null => {
    if (unit.work_unit_type !== 'static') return null;
    const location = locations.find((l) => l.id === unit.service_agreement_location_id);
    if (!location) return null;
    if (!location.site_id) return `${names.get(location.zone_id ?? '') ?? 'This place'} is a zone, not a site, so the officer cannot record arriving at or leaving this post.`;
    const site = sites.find((s) => s.id === location.site_id);
    if (site && site.boundary_verification !== 'verified') return `${site.name} has no verified boundary yet, so the officer cannot record arriving at or leaving this post. Verify the site boundary first.`;
    return null;
  };
  const scopedLocations = workflowContext.agreementId ? locations.filter((location) => location.service_agreement_id === workflowContext.agreementId) : locations;
  const scopedModules = workflowContext.agreementId ? modules.filter((module) => module.service_agreement_id === workflowContext.agreementId) : modules;
  const matchingModules = scopedModules.filter((module) => module.service_agreement_id === scopedLocations.find((location) => location.id === form.locationId)?.service_agreement_id);
  const rosterUnit = (unit: Unit) => navigate(`/admin/roster${workflowContextQuery({ ...workflowContext, workUnitId: unit.id })}`);
  const TYPE_TABS: Array<[UnitType, string]> = [['patrol', 'Patrol run'], ['static', 'Static post'], ['internal', 'Office / internal'], ['workshop', 'Manufacturing & maintenance']];
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
        <div>
          <Wrench />
          <span>Manufacturing &amp; maintenance</span>
          <strong>{units.filter((u) => u.work_unit_type === 'workshop').length}</strong>
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
                <p>A work unit is what a shift covers. Each kind comes from somewhere specific:</p>
                <ul>
                  <li><b>Patrol run</b> – built from a client agreement in Client Portfolios (the Patrol run card). Pick it here once it exists.</li>
                  <li><b>Static post</b> – a place covered by a client agreement that includes static guarding.</li>
                  <li><b>Office / internal</b> – your own workplace, team or cost centre. No client involved.</li>
                  <li><b>Manufacturing &amp; maintenance</b> – a Workshop work order for a client job or your own internal work.</li>
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
              <span>{unit.work_unit_type === 'patrol' ? <Route /> : unit.work_unit_type === 'static' ? <Shield /> : unit.work_unit_type === 'workshop' ? <Wrench /> : <Building2 />}</span>
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
                    <small>{unit.required_skill_names?.length > 0 ? `Required skills: ${unit.required_skill_names.join(', ')}` : 'No required skills configured'}</small>
                    {attendanceBlocker(unit) && <small className="targets-unit-warning" role="note"><AlertTriangle size={13} aria-hidden="true" /> {attendanceBlocker(unit)}</small>}
              </div>
              <div className="targets-unit-actions">
                {unit.workshop_work_order_id && <button type="button" onClick={() => navigate(`/admin/workshop?workOrderId=${unit.workshop_work_order_id}`)}>Open work order</button>}
                <button type="button" onClick={() => setSkillDialog({ unit, selectedIds: unit.required_skill_ids ?? [], requestId: crypto.randomUUID() })} aria-label={`Configure required skills for ${unit.name}`}>
                  <Settings2 size={15} />
                  Required skills
                </button>
                <button type="button" className={workflowContext.workUnitId === unit.id ? 'is-primary' : ''} onClick={() => rosterUnit(unit)} aria-label={`Roster shifts for ${unit.name}`}>
                  <Plus size={15} />
                  {workflowContext.workUnitId === unit.id ? 'Create assignment' : 'Roster it'}
                </button>
              </div>
            </article>
          ))
        )}
      </section>
      {skillDialog && (
        <div className="targets-dialog-backdrop">
          <form className="targets-dialog targets-skill-dialog" onSubmit={saveSkillRequirements} role="dialog" aria-modal="true" aria-labelledby="work-unit-skills-title">
            <header>
              <div>
                <span>Deployment readiness</span>
                <h2 id="work-unit-skills-title">Required skills</h2>
              </div>
              <button type="button" onClick={() => setSkillDialog(null)} aria-label="Close required skills">
                <X />
              </button>
            </header>
            <p className="targets-dialog-note"><strong>{skillDialog.unit.name}</strong> may only be assigned to staff who hold every selected current skill. Site inductions remain separate in People.</p>
            {skills.length ? (
              <fieldset className="targets-skill-picker">
                <legend>Organisation skill catalog</legend>
                {skills.map((skill) => (
                  <label key={skill.id}>
                    <input
                      type="checkbox"
                      checked={skillDialog.selectedIds.includes(skill.id)}
                      onChange={() => setSkillDialog({ ...skillDialog, selectedIds: toggleSkill(skill.id, skillDialog.selectedIds) })}
                    />
                    <span><strong>{skill.skill_name}</strong>{skill.skill_category && <small>{skill.skill_category}</small>}</span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <div className="targets-prereq" role="status">
                <strong>No active skills are configured.</strong>
                <p>Create the organisation’s reusable skill catalog in People before requiring skills here.</p>
                <button type="button" onClick={() => navigate('/admin/people-hr')}>Open People</button>
              </div>
            )}
            <p className="targets-skill-impact">{skillDialog.selectedIds.length
              ? `${skillDialog.selectedIds.length} required ${skillDialog.selectedIds.length === 1 ? 'skill' : 'skills'}. New and changed assignments will be refused unless the staff member holds all of them.`
              : 'No required skills. This work unit will not add a skill gate to roster assignment.'}</p>
            <footer>
              <button type="button" onClick={() => setSkillDialog(null)}>Keep current requirements</button>
              <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save required skills'}</button>
            </footer>
          </form>
        </div>
      )}
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
            {error && <p role="alert">{error}</p>}
            <div className="target-type-tabs" role="tablist" aria-label="Kind of work unit">
              {TYPE_TABS.map(([v, label]) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={type === v}
                  className={type === v ? 'is-active' : ''}
                  onClick={() => {
                    setType(v);
                    setForm({ ...form, serviceType: DEFAULT_SERVICE_TYPE[v], routeId: '', locationId: '', moduleId: '', workOrderId: '' });
                  }}
                  key={v}
                >
                  {label}
                </button>
              ))}
            </div>
            <label>
              <span>Name</span>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={type === 'patrol' ? 'e.g. Nelson CBD night patrol' : type === 'static' ? 'e.g. Civic House front desk' : type === 'workshop' ? 'e.g. Lockbox fabrication crew' : 'e.g. After-hours rosterer'} />
            </label>
            <label>
              <span>Kind of work</span>
              <input required readOnly={type === 'workshop'} list="work-unit-service-types" value={form.serviceType} onChange={(e) => setForm({ ...form, serviceType: e.target.value })} />
              <datalist id="work-unit-service-types">
                {SERVICE_TYPE_SUGGESTIONS[type].map((value) => <option value={value} key={value}>{plainWords(value)}</option>)}
              </datalist>
              <small>{type === 'workshop' ? 'Derived from the linked work order for reports and pay rules.' : 'Used for reports and pay rules. Pick a suggestion or type your own.'}</small>
            </label>
            {skills.length ? (
              <fieldset className="targets-skill-picker">
                <legend>Required skills</legend>
                <p>Select only skills every assigned staff member must hold. You can change this later from the work-unit card.</p>
                {skills.map((skill) => (
                  <label key={skill.id}>
                    <input
                      type="checkbox"
                      checked={form.requiredSkillIds.includes(skill.id)}
                      onChange={() => setForm({ ...form, requiredSkillIds: toggleSkill(skill.id, form.requiredSkillIds) })}
                    />
                    <span><strong>{skill.skill_name}</strong>{skill.skill_category && <small>{skill.skill_category}</small>}</span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <div className="targets-prereq" role="status">
                <strong>No active skills are configured.</strong>
                <p>You can create this work unit now, then set up reusable skills in People before adding assignment requirements.</p>
                <button type="button" onClick={() => navigate('/admin/people-hr')}>Open People</button>
              </div>
            )}
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
            {type === 'workshop' && <section aria-label="Workshop work order">
              <p>Choose a client job for gate or lock repairs, installations, signs, digger work, manufacturing or maintenance. The work order retains the client, place or asset, materials, assigned job lead and invoice lines. Rostering staff does not reassign the job lead or invoice this time again.</p>
              {workshopOrders.length === 0 ? <div className="targets-prereq" role="status">
                <strong>No open work orders to link.</strong>
                <p>Create a client work order in Workshop first, then refresh this page. Internal work is not eligible for this client-work category.</p>
                <button type="button" onClick={() => navigate('/admin/workshop?clientJob=1')}>Open Workshop</button>
              </div> : <label><span>Work order</span><select required value={form.workOrderId} onChange={(event) => {
                const order = workshopOrders.find((item) => item.id === event.target.value);
                setForm({ ...form, workOrderId: event.target.value, serviceType: order?.kind ?? 'fabrication' });
              }}><option value="">Choose a client work order</option>{workshopOrders.map((order) => <option key={order.id} value={order.id}>{order.order_number} · {order.title} · {order.client_name ?? 'Client name unavailable'} · {plainWords(order.status)}</option>)}</select></label>}
            </section>}
            {(type === 'internal' || type === 'workshop') && (workplaces.length === 0 ? (
              <div className="targets-prereq" role="status">
                <strong>No workplaces yet.</strong>
                <p>This work needs one of your own workplaces as its base. A maintenance visit keeps its actual client place or asset on the work order. Add a workplace first – it only needs a name.</p>
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
            <p>{type === 'patrol' ? 'Every stop on the run keeps its own client and contract, so billing follows the place, not the shift.' : type === 'static' ? 'The post is authorised by the client agreement that covers the place.' : type === 'workshop' ? 'Labour appears on the roster. Work starts and completes in Workshop; client billing follows the work order, not a second roster charge.' : 'Office and internal work belongs to your organisation. It is never billed to a client.'}</p>
            <footer>
              <button type="button" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" disabled={busy || (type === 'patrol' && routes.length === 0) || (type === 'static' && (scopedLocations.length === 0 || (!!form.locationId && matchingModules.length === 0))) || ((type === 'internal' || type === 'workshop') && workplaces.length === 0) || (type === 'workshop' && !form.workOrderId)}>
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
