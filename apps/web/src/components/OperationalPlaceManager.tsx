import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, LandPlot, MapPinned, ShieldCheck, Siren, X } from 'lucide-react';
import { LocationHouseMap, type EditableEntity, type HouseMapSite, type HouseMapZone } from './LocationHouseMap';
import { supabase } from '../lib/supabase';
import './OperationalPlaceManager.css';
import './OperationalPlaceManagerHuman.css';

type View = 'site' | 'zones' | 'boundary' | 'closures';

interface Site extends HouseMapSite {
  risk_level: string | null;
  site_brief: string | null;
  access_instructions: string | null;
  hs_notes: string | null;
  active: boolean;
  configuration_version: number;
}

interface Zone extends HouseMapZone {
  zone_type: string;
  module_key: string;
  rule_type: string;
  is_active: boolean;
  nightly_limit_consecutive: number | null;
  nightly_limit_monthly: number | null;
  scv_required: boolean;
  enforcement_workflow_override: string | null;
  configuration_version: number;
}

interface Module { module_key: string; display_name: string }
interface Closure { id: string; zone_id: string; closure_type: string; status: string; effective_from: string; effective_to: string | null; reason: string | null; resolution_notes: string | null }
interface EditorData { location: { id: string; name: string; address: string | null; organization_id: string }; sites: Site[]; zones: Zone[]; modules: Module[]; closures: Closure[] }
interface GeographyData { locations: Array<{ id: string; address: string | null }>; sites: HouseMapSite[]; zones: HouseMapZone[] }

interface ZoneForm {
  name: string;
  zoneType: string;
  moduleKey: string;
  ruleType: string;
  active: boolean;
  nightConsecutive: string;
  nightMonthly: string;
  scv: boolean;
  workflow: string;
}

const ZONE_TYPE_LABELS: Record<string, string> = {
  general: 'General service area',
  access_control: 'Entry and access area',
  biosecurity: 'Biosecurity control area',
  freedom_camping: 'Freedom camping area',
  noise_control: 'Noise control area',
  parking: 'Parking area',
  patrol_route: 'Patrol area or route',
  trespass: 'Restricted or trespass area',
};

const MODULE_ZONE_TYPES: Record<string, string[]> = {
  freedom_camping: ['freedom_camping', 'general'],
  parking_enforcement: ['parking', 'general'],
  parking: ['parking', 'general'],
  noise_control: ['noise_control', 'general'],
  biosecurity: ['biosecurity', 'access_control', 'general'],
  patrol: ['patrol_route', 'access_control', 'general', 'trespass'],
  site_guard: ['access_control', 'general', 'trespass'],
  static_guarding: ['access_control', 'general', 'trespass'],
};

const RULE_LABELS: Record<string, string> = {
  unrestricted: 'Normal operations allowed',
  restricted: 'Restricted access or activity',
  prohibited: 'No entry or activity allowed',
  day_visit_only: 'Daytime use only',
  overnight_limited: 'Overnight stay limits apply',
};

const WORKFLOW_LABELS: Record<string, string> = {
  '': 'Use the service default',
  admin_first: 'Send to a supervisor before action',
  officer_direct: 'Officer may act directly',
  hybrid: 'Officer records it, supervisor reviews',
};

const RESTRICTION_LABELS: Record<string, string> = {
  temporary_closure: 'Closed temporarily',
  restricted: 'Restricted access',
  prohibited: 'No entry or activity',
};

const allowedRules = (moduleKey: string) => moduleKey === 'freedom_camping'
  ? ['overnight_limited', 'day_visit_only', 'restricted', 'prohibited', 'unrestricted']
  : ['restricted', 'prohibited', 'unrestricted'];

const defaultsForModule = (moduleKey: string): Pick<ZoneForm, 'zoneType' | 'ruleType'> => ({
  zoneType: MODULE_ZONE_TYPES[moduleKey]?.[0] ?? 'general',
  ruleType: moduleKey === 'freedom_camping' ? 'overnight_limited' : moduleKey === 'patrol' ? 'unrestricted' : 'restricted',
});

const emptyZone = (moduleKey = 'patrol'): ZoneForm => ({
  name: '',
  moduleKey,
  ...defaultsForModule(moduleKey),
  active: true,
  nightConsecutive: '',
  nightMonthly: '',
  scv: false,
  workflow: '',
});

