import { isAdminTierRole } from '../lib/roles';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LocationHouseMap } from '../components/LocationHouseMap';
import { resolveAddressCandidates, type AddressCandidate } from '../lib/locationAddress';
import { contractedDaysWords, contractedHoursWords } from '../lib/rosterWords';
import { supabase } from '../lib/supabase';
import type { NavigateWithContext } from '../lib/workflowNavigation';
import './ClientSetupPage.css';

export const SERVICE_CHOICES: Array<{ key: string; label: string; help: string; kind: 'visits' | 'post' | 'response' }> = [
  { key: 'patrol', label: 'Patrol visits', help: 'Visit and check the place.', kind: 'visits' },
  { key: 'static_guarding', label: 'Guard on post', help: 'Configure coverage in the agreement workspace.', kind: 'post' },
  { key: 'dispatch', label: 'Alarm response', help: 'Attend an alarm or call.', kind: 'response' },
  { key: 'parking_enforcement', label: 'Parking enforcement', help: 'Check vehicles and issue notices.', kind: 'visits' },
  { key: 'noise_control', label: 'Noise control', help: 'Assess noise complaints.', kind: 'visits' },
  { key: 'freedom_camping', label: 'Freedom camping', help: 'Patrol camping areas.', kind: 'visits' },
  { key: 'biosecurity', label: 'Biosecurity checks', help: 'Inspect for pests and breaches.', kind: 'visits' },
  { key: 'smoke_complaints', label: 'Smoke complaints', help: 'Assess smoke nuisance.', kind: 'visits' },
  { key: 'access_control', label: 'Access control', help: 'Open, close and control entry.', kind: 'visits' },
];
export const PLACE_TYPES = [
  { key: 'commercial_premises', label: 'Shop, office or premises' }, { key: 'car_park', label: 'Car park' },
  { key: 'reserve', label: 'Park or reserve' }, { key: 'street', label: 'Street or public area' },
  { key: 'residential', label: 'Home or residential block' }, { key: 'industrial', label: 'Yard or industrial site' },
];
interface ScheduleForm { days: number[]; anyTime: boolean; start: string; end: string; visits: string; gap: string; stay: string; slaMinutes: string; notes: string; attendanceMode: 'scheduled' | 'as_attended'; patrolRouteId: string }
const defaultSchedule = (): ScheduleForm => ({ days: [1, 2, 3, 4, 5, 6, 7], anyTime: true, start: '', end: '', visits: '1', gap: '60', stay: '10', slaMinutes: '', notes: '', attendanceMode: 'scheduled', patrolRouteId: '' });
export const serviceWords = (label: string, kind: 'visits' | 'post' | 'response', form: Pick<ScheduleForm, 'days' | 'anyTime' | 'start' | 'end' | 'visits' | 'stay' | 'slaMinutes'> & Partial<Pick<ScheduleForm, 'attendanceMode'>>): string => {
  if (kind === 'post') return `${label} · a guard stays for the shift`;
  if (kind === 'response') return `${label} · on scene within ${form.slaMinutes || '30'} min of the call`;
  if (label === 'Patrol visits' && form.attendanceMode === 'as_attended') return `${label} · As attended`;
  const visits = Number(form.visits) || 1;
  return `${label} · ${contractedDaysWords(form.days)} · ${form.anyTime ? contractedHoursWords(null, null) : contractedHoursWords(form.start, form.end)} · ${visits} visit${visits === 1 ? '' : 's'} a shift, ${form.stay || '10'} min each`;
};
interface Client { id: string; name: string; contact_email: string | null; contact_phone: string | null }
interface Place { id: string; name: string; address: string | null; site_type: string | null; gps_lat: number | null; gps_lng: number | null; boundary: GeoJSON.Geometry | null; boundary_verification: string }
interface Rate { id: string; updated_at: string; amount: number; rate_type: string; site_id: string; service_type: string; name: string }
interface Delivery { id: string; site_id: string; module_key: string; work_model: string | null; active_days: number[]; window_start: string | null; window_end: string | null; visits_per_shift: number; min_gap_between_visits_minutes: number; dwell_minutes: number; officer_instructions: string | null; response_sla_minutes: number | null }
const RATE_UNITS = ['per_visit', 'hourly', 'callout', 'flat', 'daily', 'per_notice'];
const simpleRate = (rate: Record<string, unknown>) => !['job_type', 'day_category', 'effective_from', 'effective_to', 'module_key', 'role_code', 'region_code', 'job_code', 'vehicle_type', 'distance_min_km', 'distance_max_km', 'outside_area', 'zone_id', 'pay_code', 'gl_account'].some((field) => rate[field] != null) && rate.priority === 0 && RATE_UNITS.includes(String(rate.rate_type));
interface Row { key: string; module: string; enabled: boolean; scheduleId: string | null; workModel: string | null; form: ScheduleForm; amount: string; unit: string; rate: Rate | null; rateBlocked: boolean; dirty: boolean; scheduleDone: boolean; rateDone: boolean; requestId: string; rateRequestId: string; receipt: string }
const moduleKey = (key: string) => key === 'general_patrol' ? 'patrol' : key === 'alarm_response' ? 'dispatch' : key;
const newRow = (module: string): Row => ({ key: crypto.randomUUID(), module, enabled: false, scheduleId: null, workModel: null, form: defaultSchedule(), amount: '', unit: 'per_visit', rate: null, rateBlocked: false, dirty: false, scheduleDone: false, rateDone: false, requestId: crypto.randomUUID(), rateRequestId: crypto.randomUUID(), receipt: '' });
const failureMessage = (failure: unknown) => failure instanceof Error ? failure.message : (failure as { message?: string })?.message ?? 'The request failed. Check permissions and retry.';

