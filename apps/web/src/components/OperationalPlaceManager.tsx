import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, LandPlot, MapPinned, ShieldCheck, Siren, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { LocationHouseMap, type EditableEntity, type HouseMapCheckpoint, type HouseMapSite, type HouseMapZone } from './LocationHouseMap';
import { WorkingZonePolicyEditor } from './WorkingZonePolicyEditor';
import { orderZonesByParent, partOfOptions } from '../lib/placeLayers';
import { areaDraftSync, isStaleAreaDraft, type AreaDraftBase } from '../lib/areaDraft';
import { supabase } from '../lib/supabase';
import './OperationalPlaceManager.css';
import './OperationalPlaceManagerHuman.css';

type View = 'site' | 'zones' | 'boundary' | 'checkpoints' | 'closures';

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
interface Checkpoint extends HouseMapCheckpoint { location_id: string; client_site_id: string | null; zone_id: string | null; description: string | null; qr_code: string | null; checkpoint_verified_at: string | null }
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

interface CheckpointForm { name: string; description: string; qrCode: string; latitude: string; longitude: string; radius: string }
const emptyCheckpoint: CheckpointForm = { name: '', description: '', qrCode: '', latitude: '', longitude: '', radius: '' };

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
  const { profile } = useAuth();
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
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [checkpointAnchor, setCheckpointAnchor] = useState(initialZoneId ? `zone:${initialZoneId}` : '');
  const [checkpointId, setCheckpointId] = useState('');
  const [checkpointForm, setCheckpointForm] = useState<CheckpointForm>(emptyCheckpoint);
  const [checkpointFormOpen, setCheckpointFormOpen] = useState(false);
  const [placingCheckpoint, setPlacingCheckpoint] = useState(false);
  const [checkpointReviewed, setCheckpointReviewed] = useState('');
  const [partOf, setPartOf] = useState('');
  const [partOfState, setPartOfState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [partOfError, setPartOfError] = useState<string | null>(null);
  const [zoneDraft, setZoneDraft] = useState<AreaDraftBase>({ zoneId: null, version: 0, dirty: false });
  const [policyDirty, setPolicyDirty] = useState(false);

  const site = data?.sites.find((item) => item.id === siteId) ?? null;
  const zone = data?.zones.find((item) => item.id === zoneId) ?? null;
  const selectedCheckpoint = checkpoints.find((item) => item.id === checkpointId) ?? null;
  const checkpointFacetKind = checkpointAnchor.split(':')[0];
  const checkpointFacetId = checkpointAnchor.split(':')[1] ?? '';
  const checkpointSite = checkpointFacetKind === 'site' ? data?.sites.find((item) => item.id === checkpointFacetId) ?? null : null;
  const checkpointZone = checkpointFacetKind === 'zone' ? data?.zones.find((item) => item.id === checkpointFacetId) ?? null : null;
  const anchorCheckpoints = checkpoints.filter((item) => checkpointSite ? item.client_site_id === checkpointSite.id : checkpointZone ? item.zone_id === checkpointZone.id : false);
  const checkpointPoint = checkpointForm.latitude.trim() && checkpointForm.longitude.trim()
    ? { lat: Number(checkpointForm.latitude), lng: Number(checkpointForm.longitude) } : null;
  const isFreedomCamping = zoneForm.moduleKey === 'freedom_camping';
  const selectedRestrictions = useMemo(() => data?.closures.filter((item) => item.zone_id === zoneId) ?? [], [data?.closures, zoneId]);

  const load = useCallback(async (preferredZoneId?: string): Promise<boolean> => {
    setError(null);
    const [editorResponse, geographyResponse] = await Promise.all([
      supabase.rpc('get_crm_operational_place_editor', { p_location_id: locationId }),
      supabase.rpc('get_crm_operational_geography'),
    ]);
    const loadError = editorResponse.error ?? geographyResponse.error;
    if (loadError) { setError(loadError.message); return false; }

    const editor = editorResponse.data as Omit<EditorData, 'location' | 'sites' | 'zones'> & {
      location: Omit<EditorData['location'], 'address'>;
      sites: Array<Omit<Site, keyof HouseMapSite> & { id: string; name: string }>;
      zones: Array<Omit<Zone, keyof HouseMapZone> & { id: string; name: string; parent_zone_id?: string | null }>;
    };
    const geography = geographyResponse.data as GeographyData;
    const siteGeometry = new Map(geography.sites.map((item) => [item.id, item]));
    const zoneGeometry = new Map(geography.zones.map((item) => [item.id, item]));
    const next: EditorData = {
      ...editor,
      location: { ...editor.location, address: geography.locations.find((item) => item.id === locationId)?.address ?? null },
      sites: editor.sites.map((item) => ({ ...item, ...siteGeometry.get(item.id) })) as Site[],
      // The editor lists every work area on the place; the geography read covers only those in reach, so the parent comes from the editor.
      zones: editor.zones.map((item) => ({ ...item, ...zoneGeometry.get(item.id), parent_zone_id: item.parent_zone_id ?? null })) as Zone[],
    };
    const checkpointResponse = profile?.organizationId
      ? await supabase.rpc('get_location_patrol_checkpoints', { p_location_id: locationId })
      : { data: [], error: null };
    if (checkpointResponse.error) { setError(checkpointResponse.error.message); return false; }
    setCheckpoints((checkpointResponse.data as Checkpoint[]) ?? []);
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
    setCheckpointAnchor((current) => {
      if (current.startsWith('site:') && next.sites.some((item) => `site:${item.id}` === current)) return current;
      if (current.startsWith('zone:') && next.zones.some((item) => `zone:${item.id}` === current)) return current;
      if (initialZoneId && next.zones.some((item) => item.id === initialZoneId)) return `zone:${initialZoneId}`;
      return next.sites[0] ? `site:${next.sites[0].id}` : next.zones[0] ? `zone:${next.zones[0].id}` : '';
    });
    return true;
  }, [initialZoneId, locationId, profile?.organizationId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (site) setSiteForm({ risk: site.risk_level ?? '', brief: site.site_brief ?? '', access: site.access_instructions ?? '', safety: site.hs_notes ?? '', active: site.active });
  }, [site]);
  const loadZoneForm = useCallback((item: Zone) => {
    setZoneForm({
      name: item.name,
      zoneType: item.zone_type,
      moduleKey: item.module_key,
      ruleType: item.rule_type,
      active: item.is_active,
      nightConsecutive: item.nightly_limit_consecutive?.toString() ?? '',
      nightMonthly: item.nightly_limit_monthly?.toString() ?? '',
      scv: item.scv_required,
      workflow: item.enforcement_workflow_override ?? '',
    });
    setZoneDraft({ zoneId: item.id, version: item.configuration_version, dirty: false });
  }, []);
  useEffect(() => {
    // A clean form follows the server; an edited one keeps its base version so a stale save conflicts rather than overwrites.
    if (zone && !creatingZone && areaDraftSync(zoneDraft, zone) === 'reset') loadZoneForm(zone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatingZone, zone?.id, zone?.configuration_version]);
  const editZoneForm = (values: Partial<ZoneForm>) => {
    setZoneForm((current) => ({ ...current, ...values }));
    setZoneDraft((current) => ({ ...current, dirty: true }));
  };
  const zoneDirty = !creatingZone && zoneDraft.dirty && zoneDraft.zoneId === zone?.id;
  const zoneDraftStale = !creatingZone && isStaleAreaDraft(zoneDraft, zone);
  const unsavedAreaChanges = zoneDirty || policyDirty;
  useEffect(() => {
    setPartOf(zone?.parent_zone_id ?? '');
  }, [zone?.id, zone?.parent_zone_id]);
  useEffect(() => {
    setPartOfState('idle');
    setPartOfError(null);
  }, [zone?.id]);

  const savePartOf = async () => {
    if (!zone || unsavedAreaChanges) return;
    setPartOfState('saving'); setPartOfError(null);
    const { error: parentError } = await supabase.rpc('set_location_zone_parent', { p_zone_id: zone.id, p_parent_zone_id: partOf || null, p_expected_version: zone.configuration_version });
    if (parentError) {
      // Only the command's own plain-language refusals are shown; anything else gets safe copy.
      const known = /cannot be part of|same organisation|same place|nested at most|changed since it was opened|not work areas|cannot be a parent/i.test(parentError.message);
      setPartOfError(known ? parentError.message : 'The area could not be moved. Reload and try again.');
      setPartOfState('error');
      return;
    }
    if (!(await load(zone.id))) {
      setPartOfError('The area was moved, but the place could not be reloaded. Reload to see the change.');
      setPartOfState('error');
      return;
    }
    setPartOfState('saved');
    onSaved();
  };

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
    editZoneForm({ moduleKey, ...defaultsForModule(moduleKey), nightConsecutive: '', nightMonthly: '', scv: false });
  };

  const saveZone = async (event: FormEvent) => {
    event.preventDefault();
    if (!data || !zoneForm.name.trim() || (!creatingZone && policyDirty)) return;
    setBusy(true); setError(null); setNotice(null);
    const { data: saved, error: saveError } = await supabase.rpc('manage_crm_zone', {
      p_action: creatingZone ? 'create' : 'update',
      p_zone_id: creatingZone ? null : zone?.id ?? null,
      p_location_id: data.location.id,
      p_expected_version: creatingZone ? 0 : zoneDraft.zoneId === zone?.id ? zoneDraft.version : zone?.configuration_version ?? 0,
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
      // Saved, so the form is clean and follows the reloaded version.
      setZoneDraft((current) => ({ ...current, dirty: false }));
      setCreatingZone(false);
      setZoneId(savedZone.id);
      setBoundaryTarget(`zone:${savedZone.id}`);
      setView('boundary');
      setNotice(creatingZone ? 'Work area saved. Draw or confirm its boundary next.' : 'Work area settings saved. Check its boundary next.');
      if (!(await load(savedZone.id))) {
        // The save stood but the reload failed (load keeps its error visible): base the draft on the saved version so
        // the next save is not refused as stale against the person's own change.
        setZoneDraft((current) => ({ zoneId: savedZone.id, version: typeof savedZone.configuration_version === 'number' ? savedZone.configuration_version : current.version, dirty: false }));
      }
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

  const editCheckpoint = (item: Checkpoint) => {
    setCheckpointId(item.id);
    setCheckpointAnchor(item.client_site_id ? `site:${item.client_site_id}` : `zone:${item.zone_id}`);
    setCheckpointForm({ name: item.name, description: item.description ?? '', qrCode: item.qr_code ?? '', latitude: item.gps_lat?.toString() ?? '', longitude: item.gps_lng?.toString() ?? '', radius: item.radius_meters.toString() });
    setCheckpointFormOpen(true);
    setCheckpointReviewed('');
    setPlacingCheckpoint(false);
  };

  const addCheckpoint = () => {
    setCheckpointId('');
    setCheckpointForm(emptyCheckpoint);
    setCheckpointFormOpen(true);
    setCheckpointReviewed('');
    setPlacingCheckpoint(true);
  };

  const saveCheckpoint = async (event: FormEvent) => {
    event.preventDefault();
    if (!data || !profile?.organizationId || (!checkpointSite && !checkpointZone)) {
      setError('Choose an authorised Site or Zone before managing a checkpoint.');
      return;
    }
    if (!checkpointForm.name.trim() || !checkpointPoint || !Number.isFinite(checkpointPoint.lat) || !Number.isFinite(checkpointPoint.lng)) {
      setError('Enter a checkpoint name and choose its position on the map.');
      return;
    }
    const radius = checkpointForm.radius.trim() ? Number(checkpointForm.radius) : null;
    if (radius !== null && (!Number.isInteger(radius) || radius < 1 || radius > 500)) {
      setError('Checkpoint radius must be between 1 and 500 metres.');
      return;
    }
    setBusy(true); setError(null); setNotice(null);
    try {
      const { data: receiptData, error: saveError } = await supabase.rpc('manage_location_patrol_checkpoint', {
        p_client_request_id: crypto.randomUUID(),
        p_action: checkpointId ? 'update' : 'create',
        p_organization_id: profile.organizationId,
        p_location_id: data.location.id,
        p_checkpoint_id: checkpointId || null,
        p_client_site_id: checkpointSite?.id ?? null,
        p_zone_id: checkpointZone?.id ?? null,
        p_name: checkpointForm.name.trim(),
        p_description: checkpointForm.description,
        p_gps_lat: checkpointPoint.lat,
        p_gps_lng: checkpointPoint.lng,
        p_radius_meters: radius,
        p_qr_code: checkpointForm.qrCode,
      });
      if (saveError) throw saveError;
      const receipt = (Array.isArray(receiptData) ? receiptData[0] : receiptData) as { id?: string; created?: boolean; geometry_changed?: boolean; history_version?: number } | null;
      if (!receipt?.id) throw new Error('No checkpoint receipt was returned. Reload before retrying.');
      const wasCreated = !checkpointId;
      setCheckpointId(receipt.id);
      setPlacingCheckpoint(false);
      setCheckpointReviewed('');
      setNotice(wasCreated
        ? 'Checkpoint placed. It remains unverified until its position is inspected on the map.'
        : receipt.geometry_changed ? 'Checkpoint position updated. Its verification was reset; inspect the new position on the map.' : 'Checkpoint details saved.');
      await load();
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The checkpoint could not be saved.');
    } finally { setBusy(false); }
  };

  const verifyCheckpoint = async () => {
    if (!selectedCheckpoint || checkpointReviewed !== selectedCheckpoint.id) return;
    setBusy(true); setError(null); setNotice(null);
    const { error: verifyError } = await supabase.rpc('verify_boundary', { p_entity_type: 'patrol_checkpoint', p_entity_id: selectedCheckpoint.id });
    if (verifyError) setError(verifyError.message);
    else {
      setNotice(`${selectedCheckpoint.name} confirmed from visual map review.`);
      setCheckpointReviewed('');
      await load();
      onSaved();
    }
    setBusy(false);
  };

  const changeCheckpointStatus = (item: Checkpoint) => {
    const anchor = item.client_site_id ? `site:${item.client_site_id}` : `zone:${item.zone_id}`;
    const siteIdForRpc = item.client_site_id;
    const zoneIdForRpc = item.zone_id;
    void complete(() => supabase.rpc('manage_location_patrol_checkpoint', {
      p_client_request_id: crypto.randomUUID(),
      p_action: item.active ? 'deactivate' : 'reactivate',
      p_organization_id: profile?.organizationId ?? '',
      p_location_id: locationId,
      p_checkpoint_id: item.id,
      p_client_site_id: siteIdForRpc,
      p_zone_id: zoneIdForRpc,
    }), `${item.name} ${item.active ? 'deactivated' : 'reactivated'}.`);
    setCheckpointAnchor(anchor);
  };

  const startNewZone = () => {
    const moduleKey = data?.modules.find((item) => item.module_key === 'patrol')?.module_key ?? data?.modules[0]?.module_key ?? 'patrol';
    setZoneForm(emptyZone(moduleKey));
    // Cancelling the new area reloads the selected one rather than keeping the new-area draft.
    setZoneDraft({ zoneId: null, version: 0, dirty: false });
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
        <button className={view === 'checkpoints' ? 'is-active' : ''} onClick={() => setView('checkpoints')}><MapPinned size={15} />4. Checkpoints</button>
        <button className={view === 'closures' ? 'is-active' : ''} onClick={() => setView('closures')}><Siren size={15} />5. Temporary restrictions</button>
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
          <><form onSubmit={(event) => void saveZone(event)}>
            <div className="place-manager-heading"><div><h3>{creatingZone ? 'Add a work area' : 'Work area settings'}</h3><p>A work area is the named part of this place where a service and its rules apply.</p></div><div>{!creatingZone && <select aria-label="Work area to edit" value={zoneId} onChange={(event) => { setZoneId(event.target.value); setBoundaryTarget(`zone:${event.target.value}`); }}>{orderZonesByParent(data.zones).map(({ zone: item, depth }) => <option value={item.id} key={item.id}>{`${'\u00a0\u00a0\u00a0'.repeat(depth)}${depth ? '↳ ' : ''}${item.name}`}</option>)}</select>}<button type="button" onClick={creatingZone ? () => setCreatingZone(false) : startNewZone}>{creatingZone ? 'Cancel' : 'Add work area'}</button></div></div>
            {(zone || creatingZone) ? <>
              <div className="place-manager-help"><MapPinned size={17} /><div><strong>{creatingZone ? 'Name the area officers will recognise.' : 'These settings tell officers what applies after GPS selects this area.'}</strong><span>The boundary itself is drawn and confirmed in the next step.</span></div></div>
              <div className="place-manager-grid is-three">
                <label><span>Area name</span><input required value={zoneForm.name} onChange={(event) => editZoneForm({ name: event.target.value })} placeholder="North gate, river reserve, patrol sector..." /></label>
                <label><span>Service</span><select value={zoneForm.moduleKey} onChange={(event) => changeModule(event.target.value)}>{data.modules.map((item) => <option value={item.module_key} key={item.module_key}>{item.display_name}</option>)}</select></label>
                <label><span>Area purpose</span><select value={zoneForm.zoneType} onChange={(event) => editZoneForm({ zoneType: event.target.value })}>{zoneTypeOptions.map((value) => <option value={value} key={value}>{ZONE_TYPE_LABELS[value] ?? value.replaceAll('_', ' ')}</option>)}</select></label>
                <label><span>What may officers or visitors do here?</span><select value={zoneForm.ruleType} onChange={(event) => editZoneForm({ ruleType: event.target.value })}>{ruleOptions.map((value) => <option value={value} key={value}>{RULE_LABELS[value] ?? value.replaceAll('_', ' ')}</option>)}</select></label>
                <label><span>If an issue is found</span><select value={zoneForm.workflow} onChange={(event) => editZoneForm({ workflow: event.target.value })}>{Object.entries(WORKFLOW_LABELS).map(([value, label]) => <option value={value} key={value || 'default'}>{label}</option>)}</select></label>
                <label className="place-manager-check"><input type="checkbox" checked={zoneForm.active} onChange={(event) => editZoneForm({ active: event.target.checked })} />Area is available for operations</label>
              </div>
              {zoneDraftStale && zone && <div className="place-manager-message is-warning" role="alert"><AlertTriangle size={15} /><span>This area changed since you started editing — reload to see the latest</span><button type="button" onClick={() => loadZoneForm(zone)}>Discard my changes and load the latest</button></div>}
              <footer><span>{creatingZone ? 'Saving creates the area, then opens its map boundary.' : `Saved version ${zone?.configuration_version ?? 0}`}</span>{zoneDirty && !zoneDraftStale && zone && <button type="button" onClick={() => loadZoneForm(zone)}>Discard changes</button>}{!creatingZone && policyDirty && <span className="place-manager-save-hint">Save or discard your rule changes first</span>}<button type="submit" className="is-primary" disabled={busy || !zoneForm.name.trim() || (!creatingZone && policyDirty)}>{creatingZone ? 'Save and draw boundary' : 'Save area settings'}</button></footer>
            </> : <div className="place-manager-empty">No work area exists yet. Add one to describe where a service applies.</div>}
          </form>
          {zone && !creatingZone && <section className="place-manager-part-of" aria-label="Part of another work area">
            <label><span>Part of</span><select value={partOf} disabled={partOfState === 'saving'} onChange={(event) => { setPartOf(event.target.value); setPartOfState('idle'); setPartOfError(null); }}><option value="">Not part of another area</option>{partOfOptions(data.zones, zone.id).map(({ zone: item, depth }) => <option value={item.id} key={item.id}>{`${'\u00a0\u00a0\u00a0'.repeat(depth)}${depth ? '↳ ' : ''}${item.name}`}</option>)}</select></label>
            <p>For grouping and reporting only. GPS still matches the smallest confirmed work area, and nothing is blocked if the shapes overlap.</p>
            <div>
              {partOfState === 'saved' && <span className="is-success" role="status"><CheckCircle2 size={14} />Saved</span>}
              {partOfState === 'error' && partOfError && <span className="is-error" role="alert"><AlertTriangle size={14} />{partOfError}</span>}
              {unsavedAreaChanges && <span className="is-hint">Save or discard your area changes first</span>}
              <button type="button" onClick={() => void savePartOf()} disabled={unsavedAreaChanges || partOfState === 'saving' || partOf === (zone.parent_zone_id ?? '')}>{partOfState === 'saving' ? 'Saving' : 'Save part of'}</button>
            </div>
          </section>}
          {zone && !creatingZone && zone.module_key === zoneForm.moduleKey && ['parking_enforcement', 'freedom_camping'].includes(zone.module_key) && <WorkingZonePolicyEditor key={zone.id} zoneId={zone.id} moduleKey={zone.module_key} configurationVersion={zone.configuration_version} onDirtyChange={setPolicyDirty} saveBlockedReason={zoneDirty ? 'Save or discard your area settings first' : null} onSaved={() => { void load(zone.id); onSaved(); }} />}
          </>
        ) : view === 'boundary' ? (
          <div className="place-manager-boundary">
            <div className="place-manager-heading"><div><h3>Draw or update a boundary</h3><p>Choose a Site or work area, inspect the real map, then confirm the shape officers may rely on.</p></div><select aria-label="Boundary to edit" value={boundaryTarget} onChange={(event) => setBoundaryTarget(event.target.value)}><optgroup label="Sites">{data.sites.map((item) => <option value={`site:${item.id}`} key={item.id}>{item.name}</option>)}</optgroup><optgroup label="Work areas">{data.zones.map((item) => <option value={`zone:${item.id}`} key={item.id}>{item.name}</option>)}</optgroup></select></div>
            <div className="place-manager-help"><LandPlot size={17} /><div><strong>Use the map, not GeoJSON.</strong><span>Find the LINZ parcel, draw corners over satellite imagery, or use a measured radius. A boundary is not used by officers until a person confirms it.</span></div></div>
            {editableEntity ? <LocationHouseMap key={boundaryTarget} data-testid="test-location-house-map" organizationId={data.location.organization_id} house={data.location} sites={data.sites} zones={data.zones} checkpoints={checkpoints} editableEntity={editableEntity} onSelectFacet={(facet) => { setNotice(null); setBoundaryTarget(`${facet.type === 'client_site' ? 'site' : 'zone'}:${facet.id}`); }} /> : <div className="place-manager-empty">Add a Site or work area before drawing a boundary.</div>}
          </div>
        ) : view === 'checkpoints' ? (
          <div className="place-manager-checkpoints">
            <div className="place-manager-heading">
              <div><h3>Checkpoints</h3><p>Place a point-radius checkpoint under exactly one Site or Zone at this Location House.</p></div>
              <div>
                <select aria-label="Checkpoint Site or Zone" value={checkpointAnchor} onChange={(event) => { setCheckpointAnchor(event.target.value); setCheckpointId(''); setCheckpointForm(emptyCheckpoint); setCheckpointFormOpen(false); setCheckpointReviewed(''); setPlacingCheckpoint(false); }}>
                  <optgroup label="Sites">{data.sites.map((item) => <option value={`site:${item.id}`} key={item.id}>{item.name}</option>)}</optgroup>
                  <optgroup label="Zones">{data.zones.map((item) => <option value={`zone:${item.id}`} key={item.id}>{item.name}</option>)}</optgroup>
                </select>
                <button type="button" onClick={addCheckpoint} disabled={!checkpointSite && !checkpointZone}>Add checkpoint</button>
              </div>
            </div>
            <div className="place-manager-help"><MapPinned size={17} /><div><strong>Checkpoints are separate from the Site or Zone boundary.</strong><span>Every new or moved point is unverified. Inspect its radius on this map, then confirm it explicitly.</span></div></div>
            {checkpointSite || checkpointZone ? <div className="place-manager-checkpoint-layout">
              <section className="place-manager-checkpoint-list" aria-label="Checkpoints for selected Site or Zone">
                <h4>{checkpointSite?.name ?? checkpointZone?.name}</h4>
                {anchorCheckpoints.length ? anchorCheckpoints.map((item) => <button type="button" key={item.id} className={checkpointId === item.id ? 'is-selected' : ''} onClick={() => editCheckpoint(item)}>
                  <span><strong>{item.name}</strong><small>{item.gps_lat == null ? 'No map position' : `${item.radius_meters} m radius`} · {item.active ? 'active' : 'inactive'}</small></span>
                  <em className={item.checkpoint_verification === 'verified' ? 'is-verified' : 'is-unverified'}>{item.checkpoint_verification === 'verified' ? 'Verified' : 'Unverified'}</em>
                </button>) : <p>No checkpoints for this facet yet.</p>}
              </section>
              <LocationHouseMap
                key={`checkpoint:${checkpointAnchor}`}
                organizationId={data.location.organization_id}
                house={data.location}
                sites={data.sites}
                zones={data.zones}
                checkpoints={checkpoints}
                checkpointDraftPoint={checkpointPoint}
                checkpointPlacement={placingCheckpoint}
                onCheckpointPosition={(point) => { setCheckpointForm((current) => ({ ...current, latitude: point.lat.toFixed(7), longitude: point.lng.toFixed(7) })); setCheckpointReviewed(''); setPlacingCheckpoint(false); }}
              />
              {checkpointFormOpen && <form className="place-manager-checkpoint-form" onSubmit={(event) => void saveCheckpoint(event)}>
                <div className="place-manager-heading"><div><h4>{checkpointId ? 'Edit checkpoint' : 'New checkpoint'}</h4><p>{placingCheckpoint ? 'Click the map to set the point.' : 'Enter details and choose its position on the map.'}</p></div><button type="button" onClick={() => { setCheckpointId(''); setCheckpointForm(emptyCheckpoint); setCheckpointFormOpen(false); setCheckpointReviewed(''); setPlacingCheckpoint(false); }}>Cancel</button></div>
                <div className="place-manager-grid is-three">
                  <label><span>Checkpoint name</span><input required maxLength={200} value={checkpointForm.name} onChange={(event) => setCheckpointForm({ ...checkpointForm, name: event.target.value })} /></label>
                  <label><span>Radius in metres</span><input type="number" min="1" max="500" value={checkpointForm.radius} onChange={(event) => setCheckpointForm({ ...checkpointForm, radius: event.target.value })} placeholder="Organisation default (5 m)" /></label>
                  <label><span>QR code (optional)</span><input value={checkpointForm.qrCode} onChange={(event) => setCheckpointForm({ ...checkpointForm, qrCode: event.target.value })} /></label>
                  <label className="is-wide"><span>Description (optional)</span><textarea rows={2} value={checkpointForm.description} onChange={(event) => setCheckpointForm({ ...checkpointForm, description: event.target.value })} /></label>
                </div>
                <div className="place-manager-checkpoint-position">
                  <span>{checkpointPoint ? `Position: ${checkpointPoint.lat.toFixed(6)}, ${checkpointPoint.lng.toFixed(6)}` : 'No position selected'}</span>
                  <button type="button" onClick={() => { setPlacingCheckpoint(true); setCheckpointReviewed(''); }}>{placingCheckpoint ? 'Click the map to place' : checkpointId ? 'Move on map' : 'Choose on map'}</button>
                </div>
                <footer><span>A changed position resets checkpoint verification.</span><button type="submit" className="is-primary" disabled={busy || !checkpointForm.name.trim() || !checkpointPoint}>{busy ? 'Saving' : checkpointId ? 'Save checkpoint' : 'Place checkpoint'}</button></footer>
                {selectedCheckpoint?.checkpoint_verification !== 'verified' && selectedCheckpoint?.gps_lat != null && <div className="place-manager-checkpoint-review">
                  <label><input type="checkbox" checked={checkpointReviewed === selectedCheckpoint.id} onChange={(event) => setCheckpointReviewed(event.target.checked ? selectedCheckpoint.id : '')} />Position inspected on the map</label>
                  <button type="button" className="is-primary" disabled={busy || checkpointReviewed !== selectedCheckpoint.id} onClick={() => void verifyCheckpoint()}>Verify checkpoint</button>
                </div>}
                {selectedCheckpoint && <button type="button" disabled={busy} onClick={() => changeCheckpointStatus(selectedCheckpoint)}>{selectedCheckpoint.active ? 'Deactivate checkpoint' : 'Reactivate checkpoint'}</button>}
              </form>}
            </div> : <div className="place-manager-empty">Add a Site or Zone to this Location House before placing checkpoints.</div>}
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