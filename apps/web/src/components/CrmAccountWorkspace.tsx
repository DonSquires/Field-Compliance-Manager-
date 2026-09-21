import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Building2, CalendarClock, CheckCircle2, FileBarChart, Handshake, Layers3, Mail, MapPin, MessageSquarePlus, Phone, Radio, Route, Star, UserPlus, Users, WalletCards, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { contractedDaysWords, contractedHoursWords } from '../lib/rosterWords';
import type { NavigateWithContext } from '../lib/workflowNavigation';
import { CrmAgreementSetupDialog } from './CrmAgreementSetupDialog';
import { agreementTermState, CrmAgreementTerm } from './CrmAgreementTerm';
import { CrmOnboardingPanel } from './CrmOnboardingPanel';
import { CrmOperationalWorkPanel } from './CrmOperationalWorkPanel';
import { CrmRosterHandoffPanel } from './CrmRosterHandoffPanel';
import { CrmAgreementDeliveryPanel } from './CrmAgreementDeliveryPanel';
import { CrmSiteDialog } from './CrmSiteDialog';
import { OperationalPlaceManager } from './OperationalPlaceManager';
import type { EditableCrmOrganization } from './CrmOrganizationDialog';
import './CrmAccountWorkspace.css';

export interface CrmWorkspaceAccount {
  id: string;
  name: string;
  agreementId?: string | null;
  status?: string;
  primaryContactName?: string | null;
  siteCount?: number;
  readinessBlockers?: string[];
  nextAction?: string;
  latestQuoteStatus?: string | null;
}

interface AgreementRow { id: string; name: string; agreement_type: string; invitation_status: string; provider_organization_id: string; client_organization_id: string; starts_on: string | null; ends_on: string | null; }
interface SiteRow { id: string; name: string; address: string | null; site_type: string | null; active: boolean; location_id: string | null; }
interface ZoneRow { id: string; name: string; zone_type: string; is_active: boolean; location_id: string | null; }
interface LocationRow { id: string; name: string; address: string | null; suburb: string | null; postcode: string | null; }
interface OrganizationChild { id: string; name: string; organization_type: string; status: string; }
interface OrganizationModule { id: string; module_key: string; enabled: boolean; }
interface GeofenceConfig { config_key: string; config_value: number; zone_type: string | null; }
interface JobRow { id: string; job_type: string; status: string; priority: string; sla_breached: boolean; created_at: string; client_site_id: string | null; }
interface ReportPackRow { id: string; template_code: string; period_start: string; period_end: string; status: string; }
interface QuoteRow { id: string; title: string; status: string; total_charge: number; created_at: string; service_agreement_id: string | null; }
export type WorkspaceQuote = QuoteRow;
interface InvoiceRow { id: string; invoice_number: string; status: string; total_amount: number; due_date: string; }
interface RateRuleRow { id: string; name: string; rate_type: string; amount: number; service_type: string | null; active: boolean; }
interface TenderRow { id: string; title: string; status: string; estimated_value: number | null; due_date: string | null; }
interface DeliveryScheduleRow { id: string; service_agreement_id: string; site_id: string | null; zone_id: string | null; capability_key: string; work_model: string; active_days: number[]; visits_per_shift: number; window_start: string | null; window_end: string | null; response_sla_minutes: number | null; depart_sla_minutes: number | null; dwell_minutes: number; }
interface LocationAgreementRow { id: string; service_agreement_id: string; site_id: string | null; zone_id: string | null; status: string; share_contract_price: boolean | null; share_actual_cost: boolean | null; agreement: { name: string; agreement_type: string; invitation_status: string } | null; }
interface LocationFinanceRow { id: string; service_agreement_id: string | null; site_id: string | null; zone_id: string | null; billing_model: string; hourly_rate: number | null; per_visit_rate: number | null; flat_rate_monthly: number | null; payment_terms_days: number; }
interface LocationCandidate { location_id: string; name: string; address: string | null; suburb: string | null; postcode: string | null; site_count: number; zone_count: number; boundary_state: string; match_reason: string; belongs_to_account: boolean; }

interface Contact {
  id: string;
  first_name: string;
  last_name: string;
  role_title: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  is_primary: boolean;
  is_emergency: boolean;
  notes: string | null;
  updated_at: string;
  deactivated_at: string | null;
}

interface Activity {
  id: string;
  activity_type: string;
  subject: string;
  details: string | null;
  outcome: string | null;
  occurred_at: string;
  follow_up_at: string | null;
  created_at: string;
  completed_at?: string | null;
  completed_by?: string | null;
  completion_notes?: string | null;
}

const emptyContact = { firstName: '', lastName: '', roleTitle: '', email: '', phone: '', mobile: '', isPrimary: false, isEmergency: false, notes: '' };
const emptyActivity = { type: 'call', subject: '', details: '', outcome: '', occurredAt: new Date().toISOString().slice(0, 16), followUpAt: '' };
const emptyChildOrganization = { name: '', type: 'client', nzbn: '', notes: '' };