const today = () => new Date().toISOString().slice(0, 10);

export function OperationalPlaceManager({ locationId, initialZoneId, onClose, onSaved }: { locationId: string; initialZoneId?: string | null; onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<EditorData | null>(null);
  const [view, setView] = useState<View>(initialZoneId ? 'zones' : 'site');
  const [siteId, setSiteId] = useState('');
  const [zoneId, setZoneId] = useState(initialZoneId ?? '');
  const [boundaryTarget, setBoundaryTarget] = useState(initialZoneId ? `zone:${initialZoneId}` : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [siteForm, setSiteForm] = useState({ risk: '', brief: '', access: '', safety: '', active: true });
  const [zoneForm, setZoneForm] = useState<ZoneForm>(emptyZone());
  const [creatingZone, setCreatingZone] = useState(false);
  const [restriction, setRestriction] = useState({ type: 'temporary_closure', from: today(), to: '', reason: '' });

  const site = data?.sites.find((item) => item.id === siteId) ?? null;
  const zone = data?.zones.find((item) => item.id === zoneId) ?? null;
  const isFreedomCamping = zoneForm.moduleKey === 'freedom_camping';
  const selectedRestrictions = useMemo(() => data?.closures.filter((item) => item.zone_id === zoneId) ?? [], [data?.closures, zoneId]);

  const load = useCallback(async (preferredZoneId?: string) => {
    setError(null);
    const [editorResponse, geographyResponse] = await Promise.all([
      supabase.rpc('get_crm_operational_place_editor', { p_location_id: locationId }),
      supabase.rpc('get_crm_operational_geography'),
    ]);
    const loadError = editorResponse.error ?? geographyResponse.error;
    if (loadError) { setError(loadError.message); return; }

    const editor = editorResponse.data as Omit<EditorData, 'location' | 'sites' | 'zones'> & {
      location: Omit<EditorData['location'], 'address'>;
      sites: Array<Omit<Site, keyof HouseMapSite> & { id: string; name: string }>;
      zones: Array<Omit<Zone, keyof HouseMapZone> & { id: string; name: string }>;
    };
    const geography = geographyResponse.data as GeographyData;
    const siteGeometry = new Map(geography.sites.map((item) => [item.id, item]));
    const zoneGeometry = new Map(geography.zones.map((item) => [item.id, item]));
    const next: EditorData = {
      ...editor,
      location: { ...editor.location, address: geography.locations.find((item) => item.id === locationId)?.address ?? null },
      sites: editor.sites.map((item) => ({ ...item, ...siteGeometry.get(item.id) })) as Site[],
      zones: editor.zones.map((item) => ({ ...item, ...zoneGeometry.get(item.id) })) as Zone[],
    };
    setData(next);
    setSiteId((current) => next.sites.some((item) => item.id === current) ? current : next.sites[0]?.id ?? '');
    const requestedZoneId = preferredZoneId ?? initialZoneId ?? '';
    setZoneId((current) => next.zones.some((item) => item.id === requestedZoneId) ? requestedZoneId : next.zones.some((item) => item.id === current) ? current : next.zones[0]?.id ?? '');
    setBoundaryTarget((current) => {
      if (current.startsWith('site:') && next.sites.some((item) => `site:${item.id}` === current)) return current;
      if (current.startsWith('zone:') && next.zones.some((item) => `zone:${item.id}` === current)) return current;
      if (requestedZoneId && next.zones.some((item) => item.id === requestedZoneId)) return `zone:${requestedZoneId}`;
      return next.sites[0] ? `site:${next.sites[0].id}` : next.zones[0] ? `zone:${next.zones[0].id}` : '';
    });
  }, [initialZoneId, locationId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (site) setSiteForm({ risk: site.risk_level ?? '', brief: site.site_brief ?? '', access: site.access_instructions ?? '', safety: site.hs_notes ?? '', active: site.active });
  }, [site]);
  useEffect(() => {
    if (zone && !creatingZone) setZoneForm({
      name: zone.name,
      zoneType: zone.zone_type,
      moduleKey: zone.module_key,
      ruleType: zone.rule_type,
      active: zone.is_active,
      nightConsecutive: zone.nightly_limit_consecutive?.toString() ?? '',
      nightMonthly: zone.nightly_limit_monthly?.toString() ?? '',
      scv: zone.scv_required,
      workflow: zone.enforcement_workflow_override ?? '',
    });
  }, [creatingZone, zone]);

  const complete = async (action: () => PromiseLike<{ error: { message: string } | null }>, message: string) => {
    setBusy(true); setError(null); setNotice(null);
    const { error: actionError } = await action();
    if (actionError) setError(actionError.message);
    else { setNotice(message); await load(); onSaved(); }
    setBusy(false);
  };

  const saveSite = (event: FormEvent) => {
    event.preventDefault();
    if (!site) return;
    void complete(() => supabase.rpc('manage_crm_site_profile', {
      p_site_id: site.id,
      p_expected_version: site.configuration_version,
      p_risk_level: siteForm.risk || null,
      p_site_brief: siteForm.brief,
      p_access_instructions: siteForm.access,
      p_hs_notes: siteForm.safety,
      p_active: siteForm.active,
    }), `${site.name} briefing saved.`);
  };

  const changeModule = (moduleKey: string) => {
    const defaults = defaultsForModule(moduleKey);
    setZoneForm((current) => ({ ...current, moduleKey, ...defaults, nightConsecutive: '', nightMonthly: '', scv: false }));
  };

  const saveZone = async (event: FormEvent) => {
    event.preventDefault();
    if (!data || !zoneForm.name.trim()) return;
    setBusy(true); setError(null); setNotice(null);
    const { data: saved, error: saveError } = await supabase.rpc('manage_crm_zone', {
      p_action: creatingZone ? 'create' : 'update',
      p_zone_id: creatingZone ? null : zone?.id ?? null,
      p_location_id: data.location.id,
      p_expected_version: creatingZone ? 0 : zone?.configuration_version ?? 0,
      p_name: zoneForm.name.trim(),
      p_zone_type: zoneForm.zoneType,
      p_module_key: zoneForm.moduleKey,
      p_rule_type: zoneForm.ruleType,
      p_is_active: zoneForm.active,
      p_nightly_limit_consecutive: isFreedomCamping && zoneForm.nightConsecutive ? Number(zoneForm.nightConsecutive) : null,
      p_nightly_limit_monthly: isFreedomCamping && zoneForm.nightMonthly ? Number(zoneForm.nightMonthly) : null,
      p_scv_required: isFreedomCamping ? zoneForm.scv : false,
      p_enforcement_workflow_override: zoneForm.workflow || null,
    });
    if (saveError) setError(saveError.message);
    else {
      const savedZone = saved as Zone;
      setCreatingZone(false);
      setZoneId(savedZone.id);
      setBoundaryTarget(`zone:${savedZone.id}`);
      setView('boundary');
      setNotice(creatingZone ? 'Work area saved. Draw or confirm its boundary next.' : 'Work area settings saved. Check its boundary next.');
      await load(savedZone.id);
      onSaved();
    }
    setBusy(false);
  };

  const createRestriction = (event: FormEvent) => {
    event.preventDefault();
    if (!zone) return;
    if (!restriction.reason.trim()) { setError('Explain why access or activity is changing.'); return; }
    void complete(() => supabase.rpc('manage_crm_zone_closure', {
      p_zone_id: zone.id,
      p_action: 'create',
      p_closure_id: null,
      p_closure_type: restriction.type,
      p_effective_from: restriction.from,
      p_effective_to: restriction.to || null,
      p_reason: restriction.reason.trim(),
    }), 'Temporary restriction scheduled. Officers will see it when this area resolves from GPS.');
  };

  const endRestriction = (item: Closure) => {
    if (!zone) return;
    void complete(() => supabase.rpc('manage_crm_zone_closure', {
      p_zone_id: zone.id,
      p_action: 'lift',
      p_closure_id: item.id,
      p_closure_type: item.closure_type,
      p_effective_from: item.effective_from,
      p_effective_to: item.effective_to,
      p_reason: 'Ended by operations administrator',
    }), 'Temporary restriction ended. The history remains on this area.');
  };

  const startNewZone = () => {
    const moduleKey = data?.modules.find((item) => item.module_key === 'patrol')?.module_key ?? data?.modules[0]?.module_key ?? 'patrol';
    setZoneForm(emptyZone(moduleKey));
    setCreatingZone(true);
    setNotice(null);
    setError(null);
  };

  const boundaryKind = boundaryTarget.split(':')[0];
  const boundaryId = boundaryTarget.split(':')[1] ?? '';
  const boundarySite = boundaryKind === 'site' ? data?.sites.find((item) => item.id === boundaryId) ?? null : null;
  const boundaryZone = boundaryKind === 'zone' ? data?.zones.find((item) => item.id === boundaryId) ?? null : null;
  const editableEntity: EditableEntity | undefined = data && (boundarySite || boundaryZone) ? {
    type: boundarySite ? 'client_site' : 'location_zone',
    id: (boundarySite ?? boundaryZone)!.id,
    organizationId: data.location.organization_id,
    zoneType: boundaryZone?.zone_type ?? null,
    centerLat: boundarySite?.gps_lat ?? boundaryZone?.center_point?.coordinates?.[1] ?? null,
    centerLng: boundarySite?.gps_lng ?? boundaryZone?.center_point?.coordinates?.[0] ?? null,
    onSaved: (verified) => {
      setNotice(verified ? 'Boundary confirmed. GPS can now use this place.' : 'Boundary saved for visual review.');
      void load();
      onSaved();
    },
  } : undefined;

  const zoneTypeOptions = [...new Set([...(MODULE_ZONE_TYPES[zoneForm.moduleKey] ?? MODULE_ZONE_TYPES.patrol), zoneForm.zoneType])];
  const ruleOptions = [...new Set([...allowedRules(zoneForm.moduleKey), zoneForm.ruleType])];

  return <div className="place-manager-backdrop">
    <section className="place-manager" role="dialog" aria-modal="true" aria-labelledby="place-manager-title">
      <header>
        <div><span>Operational setup</span><h2 id="place-manager-title">Manage {data?.location.name ?? 'place'}</h2><p>Brief the team, define work areas on the map, and record temporary access changes.</p></div>
        <button type="button" onClick={onClose} aria-label="Close operational setup"><X size={18} /></button>
      </header>
      <nav aria-label="Operational setup steps">
        <button className={view === 'site' ? 'is-active' : ''} onClick={() => setView('site')}><ShieldCheck size={15} />1. Site briefing</button>
        <button className={view === 'zones' ? 'is-active' : ''} onClick={() => setView('zones')}><MapPinned size={15} />2. Work areas</button>
        <button className={view === 'boundary' ? 'is-active' : ''} onClick={() => setView('boundary')}><LandPlot size={15} />3. Map boundaries</button>
        <button className={view === 'closures' ? 'is-active' : ''} onClick={() => setView('closures')}><Siren size={15} />4. Temporary restrictions</button>
      </nav>
      {error && <div className="place-manager-message is-error" role="alert"><AlertTriangle size={15} />{error}</div>}
      {notice && <div className="place-manager-message is-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
      <main>
        {!data ? <div className="place-manager-empty">Loading operational setup...</div> : view === 'site' ? (
          <form onSubmit={saveSite}>
            <div className="place-manager-heading"><div><h3>Site briefing</h3><p>What officers need to know before they arrive.</p></div><select aria-label="Site to edit" value={siteId} onChange={(event) => { setSiteId(event.target.value); setBoundaryTarget(`site:${event.target.value}`); }}>{data.sites.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
            {site ? <>
              <div className="place-manager-grid"><label><span>Risk level</span><select value={siteForm.risk} onChange={(event) => setSiteForm({ ...siteForm, risk: event.target.value })}><option value="">Not assessed</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label><label className="place-manager-check"><input type="checkbox" checked={siteForm.active} onChange={(event) => setSiteForm({ ...siteForm, active: event.target.checked })} />Available for operations</label></div>
              <label><span>What happens at this site?</span><textarea rows={3} value={siteForm.brief} onChange={(event) => setSiteForm({ ...siteForm, brief: event.target.value })} placeholder="Purpose, normal activity, client expectations..." /></label>
              <label><span>How do officers enter and move around?</span><textarea rows={3} value={siteForm.access} onChange={(event) => setSiteForm({ ...siteForm, access: event.target.value })} placeholder="Gates, keys, access hours, parking, check-in point..." /></label>
              <label><span>Health and safety information</span><textarea rows={3} value={siteForm.safety} onChange={(event) => setSiteForm({ ...siteForm, safety: event.target.value })} placeholder="Hazards, PPE, emergency contacts, areas to avoid..." /></label>
              <footer><span>Saved version {site.configuration_version}</span><button type="submit" className="is-primary" disabled={busy}>Save site briefing</button></footer>
            </> : <div className="place-manager-empty">No Site is linked to this place. Add it in the client portfolio first.</div>}
          </form>
        ) : view === 'zones' ? (
          <form onSubmit={(event) => void saveZone(event)}>
            <div className="place-manager-heading"><div><h3>{creatingZone ? 'Add a work area' : 'Work area settings'}</h3><p>A work area is the named part of this place where a service and its rules apply.</p></div><div>{!creatingZone && <select aria-label="Work area to edit" value={zoneId} onChange={(event) => { setZoneId(event.target.value); setBoundaryTarget(`zone:${event.target.value}`); }}>{data.zones.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>}<button type="button" onClick={creatingZone ? () => setCreatingZone(false) : startNewZone}>{creatingZone ? 'Cancel' : 'Add work area'}</button></div></div>
            {(zone || creatingZone) ? <>
              <div className="place-manager-help"><MapPinned size={17} /><div><strong>{creatingZone ? 'Name the area officers will recognise.' : 'These settings tell officers what applies after GPS selects this area.'}</strong><span>The boundary itself is drawn and confirmed in the next step.</span></div></div>
              <div className="place-manager-grid is-three">
                <label><span>Area name</span><input required value={zoneForm.name} onChange={(event) => setZoneForm({ ...zoneForm, name: event.target.value })} placeholder="North gate, river reserve, patrol sector..." /></label>
                <label><span>Service</span><select value={zoneForm.moduleKey} onChange={(event) => changeModule(event.target.value)}>{data.modules.map((item) => <option value={item.module_key} key={item.module_key}>{item.display_name}</option>)}</select></label>
                <label><span>Area purpose</span><select value={zoneForm.zoneType} onChange={(event) => setZoneForm({ ...zoneForm, zoneType: event.target.value })}>{zoneTypeOptions.map((value) => <option value={value} key={value}>{ZONE_TYPE_LABELS[value] ?? value.replaceAll('_', ' ')}</option>)}</select></label>
                <label><span>What may officers or visitors do here?</span><select value={zoneForm.ruleType} onChange={(event) => setZoneForm({ ...zoneForm, ruleType: event.target.value })}>{ruleOptions.map((value) => <option value={value} key={value}>{RULE_LABELS[value] ?? value.replaceAll('_', ' ')}</option>)}</select></label>
                <label><span>If an issue is found</span><select value={zoneForm.workflow} onChange={(event) => setZoneForm({ ...zoneForm, workflow: event.target.value })}>{Object.entries(WORKFLOW_LABELS).map(([value, label]) => <option value={value} key={value || 'default'}>{label}</option>)}</select></label>
                <label className="place-manager-check"><input type="checkbox" checked={zoneForm.active} onChange={(event) => setZoneForm({ ...zoneForm, active: event.target.checked })} />Area is available for operations</label>
              </div>
              {isFreedomCamping && <fieldset className="place-manager-module-fields"><legend>Freedom camping limits</legend><p>These controls appear only because the selected service is Freedom camping.</p><div className="place-manager-grid"><label><span>Consecutive-night limit</span><input type="number" min="0" value={zoneForm.nightConsecutive} onChange={(event) => setZoneForm({ ...zoneForm, nightConsecutive: event.target.value })} placeholder="No limit recorded" /></label><label><span>Monthly-night limit</span><input type="number" min="0" value={zoneForm.nightMonthly} onChange={(event) => setZoneForm({ ...zoneForm, nightMonthly: event.target.value })} placeholder="No limit recorded" /></label><label className="place-manager-check"><input type="checkbox" checked={zoneForm.scv} onChange={(event) => setZoneForm({ ...zoneForm, scv: event.target.checked })} />Self-contained vehicle requirement applies</label></div></fieldset>}
              <footer><span>{creatingZone ? 'Saving creates the area, then opens its map boundary.' : `Saved version ${zone?.configuration_version ?? 0}`}</span><button type="submit" className="is-primary" disabled={busy || !zoneForm.name.trim()}>{creatingZone ? 'Save and draw boundary' : 'Save area settings'}</button></footer>
            </> : <div className="place-manager-empty">No work area exists yet. Add one to describe where a service applies.</div>}
          </form>
        ) : view === 'boundary' ? (
          <div className="place-manager-boundary">
            <div className="place-manager-heading"><div><h3>Draw or update a boundary</h3><p>Choose a Site or work area, inspect the real map, then confirm the shape officers may rely on.</p></div><select aria-label="Boundary to edit" value={boundaryTarget} onChange={(event) => setBoundaryTarget(event.target.value)}><optgroup label="Sites">{data.sites.map((item) => <option value={`site:${item.id}`} key={item.id}>{item.name}</option>)}</optgroup><optgroup label="Work areas">{data.zones.map((item) => <option value={`zone:${item.id}`} key={item.id}>{item.name}</option>)}</optgroup></select></div>
            <div className="place-manager-help"><LandPlot size={17} /><div><strong>Use the map, not GeoJSON.</strong><span>Find the LINZ parcel, draw corners over satellite imagery, or use a measured radius. A boundary is not used by officers until a person confirms it.</span></div></div>
            {editableEntity ? <LocationHouseMap key={boundaryTarget} organizationId={data.location.organization_id} house={data.location} sites={data.sites} zones={data.zones} editableEntity={editableEntity} onSelectFacet={(facet) => { setNotice(null); setBoundaryTarget(`${facet.type === 'client_site' ? 'site' : 'zone'}:${facet.id}`); }} /> : <div className="place-manager-empty">Add a Site or work area before drawing a boundary.</div>}
          </div>
        ) : (
          <div className="place-manager-restrictions">
            <div className="place-manager-heading"><div><h3>Temporary restrictions</h3><p>Temporarily change access or activity without changing the area's permanent rules.</p></div><select aria-label="Work area for temporary restriction" value={zoneId} onChange={(event) => setZoneId(event.target.value)}>{data.zones.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
            <div className="place-manager-help is-warning"><Siren size={17} /><div><strong>Use this for a storm, fire risk, event, maintenance, or temporary client instruction.</strong><span>Officers see the restriction when GPS matches this area. The start, end, reason, author, and history are retained.</span></div></div>
            {zone ? <form onSubmit={createRestriction}>
              <div className="place-manager-grid is-three"><label><span>What changes?</span><select value={restriction.type} onChange={(event) => setRestriction({ ...restriction, type: event.target.value })}>{Object.entries(RESTRICTION_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span>Starts</span><input type="date" required value={restriction.from} onChange={(event) => setRestriction({ ...restriction, from: event.target.value })} /></label><label><span>Ends (optional)</span><input type="date" value={restriction.to} min={restriction.from} onChange={(event) => setRestriction({ ...restriction, to: event.target.value })} /></label></div>
              <label><span>Why is access or activity changing?</span><textarea required rows={3} value={restriction.reason} onChange={(event) => setRestriction({ ...restriction, reason: event.target.value })} placeholder="For example: bridge inspection until 4 pm; use the south entrance." /></label>
              <footer><span>Leaving the end date blank keeps the restriction active until an administrator ends it.</span><button type="submit" className="is-primary" disabled={busy || !restriction.reason.trim()}>Schedule restriction</button></footer>
            </form> : <div className="place-manager-empty">Add a work area before scheduling a temporary restriction.</div>}
            {selectedRestrictions.length > 0 && <section className="place-manager-restriction-history"><h4>Restriction history</h4>{selectedRestrictions.map((item) => <article key={item.id}><div><strong>{RESTRICTION_LABELS[item.closure_type] ?? item.closure_type.replaceAll('_', ' ')}</strong><span>{item.effective_from}{item.effective_to ? ` to ${item.effective_to}` : ' until ended'} · {item.status.replaceAll('_', ' ')}</span><p>{item.reason ?? 'No reason recorded'}{item.resolution_notes ? ` · ${item.resolution_notes}` : ''}</p></div>{['active', 'scheduled'].includes(item.status) && <button type="button" disabled={busy} onClick={() => endRestriction(item)}>End restriction now</button>}</article>)}</section>}
          </div>
        )}
      </main>
    </section>
  </div>;
}