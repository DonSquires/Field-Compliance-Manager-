/**
 * Set up a new client — five plain steps over the existing spine, nothing invented:
 *   1 Who is the client?      organizations + crm_contacts     (manage_crm_organization, manage_crm_contact)
 *   2 Where do we work?       client_sites                      (create_crm_site, LINZ address candidates)
 *   3 What do we do there?    service_agreements + modules + delivery schedules + patrol configs
 *                             (ensure_crm_client_agreement, manage_crm_agreement_delivery_schedule, manage_crm_agreement_setup)
 *   4 Who logs in for them?   invitation                        (prepare_crm_client_invitation, invite-org) — optional
 *   5 Done                    patrol run + work unit, and the next thing to do (roster it).
 * Resumable: ?account=<id> reopens a client that is part-way through.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Building2, CheckCircle2, ClipboardList, MapPin, Search, Send, Shield, UserRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { LocationHouseMap } from '../components/LocationHouseMap';
import { resolveAddressCandidates, type AddressCandidate } from '../lib/locationAddress';
import { contractedDaysWords, contractedHoursWords } from '../lib/rosterWords';
import { supabase } from '../lib/supabase';
import type { NavigateWithContext } from '../lib/workflowNavigation';
import './ClientSetupPage.css';

type Step = 1 | 2 | 3 | 4 | 5;
interface ClientRecord { id: string; name: string; contact_email: string | null; contact_phone: string | null; status: string | null }
interface PlaceRecord { id: string; name: string; address: string | null; site_type: string | null }
interface ResumePlace extends PlaceRecord { gps_lat: number | null; gps_lng: number | null; boundary: GeoJSON.Geometry | null; boundary_verification: string }
interface SavedService { schedule_id: string | null; place_id: string; module_key: string; words: string }
interface ExistingMatch { id: string; name: string; status: string | null }

/** The services a provider can be contracted for, in the words a branch manager uses. Keys are module_catalog keys. */
export const SERVICE_CHOICES: Array<{ key: string; label: string; help: string; kind: 'visits' | 'post' | 'response' }> = [
  { key: 'patrol', label: 'Patrol visits', help: 'An officer visits, checks the place, and moves on.', kind: 'visits' },
  { key: 'static_guarding', label: 'Guard on post', help: 'An officer stays at the place for the whole shift.', kind: 'post' },
  { key: 'dispatch', label: 'Alarm response', help: 'We attend when an alarm or a call comes in.', kind: 'response' },
  { key: 'parking_enforcement', label: 'Parking enforcement', help: 'Officers check vehicles and issue notices.', kind: 'visits' },
  { key: 'noise_control', label: 'Noise control', help: 'Officers assess noise complaints on site.', kind: 'visits' },
  { key: 'freedom_camping', label: 'Freedom camping', help: 'Officers patrol camping areas and record breaches.', kind: 'visits' },
  { key: 'biosecurity', label: 'Biosecurity checks', help: 'Officers inspect for pests and breaches.', kind: 'visits' },
  { key: 'smoke_complaints', label: 'Smoke complaints', help: 'Officers assess smoke nuisance reports.', kind: 'visits' },
  { key: 'access_control', label: 'Access control', help: 'Officers open, close and control entry to the place.', kind: 'visits' },
];
export const PLACE_TYPES: Array<{ key: string; label: string }> = [
  { key: 'commercial_premises', label: 'Shop, office or premises' },
  { key: 'car_park', label: 'Car park' },
  { key: 'reserve', label: 'Park or reserve' },
  { key: 'street', label: 'Street or public area' },
  { key: 'residential', label: 'Home or residential block' },
  { key: 'industrial', label: 'Yard or industrial site' },
];
/** How each address-candidate `kind` reads next to its label, so a person can tell two similarly-named results apart. */
const KIND_LABEL: Record<string, string> = { address: 'Address', business: 'Business or place', reserve: 'Council reserve (boundary known)' };
const DAY_PRESETS: Array<{ key: string; label: string; days: number[] }> = [
  { key: 'every', label: 'Every day', days: [1, 2, 3, 4, 5, 6, 7] },
  { key: 'weekdays', label: 'Weekdays', days: [1, 2, 3, 4, 5] },
  { key: 'weekends', label: 'Weekends', days: [6, 7] },
  { key: 'pick', label: 'Pick days', days: [] },
];
const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface ScheduleForm { preset: string; days: number[]; anyTime: boolean; start: string; end: string; visits: string; gap: string; stay: string; slaMinutes: string; notes: string }
const defaultSchedule = (): ScheduleForm => ({ preset: 'every', days: [1, 2, 3, 4, 5, 6, 7], anyTime: true, start: '', end: '', visits: '1', gap: '60', stay: '10', slaMinutes: '30', notes: '' });