export function CrmAccountWorkspace({ account, onClose, onNavigate, onOpenAccount, onEditOrganization, onSaveAsClient, onCreateProposal, onOpenQuote, initialView = 'overview' }: { account: CrmWorkspaceAccount; onClose: () => void; onNavigate?: NavigateWithContext; onOpenAccount?: (account: CrmWorkspaceAccount) => void; onEditOrganization?: (organization: EditableCrmOrganization) => void; onSaveAsClient?: () => void; onCreateProposal?: (account: CrmWorkspaceAccount, place: { siteId?: string; zoneId?: string; name: string }) => void; onOpenQuote?: (account: CrmWorkspaceAccount, quote: QuoteRow) => void; initialView?: 'overview' | 'structure' | 'contacts' | 'activity' | 'agreements' | 'sites' | 'modules' | 'operations' | 'jobs' | 'reports' | 'finance' }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [agreements, setAgreements] = useState<AgreementRow[]>([]);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [childOrganizations, setChildOrganizations] = useState<OrganizationChild[]>([]);
  const [organizationModules, setOrganizationModules] = useState<OrganizationModule[]>([]);
  const [geofenceConfig, setGeofenceConfig] = useState<GeofenceConfig[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [reportPacks, setReportPacks] = useState<ReportPackRow[]>([]);
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [rateRules, setRateRules] = useState<RateRuleRow[]>([]);
  const [tenders, setTenders] = useState<TenderRow[]>([]);
  const [deliverySchedules, setDeliverySchedules] = useState<DeliveryScheduleRow[]>([]);
  const [locationAgreements, setLocationAgreements] = useState<LocationAgreementRow[]>([]);
  const [locationFinance, setLocationFinance] = useState<LocationFinanceRow[]>([]);
  const [setupAgreement, setSetupAgreement] = useState<AgreementRow | null>(null);
  // readiness re-read on every workspace load, so the next action follows what the panels just changed
  const [liveReadiness, setLiveReadiness] = useState<{ blockers: string[]; next_action: string } | null>(null);
  const [organizationDetails, setOrganizationDetails] = useState<EditableCrmOrganization | null>(null);
    const [siteDialogOpen, setSiteDialogOpen] = useState(false);
    const [siteDialogLocationId, setSiteDialogLocationId] = useState<string | null>(null);
    const [managedLocationId, setManagedLocationId] = useState<string | null>(null);
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const [locationStage, setLocationStage] = useState<'search' | 'create'>('search');
  const [locationCandidates, setLocationCandidates] = useState<LocationCandidate[]>([]);
  const [locationSearched, setLocationSearched] = useState(false);
  const [locationForm, setLocationForm] = useState({ name: '', address: '', suburb: '', postcode: '', notes: '' });
  const [view, setView] = useState<'overview' | 'structure' | 'contacts' | 'activity' | 'agreements' | 'sites' | 'modules' | 'operations' | 'readiness' | 'jobs' | 'reports' | 'finance'>(initialView);
  const [contactForm, setContactForm] = useState(emptyContact);
  const [activityForm, setActivityForm] = useState(emptyActivity);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [showContactForm, setShowContactForm] = useState(false);
  const [showActivityForm, setShowActivityForm] = useState(false);
  const [showChildOrganizationForm, setShowChildOrganizationForm] = useState(false);
  const [childOrganizationForm, setChildOrganizationForm] = useState(emptyChildOrganization);
  const [loading, setLoading] = useState(true);
  // Only the first load blanks the workspace; a refresh after an action keeps the panels (and their receipts) mounted.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const contactRequestId = useRef(crypto.randomUUID());
  const activityRequestId = useRef(crypto.randomUUID());
  // the headline is the live operational agreement (accepted first); an ended or cancelled one never leads
  const liveOperational = agreements.filter((agreement) => agreement.agreement_type === 'operational' && ['live', 'ending'].includes(agreementTermState(agreement)));
  const headlineAgreement = liveOperational.find((agreement) => agreement.invitation_status === 'accepted') ?? liveOperational[0] ?? agreements.find((agreement) => agreement.agreement_type === 'operational') ?? agreements[0] ?? null;
  const headlineInvitation = headlineAgreement?.invitation_status?.replaceAll('_', ' ') ?? 'not invited';
  const portfolioUpdatedAt = organizationDetails?.updated_at ?? null;
  const canAddBranch = ['owner', 'service_provider', 'branch'].includes(organizationDetails?.organization_type ?? '');
  const portfolioFlow = [
    { label: 'Account', complete: Boolean(organizationDetails?.name), current: view === 'overview' || view === 'structure' || view === 'contacts' },
    { label: 'Agreement', complete: agreements.length > 0, current: view === 'agreements' },
    { label: 'Places', complete: locations.length > 0 && sites.length > 0 && zones.length > 0, current: view === 'sites' },
    { label: 'Operations', complete: deliverySchedules.length > 0, current: view === 'operations' || view === 'modules' },
    { label: 'Invite', complete: headlineAgreement?.invitation_status === 'invited' || headlineAgreement?.invitation_status === 'accepted', current: view === 'readiness' && headlineAgreement?.invitation_status !== 'accepted' },
    { label: 'Handoff', complete: organizationDetails?.status === 'active', current: Boolean(organizationDetails?.status === 'active') },
  ];

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [contactResponse, activityResponse, agreementResponse, siteResponse, locationResponse, childResponse, moduleResponse, geofenceResponse, reportResponse, quoteResponse, invoiceResponse, rateRuleResponse, tenderResponse] = await Promise.all([
      supabase.from('crm_contacts').select('id,first_name,last_name,role_title,email,phone,mobile,is_primary,is_emergency,notes,updated_at,deactivated_at').eq('organization_id', account.id).is('deactivated_at', null).order('is_primary', { ascending: false }).order('last_name'),
      supabase.from('crm_account_activities').select('id,activity_type,subject,details,outcome,occurred_at,follow_up_at,created_at,completed_at,completed_by,completion_notes').eq('account_organization_id', account.id).order('occurred_at', { ascending: false }).limit(50),
      supabase.from('service_agreements').select('id,name,agreement_type,invitation_status,provider_organization_id,client_organization_id,starts_on,ends_on').or(`client_organization_id.eq.${account.id},provider_organization_id.eq.${account.id}`).order('created_at', { ascending: false }),
      supabase.from('client_sites').select('id,name,address,site_type,active,location_id').eq('client_organization_id', account.id).order('name'),
      supabase.from('locations').select('id,name,address,suburb,postcode').eq('organization_id', account.id).order('name'),
      supabase.from('organizations').select('id,name,organization_type,status').eq('parent_organization_id', account.id).order('name'),
      supabase.from('organization_modules').select('id,module_key,enabled').eq('organization_id', account.id).order('module_key'),
      supabase.from('org_geofence_config').select('config_key,config_value,zone_type').eq('organization_id', account.id).order('config_key'),
      supabase.from('monthly_report_packs').select('id,template_code,period_start,period_end,status').eq('organization_id', account.id).order('period_start', { ascending: false }).limit(24),
      supabase.from('quotes').select('id,title,status,total_charge,created_at,service_agreement_id').eq('client_org_id', account.id).order('created_at', { ascending: false }).limit(24),
      supabase.from('invoices').select('id,invoice_number,status,total_amount,due_date').eq('client_organization_id', account.id).order('due_date', { ascending: false }).limit(24),
      supabase.from('rate_rules').select('id,name,rate_type,amount,service_type,active').eq('client_org_id', account.id).eq('rule_kind', 'billing').order('name'),
      supabase.from('tenders').select('id,title,status,estimated_value,due_date').eq('client_organization_id', account.id).order('due_date', { ascending: false }).limit(24),
    ]);
    const { data: organizationData, error: organizationError } = await supabase
      .from('organizations')
      .select('id,name,organization_type,status,updated_at,nzbn,company_registration_number,contact_email,contact_phone,billing_email,billing_address,account_notes')
      .eq('id', account.id)
      .single();
    if (!organizationError && organizationData) setOrganizationDetails(organizationData as EditableCrmOrganization);
    const failures = [contactResponse.error, activityResponse.error, agreementResponse.error, siteResponse.error, locationResponse.error, childResponse.error, moduleResponse.error, geofenceResponse.error, reportResponse.error, quoteResponse.error, invoiceResponse.error, rateRuleResponse.error, tenderResponse.error].filter(Boolean);
    if (failures.length) setError(failures[0]?.message ?? 'Account workspace could not be loaded.');
    else {
      setContacts((contactResponse.data as Contact[]) ?? []);
      setActivities((activityResponse.data as Activity[]) ?? []);
      setAgreements((agreementResponse.data as AgreementRow[]) ?? []);
      setReportPacks((reportResponse.data as ReportPackRow[]) ?? []);
      setQuotes((quoteResponse.data as QuoteRow[]) ?? []);
      setInvoices((invoiceResponse.data as InvoiceRow[]) ?? []);
      setRateRules((rateRuleResponse.data as RateRuleRow[]) ?? []);
      setTenders((tenderResponse.data as TenderRow[]) ?? []);
      const agreementRows = (agreementResponse.data as AgreementRow[]) ?? [];
      const siteRows = (siteResponse.data as SiteRow[]) ?? [];
      const locationRows = (locationResponse.data as LocationRow[]) ?? [];
      setSites(siteRows);
      setLocations(locationRows);
      setChildOrganizations((childResponse.data as OrganizationChild[]) ?? []);
      setOrganizationModules((moduleResponse.data as OrganizationModule[]) ?? []);
      setGeofenceConfig((geofenceResponse.data as GeofenceConfig[]) ?? []);
      const locationIds = [...new Set([...locationRows.map((location) => location.id), ...siteRows.map((site) => site.location_id).filter((value): value is string => Boolean(value))])];
      const siteIds = siteRows.map((site) => site.id);
      const [zoneResponse, jobResponse, deliveryScheduleResponse, locationAgreementResponse, locationFinanceResponse] = await Promise.all([
        locationIds.length ? supabase.from('location_zones').select('id,name,zone_type,is_active,location_id').in('location_id', locationIds).order('name') : Promise.resolve({ data: [], error: null }),
        siteIds.length ? supabase.from('dispatch_jobs').select('id,job_type,status,priority,sla_breached,created_at,client_site_id').in('client_site_id', siteIds).order('created_at', { ascending: false }).limit(24) : Promise.resolve({ data: [], error: null }),
        agreementRows.length ? supabase.from('service_agreement_delivery_schedules').select('id,service_agreement_id,site_id,zone_id,capability_key,work_model,active_days,visits_per_shift,window_start,window_end,response_sla_minutes,depart_sla_minutes,dwell_minutes').in('service_agreement_id', agreementRows.map((agreement) => agreement.id)).eq('active', true) : Promise.resolve({ data: [], error: null }),
        agreementRows.length ? supabase.from('service_agreement_locations').select('id,service_agreement_id,site_id,zone_id,status,share_contract_price,share_actual_cost,agreement:service_agreement_id(name,agreement_type,invitation_status)').in('service_agreement_id', agreementRows.map((agreement) => agreement.id)) : Promise.resolve({ data: [], error: null }),
        agreementRows.length ? supabase.from('site_financial_config').select('id,service_agreement_id,site_id,zone_id,billing_model,hourly_rate,per_visit_rate,flat_rate_monthly,payment_terms_days').in('service_agreement_id', agreementRows.map((agreement) => agreement.id)) : Promise.resolve({ data: [], error: null }),
      ]);
      if (deliveryScheduleResponse.error) setError(deliveryScheduleResponse.error.message);
      setZones((zoneResponse.data as ZoneRow[]) ?? []);
      setJobs((jobResponse.data as JobRow[]) ?? []);
      setDeliverySchedules((deliveryScheduleResponse.data as DeliveryScheduleRow[]) ?? []);
      setLocationAgreements((locationAgreementResponse.data as LocationAgreementRow[]) ?? []);
      setLocationFinance((locationFinanceResponse.data as LocationFinanceRow[]) ?? []);
    }
    // ATLAS READS: get_crm_organization_readiness (blockers + next action for this account, fresh)
    const { data: readinessRows } = await supabase.rpc('get_crm_organization_readiness', { p_organization_ids: [account.id] });
    const readinessRow = ((readinessRows as Array<{ organization_id: string; blockers: string[]; next_action: string }> | null) ?? []).find((row) => row.organization_id === account.id);
    setLiveReadiness(readinessRow ? { blockers: readinessRow.blockers ?? [], next_action: readinessRow.next_action } : null);
    setLoading(false);
    setLoadedOnce(true);
  }, [account.id]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);

  const openContact = (contact?: Contact) => {
    setEditing(contact ?? null);
    setContactForm(contact ? { firstName: contact.first_name, lastName: contact.last_name, roleTitle: contact.role_title ?? '', email: contact.email ?? '', phone: contact.phone ?? '', mobile: contact.mobile ?? '', isPrimary: contact.is_primary, isEmergency: contact.is_emergency, notes: contact.notes ?? '' } : emptyContact);
    if (!contact) contactRequestId.current = crypto.randomUUID();
    setShowContactForm(true);
    setError(null);
  };

  const saveContact = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(null); setNotice(null);
    const { data, error: saveError } = await supabase.rpc('manage_crm_contact', {
      p_client_request_id: contactRequestId.current,
      p_contact_id: editing?.id ?? null,
      p_account_organization_id: account.id,
      p_expected_updated_at: editing?.updated_at ?? null,
      p_action: editing ? 'update' : 'create',
      p_first_name: contactForm.firstName.trim(), p_last_name: contactForm.lastName.trim(), p_role_title: contactForm.roleTitle.trim() || null,
      p_email: contactForm.email.trim() || null, p_phone: contactForm.phone.trim() || null, p_mobile: contactForm.mobile.trim() || null,
      p_is_primary: contactForm.isPrimary, p_is_emergency: contactForm.isEmergency, p_notes: contactForm.notes.trim() || null,
    });
    if (saveError || !data) setError(saveError?.message ?? 'Contact receipt was not confirmed. Your entries remain available.');
    else {
      setNotice(editing ? 'Contact updated with a new audit revision.' : 'Contact added to the account.');
      setShowContactForm(false); setEditing(null); setContactForm(emptyContact); contactRequestId.current = crypto.randomUUID();
      await loadWorkspace();
    }
    setSaving(false);
  };

  const deactivateContact = async (contact: Contact) => {
    setSaving(true); setError(null); setNotice(null);
    const { error: saveError } = await supabase.rpc('manage_crm_contact', {
      p_client_request_id: crypto.randomUUID(), p_contact_id: contact.id, p_account_organization_id: account.id,
      p_expected_updated_at: contact.updated_at, p_action: 'deactivate', p_first_name: contact.first_name, p_last_name: contact.last_name,
      p_role_title: contact.role_title, p_email: contact.email, p_phone: contact.phone, p_mobile: contact.mobile,
      p_is_primary: false, p_is_emergency: contact.is_emergency, p_notes: contact.notes,
    });
    if (saveError) setError(saveError.message);
    else { setNotice('Contact deactivated. Historical activity remains available.'); await loadWorkspace(); }
    setSaving(false);
  };

  const completeFollowUp = async (activity: Activity) => {
    setSaving(true); setError(null); setNotice(null);
    const { error: completeError } = await supabase.rpc('complete_crm_follow_up', {
      p_client_request_id: crypto.randomUUID(),
      p_activity_id: activity.id,
      p_completion_notes: 'Completed in account workspace',
    });
    if (completeError) setError(completeError.message);
    else { setNotice('Follow-up task marked complete.'); await loadWorkspace(); }
    setSaving(false);
  };

  const saveActivity = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(null); setNotice(null);
    const { data, error: saveError } = await supabase.rpc('create_crm_account_activity', {
      p_client_request_id: activityRequestId.current, p_account_organization_id: account.id, p_service_agreement_id: account.agreementId ?? null,
      p_activity_type: activityForm.type, p_subject: activityForm.subject.trim(), p_details: activityForm.details.trim() || null,
      p_outcome: activityForm.outcome.trim() || null, p_occurred_at: new Date(activityForm.occurredAt).toISOString(),
      p_follow_up_at: activityForm.followUpAt ? new Date(activityForm.followUpAt).toISOString() : null,
    });
    if (saveError || !data) setError(saveError?.message ?? 'Activity receipt was not confirmed. Your entries remain available.');
    else {
      setNotice('Account activity recorded with follow-up ownership.'); setShowActivityForm(false); setActivityForm(emptyActivity);
      activityRequestId.current = crypto.randomUUID(); await loadWorkspace();
    }
    setSaving(false);
  };

  const createChildOrganization = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    const childType = !canAddBranch && childOrganizationForm.type === 'branch' ? 'department' : childOrganizationForm.type;
      const { data, error: createError } = await supabase.rpc('manage_crm_organization_child', { 
        p_client_request_id: crypto.randomUUID(), 
        p_parent_organization_id: account.id, 
        p_name: childOrganizationForm.name.trim(), 
        p_organization_type: childType, 
        p_nzbn: childOrganizationForm.nzbn.trim() || null, 
        p_notes: childOrganizationForm.notes.trim() || null 
      });
    if (createError || !data) setError(createError?.message ?? 'Child organization receipt was not confirmed.');
    else { setNotice(`${data.name} added under ${account.name}.`); setChildOrganizationForm(emptyChildOrganization); setShowChildOrganizationForm(false); await loadWorkspace(); }
    setSaving(false);
  };

  const createLocation = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null);
    const { data, error: createError } = await supabase.rpc('manage_crm_location', {
      p_client_request_id: crypto.randomUUID(), p_organization_id: account.id, p_action: 'create',
      p_name: locationForm.name.trim(), p_address: locationForm.address.trim() || null,
      p_suburb: locationForm.suburb.trim() || null, p_postcode: locationForm.postcode.trim() || null,
      p_notes: locationForm.notes.trim() || null,
    });
    if (createError || !data) setError(createError?.message ?? 'Location receipt was not confirmed. Your entries remain available.');
    else { setLocationDialogOpen(false); setLocationForm({ name: '', address: '', suburb: '', postcode: '', notes: '' }); setNotice(`${data.name} added to ${account.name}. Add its site, zones, and boundaries next.`); await loadWorkspace(); }
    setSaving(false);
  };

  const searchLocations = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setLocationSearched(false);
    const { data, error: searchError } = await supabase.rpc('find_crm_location_candidates', {
      p_account_organization_id: account.id,
      p_query: locationForm.name.trim() || null,
      p_address: locationForm.address.trim() || null,
    });
    if (searchError) setError(searchError.message);
    else { setLocationCandidates((data as LocationCandidate[]) ?? []); setLocationSearched(true); }
    setSaving(false);
  };

  const openLocationLookup = () => {
    setLocationDialogOpen(true); setLocationStage('search'); setLocationCandidates([]); setLocationSearched(false); setError(null);
  };

  const attachSiteToLocation = async (site: SiteRow, location: LocationRow) => {
    setSaving(true); setError(null); setNotice(null);
    const { error: attachError } = await supabase.rpc('attach_crm_site_to_location', { p_site_id: site.id, p_location_id: location.id });
    if (attachError) setError(attachError.message);
    else { setNotice(`${site.name} attached to ${location.name}.`); await loadWorkspace(); }
    setSaving(false);
  };

  return <div className="crm-workspace-backdrop">
    <section className="crm-workspace" role="dialog" aria-modal="true" aria-labelledby="crm-workspace-title">
      <header><div><span>Client portfolio</span><h2 id="crm-workspace-title">{account.name}</h2><p>Commercial, operational, and relationship context for this organisation.</p><small className="crm-portfolio-context-note">Bob uses this portfolio context when you ask for help.</small>{portfolioUpdatedAt && <small className="crm-portfolio-freshness">Live account record updated {new Date(portfolioUpdatedAt).toLocaleString('en-NZ')}</small>}</div><button type="button" onClick={onClose} aria-label="Close client portfolio"><X size={19} /></button></header>
      <div className="crm-portfolio-flow" aria-label="Client portfolio account flow">{portfolioFlow.map((stage) => <span className={`${stage.complete ? 'is-complete' : ''} ${stage.current ? 'is-current' : ''}`} key={stage.label}>{stage.label}</span>)}</div>
      {error && <div className="crm-workspace-message is-error" role="alert">{error}</div>}
      {notice && <div className="crm-workspace-message is-success" role="status">{notice}</div>}
      <nav className="crm-portfolio-nav" aria-label="Client portfolio views">
        <button type="button" className={view === 'overview' ? 'is-active' : ''} onClick={() => setView('overview')}><Users size={16} />Overview</button>
        <button type="button" className={view === 'structure' ? 'is-active' : ''} onClick={() => setView('structure')}><Building2 size={16} />Structure <strong>{childOrganizations.length}</strong></button>
        <button type="button" className={view === 'agreements' ? 'is-active' : ''} onClick={() => setView('agreements')}><Handshake size={16} />Agreements <strong>{agreements.length}</strong></button>
        <button type="button" className={view === 'sites' ? 'is-active' : ''} onClick={() => setView('sites')}><MapPin size={16} />Places <strong>{locations.length}</strong></button>
          <button type="button" className={view === 'modules' ? 'is-active' : ''} onClick={() => setView('modules')}><Layers3 size={16} />Modules <strong>{organizationModules.filter((module) => module.enabled).length}</strong></button>
          <button type="button" className={view === 'operations' ? 'is-active' : ''} onClick={() => setView('operations')}><Route size={16} />Operations <strong>{deliverySchedules.length}</strong></button>
          <button type="button" className={view === 'readiness' ? 'is-active' : ''} onClick={() => setView('readiness')}><CheckCircle2 size={16} />Readiness</button>
          <div className="crm-workspace-toolbar"><div><strong>{view === 'overview' ? 'Account overview' : view === 'structure' ? 'Structure and governance' : view === 'contacts' ? 'Account contacts' : view === 'activity' ? 'Relationship timeline' : view === 'agreements' ? 'Service agreements' : view === 'sites' ? 'Places, sites, and zones' : view === 'modules' ? 'Enabled modules and rules' : view === 'operations' ? 'Operations and schedules' : view === 'readiness' ? 'Readiness and handoff' : view === 'jobs' ? 'Field response' : view === 'reports' ? 'Report packs' : 'Finance'}</strong><span>{view === 'overview' ? 'Readiness, commercial state, locations, and relationship ownership.' : view === 'structure' ? 'Branches and divisions with independent standing, enabled modules, and organization-level geofence defaults.' : view === 'contacts' ? 'Maintain decision-makers, operational contacts, and emergency escalation.' : view === 'activity' ? 'Record human interactions and make follow-up visible.' : view === 'agreements' ? 'Every commercial and operational agreement linking this account.' : view === 'sites' ? 'Find, reuse, or create this organization\'s location houses, sites, zones, boundaries, and closures.' : view === 'modules' ? 'Modules radiate from this portfolio and become available to the places and agreements that need them.' : view === 'operations' ? 'Schedules and roster readiness stay in the portfolio context while assignment remains in Workforce.' : view === 'readiness' ? 'One checklist for what is ready, what is blocked, and what unlocks the next governed handoff.' : view === 'jobs' ? 'Dispatch response history for this account\'s sites.' : view === 'reports' ? 'Generated and delivered monthly report packs.' : 'Quotes and invoices for this account.'}</span></div>{view === 'contacts' ? <button type="button" onClick={() => openContact()}><UserPlus size={16} />Add contact</button> : view === 'activity' ? <button type="button" onClick={() => { setActivityForm({ ...emptyActivity, occurredAt: new Date().toISOString().slice(0, 16) }); setShowActivityForm(true); setError(null); }}><MessageSquarePlus size={16} />Log activity</button> : view === 'agreements' ? <button type="button" onClick={() => setSetupAgreement(agreements[0] ?? null)}>Configure agreement</button> : view === 'sites' ? <div className="crm-workspace-toolbar-actions"><button type="button" onClick={openLocationLookup}><MapPin size={16} />Find or add location</button><button type="button" onClick={() => { setSiteDialogLocationId(locations[0]?.id ?? null); setSiteDialogOpen(true); }}><MapPin size={16} />Add site</button></div> : view === 'operations' ? <button type="button" onClick={() => onNavigate?.('roster', { accountId: account.id, agreementId: agreements[0]?.id })}>Open roster</button> : null}</div>
        <button type="button" className={view === 'jobs' ? 'is-active' : ''} onClick={() => setView('jobs')}><Radio size={16} />Response <strong>{jobs.length}</strong></button>
        <button type="button" className={view === 'contacts' ? 'is-active' : ''} onClick={() => setView('contacts')}><Users size={16} />Contacts <strong>{contacts.length}</strong></button>
        <button type="button" className={view === 'activity' ? 'is-active' : ''} onClick={() => setView('activity')}><CalendarClock size={16} />Activity <strong>{activities.length}</strong></button>
        <button type="button" className={view === 'reports' ? 'is-active' : ''} onClick={() => setView('reports')}><FileBarChart size={16} />Reports <strong>{reportPacks.length}</strong></button>
        <button type="button" className={view === 'finance' ? 'is-active' : ''} onClick={() => setView('finance')}><WalletCards size={16} />Finance <strong>{quotes.length + invoices.length + rateRules.length + tenders.length}</strong></button>
      </nav>
      <div className="crm-workspace-toolbar"><div><strong>{view === 'overview' ? 'Account overview' : view === 'structure' ? 'Structure and governance' : view === 'contacts' ? 'Account contacts' : view === 'activity' ? 'Relationship timeline' : view === 'agreements' ? 'Service agreements' : view === 'sites' ? 'Places, sites, and zones' : view === 'jobs' ? 'Field response' : view === 'reports' ? 'Report packs' : 'Finance'}</strong><span>{view === 'overview' ? 'Readiness, commercial state, locations, and relationship ownership.' : view === 'structure' ? 'Branches and divisions with independent standing, enabled modules, and organization-level geofence defaults.' : view === 'contacts' ? 'Maintain decision-makers, operational contacts, and emergency escalation.' : view === 'activity' ? 'Record human interactions and make follow-up visible.' : view === 'agreements' ? 'Every commercial and operational agreement linking this account.' : view === 'sites' ? 'Find, reuse, or create this organization\'s location houses, sites, zones, boundaries, and closures.' : view === 'jobs' ? 'Dispatch response history for this account\'s sites.' : view === 'reports' ? 'Generated and delivered monthly report packs.' : 'Quotes and invoices for this account.'}</span></div>{view === 'contacts' ? <button type="button" onClick={() => openContact()}><UserPlus size={16} />Add contact</button> : view === 'activity' ? <button type="button" onClick={() => { setActivityForm({ ...emptyActivity, occurredAt: new Date().toISOString().slice(0, 16) }); setShowActivityForm(true); setError(null); }}><MessageSquarePlus size={16} />Log activity</button> : view === 'agreements' ? <button type="button" onClick={() => setSetupAgreement(agreements[0] ?? null)}>Configure agreement</button> : view === 'sites' ? <div className="crm-workspace-toolbar-actions"><button type="button" onClick={openLocationLookup}><MapPin size={16} />Find or add location</button><button type="button" onClick={() => { setSiteDialogLocationId(locations[0]?.id ?? null); setSiteDialogOpen(true); }}><MapPin size={16} />Add site</button></div> : view === 'jobs' ? <button type="button" onClick={() => onNavigate?.('field-ops', { accountId: account.id })}>Open dispatch console</button> : view === 'reports' ? <button type="button" onClick={() => onNavigate?.('reports', { accountId: account.id })}>Open reports</button> : view === 'finance' ? <button type="button" onClick={() => onNavigate?.('crm', { accountId: account.id })}>Open finance</button> : null}</div>
      {view === 'overview' && <div className="crm-account-overview"><button type="button" onClick={() => setView('overview')}><span>Account status</span><strong>{organizationDetails?.status ?? account.status ?? 'Status not recorded'}</strong></button><button type="button" onClick={() => setView('readiness')}><span>Client access</span><strong className={`crm-headline-state state-${headlineAgreement?.invitation_status ?? 'not_invited'}`}>{headlineInvitation}</strong></button><button type="button" onClick={() => setView('agreements')}><span>Commercial agreement</span><strong>{headlineAgreement?.name ?? 'Not configured'}</strong></button><button type="button" onClick={() => setView('contacts')}><span>Primary contact</span><strong>{account.primaryContactName ?? 'Not assigned'}</strong></button><button type="button" onClick={() => setView('structure')}><span>Branches / divisions</span><strong>{childOrganizations.length}</strong></button><button type="button" onClick={() => setView('sites')}><span>Locations / houses</span><strong>{locations.length}</strong></button><button type="button" onClick={() => setView('sites')}><span>Site facets</span><strong>{sites.length}</strong></button><button type="button" onClick={() => setView('sites')}><span>Zone facets</span><strong>{zones.length}</strong></button><button type="button" onClick={() => setView('agreements')}><span>Agreements</span><strong>{agreements.length}</strong></button><button type="button" onClick={() => setView('operations')}><span>Schedules</span><strong>{deliverySchedules.length}</strong></button><button type="button" onClick={() => setView('jobs')}><span>Open response jobs</span><strong>{jobs.filter((job) => job.status !== 'completed').length}</strong></button><div className={`crm-account-readiness-panel ${account.readinessBlockers?.length ? 'is-attention' : 'is-ready'}`}><span>Next action</span><strong>{liveReadiness?.next_action ?? account.nextAction ?? 'Review account readiness'}</strong>{(liveReadiness?.blockers ?? account.readinessBlockers ?? []).length ? <ul>{(liveReadiness?.blockers ?? account.readinessBlockers ?? []).map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : <small>Everything needed to start service is in place</small>}{(organizationDetails?.organization_type ?? 'client') === 'client' && <button type="button" className="crm-guided-setup" onClick={() => onNavigate?.('client-setup', { accountId: account.id })}>Add a place or service (guided)</button>}</div></div>}
      {view === 'overview' && <div className="crm-portfolio-truth"><span>Where work lives</span><div><button type="button" onClick={() => setView('overview')}><strong>CRM</strong><small>identity and relationship</small></button><button type="button" onClick={() => setView('sites')}><strong>Places</strong><small>houses, sites, zones</small></button><button type="button" onClick={() => setView('operations')}><strong>Roster</strong><small>schedules and coverage</small></button><button type="button" onClick={() => setView('finance')}><strong>Finance</strong><small>rates and invoices</small></button><button type="button" onClick={() => setView('jobs')}><strong>Operations</strong><small>response and evidence</small></button></div></div>}
      {view === 'overview' && <CrmOnboardingPanel accountId={account.id} accountStatus={organizationDetails?.status ?? account.status} onChanged={loadWorkspace} />}
      {view === 'structure' && showChildOrganizationForm && <form className="crm-workspace-form" onSubmit={createChildOrganization}><header><strong>Add child organization</strong><button type="button" onClick={() => setShowChildOrganizationForm(false)}><X size={16} /></button></header><div className="crm-form-grid"><label><span>Name</span><input required value={childOrganizationForm.name} onChange={(event) => setChildOrganizationForm({ ...childOrganizationForm, name: event.target.value })} /></label><label><span>Role in hierarchy</span><select value={childOrganizationForm.type} onChange={(event) => setChildOrganizationForm({ ...childOrganizationForm, type: event.target.value })}><option value="branch">Internal branch</option><option value="client">Client organization</option><option value="government">Government client</option><option value="private_enterprise">Private-enterprise client</option><option value="department">Client department</option><option value="contractor">Contractor organization</option></select></label></div><label><span>NZBN, if applicable</span><input inputMode="numeric" value={childOrganizationForm.nzbn} onChange={(event) => setChildOrganizationForm({ ...childOrganizationForm, nzbn: event.target.value })} /></label><label><span>Context</span><textarea rows={2} value={childOrganizationForm.notes} onChange={(event) => setChildOrganizationForm({ ...childOrganizationForm, notes: event.target.value })} /></label><footer><button type="button" onClick={() => setShowChildOrganizationForm(false)}>Cancel</button><button type="submit" disabled={saving || !childOrganizationForm.name.trim()}>{saving ? 'Adding' : 'Add child organization'}</button></footer></form>}
      {view === 'structure' && <section className="crm-hierarchy-guide"><div><strong>What belongs in this hierarchy</strong><span><b>Internal branch:</b> a First Security delivery region with its own staff, clients, pricing, rosters, and agreements. <b>Client organization:</b> the external organization that receives services. <b>Client department:</b> an accountable client unit only when it owns a budget, service area, or agreement.</span></div>{!showChildOrganizationForm && <button type="button" onClick={() => setShowChildOrganizationForm(true)}><UserPlus size={16} />Add child organization</button>}</section>}
      {view === 'overview' && (onEditOrganization || onSaveAsClient) && organizationDetails && <div className="crm-workspace-toolbar"><span>Keep identity and provider account ownership explicit. The canonical external organization is never re-parented.</span><div>{onEditOrganization && <button type="button" onClick={() => onEditOrganization(organizationDetails)}><Building2 size={16} />Edit organization details</button>}{onSaveAsClient && <button type="button" onClick={onSaveAsClient}><Building2 size={16} />Save as client organization</button>}</div></div>}
      <div className="crm-workspace-body">
        {loading && !loadedOnce ? <div className="crm-workspace-empty">Loading account record</div> : view === 'agreements' ? (agreements.length === 0 ? <div className="crm-workspace-empty"><Handshake size={24} />No service agreements linked to this account yet.</div> : <div className="crm-agreement-list">{agreements.map((agreement) => { const schedules = deliverySchedules.filter((schedule) => schedule.service_agreement_id === agreement.id); const termState = agreementTermState(agreement); const live = termState === 'live' || termState === 'ending'; return <article key={agreement.id} className={live ? '' : 'is-ended'}><div><strong>{agreement.name}</strong><span className={`crm-status-pill status-${live ? agreement.invitation_status : 'ended'}`}>{live ? agreement.invitation_status.replaceAll('_', ' ') : termState}</span></div><p>{agreement.agreement_type === 'operational' ? 'Operational service agreement' : 'Platform subscription'}</p><CrmAgreementTerm agreement={agreement} canEnd={agreement.agreement_type === 'operational' && agreement.client_organization_id === account.id} onEnded={loadWorkspace} />{schedules.length > 0 && <section className="crm-agreement-schedules" aria-label={`${agreement.name} delivery schedules`}><header><CalendarClock size={15} /><strong>Active delivery schedules</strong><span>{schedules.length}</span></header>{schedules.map((schedule) => { const place = sites.find((site) => site.id === schedule.site_id)?.name ?? zones.find((zone) => zone.id === schedule.zone_id)?.name ?? 'Authorized place'; const window = contractedHoursWords(schedule.window_start, schedule.window_end); const sla = [schedule.response_sla_minutes && `arrive ${schedule.response_sla_minutes}m`, schedule.depart_sla_minutes && `depart ${schedule.depart_sla_minutes}m`].filter(Boolean).join(' | '); return <div className="crm-agreement-schedule" key={schedule.id}><strong>{place} | {schedule.capability_key.replaceAll('_', ' ')}</strong><span>{schedule.work_model.replaceAll('_', ' ')} | {schedule.visits_per_shift} visit{schedule.visits_per_shift === 1 ? '' : 's'} | {contractedDaysWords(schedule.active_days)}</span><small>{window} | dwell {schedule.dwell_minutes}m{sla ? ` | ${sla}` : ''}</small></div>; })}</section>}{agreement.agreement_type === 'operational' && agreement.client_organization_id === account.id && live && <><button type="button" onClick={() => setSetupAgreement(agreement)}>Configure coverage and modules</button><CrmOperationalWorkPanel agreement={agreement} sites={sites} zones={zones} onChanged={loadWorkspace} /><CrmRosterHandoffPanel agreement={agreement} onChanged={loadWorkspace} /><CrmAgreementDeliveryPanel agreementId={agreement.id} /></>}</article>; })}</div>)
          : view === 'modules' ? <div className="crm-structure-grid"><section><h4>Portfolio modules</h4>{organizationModules.length === 0 ? <p className="crm-workspace-subtle">No module configuration recorded for this organization.</p> : <div className="crm-module-card-list">{organizationModules.map((module) => <article key={module.id} className={module.enabled ? 'is-enabled' : 'is-disabled'}><div><strong>{module.module_key.replaceAll('_', ' ')}</strong><span>{module.enabled ? 'Enabled for this portfolio' : 'Available but disabled'}</span></div><small>Module rules and operational records stay linked to this organization, its agreements, and its places.</small></article>)}</div>}</section><section><h4>Coverage context</h4><p className="crm-workspace-subtle">{agreements.length} agreement{agreements.length === 1 ? '' : 's'} · {locations.length} location house{locations.length === 1 ? '' : 's'} · {sites.length} site facet{sites.length === 1 ? '' : 's'} · {zones.length} zone facet{zones.length === 1 ? '' : 's'}</p><p className="crm-workspace-subtle">Enablement belongs to the portfolio; place-level scope and module rules are configured from Agreements and Places.</p></section><section><h4>Geofence defaults</h4>{geofenceConfig.length === 0 ? <p className="crm-workspace-subtle">No organization-level provisional-radius overrides. Site and zone boundaries remain independently verified.</p> : geofenceConfig.map((config) => <div className="crm-geofence-config" key={`${config.config_key}-${config.zone_type ?? 'all'}`}><strong>{config.config_key.replaceAll('_', ' ')}</strong><span>{config.config_value} m{config.zone_type ? ` · ${config.zone_type.replaceAll('_', ' ')}` : ''}</span></div>)}</section></div>
          : view === 'operations' ? <div className="crm-agreement-list">{deliverySchedules.length === 0 ? <div className="crm-workspace-empty"><Route size={24} />No delivery schedules recorded for this portfolio yet.</div> : deliverySchedules.map((schedule) => { const place = sites.find((site) => site.id === schedule.site_id)?.name ?? zones.find((zone) => zone.id === schedule.zone_id)?.name ?? 'Authorized place'; return <article key={schedule.id}><div><strong>{place}</strong><span className="crm-status-pill status-active">Active</span></div><p>{schedule.capability_key.replaceAll('_', ' ')} · {schedule.work_model.replaceAll('_', ' ')} · {schedule.visits_per_shift} visit{schedule.visits_per_shift === 1 ? '' : 's'} across {contractedDaysWords(schedule.active_days)}</p><small>{contractedHoursWords(schedule.window_start, schedule.window_end)} · dwell {schedule.dwell_minutes}m</small></article>; })}</div>
          : view === 'readiness' ? <div className="crm-readiness-list">{[
            { label: 'Organization identity', ready: Boolean(organizationDetails?.name), view: 'overview' as const, detail: organizationDetails?.name ?? 'Organization identity is not loaded.' },
            { label: 'Primary contact', ready: Boolean(account.primaryContactName), view: 'contacts' as const, detail: account.primaryContactName ?? 'Add the person the provider should contact first.' },
            { label: 'Service agreement', ready: agreements.length > 0, view: 'agreements' as const, detail: agreements.length ? `${agreements.length} agreement${agreements.length === 1 ? '' : 's'} linked` : 'Create the commercial and operational agreement.' },
            { label: 'Places and boundaries', ready: locations.length > 0 && sites.length > 0 && zones.length > 0, view: 'sites' as const, detail: `${locations.length} houses · ${sites.length} sites · ${zones.length} zones` },
            { label: 'Enabled modules', ready: organizationModules.some((module) => module.enabled), view: 'modules' as const, detail: `${organizationModules.filter((module) => module.enabled).length} enabled` },
            { label: 'Operations schedules', ready: deliverySchedules.length > 0, view: 'operations' as const, detail: `${deliverySchedules.length} active schedule${deliverySchedules.length === 1 ? '' : 's'}` },
          ].map((item) => <button type="button" className={`crm-readiness-item ${item.ready ? 'is-ready' : 'is-blocked'}`} key={item.label} onClick={() => setView(item.view)}><span>{item.ready ? <CheckCircle2 size={17} /> : <X size={17} />}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div><em>{item.ready ? 'Ready' : 'Needs work'}</em></button>)}{account.readinessBlockers?.length ? <p className="crm-workspace-subtle">Server readiness reports {account.readinessBlockers.length} additional blocker{account.readinessBlockers.length === 1 ? '' : 's'} before activation.</p> : <p className="crm-workspace-subtle">No recorded activation blockers. Confirm the final provider handoff when the operational owner is ready.</p>}</div>
          : view === 'structure' ? <div className="crm-structure-grid"><section><h4>Branches and divisions</h4>{childOrganizations.length === 0 ? <p className="crm-workspace-subtle">No child organizations. Create one only where a branch or division has independent authority, staff, billing, agreements, or jurisdiction.</p> : childOrganizations.map((child) => <button type="button" className="crm-structure-child" key={child.id} onClick={() => onOpenAccount?.({ id: child.id, name: child.name, status: child.status })}><Building2 size={16} /><span><strong>{child.name}</strong><small>{child.organization_type.replaceAll('_', ' ')} · {child.status}</small></span></button>)}</section><section><h4>Enabled modules</h4>{organizationModules.length === 0 ? <p className="crm-workspace-subtle">No module configuration recorded for this organization.</p> : <div className="crm-module-chip-row">{organizationModules.map((module) => <span key={module.id} className={`crm-module-chip ${module.enabled ? '' : 'is-disabled'}`}>{module.module_key.replaceAll('_', ' ')}</span>)}</div>}</section><section><h4>Geofence defaults</h4>{geofenceConfig.length === 0 ? <p className="crm-workspace-subtle">No organization-level provisional-radius overrides. Site and zone boundaries remain independently verified.</p> : geofenceConfig.map((config) => <div className="crm-geofence-config" key={`${config.config_key}-${config.zone_type ?? 'all'}`}><strong>{config.config_key.replaceAll('_', ' ')}</strong><span>{config.config_value} m{config.zone_type ? ` · ${config.zone_type.replaceAll('_', ' ')}` : ''}</span></div>)}</section><section><h4>Model boundary</h4><p className="crm-workspace-subtle">Use Places for campuses, hospitals, outreach buildings, sites, and zones. A service agreement, not the organization tree, authorizes a provider to operate at another organization’s place.</p></section></div>
          : view === 'sites' ? ((locations.length + sites.filter((site) => !site.location_id).length) === 0 ? <div className="crm-workspace-empty"><MapPin size={24} />No places, sites, or zones recorded for this account yet.</div> : <div className="crm-place-list">{locations.map((location) => { const locationSites = sites.filter((site) => site.location_id === location.id); const locationZones = zones.filter((zone) => zone.location_id === location.id); return <article key={location.id}><header><div><span>Location / house</span><strong>{location.name}</strong></div><small>{[location.address, location.suburb, location.postcode].filter(Boolean).join(', ') || 'Address not recorded'}</small><button type="button" className="btn btn-sm btn-secondary" onClick={() => setManagedLocationId(location.id)}>Edit house, sites, and zones</button></header><div className="crm-place-facets"><div><span>Site facets</span>{locationSites.length ? locationSites.map((site) => <div className="crm-place-action" key={site.id}><button type="button" onClick={() => setManagedLocationId(location.id)}>{site.name}<small>{site.site_type ?? 'Site'} · {site.active ? 'Active' : 'Inactive'}</small></button>{onCreateProposal && <button type="button" className="btn btn-sm btn-primary" onClick={() => onCreateProposal(account, { siteId: site.id, name: site.name })}>Create proposal</button>}</div>) : <small>No site facet</small>}</div><div><span>Zone facets</span>{locationZones.length ? locationZones.map((zone) => <div className="crm-place-action" key={zone.id}><button type="button" onClick={() => setManagedLocationId(location.id)}>{zone.name}<small>{zone.zone_type.replaceAll('_', ' ')} · {zone.is_active ? 'Active' : 'Inactive'}</small></button>{onCreateProposal && <button type="button" className="btn btn-sm btn-primary" onClick={() => onCreateProposal(account, { zoneId: zone.id, name: zone.name })}>Create proposal</button>}</div>) : <small>No zone facet</small>}</div></div></article>; })}{sites.filter((site) => !site.location_id).length > 0 && <section className="crm-unlinked-facets"><h4>Unlinked site facets</h4><p>These existing sites have not yet been attached to a Location / house.</p>{sites.filter((site) => !site.location_id).map((site) => <div className="crm-place-action" key={site.id}><button type="button" onClick={() => setManagedLocationId(site.location_id ?? '')}><strong>{site.name}</strong><span>{site.address ?? 'No address recorded'} · {site.site_type ?? 'Site'}</span></button>{onCreateProposal && <button type="button" className="btn btn-sm btn-primary" onClick={() => onCreateProposal(account, { siteId: site.id, name: site.name })}>Create proposal</button>}{locations.length > 0 && <button type="button" className="btn btn-sm btn-secondary" disabled={saving} onClick={() => void attachSiteToLocation(site, locations[0])}>Attach to house</button>}</div>)}</section>}</div>)
          : view === 'jobs' ? (jobs.length === 0 ? <div className="crm-workspace-empty"><Radio size={24} />No dispatch response history for this account's sites yet.</div> : <div className="crm-job-list">{jobs.map((job) => <article key={job.id}><div><strong>{job.job_type}</strong><span className={job.sla_breached ? 'is-attention' : 'is-ready'}>{job.status}</span></div><p>Priority {job.priority} · {new Date(job.created_at).toLocaleString('en-NZ')}</p></article>)}</div>)
          : view === 'reports' ? (reportPacks.length === 0 ? <div className="crm-workspace-empty"><FileBarChart size={24} />No report packs generated for this account yet.</div> : <div className="crm-report-list">{reportPacks.map((pack) => <article key={pack.id}><div><strong>{pack.template_code}</strong><span className={`crm-status-pill status-${pack.status}`}>{pack.status}</span></div><p>{pack.period_start} – {pack.period_end}</p></article>)}</div>)
          : view === 'finance' ? ((quotes.length + invoices.length + rateRules.length + tenders.length) === 0 ? <div className="crm-workspace-empty"><WalletCards size={24} />No quotes, invoices, rates, or tenders recorded for this account yet.</div> : <div className="crm-finance-list"><div className="crm-finance-summary"><div><span>Outstanding</span><strong>${invoices.filter((invoice) => invoice.status === 'sent' || invoice.status === 'overdue').reduce((sum, invoice) => sum + invoice.total_amount, 0).toFixed(2)}</strong></div><div><span>Paid</span><strong>${invoices.filter((invoice) => invoice.status === 'paid').reduce((sum, invoice) => sum + invoice.total_amount, 0).toFixed(2)}</strong></div><div><span>Active billing rates</span><strong>{rateRules.filter((rule) => rule.active).length}</strong></div><div><span>Open tenders</span><strong>{tenders.filter((tender) => tender.status !== 'awarded' && tender.status !== 'declined').length}</strong></div></div><div className="crm-finance-columns"><div><h4>Quotes</h4>{quotes.length === 0 ? <p className="crm-workspace-subtle">No quotes yet.</p> : quotes.map((quote) => <article key={quote.id}><div><strong>{quote.title}</strong><span className={`crm-status-pill status-${quote.status}`}>{quote.status}</span></div><p>${quote.total_charge.toFixed(2)} · {new Date(quote.created_at).toLocaleDateString('en-NZ')}{quote.service_agreement_id ? ' · variation' : ''}</p>{onOpenQuote && (quote.status === 'draft' || quote.status === 'sent') && <button type="button" className="btn btn-sm btn-secondary" onClick={() => onOpenQuote(account, quote)}>{quote.status === 'draft' ? 'Continue pricing' : 'Open quote'}</button>}</article>)}</div><div><h4>Invoices</h4>{invoices.length === 0 ? <p className="crm-workspace-subtle">No invoices yet.</p> : invoices.map((invoice) => <article key={invoice.id}><div><strong>{invoice.invoice_number}</strong><span className={`crm-status-pill status-${invoice.status}`}>{invoice.status}</span></div><p>${invoice.total_amount.toFixed(2)} · due {invoice.due_date}</p></article>)}</div><div><h4>Billing rates</h4>{rateRules.length === 0 ? <p className="crm-workspace-subtle">No client-specific billing rates yet.</p> : rateRules.map((rule) => <article key={rule.id}><div><strong>{rule.name}</strong><span className={rule.active ? 'is-ready' : 'is-attention'}>{rule.active ? 'Active' : 'Inactive'}</span></div><p>{rule.rate_type} · ${rule.amount.toFixed(2)}{rule.service_type ? ` · ${rule.service_type}` : ''}</p></article>)}</div><div><h4>Tenders</h4>{tenders.length === 0 ? <p className="crm-workspace-subtle">No tenders for this account yet.</p> : tenders.map((tender) => <article key={tender.id}><div><strong>{tender.title}</strong><span className={`crm-status-pill status-${tender.status}`}>{tender.status}</span></div><p>{tender.estimated_value ? `$${tender.estimated_value.toFixed(2)}` : 'No estimate'}{tender.due_date ? ` · Due ${tender.due_date}` : ''}</p></article>)}</div></div></div>)
          : view === 'contacts' ? contacts.length === 0 ? <div className="crm-workspace-empty"><Users size={24} />No active contacts. Add the person your team should call first.</div> : <div className="crm-contact-list">{contacts.map((contact) => <article key={contact.id}><div className="crm-contact-avatar">{contact.first_name[0]}{contact.last_name[0]}</div><div><div className="crm-contact-name"><strong>{contact.first_name} {contact.last_name}</strong>{contact.is_primary && <span><Star size={11} />Primary</span>}{contact.is_emergency && <span className="is-emergency">Emergency</span>}</div><p>{contact.role_title ?? 'Role not recorded'}</p><div className="crm-contact-methods">{contact.email && <a href={`mailto:${contact.email}`}><Mail size={13} />{contact.email}</a>}{(contact.mobile ?? contact.phone) && <a href={`tel:${contact.mobile ?? contact.phone}`}><Phone size={13} />{contact.mobile ?? contact.phone}</a>}</div></div><div className="crm-contact-actions"><button type="button" onClick={() => openContact(contact)}>Edit</button><button type="button" disabled={saving} onClick={() => void deactivateContact(contact)}>Deactivate</button></div></article>)}</div> : activities.length === 0 ? <div className="crm-workspace-empty"><MessageSquarePlus size={24} />No relationship activity recorded yet.</div> : <div className="crm-activity-list">{activities.map((activity) => <article key={activity.id}><div className={`crm-activity-kind kind-${activity.activity_type}`}>{activity.activity_type}</div><div><header><strong>{activity.subject}</strong><time>{new Date(activity.occurred_at).toLocaleString('en-NZ')}</time></header>{activity.details && <p>{activity.details}</p>}{activity.outcome && <small>Outcome: {activity.outcome}</small>}{activity.follow_up_at && <div className="crm-follow-up"><CalendarClock size={13} />Follow up {new Date(activity.follow_up_at).toLocaleString('en-NZ')}{activity.completed_at ? <span className="crm-completed-badge"> — Completed {new Date(activity.completed_at).toLocaleDateString('en-NZ')}</span> : <button type="button" disabled={saving} onClick={() => void completeFollowUp(activity)}>Mark complete</button>}</div>}</div></article>)}</div>}
      </div>
      {showContactForm && <form className="crm-workspace-form" onSubmit={saveContact}><header><strong>{editing ? 'Edit contact' : 'New contact'}</strong><button type="button" onClick={() => setShowContactForm(false)}><X size={16} /></button></header><div className="crm-form-grid"><label><span>First name</span><input required value={contactForm.firstName} onChange={(e) => setContactForm({ ...contactForm, firstName: e.target.value })} /></label><label><span>Last name</span><input required value={contactForm.lastName} onChange={(e) => setContactForm({ ...contactForm, lastName: e.target.value })} /></label></div><label><span>Role or title</span><input value={contactForm.roleTitle} onChange={(e) => setContactForm({ ...contactForm, roleTitle: e.target.value })} /></label><div className="crm-form-grid"><label><span>Email</span><input type="email" value={contactForm.email} onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })} /></label><label><span>Mobile</span><input value={contactForm.mobile} onChange={(e) => setContactForm({ ...contactForm, mobile: e.target.value })} /></label></div><label><span>Phone</span><input value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })} /></label><div className="crm-checks"><label><input type="checkbox" checked={contactForm.isPrimary} onChange={(e) => setContactForm({ ...contactForm, isPrimary: e.target.checked })} />Primary contact</label><label><input type="checkbox" checked={contactForm.isEmergency} onChange={(e) => setContactForm({ ...contactForm, isEmergency: e.target.checked })} />Emergency contact</label></div><label><span>Internal notes</span><textarea rows={3} value={contactForm.notes} onChange={(e) => setContactForm({ ...contactForm, notes: e.target.value })} /></label><footer><span>At least one email or phone number is required.</span><div><button type="button" onClick={() => setShowContactForm(false)}>Cancel</button><button type="submit" disabled={saving || !contactForm.firstName.trim() || !contactForm.lastName.trim() || !(contactForm.email.trim() || contactForm.phone.trim() || contactForm.mobile.trim())}>{saving ? 'Saving' : editing ? 'Save changes' : 'Add contact'}</button></div></footer></form>}
      {showActivityForm && <form className="crm-workspace-form" onSubmit={saveActivity}><header><strong>Log relationship activity</strong><button type="button" onClick={() => setShowActivityForm(false)}><X size={16} /></button></header><div className="crm-form-grid"><label><span>Activity type</span><select value={activityForm.type} onChange={(e) => setActivityForm({ ...activityForm, type: e.target.value })}><option value="call">Call</option><option value="email">Email</option><option value="meeting">Meeting</option><option value="note">Note</option><option value="task">Task</option></select></label><label><span>Occurred at</span><input type="datetime-local" required value={activityForm.occurredAt} onChange={(e) => setActivityForm({ ...activityForm, occurredAt: e.target.value })} /></label></div><label><span>Subject</span><input required value={activityForm.subject} onChange={(e) => setActivityForm({ ...activityForm, subject: e.target.value })} /></label><label><span>Details</span><textarea rows={4} value={activityForm.details} onChange={(e) => setActivityForm({ ...activityForm, details: e.target.value })} /></label><label><span>Outcome</span><input value={activityForm.outcome} onChange={(e) => setActivityForm({ ...activityForm, outcome: e.target.value })} /></label><label><span>Follow up at</span><input type="datetime-local" value={activityForm.followUpAt} onChange={(e) => setActivityForm({ ...activityForm, followUpAt: e.target.value })} /></label><footer><span>Activities are append-only account history.</span><div><button type="button" onClick={() => setShowActivityForm(false)}>Cancel</button><button type="submit" disabled={saving || !activityForm.subject.trim()}>{saving ? 'Recording' : 'Record activity'}</button></div></footer></form>}
        {siteDialogOpen && <CrmSiteDialog account={{ id: account.id, name: account.name }} locationId={siteDialogLocationId ?? undefined} onClose={() => setSiteDialogOpen(false)} onCreated={() => { setSiteDialogOpen(false); setNotice('Site created. Continue with its zones and boundary inside Places.'); void loadWorkspace(); }} />}
        {locationDialogOpen && locationStage === 'search' && <form className="crm-workspace-form" onSubmit={searchLocations}><header><strong>Find location / place</strong><button type="button" onClick={() => setLocationDialogOpen(false)}><X size={16} /></button></header><p>Search physical place records before creating a Location House. Results never expose another account's organization, finance, contacts, jobs, safety notes, or agreements.</p><div className="crm-form-grid"><label><span>Location name</span><input value={locationForm.name} onChange={(event) => setLocationForm({ ...locationForm, name: event.target.value })} placeholder="e.g. Nelson Civic Centre" /></label><label><span>Street address</span><input value={locationForm.address} onChange={(event) => setLocationForm({ ...locationForm, address: event.target.value })} placeholder="Full physical address" /></label></div><footer><button type="button" onClick={() => setLocationDialogOpen(false)}>Cancel</button><button type="submit" disabled={saving || (locationForm.name.trim().length < 2 && locationForm.address.trim().length < 4)}>{saving ? 'Searching' : 'Search places'}</button></footer>{locationSearched && <section className="crm-location-lookup-results"><strong>{locationCandidates.length ? 'Possible physical place matches' : 'No matching physical places found'}</strong><span>{locationCandidates.length ? 'Review the shared physical setup before creating another Location House.' : 'A new Location House can be created for this account.'}</span>{locationCandidates.map((candidate) => <article key={candidate.location_id}><div><strong>{candidate.name}</strong><span>{[candidate.address, candidate.suburb, candidate.postcode].filter(Boolean).join(', ') || 'Address not recorded'}</span><small>{candidate.match_reason} · {candidate.site_count} site facet{candidate.site_count === 1 ? '' : 's'} · {candidate.zone_count} zone facet{candidate.zone_count === 1 ? '' : 's'} · {candidate.boundary_state}</small></div>{candidate.belongs_to_account ? <button type="button" onClick={() => { setLocationDialogOpen(false); setManagedLocationId(candidate.location_id); }}>Open existing place</button> : <em>Existing place is managed by another account. Arrange authorized service access; do not duplicate it.</em>}</article>)}{!locationCandidates.some((candidate) => candidate.match_reason === 'Exact address match') && <button type="button" onClick={() => setLocationStage('create')}>Create new location</button>}</section>}</form>}
        {locationDialogOpen && locationStage === 'create' && <form className="crm-workspace-form" onSubmit={createLocation}><header><strong>Create location / place</strong><button type="button" onClick={() => setLocationDialogOpen(false)}><X size={16} /></button></header><p>Create an organization-owned Location House only after no matching physical place is found. Sites and zones remain sibling facets managed from this organization card.</p><div className="crm-form-grid"><label><span>Location name</span><input required maxLength={200} value={locationForm.name} onChange={(event) => setLocationForm({ ...locationForm, name: event.target.value })} placeholder="e.g. Nelson Civic Centre" /></label><label><span>Street address</span><input value={locationForm.address} onChange={(event) => setLocationForm({ ...locationForm, address: event.target.value })} placeholder="Full physical address" /></label></div><div className="crm-form-grid"><label><span>Suburb / locality</span><input value={locationForm.suburb} onChange={(event) => setLocationForm({ ...locationForm, suburb: event.target.value })} /></label><label><span>Postcode</span><input inputMode="numeric" value={locationForm.postcode} onChange={(event) => setLocationForm({ ...locationForm, postcode: event.target.value })} /></label></div><label><span>Location notes</span><textarea rows={3} value={locationForm.notes} onChange={(event) => setLocationForm({ ...locationForm, notes: event.target.value })} placeholder="Access context, hazards, or other house-level notes" /></label><footer><button type="button" onClick={() => setLocationStage('search')}>Back to matches</button><button type="submit" disabled={saving || !locationForm.name.trim()}>{saving ? 'Creating' : 'Create location / place'}</button></footer></form>}
        {managedLocationId && <OperationalPlaceManager locationId={managedLocationId} onClose={() => { setManagedLocationId(null); void loadWorkspace(); }} onSaved={() => void loadWorkspace()} />}
      {view === 'sites' && <section className="crm-location-finance"><header><div><span>Location house 360</span><strong>Agreements and finance by place</strong><p>Commercial authority is held at the Site or Zone under this physical house.</p></div></header>{locations.map((location) => { const siteIdsAtLocation = sites.filter((site) => site.location_id === location.id).map((site) => site.id); const zoneIdsAtLocation = zones.filter((zone) => zone.location_id === location.id).map((zone) => zone.id); const agreementsAtLocation = locationAgreements.filter((link) => (link.site_id !== null && siteIdsAtLocation.includes(link.site_id)) || (link.zone_id !== null && zoneIdsAtLocation.includes(link.zone_id))); const financeAtLocation = locationFinance.filter((finance) => (finance.site_id !== null && siteIdsAtLocation.includes(finance.site_id)) || (finance.zone_id !== null && zoneIdsAtLocation.includes(finance.zone_id))); return <article key={location.id}><div className="crm-location-finance-heading"><strong>{location.name}</strong><span>{agreementsAtLocation.length} agreement link{agreementsAtLocation.length === 1 ? '' : 's'} · {financeAtLocation.length} finance record{financeAtLocation.length === 1 ? '' : 's'}</span></div>{agreementsAtLocation.length > 0 ? <div className="crm-location-agreements">{agreementsAtLocation.map((link) => <div key={link.id}><strong>{link.agreement?.name ?? 'Service agreement'}</strong><span>{link.agreement?.agreement_type ?? 'operational'} · {link.status} · contract price {link.share_contract_price ? 'shared' : 'private'} · actual cost {link.share_actual_cost ? 'shared' : 'private'}</span></div>)}</div> : <p className="crm-workspace-subtle">No service agreement is anchored to this house yet.</p>}{financeAtLocation.length > 0 && <div className="crm-location-finance-grid">{financeAtLocation.map((finance) => <div key={finance.id}><span>{finance.billing_model.replaceAll('_', ' ')}</span>{finance.hourly_rate != null && <strong>NZ${Number(finance.hourly_rate).toFixed(2)}/hr</strong>}{finance.per_visit_rate != null && <strong>NZ${Number(finance.per_visit_rate).toFixed(2)}/visit</strong>}{finance.flat_rate_monthly != null && <strong>NZ${Number(finance.flat_rate_monthly).toFixed(2)}/month</strong>}<small>{finance.payment_terms_days} day payment terms</small></div>)}</div>}</article>; })}</section>}
      {setupAgreement && <CrmAgreementSetupDialog agreement={{ id: setupAgreement.id, name: setupAgreement.name, clientName: account.name, invitationStatus: setupAgreement.invitation_status }} onClose={() => { setSetupAgreement(null); void loadWorkspace(); }} />}
    </section>
  </div>;
}