const ClientSetupPage: React.FC<{ onNavigate?: NavigateWithContext; accountId?: string; providerOrganizationId?: string; embedded?: boolean; onDirtyChange?: (dirty: boolean) => void; onOpenCoverage?: () => void }> = ({ onNavigate = () => undefined, accountId, providerOrganizationId, embedded = false, onDirtyChange, onOpenCoverage }) => {
  const { profile, operatingOrganizationId } = useAuth();
  const branchId = providerOrganizationId ?? operatingOrganizationId ?? profile?.organizationId ?? null;
  const canEdit = Boolean(branchId && isAdminTierRole(profile?.role));
  const location = useLocation();
  const navigate = useNavigate();
  const [client, setClient] = useState<Client | null>(null);
  const [clientForm, setClientForm] = useState({ name: '', firstName: '', lastName: '', email: '', phone: '' });
  const [contactSaved, setContactSaved] = useState(false);
  const [matches, setMatches] = useState<Client[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [selected, setSelected] = useState('');
  const [agreementId, setAgreementId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Row[]>>({});
  const [catalog, setCatalog] = useState<string[]>([]);
  const [patrolRoutes, setPatrolRoutes] = useState<Array<{ id: string; name: string }>>([]);
  const [patrolRoutesLoading, setPatrolRoutesLoading] = useState(false);
  const [patrolRoutesError, setPatrolRoutesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<'organization' | 'location' | 'spatial' | 'invite' | 'bob' | null>(null);
  const [mobilePane, setMobilePane] = useState<'locations' | 'detail'>('locations');
  const [placeForm, setPlaceForm] = useState({ name: '', address: '', type: 'commercial_premises' });
  const [candidates, setCandidates] = useState<AddressCandidate[]>([]);
  const [chosenAddress, setChosenAddress] = useState<AddressCandidate | null>(null);
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  const [workUnitId, setWorkUnitId] = useState<string | null>(null);
  const [inlineExpanded, setInlineExpanded] = useState(false);
  const [inlineServices, setInlineServices] = useState<Record<string, string>>({});
  const clientRequest = useRef(crypto.randomUUID());
  const contactRequest = useRef(crypto.randomUUID());
  const placeRequest = useRef(crypto.randomUUID());
  const routeRequest = useRef(crypto.randomUUID());
  const loadKey = useRef('');
  const loadVersion = useRef(0);
  const drawerRef = useRef<HTMLElement>(null);
  const selectedPlace = places.find((place) => place.id === selected);
  const rows = drafts[selected] ?? [];
  const dirtyCount = Object.values(drafts).flat().filter((row) => row.dirty).length;
  useEffect(() => { onDirtyChange?.(dirtyCount > 0); }, [dirtyCount, onDirtyChange]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await work(); } catch (failure) { setError(failureMessage(failure)); } finally { setBusy(false); }
  };
  const leave = (page: Parameters<NavigateWithContext>[0]) => {
    if (dirtyCount && !window.confirm('Unsaved location drafts will be lost. Leave this workspace?')) return;
    if (embedded && page === 'crm' && onOpenCoverage) onOpenCoverage();
    else onNavigate(page, { accountId: client?.id });
  };
  useEffect(() => {
    if (!branchId) {
      setPatrolRoutes([]);
      setPatrolRoutesLoading(false);
      return;
    }
    let cancelled = false;
    setPatrolRoutesLoading(true);
    setPatrolRoutesError(null);
    void (async () => {
      try {
        const { data, error: routeError } = await supabase.from('patrol_routes').select('id,name').eq('organization_id', branchId).eq('is_active', true).order('name');
        if (routeError) throw routeError;
        if (!cancelled) setPatrolRoutes(data ?? []);
      } catch (failure) {
        if (!cancelled) setPatrolRoutesError(failureMessage(failure));
      } finally {
        if (!cancelled) setPatrolRoutesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [branchId]);
  useEffect(() => {
    if (!dirtyCount) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirtyCount]);
  useEffect(() => {
    if (!drawer) return;
    const previous = document.activeElement as HTMLElement | null;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]');
      if (!focusable?.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [drawer]);
  const loadClient = useCallback(async (id: string) => {
    const version = ++loadVersion.current;
    setLoading(true); setError(null);
    setClient(null); setPlaces([]); setDrafts({}); setSelected(''); setAgreementId(null); setWorkUnitId(null); setInviteEmail(null);
    try {
      const org = await supabase.from('organizations').select('id,name,contact_email,contact_phone').eq('id', id).single();
      if (org.error || !org.data) throw org.error ?? new Error('Client not found or not accessible.');
      const [sites, agreements, contacts] = await Promise.all([
        supabase.from('client_sites').select('id,name,address,site_type,gps_lat,gps_lng,boundary,boundary_verification').eq('client_organization_id', id).eq('active', true).order('created_at'),
        supabase.from('service_agreements').select('id,ends_on').eq('client_organization_id', id).eq('provider_organization_id', branchId).eq('agreement_type', 'operational').in('invitation_status', ['not_invited', 'invited', 'accepted']),
        supabase.from('crm_contacts').select('id').eq('organization_id', id).eq('is_primary', true).is('deactivated_at', null).limit(1),
      ]);
      if (sites.error || agreements.error || contacts.error) throw sites.error ?? agreements.error ?? contacts.error;
      const active = (agreements.data ?? []).filter((agreement) => !agreement.ends_on || agreement.ends_on >= new Date().toISOString().slice(0, 10));
      if (active.length > 1) throw new Error('More than one live agreement exists for this provider. Choose the agreement in the client workspace before editing delivery.');
      const agreement = active[0]?.id ?? null;
      const [schedules, rates] = await Promise.all([
        agreement ? supabase.from('service_agreement_delivery_schedules').select('id,site_id,module_key,work_model,active_days,window_start,window_end,visits_per_shift,min_gap_between_visits_minutes,dwell_minutes,officer_instructions,response_sla_minutes').eq('service_agreement_id', agreement).eq('active', true) : Promise.resolve({ data: [], error: null }),
        supabase.from('rate_rules').select('id,updated_at,amount,rate_type,site_id,service_type,name,job_type,day_category,effective_from,effective_to,priority,module_key,role_code,region_code,job_code,vehicle_type,distance_min_km,distance_max_km,outside_area,zone_id,pay_code,gl_account').eq('organization_id', branchId).eq('client_org_id', id).eq('rule_kind', 'billing').eq('active', true),
      ]);
      if (schedules.error || rates.error) throw schedules.error ?? rates.error;
      const attendedScheduleIds = ((schedules.data ?? []) as Delivery[]).filter((schedule) => schedule.work_model === 'as_attended_patrol').map((schedule) => schedule.id);
      const attendanceConfigs = attendedScheduleIds.length
        ? await supabase.from('client_site_patrol_config').select('delivery_schedule_id,patrol_route_id').in('delivery_schedule_id', attendedScheduleIds)
        : { data: [], error: null };
      if (attendanceConfigs.error) throw attendanceConfigs.error;
      const routeBySchedule = new Map((attendanceConfigs.data ?? []).map((config) => [config.delivery_schedule_id, config.patrol_route_id]));
      if (attendedScheduleIds.some((scheduleId) => !routeBySchedule.get(scheduleId))) {
        throw new Error('An as-attended patrol is missing its route configuration. Review the agreement before changing delivery.');
      }
      const next: Record<string, Row[]> = {};
      for (const site of (sites.data ?? []) as Place[]) {
        next[site.id] = ((schedules.data ?? []) as Delivery[]).filter((schedule) => schedule.site_id === site.id).map((schedule) => {
          const module = moduleKey(schedule.module_key);
          // Only a simple, exact site/service rule is editable here. Qualified or shared rates stay in Finance.
          const scoped = (rates.data ?? []).filter((rate) => rate.site_id === site.id && rate.service_type === module);
          const exact = scoped.filter(simpleRate);
          const rate = exact.length === 1 ? exact[0] as Rate : null;
          return { ...newRow(module), enabled: true, scheduleId: schedule.id, workModel: schedule.work_model, rate, rateBlocked: scoped.length > 0 && (scoped.length !== 1 || !rate), amount: rate ? String(rate.amount) : '', unit: rate?.rate_type ?? 'per_visit', form: { ...defaultSchedule(), days: schedule.active_days, anyTime: !schedule.window_start, start: schedule.window_start?.slice(0, 5) ?? '', end: schedule.window_end?.slice(0, 5) ?? '', visits: String(schedule.visits_per_shift), gap: String(schedule.min_gap_between_visits_minutes), stay: String(schedule.dwell_minutes), notes: schedule.officer_instructions ?? '', slaMinutes: schedule.response_sla_minutes == null ? '' : String(schedule.response_sla_minutes), attendanceMode: schedule.work_model === 'as_attended_patrol' ? 'as_attended' : 'scheduled', patrolRouteId: routeBySchedule.get(schedule.id) ?? '' } };
        });
        for (const service of SERVICE_CHOICES) {
          if (next[site.id].some((row) => row.module === service.key)) continue;
          const scoped = (rates.data ?? []).filter((rate) => rate.site_id === site.id && rate.service_type === service.key);
          const exact = scoped.length === 1 && simpleRate(scoped[0]) ? scoped[0] as Rate : null;
          next[site.id].push({ ...newRow(service.key), rate: exact, rateBlocked: scoped.length > 0 && !exact, amount: exact ? String(exact.amount) : '', unit: exact?.rate_type ?? 'per_visit' });
        }
      }
      if (version !== loadVersion.current) return;
      setClient(org.data as Client); setContactSaved(Boolean(contacts.data?.length));
      setClientForm({ name: org.data.name, firstName: '', lastName: '', email: org.data.contact_email ?? '', phone: org.data.contact_phone ?? '' });
      setAgreementId(agreement); setPlaces((sites.data ?? []) as Place[]); setDrafts(next); setSelected(sites.data?.[0]?.id ?? '');
    } catch (failure) { if (version === loadVersion.current) setError(failureMessage(failure)); } finally { if (version === loadVersion.current) setLoading(false); }
  }, [branchId]);
  useEffect(() => {
    const account = accountId ?? new URLSearchParams(location.search).get('account');
    const key = `${branchId}:${account}`;
    if (account && branchId && key !== loadKey.current) { loadKey.current = key; void loadClient(account); }
  }, [location.search, branchId, loadClient, accountId]);
  useEffect(() => {
    let cancelled = false;
    void supabase.from('module_catalog').select('module_key').eq('active', true).then(({ data, error: catalogError }) => {
      if (!cancelled) { if (catalogError) setError(catalogError.message); else setCatalog((data ?? []).map((item) => item.module_key)); }
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (client || clientForm.name.trim().length < 3) { setMatches([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await supabase.from('organizations').select('id,name,contact_email,contact_phone').ilike('name', `%${clientForm.name.trim()}%`).limit(5);
      if (!cancelled) {
        if (result.error || !Array.isArray(result.data)) { setMatches([]); setError('Existing client matching is unavailable. Check the CRM before creating another organization.'); }
        else setMatches(result.data.filter((item) => item.id !== branchId));
      }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [client, clientForm.name, branchId]);
  const ensureAgreement = async () => {
    if (agreementId) return agreementId;
    if (!client) throw new Error('Save the organization first.');
    const result = await supabase.rpc('ensure_crm_client_agreement', { p_account_organization_id: client.id, p_provider_organization_id: branchId });
    if (result.error || !result.data?.agreement_id) throw result.error ?? new Error('Agreement could not be opened.');
    setAgreementId(result.data.agreement_id); return result.data.agreement_id as string;
  };
  const saveClient = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (!clientForm.name.trim() || (!clientForm.email.trim() && !clientForm.phone.trim())) throw new Error('Add the client name and an email or phone.');
      if (!contactSaved && (!clientForm.firstName.trim() || !clientForm.lastName.trim())) throw new Error('Add both first and last names for the primary contact.');
      let record = client;
      if (!record) {
        const { data, error: saveError } = await supabase.rpc('manage_crm_organization', {
          p_client_request_id: clientRequest.current, p_organization_id: null, p_expected_updated_at: null, p_action: 'create',
          p_name: clientForm.name.trim(), p_organization_type: 'client', p_nzbn: null, p_company_registration_number: null,
          p_contact_email: clientForm.email.trim() || null, p_contact_phone: clientForm.phone.trim() || null,
          p_billing_email: null, p_billing_address: null, p_account_notes: null, p_status: null,
        });
        if (saveError || !data) throw saveError ?? new Error('The organization was not saved.');
        record = data as Client; setClient(record); loadKey.current = `${branchId}:${record.id}`;
        navigate(`${location.pathname}?account=${record.id}`, { replace: true });
      }
      if (!contactSaved) {
        const contact = await supabase.rpc('manage_crm_contact', {
          p_client_request_id: contactRequest.current, p_contact_id: null, p_account_organization_id: record.id, p_expected_updated_at: null, p_action: 'create',
          p_first_name: clientForm.firstName.trim(), p_last_name: clientForm.lastName.trim(), p_role_title: null,
          p_email: clientForm.email.trim() || null, p_phone: clientForm.phone.trim() || null, p_mobile: null, p_is_primary: true, p_is_emergency: false, p_notes: null,
        });
        if (contact.error) throw new Error(`Organization saved; contact failed: ${contact.error.message}. Retry to save only the contact.`);
        setContactSaved(true);
      }
      setDrawer(null); setNotice('Organization and primary contact saved. Add locations when ready.');
    });
  };
  const savePlace = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (!client || !chosenAddress || !placeForm.name.trim()) throw new Error('Choose an organization, location name and resolved address.');
      const { data, error: saveError } = await supabase.rpc('create_crm_site', {
        p_client_request_id: placeRequest.current, p_account_organization_id: client.id, p_name: placeForm.name.trim(), p_address: chosenAddress.label,
        p_site_type: placeForm.type, p_center_lat: chosenAddress.lat, p_center_lng: chosenAddress.lng, p_location_id: null,
      });
      if (saveError || !data) throw saveError ?? new Error('The location was not saved.');
      const row = (Array.isArray(data) ? data[0] : data) as Place;
      if (!row?.id) throw new Error('Location may have saved; reload before trying again.');
      setPlaces((current) => current.some((place) => place.id === row.id) ? current : [...current, { ...row, gps_lat: chosenAddress.lat, gps_lng: chosenAddress.lng, boundary: null, boundary_verification: 'unverified' }]);
      setSelected(row.id); setMobilePane('detail'); setDrawer(null);
      setPlaceForm({ name: '', address: '', type: 'commercial_premises' }); setChosenAddress(null); setCandidates([]);
      placeRequest.current = crypto.randomUUID(); setNotice('Location saved. Boundary remains unverified until reviewed in Spatial context.');
    });
  };
  const changeSiteRow = (site: string, key: string, update: Partial<Row>) => setDrafts((current) => ({ ...current, [site]: (current[site] ?? []).map((row) => row.key === key && !row.receipt.startsWith('Needs retry:') ? { ...row, ...update, dirty: true, scheduleDone: false, rateDone: false, requestId: crypto.randomUUID(), rateRequestId: crypto.randomUUID(), receipt: 'Draft — not saved' } : row) }));
  const changeRow = (key: string, update: Partial<Row>) => changeSiteRow(selected, key, update);
  const patchRow = (site: string, key: string, update: Partial<Row>) => setDrafts((current) => ({ ...current, [site]: (current[site] ?? []).map((row) => row.key === key ? { ...row, ...update } : row) }));
  const toggleService = (module: string, enabled: boolean) => {
    const existing = rows.find((row) => row.module === module);
    if (existing) changeRow(existing.key, { enabled });
    else setDrafts((current) => ({ ...current, [selected]: [...(current[selected] ?? []), { ...newRow(module), enabled, dirty: true, receipt: 'Draft — not saved' }] }));
  };
  const saveMatrix = () => void run(async () => {
    if (!client || !canEdit) throw new Error('Provider administrator permission required.');
    const pending = Object.entries(drafts).flatMap(([site, entries]) => entries.filter((row) => row.dirty).map((row) => ({ site, row })));
    for (const { row } of pending) {
      const asAttended = row.module === 'patrol' && row.form.attendanceMode === 'as_attended';
      if (row.enabled && row.form.attendanceMode === 'as_attended' && row.module !== 'patrol') throw new Error('As-attended mode is only available for Patrol visits.');
      if (row.enabled && asAttended && (patrolRoutesLoading || patrolRoutesError || !patrolRoutes.some((route) => route.id === row.form.patrolRouteId))) throw new Error('Choose an active patrol before saving the as-attended schedule.');
      if (row.enabled && !asAttended && (!row.form.days.length || (!row.form.anyTime && (!row.form.start || !row.form.end)))) throw new Error('Each selected service needs days and both window times, or any-time coverage.');
      if (row.enabled && !asAttended && (!Number.isInteger(Number(row.form.visits)) || Number(row.form.visits) < 1 || Number(row.form.visits) > 24 || Number(row.form.gap) < 0 || Number(row.form.gap) > 720 || Number(row.form.stay) < 0 || Number(row.form.stay) > 480)) throw new Error('Check visits (1–24), gap (0–720) and dwell (0–480).');
      if (row.amount && (!Number.isFinite(Number(row.amount)) || Number(row.amount) <= 0)) throw new Error('A rate must be a positive amount.');
      if (row.enabled && !row.rateBlocked && row.rate && !row.amount) throw new Error('Use Finance to deactivate an existing rate; clearing a field does not remove billing rules.');
    }
    const id = await ensureAgreement();
    let saved = 0; let failed = 0;
    for (const { site, row } of pending) {
      let scheduleId = row.scheduleId;
      const asAttended = row.enabled && row.module === 'patrol' && row.form.attendanceMode === 'as_attended';
      try {
        if (!row.scheduleDone && (row.enabled || scheduleId)) {
          const result = asAttended ? await supabase.rpc('manage_crm_as_attended_patrol', {
            p_client_request_id: row.requestId, p_agreement_id: id, p_patrol_route_id: row.form.patrolRouteId,
            p_site_id: site, p_zone_id: null, p_officer_instructions: row.form.notes.trim() || null,
            p_operating_organization_id: branchId, p_expected_work_model: row.workModel,
          }) : await supabase.rpc('manage_crm_agreement_delivery_schedule', {
            p_client_request_id: row.requestId, p_agreement_id: id, p_action: row.enabled ? scheduleId ? 'update' : 'create' : 'remove', p_schedule_id: scheduleId,
            p_site_id: site, p_zone_id: null, p_module_key: row.module, p_active_days: row.form.days,
            p_window_start: row.form.anyTime ? null : row.form.start, p_window_end: row.form.anyTime ? null : row.form.end,
            p_visits_per_shift: Number(row.form.visits), p_min_gap_between_visits_minutes: Number(row.form.gap), p_dwell_minutes: Number(row.form.stay),
            p_officer_instructions: row.form.notes.trim() || null, p_operating_organization_id: branchId,
          });
          if (result.error || !result.data?.schedule_id) throw result.error ?? new Error('Schedule receipt missing; retry with the same request.');
          scheduleId = row.enabled ? result.data.schedule_id : null;
          patchRow(site, row.key, { scheduleId, workModel: asAttended ? 'as_attended_patrol' : row.enabled ? 'scheduled_patrol' : null, scheduleDone: true, receipt: row.enabled ? asAttended ? 'As-attended patrol saved; rate pending' : 'Schedule saved; rate pending' : 'Schedule archived; billing rule retained' });
        }
        if (!row.rateDone && !row.rateBlocked && row.enabled && row.amount) {
          const result = await supabase.rpc('manage_operating_branch_rate_rule', {
            p_operating_organization_id: branchId, p_client_request_id: row.rateRequestId,
            p_action: row.rate ? 'update' : 'create', p_rate_rule_id: row.rate?.id ?? null, p_expected_updated_at: row.rate?.updated_at ?? null,
            p_rule_kind: 'billing', p_name: row.rate?.name ?? `${places.find((place) => place.id === site)?.name} · ${row.module}`,
            p_rate_type: row.unit, p_amount: Number(row.amount), p_pay_code: null, p_service_type: row.module, p_job_type: null,
            p_client_org_id: client.id, p_site_id: site, p_zone_id: null, p_day_category: null, p_effective_from: null, p_effective_to: null, p_priority: 0, p_role_code: null,
          });
          let rate = (Array.isArray(result.data) ? result.data[0] : result.data) as Rate | null;
          if (result.error && row.rate) {
            // The update RPC uses optimistic timestamps, not replay receipts. Reconcile a lost response before retrying.
            const recovered = await supabase.from('rate_rules').select('id,updated_at,amount,rate_type,site_id,service_type,name,job_type,day_category,effective_from,effective_to,priority,module_key,role_code,region_code,job_code,vehicle_type,distance_min_km,distance_max_km,outside_area,zone_id,pay_code,gl_account').eq('id', row.rate.id).eq('organization_id', branchId).eq('client_org_id', client.id).eq('site_id', site).eq('service_type', row.module).eq('active', true).maybeSingle();
            if (!recovered.error && recovered.data && simpleRate(recovered.data) && Number(recovered.data.amount) === Number(row.amount) && recovered.data.rate_type === row.unit && recovered.data.name === row.rate.name) rate = recovered.data as Rate;
            else throw result.error;
          } else if (result.error) throw result.error;
          if (!rate?.id || !rate.updated_at) throw new Error('Rate receipt missing. Retry without changing the draft.');
          patchRow(site, row.key, { rate, rateDone: true });
        }
        patchRow(site, row.key, { dirty: false, scheduleId, receipt: row.enabled ? asAttended ? 'As-attended patrol saved' : 'Saved' : 'Schedule archived; rates unchanged' }); saved++;
      } catch (failure) { patchRow(site, row.key, { receipt: `Needs retry: ${failureMessage(failure)}` }); failed++; }
    }
    setNotice(`${saved} row${saved === 1 ? '' : 's'} saved. ${failed ? `${failed} need retry; successful writes remain saved.` : 'All pending rows complete.'}`);
    routeRequest.current = crypto.randomUUID();
    if (failed) setError('Some rows did not complete. Review each receipt, then retry pending rows. This is not an atomic transaction.');
  });
  const sendInvite = () => void run(async () => {
    if (!client) return;
    const prepared = await supabase.rpc('prepare_crm_client_invitation', { p_account_organization_id: client.id });
    if (prepared.error || !prepared.data) throw prepared.error ?? new Error('Invitation could not be prepared.');
    const invitation = await supabase.functions.invoke('invite-org', { body: { target_organization_id: client.id, email: prepared.data.email, display_name: prepared.data.display_name?.trim() || client.name } });
    if (invitation.error) throw invitation.error;
    setInviteEmail(prepared.data.email); setNotice('Invitation sent. Portal access is optional and does not authorize provider configuration.');
  });
  const buildRun = () => void run(async () => {
    if (!client || dirtyCount) throw new Error('Save delivery drafts before building the run.');
    const id = await ensureAgreement();
    const route = await supabase.rpc('create_patrol_route_from_agreement', { p_client_request_id: routeRequest.current, p_service_agreement_id: id, p_name: `${client.name} patrol run`, p_operating_organization_id: branchId });
    if (route.error) throw route.error;
    const built = Array.isArray(route.data) ? route.data[0] : route.data;
    if (!built?.route_id) throw new Error('No patrol run receipt returned.');
    const existing = await supabase.from('roster_work_units').select('id').eq('organization_id', branchId).eq('patrol_route_id', built.route_id).eq('active', true).limit(1);
    if (existing.error) throw new Error(`Patrol run saved; could not check its work unit: ${existing.error.message}. Retry before creating another.`);
    if (existing.data?.[0]?.id) {
      setWorkUnitId(existing.data[0].id); setNotice('Patrol run and existing work unit are ready to roster.'); return;
    }
    const unit = await supabase.rpc('create_operating_roster_work_unit', { p_operating_organization_id: branchId, p_name: `${client.name} patrol run`, p_work_unit_type: 'patrol', p_service_type: 'patrol', p_patrol_route_id: built.route_id, p_service_agreement_location_id: null, p_service_agreement_module_id: null });
    if (unit.error) throw new Error(`Patrol run saved; work unit failed: ${unit.error.message}. Retry safely or open Roster targets.`);
    setWorkUnitId(unit.data?.id ?? null); setNotice(`Patrol run saved with ${built.attached_places ?? 0} locations. Roster the run next.`);
  });

  return <div className={`client-setup${embedded ? ` is-embedded${inlineExpanded ? ' is-expanded' : ''}` : ''}`} aria-busy={busy || loading}>
    {!embedded && <header className="client-setup-head"><div><span>Client delivery workspace</span><h1>Set up a new client</h1></div><button type="button" onClick={() => leave('onboarding')}>All clients</button></header>}
    {!canEdit && <p role="alert">Provider administrator permission is required. No configuration can be saved.</p>}
    {error && <div className="client-setup-message is-error" role="alert">{error}{!client && !loading && new URLSearchParams(location.search).get('account') && <button type="button" onClick={() => void loadClient(new URLSearchParams(location.search).get('account')!)}>Retry loading client</button>}</div>}
    {notice && <div className="client-setup-message" role="status">{notice}</div>}
    {!embedded && <section className="client-setup-parent" aria-label="Parent organization and service agreement">
      <div><small>Parent organization · workspace grouping, not legal ownership</small><strong>{client?.name ?? 'Choose or create a client organization'}</strong><span>{agreementId ? `Operational agreement · ${agreementId}` : 'Agreement opens through the governed writer on first delivery save'}</span></div>
      <div className="client-setup-actions"><button type="button" onClick={() => setDrawer('organization')} disabled={busy || loading}>{client ? contactSaved ? 'Organization summary' : 'Complete contact' : 'Add organization'}</button><button type="button" disabled={!client || busy} onClick={() => setDrawer('invite')}>Client invitation</button><button type="button" onClick={() => setDrawer('bob')}>Bob Quick Setup</button></div>
    </section>}
    {embedded && <section className="crm-child-sites" aria-label="Child sites and inline services">
      <header><h3>Child sites</h3><div><button type="button" disabled={!client || busy || !canEdit} onClick={() => setDrawer('location')}>Add Location</button><button type="button" onClick={() => setDrawer('bob')}>Bob Quick Setup</button><button type="button" onClick={onOpenCoverage}>Agreement coverage</button></div></header>
      {loading ? <p role="status">Loading client delivery…</p> : !places.length ? <p>No active sites recorded for this client.</p> : <div className="crm-child-sites-scroll"><table><caption>Per-site drafts · save explicitly below. Static and CCTV coverage are not inferred from visit schedules.</caption><thead><tr><th>Site</th><th>Services</th><th>Rate / unit</th><th>Schedule</th><th>Review</th></tr></thead><tbody>{places.map((place) => {
        const siteRows = drafts[place.id] ?? [];
        const enabled = siteRows.filter((row) => row.enabled);
        const module = inlineServices[place.id] ?? enabled[0]?.module ?? 'patrol';
        const row = siteRows.find((item) => item.module === module && item.enabled);
        const locked = busy || !canEdit || Boolean(row?.receipt.startsWith('Needs retry:'));
        const preset = row ? row.form.days.join(',') === '1,2,3,4,5,6,7' ? 'all' : row.form.days.join(',') === '1,2,3,4,5' ? 'weekdays' : row.form.days.join(',') === '6,7' ? 'weekends' : 'custom' : '';
        return <tr key={place.id}><th scope="row"><strong>{place.name}</strong><small>{place.address}</small></th><td><div className="crm-inline-service-checks">{[{ key: 'patrol', label: 'Patrol' }, { key: 'dispatch', label: 'Alarm' }, { key: 'access_control', label: 'Access' }].map((service) => {
          const matches = siteRows.filter((item) => item.module === service.key);
          return <label key={service.key}><input type="checkbox" aria-label={`${place.name} ${service.label}`} checked={matches.some((item) => item.enabled)} disabled={busy || !canEdit || !catalog.includes(service.key) || matches.some((item) => item.receipt.startsWith('Needs retry:'))} onChange={(event) => {
            if (matches.length) { for (const item of event.target.checked ? matches.slice(0, 1) : matches) changeSiteRow(place.id, item.key, { enabled: event.target.checked }); }
            else setDrafts((current) => ({ ...current, [place.id]: [...(current[place.id] ?? []), { ...newRow(service.key), enabled: true, dirty: true, receipt: 'Draft — not saved' }] }));
            setInlineServices((current) => ({ ...current, [place.id]: service.key }));
          }} />{service.label}</label>;
        })}<label title="CCTV does not have a compatible per-site delivery schedule writer. Use governed agreement coverage; current coverage is not inferred."><input type="checkbox" disabled aria-label={`${place.name} CCTV setup unavailable`} />CCTV · coverage</label><label title="Static posts do not use visit schedules. Use governed agreement coverage; current coverage is not inferred."><input type="checkbox" disabled aria-label={`${place.name} Static setup unavailable`} />Static · coverage</label></div></td>
          <td><label><span className="client-setup-sr">Rate service for {place.name}</span><select aria-label={`Rate service for ${place.name}`} value={module} disabled={!enabled.length || busy} onChange={(event) => setInlineServices((current) => ({ ...current, [place.id]: event.target.value }))}>{!enabled.length && <option value="patrol">Select service first</option>}{enabled.map((item) => <option key={item.key} value={item.module}>{SERVICE_CHOICES.find((service) => service.key === item.module)?.label ?? item.module}</option>)}</select></label><div className="client-setup-two"><input aria-label={`Billing rate for ${place.name}`} type="number" min="0.01" step="0.01" value={row?.amount ?? ''} placeholder="Not set" disabled={!row || locked || row.rateBlocked} onChange={(event) => row && changeSiteRow(place.id, row.key, { amount: event.target.value })} /><select aria-label={`Rate unit for ${place.name}`} value={row?.unit ?? 'per_visit'} disabled={!row || locked || row.rateBlocked} onChange={(event) => row && changeSiteRow(place.id, row.key, { unit: event.target.value })}>{RATE_UNITS.map((unit) => <option key={unit} value={unit}>{unit.replaceAll('_', ' ')}</option>)}</select></div>{row?.rateBlocked && <small>Qualified rates: review in Finance.</small>}</td>
          <td>{row?.module === 'patrol' && <label><span>Attendance mode</span><select aria-label={`Attendance mode for ${place.name}`} value={row.form.attendanceMode} disabled={locked} onChange={(event) => row && changeSiteRow(place.id, row.key, { form: { ...row.form, attendanceMode: event.target.value as ScheduleForm['attendanceMode'] } })}><option value="scheduled" disabled={row.workModel === 'as_attended_patrol'}>Scheduled</option><option value="as_attended">As attended</option></select></label>}
            {row?.form.attendanceMode === 'as_attended' ? <label><span>Patrol route</span><select aria-label={`Patrol route for ${place.name}`} value={row.form.patrolRouteId} disabled={locked || patrolRoutesLoading || Boolean(patrolRoutesError)} onChange={(event) => row && changeSiteRow(place.id, row.key, { form: { ...row.form, patrolRouteId: event.target.value } })}><option value="">{patrolRoutesLoading ? 'Loading patrols…' : patrolRoutesError ? 'Patrols unavailable' : 'Choose a patrol'}</option>{patrolRoutes.map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}</select>{patrolRoutesError && <small role="alert">Patrols could not be loaded: {patrolRoutesError}</small>}</label> : <><select aria-label={`Schedule days for ${place.name}`} value={preset} disabled={!row || locked} onChange={(event) => row && changeSiteRow(place.id, row.key, { form: { ...row.form, days: event.target.value === 'weekdays' ? [1, 2, 3, 4, 5] : event.target.value === 'weekends' ? [6, 7] : [1, 2, 3, 4, 5, 6, 7] } })}><option value="" disabled>Select service first</option><option value="all">Every day</option><option value="weekdays">Weekdays</option><option value="weekends">Weekends</option><option value="custom" disabled>Custom days · details</option></select><label><span>Visits / shift</span><input aria-label={`Visits per shift for ${place.name}`} type="number" min="1" max="24" value={row?.form.visits ?? ''} disabled={!row || locked} onChange={(event) => row && changeSiteRow(place.id, row.key, { form: { ...row.form, visits: event.target.value } })} /></label><small>{row ? row.form.anyTime ? 'Any time · 24-hour' : `${row.form.start}–${row.form.end}` : 'Not configured'}</small></>}</td>
          <td><button type="button" onClick={() => { setSelected(place.id); setMobilePane('detail'); setInlineExpanded((current) => selected === place.id ? !current : true); }}>Service details</button><button type="button" onClick={() => { setSelected(place.id); setDrawer('spatial'); }}>Boundary</button>{siteRows.filter((item) => item.receipt).map((item) => <small key={item.key}>{item.module}: {item.receipt}</small>)}</td></tr>;
      })}</tbody></table></div>}
    </section>}
    {!embedded && <nav className="client-setup-mobile-tabs" aria-label="Workspace panes"><button type="button" aria-pressed={mobilePane === 'locations'} onClick={() => setMobilePane('locations')}>Locations ({places.length})</button><button type="button" aria-pressed={mobilePane === 'detail'} onClick={() => setMobilePane('detail')}>Selected location</button></nav>}
    <div className={`client-setup-workspace show-${mobilePane}`}>
      <aside className="client-setup-locations" aria-label="Child locations">
        <header><h2>Locations <small>{places.length}</small></h2><button type="button" disabled={!client || !canEdit || busy} onClick={() => setDrawer('location')}>Add Location</button></header>
        {loading ? <p role="status">Loading organization and delivery…</p> : !places.length ? <p>{client ? 'No locations yet. Add a resolved address to begin.' : 'Add the client organization first.'}</p> : <ul>{places.map((place) => <li key={place.id}><button type="button" aria-pressed={place.id === selected} onClick={() => { setSelected(place.id); setMobilePane('detail'); }}><strong>{place.name}</strong><span>{place.address ?? 'No address recorded'}</span><small>{drafts[place.id]?.some((row) => row.dirty) ? 'Unsaved draft retained' : `${drafts[place.id]?.filter((row) => row.enabled).length ?? 0} scheduled services`}</small></button></li>)}</ul>}
      </aside>
      <section className="client-setup-detail" aria-label="Selected location delivery">
        {!selectedPlace ? <div className="client-setup-empty"><h2>Configure delivery in one place</h2><p>Select a location to review services, rates and schedules together. Location drafts remain intact when switching panes.</p></div> : <>
          <header className="client-setup-detail-head"><div><h2>{selectedPlace.name}</h2><p>{selectedPlace.address}</p></div><button type="button" onClick={() => setDrawer('spatial')}>Spatial context</button></header>
          <label className="client-setup-clone"><span>Clone service drafts from</span><select aria-label="Clone service drafts from" value="" disabled={busy || !canEdit} onChange={(event) => {
            const source = drafts[event.target.value] ?? [];
            const clones = source.filter((row) => row.enabled).flatMap((row) => {
              const existing = rows.find((item) => item.module === row.module);
              if (existing?.enabled || existing?.scheduleId || existing?.dirty) return [];
              return [{ ...newRow(row.module), key: existing?.key ?? crypto.randomUUID(), enabled: true, dirty: true, form: { ...row.form, days: [...row.form.days], slaMinutes: '' }, rate: existing?.rate ?? null, rateBlocked: existing?.rateBlocked ?? false, amount: existing?.rate ? existing.amount : row.amount, unit: existing?.rate ? existing.unit : row.unit, receipt: 'Cloned draft — review before saving' }];
            });
            setDrafts((current) => ({ ...current, [selected]: [...rows.filter((row) => !clones.some((clone) => clone.key === row.key)), ...clones] })); setNotice(`${clones.length} services cloned as drafts only. Existing services were not overwritten.`);
          }}><option value="">Choose another location…</option>{places.filter((place) => place.id !== selected).map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}</select></label>
          <div className="client-setup-matrix-scroll"><table className="client-setup-matrix"><caption>Location service matrix · changes stay in draft until Save changes</caption><thead><tr><th scope="col">Service</th><th scope="col">Rate / unit</th><th scope="col">Schedule / visits</th><th scope="col">SLA / receipt</th></tr></thead><tbody>
            {SERVICE_CHOICES.map((service) => {
              const serviceRows = rows.filter((row) => row.module === service.key);
              const available = catalog.includes(service.key);
              if (service.kind === 'post') return <tr key={service.key}><th scope="row">{service.label}</th><td colSpan={3}><button type="button" onClick={() => leave('crm')}>Open governed agreement coverage</button><small>Static posts do not use visit schedules. Configure coverage and roster work in the client workspace.</small></td></tr>;
              const rendered = serviceRows.length ? serviceRows : [null];
              return rendered.map((row, index) => <tr key={row?.key ?? service.key} className={row?.dirty ? 'is-draft' : ''}>
                <th scope="row"><label><input type="checkbox" aria-label={`${service.label}${index ? ` schedule ${index + 1}` : ''}`} checked={row?.enabled ?? false} disabled={busy || loading || !canEdit || (!available && !row?.enabled) || row?.receipt.startsWith('Needs retry:')} onChange={(event) => row ? changeRow(row.key, { enabled: event.target.checked }) : toggleService(service.key, event.target.checked)} />{service.label}{index ? ` · ${index + 1}` : ''}</label><small>{available ? service.help : 'Unavailable in the active module catalog'}</small></th>
                <td>{row?.enabled ? <><label><span>Rate · {service.label}</span><input type="number" min="0.01" step="0.01" value={row.amount} disabled={busy || !canEdit || row.rateBlocked || row.receipt.startsWith('Needs retry:')} onChange={(event) => changeRow(row.key, { amount: event.target.value })} placeholder="Not configured" /></label><label><span>Unit · {service.label}</span><select value={row.unit} disabled={busy || !canEdit || row.rateBlocked || row.receipt.startsWith('Needs retry:')} onChange={(event) => changeRow(row.key, { unit: event.target.value })}>{['per_visit', 'hourly', 'callout', 'flat', 'daily', 'per_notice'].map((unit) => <option key={unit} value={unit}>{unit.replaceAll('_', ' ')}</option>)}</select></label><small>{row.rateBlocked ? 'Multiple or qualified site rates exist. Review in Finance; this matrix will not overwrite them.' : 'Exact client + location + service billing rule. Shared or qualified rates remain in Finance.'}</small></> : '—'}</td>
                <td>{row?.enabled ? <fieldset disabled={busy || !canEdit}><legend className="client-setup-sr">{service.label} schedule</legend>{row.module === 'patrol' && <label><span>Attendance mode</span><select aria-label={`Attendance mode · ${service.label}`} value={row.form.attendanceMode} onChange={(event) => changeRow(row.key, { form: { ...row.form, attendanceMode: event.target.value as ScheduleForm['attendanceMode'] } })}><option value="scheduled" disabled={row.workModel === 'as_attended_patrol'}>Scheduled visits</option><option value="as_attended">As attended</option></select></label>}{row.module === 'patrol' && row.form.attendanceMode === 'as_attended' ? <><label><span>Patrol route</span><select aria-label={`Patrol route · ${service.label}`} value={row.form.patrolRouteId} disabled={patrolRoutesLoading || Boolean(patrolRoutesError)} onChange={(event) => changeRow(row.key, { form: { ...row.form, patrolRouteId: event.target.value } })}><option value="">{patrolRoutesLoading ? 'Loading patrols…' : patrolRoutesError ? 'Patrols unavailable' : 'Choose a patrol'}</option>{patrolRoutes.map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}</select></label>{patrolRoutesError && <p role="alert">Patrols could not be loaded: {patrolRoutesError}</p>}<p>As-attended patrols have no fixed time window or planned visit count.</p></> : <><div className="client-setup-days" role="group" aria-label={`${service.label} days`}>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, dayIndex) => <label key={day}><input type="checkbox" checked={row.form.days.includes(dayIndex + 1)} onChange={() => changeRow(row.key, { form: { ...row.form, days: row.form.days.includes(dayIndex + 1) ? row.form.days.filter((item) => item !== dayIndex + 1) : [...row.form.days, dayIndex + 1].sort() } })} />{day}</label>)}</div><label className="client-setup-check"><input type="checkbox" checked={row.form.anyTime} onChange={(event) => changeRow(row.key, { form: { ...row.form, anyTime: event.target.checked } })} />Any time of day (24-hour)</label>{!row.form.anyTime && <div className="client-setup-two">{(['start', 'end'] as const).map((field) => <label key={field}><span>{field === 'start' ? 'From' : 'To'} · {service.label}</span><input type="time" value={row.form[field]} onChange={(event) => changeRow(row.key, { form: { ...row.form, [field]: event.target.value } })} /></label>)}</div>}<div className="client-setup-three">{([{ key: 'visits', label: 'Visits each shift', min: 1, max: 24 }, { key: 'gap', label: 'Gap minutes', min: 0, max: 720 }, { key: 'stay', label: 'Dwell minutes', min: 0, max: 480 }] as const).map((field) => <label key={field.key}><span>{field.label} · {service.label}</span><input type="number" min={field.min} max={field.max} value={row.form[field.key]} onChange={(event) => changeRow(row.key, { form: { ...row.form, [field.key]: event.target.value } })} /></label>)}</div><label><span>Officer instructions · {service.label}</span><textarea rows={2} value={row.form.notes} onChange={(event) => changeRow(row.key, { form: { ...row.form, notes: event.target.value } })} /></label></>}</fieldset> : 'Select service to configure'}</td>
                <td><span>{row?.form.slaMinutes ? `${row.form.slaMinutes} min · recorded schedule target` : 'No location SLA recorded'}</span><small>The direct schedule writer cannot change a location SLA. Use a governed quote/variation in the client workspace.</small>{row && <output aria-label={`${service.label} save receipt`}>{row.receipt || 'Saved schedule'}</output>}</td>
              </tr>);
            })}
          </tbody></table></div>
          <p className="client-setup-hint">Rates match the work’s service type; saving a rule does not create an invoice. Unchecking archives only this location’s schedule. It does not disable the agreement module, remove other locations or deactivate billing rules. Retry incomplete rows before editing them. Maintenance is not offered without an active supported catalog path.</p>
          <div className="client-setup-actions"><button type="button" onClick={() => leave('crm')}>Finance, SLA and contract workspace</button><button type="button" disabled={busy || dirtyCount > 0 || !canEdit} onClick={buildRun}>Build patrol run</button>{workUnitId && <button type="button" onClick={() => onNavigate('roster', { workUnitId, accountId: client?.id })}>Roster the patrol run</button>}<button type="button" onClick={() => leave('roster-targets')}>Roster targets / static posts</button></div>
        </>}
      </section>
    </div>
    <footer className="client-setup-savebar"><div><strong>{dirtyCount ? `${dirtyCount} unsaved service rows` : 'No unsaved service changes'}</strong><small>Sequential governed saves · completed rows stay saved if another fails</small></div><button type="button" className="btn btn-primary" disabled={!canEdit || busy || loading || !dirtyCount} onClick={saveMatrix}>{busy ? 'Working…' : 'Save changes'}</button></footer>
    {drawer && <div className="client-setup-drawer-backdrop"><section ref={drawerRef} className="client-setup-drawer" role="dialog" aria-modal="true" aria-label={drawer === 'bob' ? 'Bob Quick Setup' : `${drawer} details`} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) setDrawer(null); }}><header><h2>{drawer === 'bob' ? 'Bob Quick Setup' : drawer === 'spatial' ? 'Spatial context' : drawer === 'invite' ? 'Client invitation' : drawer === 'location' ? 'Add Location' : 'Client organization'}</h2><button type="button" autoFocus aria-label="Close details" disabled={busy} onClick={() => setDrawer(null)}>Close</button></header>
      {drawer === 'organization' && <form onSubmit={saveClient}><p>The client is own-rooted. The operational agreement links this organization to the provider; “parent” describes this workspace only.</p><label><span>Client name</span><input required disabled={Boolean(client) || busy || !canEdit} value={clientForm.name} onChange={(event) => setClientForm({ ...clientForm, name: event.target.value })} /></label>{matches.length > 0 && <div className="client-setup-matches"><span>Already on the books?</span>{matches.map((match) => <button key={match.id} type="button" onClick={() => { setDrawer(null); navigate(`${location.pathname}?account=${match.id}`, { replace: true }); }}>{match.name}</button>)}</div>}{(!client || !contactSaved) && <><div className="client-setup-two">{(['firstName', 'lastName'] as const).map((key) => <label key={key}><span>Contact {key === 'firstName' ? 'first' : 'last'} name</span><input disabled={busy || !canEdit} value={clientForm[key]} onChange={(event) => setClientForm({ ...clientForm, [key]: event.target.value })} /></label>)}</div>{(['email', 'phone'] as const).map((key) => <label key={key}><span>{key === 'email' ? 'Email' : 'Phone'}</span><input type={key === 'email' ? 'email' : 'tel'} disabled={busy || !canEdit || Boolean(client)} value={clientForm[key]} onChange={(event) => setClientForm({ ...clientForm, [key]: event.target.value })} /></label>)}<button type="submit" disabled={busy || !canEdit}>Save organization and contact</button></>}{client && contactSaved && <><p>{client.contact_email || client.contact_phone || 'No contact details recorded'}</p><button type="button" onClick={() => leave('crm')}>Manage organization and contacts</button></>}</form>}
      {drawer === 'location' && <form onSubmit={savePlace}><p>Creating this location saves immediately. Service changes remain drafts until the workspace save bar is used.</p><label><span>Place name</span><input required disabled={busy || !canEdit} value={placeForm.name} onChange={(event) => setPlaceForm({ ...placeForm, name: event.target.value })} /></label><label><span>What kind of place</span><select disabled={busy || !canEdit} value={placeForm.type} onChange={(event) => setPlaceForm({ ...placeForm, type: event.target.value })}>{PLACE_TYPES.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}</select></label><label><span>Address</span><input disabled={busy || !canEdit} value={placeForm.address} onChange={(event) => { setPlaceForm({ ...placeForm, address: event.target.value }); setChosenAddress(null); setCandidates([]); }} /></label><button type="button" disabled={busy || placeForm.address.length < 4} onClick={() => void run(async () => { const found = await resolveAddressCandidates(placeForm.address, 5); setCandidates(found); if (!found.length) throw new Error('No address matched. Try the street number, name and suburb.'); if (found.length === 1) setChosenAddress(found[0]); })}>Find address</button><div role="radiogroup" aria-label="Address matches">{candidates.map((candidate, index) => <label className="client-setup-check" key={`${candidate.label}-${index}`}><input type="radio" name="address" checked={chosenAddress === candidate} onChange={() => setChosenAddress(candidate)} />{candidate.label}</label>)}</div><button type="submit" disabled={busy || !canEdit || !chosenAddress}>Create location</button></form>}
      {drawer === 'spatial' && selectedPlace && <><p>Boundary edits use the existing proposal and human-verification path and save separately from service drafts.</p>{selectedPlace.gps_lat != null && selectedPlace.gps_lng != null ? <LocationHouseMap organizationId={client?.id ?? ''} house={{ name: selectedPlace.name, address: selectedPlace.address }} sites={[{ ...selectedPlace, boundary_status: 'provisional' }]} zones={[]} editableEntity={canEdit ? { type: 'client_site', id: selectedPlace.id, organizationId: client?.id ?? '', centerLat: selectedPlace.gps_lat, centerLng: selectedPlace.gps_lng, onSaved: (verified) => setPlaces((current) => current.map((place) => place.id === selected ? { ...place, boundary_verification: verified ? 'verified' : 'unverified' } : place)) } : undefined} /> : <p>No resolved map pin is recorded. Use the governed location workspace to resolve the address.</p>}</>}
      {drawer === 'invite' && <><p>Optional client portal access. Provider configuration does not wait for portal acceptance.</p><p>{inviteEmail ? `Invitation sent to ${inviteEmail}` : client?.contact_email ?? 'No primary email recorded'}</p><button type="button" disabled={!client || !canEdit || busy || Boolean(inviteEmail)} onClick={sendInvite}>Send invitation</button></>}
      {drawer === 'bob' && <><p>Contract extraction must preserve source classification, provenance and human review before any promotion.</p><label><span>Paste contract</span><textarea disabled rows={6} placeholder="Direct contract-to-location auto-fill is not available on this governed path." /></label><button type="button" disabled>Propose location drafts</button><p role="note">The existing Document Studio can ingest classified sources and record CRM agreement proposals for human review. No approved bridge currently promotes those proposals into this matrix. Nothing is sent to a model or saved from this panel.</p><button type="button" onClick={() => leave('document-studio')}>Open governed Document Studio</button></>}
    </section></div>}
  </div>;
};
export default ClientSetupPage;