/** One sentence a manager can read back to the client: 'Patrol visits · every day · any time of day (24-hour) · 2 visits a shift, 10 min each'. */
export const serviceWords = (label: string, kind: 'visits' | 'post' | 'response', form: Pick<ScheduleForm, 'days' | 'anyTime' | 'start' | 'end' | 'visits' | 'stay' | 'slaMinutes'>): string => {
  if (kind === 'post') return `${label} · a guard stays for the shift`;
  if (kind === 'response') return `${label} · on scene within ${form.slaMinutes || '30'} min of the call`;
  const visits = Number(form.visits) || 1;
  return `${label} · ${contractedDaysWords(form.days)} · ${form.anyTime ? contractedHoursWords(null, null) : contractedHoursWords(form.start, form.end)} · ${visits} visit${visits === 1 ? '' : 's'} a shift, ${form.stay || '10'} min each`;
};

const ClientSetupPage: React.FC<{ onNavigate?: NavigateWithContext }> = ({ onNavigate = () => undefined }) => {
  const { profile, operatingOrganizationId } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const branchId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Step 1
  const [client, setClient] = useState<ClientRecord | null>(null);
  const [clientForm, setClientForm] = useState({ name: '', firstName: '', lastName: '', email: '', phone: '' });
  const [matches, setMatches] = useState<ExistingMatch[]>([]);
  const [contactSaved, setContactSaved] = useState(false);
  const clientRequest = useRef(crypto.randomUUID());
  const contactRequest = useRef(crypto.randomUUID());
  // Step 2
  const [places, setPlaces] = useState<PlaceRecord[]>([]);
  const [placeForm, setPlaceForm] = useState({ name: '', address: '', type: 'commercial_premises' });
  const [addressCandidates, setAddressCandidates] = useState<AddressCandidate[]>([]);
  const [chosenAddress, setChosenAddress] = useState<AddressCandidate | null>(null);
  const [justAddedPlace, setJustAddedPlace] = useState<{ id: string; name: string; address: string | null; lat: number; lng: number; boundary: GeoJSON.Geometry | null; boundaryVerification: string; boundaryLabel: string | null } | null>(null);
  const placeRequest = useRef(crypto.randomUUID());
  // Step 3
  const [agreementId, setAgreementId] = useState<string | null>(null);
  const [servicePlaceId, setServicePlaceId] = useState<string>('');
  const [serviceKey, setServiceKey] = useState<string>('patrol');
  const [scheduleForm, setScheduleForm] = useState<ScheduleForm>(defaultSchedule());
  const [services, setServices] = useState<SavedService[]>([]);
  const serviceRequest = useRef(crypto.randomUUID());
  // Step 4
  const [inviteState, setInviteState] = useState<'not_sent' | 'sent' | 'skipped'>('not_sent');
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  // Step 5
  const [runResult, setRunResult] = useState<{ routeId: string | null; workUnitId: string | null; words: string } | null>(null);

  const chosenService = useMemo(() => SERVICE_CHOICES.find((choice) => choice.key === serviceKey) ?? SERVICE_CHOICES[0], [serviceKey]);
  const servicePlace = useMemo(() => places.find((place) => place.id === servicePlaceId) ?? places[0] ?? null, [places, servicePlaceId]);

  const run = async (label: string, work: () => Promise<string | void>) => {
    setBusy(label); setError(null); setNotice(null);
    try { const message = await work(); if (message) setNotice(message); }
    catch (failure) { setError(failure instanceof Error ? failure.message : (failure as { message?: string })?.message ?? 'That did not save. Nothing was changed.'); }
    finally { setBusy(null); }
  };

  // Resume a client that is part-way through (?account=<id>).
  const loadClient = useCallback(async (accountId: string) => {
    const { data: org } = await supabase.from('organizations').select('id, name, contact_email, contact_phone, status').eq('id', accountId).maybeSingle();
    if (!org) return;
    setClient(org as ClientRecord);
    setClientForm((form) => ({ ...form, name: org.name, email: org.contact_email ?? '', phone: org.contact_phone ?? '' }));
    const { data: contacts } = await supabase.from('crm_contacts').select('id').eq('organization_id', accountId).eq('is_primary', true).is('deactivated_at', null).limit(1);
    setContactSaved(Boolean(contacts?.length));
    const { data: sites } = await supabase.from('client_sites').select('id, name, address, site_type, gps_lat, gps_lng, boundary, boundary_verification').eq('client_organization_id', accountId).eq('active', true).order('created_at');
    const savedPlaces = (sites as ResumePlace[] | null) ?? [];
    setPlaces(savedPlaces);
    const unresolved = savedPlaces.find((site) => site.boundary_verification !== 'verified');
    if (unresolved && unresolved.gps_lat != null && unresolved.gps_lng != null) {
      setJustAddedPlace({ id: unresolved.id, name: unresolved.name, address: unresolved.address, lat: unresolved.gps_lat, lng: unresolved.gps_lng, boundary: unresolved.boundary, boundaryVerification: unresolved.boundary_verification, boundaryLabel: null });
    }
    setStep(unresolved ? 2 : savedPlaces.length ? 3 : 2);
  }, []);

  useEffect(() => {
    const accountId = new URLSearchParams(location.search).get('account');
    if (accountId && !client) void loadClient(accountId);
  }, [location.search, client, loadClient]);

  // Duplicate check as the name is typed: a client that already exists should be opened, not created twice.
  useEffect(() => {
    const name = clientForm.name.trim();
    if (client || name.length < 3) { setMatches([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const { data } = await supabase.from('organizations').select('id, name, status').ilike('name', `%${name}%`).limit(5);
      if (!cancelled) setMatches(((data as ExistingMatch[]) ?? []).filter((row) => row.id !== branchId));
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [clientForm.name, client, branchId]);

  const saveClient = (event: React.FormEvent) => {
    event.preventDefault();
    void run('client', async () => {
      const name = clientForm.name.trim();
      if (!name) throw new Error('Give the client a name.');
      if (!clientForm.email.trim() && !clientForm.phone.trim()) throw new Error('Add an email or a phone number so we can reach them.');
      let record = client;
      if (!record) {
        // ATLAS WRITES: organizations via manage_crm_organization (create, prospect)
        const { data, error: saveError } = await supabase.rpc('manage_crm_organization', {
          p_client_request_id: clientRequest.current, p_organization_id: null, p_expected_updated_at: null, p_action: 'create',
          p_name: name, p_organization_type: 'client', p_nzbn: null, p_company_registration_number: null,
          p_contact_email: clientForm.email.trim() || null, p_contact_phone: clientForm.phone.trim() || null,
          p_billing_email: null, p_billing_address: null, p_account_notes: null, p_status: null,
        });
        if (saveError || !data) throw saveError ?? new Error('The client was not saved.');
        record = data as ClientRecord;
        setClient(record);
      }
      if (!contactSaved && (clientForm.firstName.trim() || clientForm.lastName.trim() || clientForm.email.trim())) {
        // ATLAS WRITES: crm_contacts via manage_crm_contact (primary contact — the person we deal with and may invite)
        const { error: contactError } = await supabase.rpc('manage_crm_contact', {
          p_client_request_id: contactRequest.current, p_contact_id: null, p_account_organization_id: record.id, p_expected_updated_at: null, p_action: 'create',
          p_first_name: clientForm.firstName.trim() || name, p_last_name: clientForm.lastName.trim() || '', p_role_title: null,
          p_email: clientForm.email.trim() || null, p_phone: clientForm.phone.trim() || null, p_mobile: null, p_is_primary: true, p_is_emergency: false, p_notes: null,
        });
        if (contactError) throw contactError;
        setContactSaved(true);
      }
      setPlaceForm((form) => ({ ...form, name: form.name || name }));
      navigate(`${location.pathname}?account=${record.id}`, { replace: true });
      setStep(2);
      return `${record.name} saved. Now add the places we work at.`;
    });
  };

  const findAddress = () => run('address', async () => {
    const candidates = await resolveAddressCandidates(placeForm.address, 5);
    if (!candidates.length) throw new Error('No address matched. Try the street number and name, or the suburb.');
    setAddressCandidates(candidates);
    if (candidates.length === 1) setChosenAddress(candidates[0]);
  });

  const savePlace = (event: React.FormEvent) => {
    event.preventDefault();
    void run('place', async () => {
      if (!client) throw new Error('Save the client first.');
      if (!placeForm.name.trim()) throw new Error('Give the place a name (for example "Main store" or "Depot").');
      if (!chosenAddress) throw new Error('Find and choose the address so the place has a pin on the map.');
      // ATLAS WRITES: client_sites via create_crm_site (unverified boundary until a person checks it on the map)
      const { data, error: saveError } = await supabase.rpc('create_crm_site', {
        p_client_request_id: placeRequest.current, p_account_organization_id: client.id, p_name: placeForm.name.trim(), p_address: chosenAddress.label,
        p_site_type: placeForm.type, p_center_lat: chosenAddress.lat, p_center_lng: chosenAddress.lng, p_location_id: null,
      });
      if (saveError || !data) throw saveError ?? new Error('The place was not saved.');
      const row = (Array.isArray(data) ? data[0] : data) as { id: string; name: string; address: string | null; site_type: string | null } | undefined;
      if (!row?.id) throw new Error('The place was saved but could not be read back. Refresh and it will appear.');
      setPlaces((current) => [...current, { id: row.id, name: row.name, address: row.address, site_type: row.site_type }]);
      setJustAddedPlace({ id: row.id, name: row.name, address: row.address, lat: chosenAddress.lat, lng: chosenAddress.lng, boundary: chosenAddress.boundary ?? null, boundaryVerification: 'unverified', boundaryLabel: chosenAddress.boundary ? chosenAddress.label : null });
      placeRequest.current = crypto.randomUUID();
      setPlaceForm({ name: '', address: '', type: placeForm.type }); setAddressCandidates([]); setChosenAddress(null);
      return `${row.name} added at ${row.address ?? 'the chosen address'}.`;
    });
  };

  const ensureAgreement = async (): Promise<string> => {
    if (agreementId) return agreementId;
    if (!client) throw new Error('Save the client first.');
    // ATLAS WRITES: service_agreements via ensure_crm_client_agreement (the branch's live agreement with this client)
    const { data, error: agreementError } = await supabase.rpc('ensure_crm_client_agreement', { p_account_organization_id: client.id, p_provider_organization_id: branchId });
    if (agreementError || !data) throw agreementError ?? new Error('The service agreement could not be opened.');
    const id = (data as { agreement_id: string }).agreement_id;
    setAgreementId(id);
    return id;
  };

  const saveService = (event: React.FormEvent) => {
    event.preventDefault();
    void run('service', async () => {
      if (!servicePlace) throw new Error('Add a place first.');
      const id = await ensureAgreement();
      const words = serviceWords(chosenService.label, chosenService.kind, scheduleForm);
      if (chosenService.kind === 'post') {
        // ATLAS WRITES: service_agreement_locations + service_agreement_modules via manage_crm_agreement_setup
        const status = (await supabase.from('service_agreements').select('invitation_status').eq('id', id).single()).data?.invitation_status ?? 'not_invited';
        const link = await supabase.rpc('manage_crm_agreement_setup', { p_agreement_id: id, p_expected_invitation_status: status, p_action: 'link_site', p_site_id: servicePlace.id });
        if (link.error && !/already/i.test(link.error.message)) throw link.error;
        const module = await supabase.rpc('manage_crm_agreement_setup', { p_agreement_id: id, p_expected_invitation_status: status, p_action: 'set_module', p_module_key: 'static_guarding', p_enabled: true });
        if (module.error) throw module.error;
        setServices((current) => [...current, { schedule_id: null, place_id: servicePlace.id, module_key: 'static_guarding', words }]);
      } else {
        if (chosenService.kind === 'visits' && !scheduleForm.anyTime && (!scheduleForm.start || !scheduleForm.end)) throw new Error('Set both times, or choose any time of day.');
        if (scheduleForm.preset === 'pick' && scheduleForm.days.length === 0) throw new Error('Pick at least one day.');
        // ATLAS WRITES: service_agreement_delivery_schedules + client_site_patrol_config via manage_crm_agreement_delivery_schedule
        const { data, error: scheduleError } = await supabase.rpc('manage_crm_agreement_delivery_schedule', {
          p_client_request_id: serviceRequest.current, p_agreement_id: id, p_action: 'create', p_schedule_id: null,
          p_site_id: servicePlace.id, p_zone_id: null, p_module_key: chosenService.key,
          p_active_days: scheduleForm.days, p_window_start: scheduleForm.anyTime ? null : scheduleForm.start, p_window_end: scheduleForm.anyTime ? null : scheduleForm.end,
          p_visits_per_shift: chosenService.kind === 'response' ? 1 : Math.max(1, Number(scheduleForm.visits) || 1),
          p_min_gap_between_visits_minutes: Math.max(0, Number(scheduleForm.gap) || 0), p_dwell_minutes: Math.max(0, Number(scheduleForm.stay) || 0),
          p_officer_instructions: scheduleForm.notes.trim() || null, p_operating_organization_id: branchId,
        });
        if (scheduleError || !data) throw scheduleError ?? new Error('The service was not saved.');
        if (chosenService.kind === 'response') {
          const status = (await supabase.from('service_agreements').select('invitation_status').eq('id', id).single()).data?.invitation_status ?? 'not_invited';
          const sla = await supabase.rpc('manage_crm_agreement_setup', { p_agreement_id: id, p_expected_invitation_status: status, p_action: 'set_module', p_module_key: 'dispatch', p_enabled: true, p_sla_minutes: Math.max(1, Number(scheduleForm.slaMinutes) || 30) });
          if (sla.error) throw sla.error;
        }
        setServices((current) => [...current, { schedule_id: (data as { schedule_id: string }).schedule_id, place_id: servicePlace.id, module_key: chosenService.key, words }]);
      }
      serviceRequest.current = crypto.randomUUID();
      setScheduleForm(defaultSchedule());
      return `Saved: ${words} at ${servicePlace.name}.`;
    });
  };

  const sendInvite = () => run('invite', async () => {
    if (!client) return;
    // ATLAS WRITES: prepare_crm_client_invitation then invite-org (seats the client's administrator; acceptance ticks when they set a password)
    const { data, error: prepareError } = await supabase.rpc('prepare_crm_client_invitation', { p_account_organization_id: client.id });
    if (prepareError || !data) throw prepareError ?? new Error('The invitation could not be prepared.');
    const prepared = data as { email: string; display_name?: string };
    const { error: inviteError } = await supabase.functions.invoke('invite-org', { body: { target_organization_id: client.id, email: prepared.email, display_name: prepared.display_name?.trim() || client.name } });
    if (inviteError) throw inviteError;
    setInviteEmail(prepared.email); setInviteState('sent');
    return `Invitation sent to ${prepared.email}. When they set a password they can see their places, visits and reports.`;
  });

  const finish = () => run('finish', async () => {
    if (!client) return;
    const id = await ensureAgreement();
    const visitServices = services.filter((service) => SERVICE_CHOICES.find((choice) => choice.key === service.module_key)?.kind === 'visits');
    let routeId: string | null = null; let workUnitId: string | null = null; let words = '';
    if (visitServices.length) {
      // ATLAS WRITES: patrol_routes + roster_work_units via create_patrol_route_from_agreement / create_operating_roster_work_unit
      const route = await supabase.rpc('create_patrol_route_from_agreement', { p_client_request_id: crypto.randomUUID(), p_service_agreement_id: id, p_name: `${client.name} patrol run`, p_operating_organization_id: branchId });
      if (route.error) throw route.error;
      const built = (Array.isArray(route.data) ? route.data[0] : route.data) as { route_id: string; attached_places: number } | null;
      routeId = built?.route_id ?? null;
      if (routeId) {
        const unit = await supabase.rpc('create_operating_roster_work_unit', { p_operating_organization_id: branchId, p_name: `${client.name} patrol run`, p_work_unit_type: 'patrol', p_service_type: 'patrol', p_patrol_route_id: routeId, p_service_agreement_location_id: null, p_service_agreement_module_id: null });
        if (unit.error && !/already|exists/i.test(unit.error.message)) throw unit.error;
        workUnitId = (unit.data as { id?: string } | null)?.id ?? null;
        words = `The patrol run is built with ${built?.attached_places ?? 0} place${built?.attached_places === 1 ? '' : 's'} and is ready to roster.`;
      }
    } else {
      words = services.some((service) => service.module_key === 'static_guarding') ? 'Guard-on-post work is ready to roster as a static post.' : 'Alarm response is set; jobs will appear on the dispatch console when they come in.';
    }
    setRunResult({ routeId, workUnitId, words });
    setStep(5);
  });

  const steps: Array<{ n: Step; label: string }> = [{ n: 1, label: 'Who' }, { n: 2, label: 'Where' }, { n: 3, label: 'What we do' }, { n: 4, label: 'Who logs in' }, { n: 5, label: 'Done' }];

  return <div className="client-setup">
    <header className="client-setup-head">
      <div><span>Clients</span><h1>Set up a new client</h1><p>Five short steps. Each one saves as you go, so you can stop and come back.</p></div>
      <button type="button" className="client-setup-link" onClick={() => onNavigate('onboarding')}>See all clients being set up</button>
    </header>
    <ol className="client-setup-rail" aria-label="Setup steps">
      {steps.map((item) => <li key={item.n} className={item.n === step ? 'is-current' : item.n < step ? 'is-done' : ''} aria-current={item.n === step ? 'step' : undefined}><span>{item.n < step ? <CheckCircle2 size={14} aria-hidden="true" /> : item.n}</span>{item.label}</li>)}
    </ol>
    {error && <div className="client-setup-message is-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
    {notice && <div className="client-setup-message is-ok" role="status"><CheckCircle2 size={16} /><span>{notice}</span></div>}

    {step === 1 && <form className="client-setup-card" onSubmit={saveClient} aria-labelledby="step-who">
      <div className="client-setup-card-head"><UserRound size={20} aria-hidden="true" /><div><h2 id="step-who">Who is the client?</h2><p>The business, council or person you are working for, and the person you deal with there.</p></div></div>
      <label><span>Client name</span><input value={clientForm.name} onChange={(event) => setClientForm({ ...clientForm, name: event.target.value })} placeholder="e.g. Trafalgar Street Dairy Ltd" required disabled={Boolean(client)} /></label>
      {matches.length > 0 && !client && <div className="client-setup-matches" role="status"><Search size={14} aria-hidden="true" /><span>Already on the books?</span>{matches.map((match) => <button type="button" key={match.id} onClick={() => { navigate(`${location.pathname}?account=${match.id}`, { replace: true }); void loadClient(match.id); }}>{match.name}{match.status ? ` · ${match.status}` : ''}</button>)}</div>}
      <div className="client-setup-two">
        <label><span>Contact first name</span><input value={clientForm.firstName} onChange={(event) => setClientForm({ ...clientForm, firstName: event.target.value })} placeholder="Jamie" /></label>
        <label><span>Contact last name</span><input value={clientForm.lastName} onChange={(event) => setClientForm({ ...clientForm, lastName: event.target.value })} placeholder="Rangi" /></label>
      </div>
      <div className="client-setup-two">
        <label><span>Email</span><input type="email" value={clientForm.email} onChange={(event) => setClientForm({ ...clientForm, email: event.target.value })} placeholder="jamie@example.co.nz" /></label>
        <label><span>Phone</span><input value={clientForm.phone} onChange={(event) => setClientForm({ ...clientForm, phone: event.target.value })} placeholder="03 555 0100" /></label>
      </div>
      <p className="client-setup-hint">The email is who we invite to the client portal in step 4. You can skip that step.</p>
      <footer><button type="submit" className="btn btn-primary" disabled={busy !== null}>{busy === 'client' ? 'Saving…' : client ? 'Continue' : 'Save client and continue'} <ArrowRight size={15} aria-hidden="true" /></button></footer>
    </form>}

    {step === 2 && <section className="client-setup-card" aria-labelledby="step-where">
      <div className="client-setup-card-head"><MapPin size={20} aria-hidden="true" /><div><h2 id="step-where">Where do we work for {client?.name ?? 'them'}?</h2><p>Add each place — a shop, a car park, a reserve. Type the address and pick the match so it gets a pin on the map.</p></div></div>
      {places.length > 0 && <ul className="client-setup-list">{places.map((place) => <li key={place.id}><strong>{place.name}</strong><span>{place.address ?? 'No address'} · {PLACE_TYPES.find((type) => type.key === place.site_type)?.label ?? place.site_type ?? 'Place'}</span><em>Saved</em></li>)}</ul>}
      <form onSubmit={savePlace} className="client-setup-subform">
        <div className="client-setup-two">
          <label><span>Place name</span><input value={placeForm.name} onChange={(event) => setPlaceForm({ ...placeForm, name: event.target.value })} placeholder="e.g. Main store" required /></label>
          <label><span>What kind of place</span><select value={placeForm.type} onChange={(event) => setPlaceForm({ ...placeForm, type: event.target.value })}>{PLACE_TYPES.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}</select></label>
        </div>
        <label><span>Address</span><div className="client-setup-address"><input value={placeForm.address} onChange={(event) => { setPlaceForm({ ...placeForm, address: event.target.value }); setChosenAddress(null); }} placeholder="12 Trafalgar Street, Nelson" /><button type="button" onClick={findAddress} disabled={busy !== null || placeForm.address.trim().length < 4}>{busy === 'address' ? 'Finding…' : 'Find address'}</button></div></label>
        {addressCandidates.length > 0 && <div className="client-setup-candidates" role="radiogroup" aria-label="Address matches">{addressCandidates.map((candidate, index) => <label key={`${candidate.label}-${index}`} className={chosenAddress?.label === candidate.label ? 'is-chosen' : ''}><input type="radio" name="address" checked={chosenAddress?.label === candidate.label} onChange={() => setChosenAddress(candidate)} />{candidate.label}{candidate.kind && <em> · {KIND_LABEL[candidate.kind] ?? candidate.kind}</em>}</label>)}</div>}
        <footer>
          <button type="submit" className="btn btn-secondary" disabled={busy !== null}>{busy === 'place' ? 'Saving…' : places.length ? 'Add another place' : 'Add this place'}</button>
          <button type="button" className="btn btn-primary" disabled={places.length === 0 || busy !== null} onClick={() => { setServicePlaceId(places[0]?.id ?? ''); setStep(3); }}>Continue <ArrowRight size={15} aria-hidden="true" /></button>
        </footer>
      </form>
      {justAddedPlace && <LocationHouseMap organizationId={client?.id ?? ''} house={{ name: justAddedPlace.name, address: justAddedPlace.address }} sites={[{ id: justAddedPlace.id, name: justAddedPlace.name, gps_lat: justAddedPlace.lat, gps_lng: justAddedPlace.lng, boundary: justAddedPlace.boundaryLabel ? null : justAddedPlace.boundary, boundary_status: 'provisional', boundary_verification: justAddedPlace.boundaryVerification }]} zones={[]} editableEntity={{ type: 'client_site', id: justAddedPlace.id, organizationId: client?.id ?? '', centerLat: justAddedPlace.lat, centerLng: justAddedPlace.lng, onSaved: (verified) => setJustAddedPlace((place) => place ? { ...place, boundaryVerification: verified ? 'verified' : 'unverified' } : place) }} seedBoundary={justAddedPlace.boundaryLabel && justAddedPlace.boundary ? { geometry: justAddedPlace.boundary, kind: 'reserve', label: justAddedPlace.boundaryLabel, lat: justAddedPlace.lat, lng: justAddedPlace.lng } : null} />}
      <p className="client-setup-hint">Officers can be rostered before the boundary is confirmed; arrivals are recorded as unverified until it is done.</p>
    </section>}

    {step === 3 && <section className="client-setup-card" aria-labelledby="step-what">
      <div className="client-setup-card-head"><Shield size={20} aria-hidden="true" /><div><h2 id="step-what">What do we do there?</h2><p>Pick a service, say when, and save. Add as many as the client has asked for.</p></div></div>
      {services.length > 0 && <ul className="client-setup-list">{services.map((service, index) => <li key={`${service.module_key}-${index}`}><strong>{places.find((place) => place.id === service.place_id)?.name ?? 'Place'}</strong><span>{service.words}</span><em>Saved</em></li>)}</ul>}
      <form onSubmit={saveService} className="client-setup-subform">
        <div className="client-setup-two">
          <label><span>At which place</span><select value={servicePlace?.id ?? ''} onChange={(event) => setServicePlaceId(event.target.value)}>{places.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}</select></label>
          <label><span>Service</span><select value={serviceKey} onChange={(event) => setServiceKey(event.target.value)}>{SERVICE_CHOICES.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</select></label>
        </div>
        <p className="client-setup-help">{chosenService.help}</p>
        {chosenService.kind === 'visits' && <>
          <fieldset className="client-setup-days"><legend>Which days</legend>
            <div className="client-setup-chips" role="radiogroup" aria-label="Which days">{DAY_PRESETS.map((preset) => <label key={preset.key} className={scheduleForm.preset === preset.key ? 'is-chosen' : ''}><input type="radio" name="days" checked={scheduleForm.preset === preset.key} onChange={() => setScheduleForm({ ...scheduleForm, preset: preset.key, days: preset.key === 'pick' ? scheduleForm.days : preset.days })} />{preset.label}</label>)}</div>
            {scheduleForm.preset === 'pick' && <div className="client-setup-chips" role="group" aria-label="Days of the week">{[1, 2, 3, 4, 5, 6, 7].map((day) => <label key={day} className={scheduleForm.days.includes(day) ? 'is-chosen' : ''}><input type="checkbox" checked={scheduleForm.days.includes(day)} onChange={() => setScheduleForm({ ...scheduleForm, days: scheduleForm.days.includes(day) ? scheduleForm.days.filter((item) => item !== day) : [...scheduleForm.days, day].sort() })} />{DAY_SHORT[day]}</label>)}</div>}
          </fieldset>
          <fieldset className="client-setup-days"><legend>What hours</legend>
            <div className="client-setup-chips" role="radiogroup" aria-label="What hours"><label className={scheduleForm.anyTime ? 'is-chosen' : ''}><input type="radio" name="hours" checked={scheduleForm.anyTime} onChange={() => setScheduleForm({ ...scheduleForm, anyTime: true })} />Any time of day (24-hour)</label><label className={!scheduleForm.anyTime ? 'is-chosen' : ''}><input type="radio" name="hours" checked={!scheduleForm.anyTime} onChange={() => setScheduleForm({ ...scheduleForm, anyTime: false })} />Between set hours</label></div>
            {!scheduleForm.anyTime && <div className="client-setup-two"><label><span>From</span><input type="time" value={scheduleForm.start} onChange={(event) => setScheduleForm({ ...scheduleForm, start: event.target.value })} /></label><label><span>To</span><input type="time" value={scheduleForm.end} onChange={(event) => setScheduleForm({ ...scheduleForm, end: event.target.value })} /></label></div>}
          </fieldset>
          <div className="client-setup-three">
            <label><span>Visits each shift</span><input type="number" min="1" max="24" value={scheduleForm.visits} onChange={(event) => setScheduleForm({ ...scheduleForm, visits: event.target.value })} /></label>
            <label><span>At least (min) apart</span><input type="number" min="0" max="720" value={scheduleForm.gap} onChange={(event) => setScheduleForm({ ...scheduleForm, gap: event.target.value })} /></label>
            <label><span>Stay (min) each visit</span><input type="number" min="0" max="480" value={scheduleForm.stay} onChange={(event) => setScheduleForm({ ...scheduleForm, stay: event.target.value })} /></label>
          </div>
          <label><span>What the officer should do there (optional)</span><input value={scheduleForm.notes} onChange={(event) => setScheduleForm({ ...scheduleForm, notes: event.target.value })} placeholder="e.g. Check the back roller door and the fuel cage" /></label>
        </>}
        {chosenService.kind === 'response' && <label><span>Be on scene within (minutes)</span><input type="number" min="1" max="1440" value={scheduleForm.slaMinutes} onChange={(event) => setScheduleForm({ ...scheduleForm, slaMinutes: event.target.value })} /></label>}
        <p className="client-setup-readback"><ClipboardList size={14} aria-hidden="true" /> {serviceWords(chosenService.label, chosenService.kind, scheduleForm)}</p>
        <footer>
          <button type="submit" className="btn btn-secondary" disabled={busy !== null || !servicePlace}>{busy === 'service' ? 'Saving…' : 'Save this service'}</button>
          <button type="button" className="btn btn-primary" disabled={services.length === 0 || busy !== null} onClick={() => setStep(4)}>Continue <ArrowRight size={15} aria-hidden="true" /></button>
        </footer>
      </form>
    </section>}

    {step === 4 && <section className="client-setup-card" aria-labelledby="step-login">
      <div className="client-setup-card-head"><Send size={20} aria-hidden="true" /><div><h2 id="step-login">Who logs in for {client?.name ?? 'the client'}?</h2><p>Invite the contact to the client portal. They will see their places, the visits made, and reports — nothing about your staff.</p></div></div>
      <div className="client-setup-invite"><strong>{clientForm.email.trim() || client?.contact_email || 'No email on file'}</strong><span>{inviteState === 'sent' ? `Invitation sent to ${inviteEmail}.` : 'Sending is optional. You can do it later from the client\u2019s page.'}</span></div>
      <footer>
        {inviteState !== 'sent' && <button type="button" className="btn btn-secondary" onClick={() => { setInviteState('skipped'); setStep(5); void finish(); }} disabled={busy !== null}>Skip for now</button>}
        {inviteState !== 'sent' && <button type="button" className="btn btn-primary" onClick={sendInvite} disabled={busy !== null || !(clientForm.email.trim() || client?.contact_email)}>{busy === 'invite' ? 'Sending…' : 'Send invitation'}</button>}
        {inviteState === 'sent' && <button type="button" className="btn btn-primary" onClick={finish} disabled={busy !== null}>{busy === 'finish' ? 'Finishing…' : 'Finish setup'} <ArrowRight size={15} aria-hidden="true" /></button>}
      </footer>
    </section>}

    {step === 5 && <section className="client-setup-card is-done" aria-labelledby="step-done">
      <div className="client-setup-card-head"><Building2 size={20} aria-hidden="true" /><div><h2 id="step-done">{busy === 'finish' ? `Finishing ${client?.name}…` : `${client?.name} is set up`}</h2><p>{busy === 'finish' ? 'Building the patrol run from the services you saved.' : runResult?.words ?? 'Everything you entered is saved.'}</p></div></div>
      <dl className="client-setup-summary">
        <div><dt>Places</dt><dd>{places.map((place) => place.name).join(', ') || 'None yet'}</dd></div>
        <div><dt>Services</dt><dd>{services.length ? services.map((service) => service.words).join('; ') : 'None yet'}</dd></div>
        <div><dt>Client login</dt><dd>{inviteState === 'sent' ? `Invited: ${inviteEmail}` : 'Not invited yet — you can do this from the client\u2019s page.'}</dd></div>
      </dl>
      <h3>What happens next</h3>
      <div className="client-setup-next">
        {runResult?.workUnitId && <button type="button" className="btn btn-primary" onClick={() => onNavigate('roster', { workUnitId: runResult.workUnitId ?? undefined, accountId: client?.id })}>Roster the patrol run <ArrowRight size={15} aria-hidden="true" /></button>}
        {!runResult?.workUnitId && services.some((service) => service.module_key === 'static_guarding') && <button type="button" className="btn btn-primary" onClick={() => onNavigate('roster', { accountId: client?.id })}>Roster the guard post <ArrowRight size={15} aria-hidden="true" /></button>}
        {places[0] && <button type="button" className="btn btn-secondary" onClick={() => onNavigate('sites', { siteId: places[0].id })}>Check the place on the map</button>}
        <button type="button" className="btn btn-secondary" onClick={() => onNavigate('crm', { accountId: client?.id })}>Open the client's page</button>
      </div>
      <p className="client-setup-hint">Prices and invoicing live on the client's page under Finance. Nothing is billed until a rate or quote is set there.</p>
    </section>}
  </div>;
};

export default ClientSetupPage;
