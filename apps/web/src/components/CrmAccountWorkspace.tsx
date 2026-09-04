import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CalendarClock, FileBarChart, Handshake, Mail, MapPin, MessageSquarePlus, Phone, Radio, Star, UserPlus, Users, WalletCards, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { NavigateWithContext } from '../lib/workflowNavigation';
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

interface AgreementRow { id: string; name: string; agreement_type: string; invitation_status: string; provider_organization_id: string; client_organization_id: string; }
interface SiteRow { id: string; name: string; address: string | null; site_type: string | null; active: boolean; location_id: string | null; }
interface ZoneRow { id: string; name: string; zone_type: string; is_active: boolean; location_id: string | null; }
interface JobRow { id: string; job_type: string; status: string; priority: string; sla_breached: boolean; created_at: string; client_site_id: string | null; }
interface ReportPackRow { id: string; template_code: string; period_start: string; period_end: string; status: string; }
interface QuoteRow { id: string; title: string; status: string; total_charge: number; created_at: string; }
interface InvoiceRow { id: string; invoice_number: string; status: string; total_amount: number; due_date: string; }

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

export function CrmAccountWorkspace({ account, onClose, onNavigate }: { account: CrmWorkspaceAccount; onClose: () => void; onNavigate?: NavigateWithContext }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [agreements, setAgreements] = useState<AgreementRow[]>([]);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [reportPacks, setReportPacks] = useState<ReportPackRow[]>([]);
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [view, setView] = useState<'overview' | 'contacts' | 'activity' | 'agreements' | 'sites' | 'jobs' | 'reports' | 'finance'>('overview');
  const [contactForm, setContactForm] = useState(emptyContact);
  const [activityForm, setActivityForm] = useState(emptyActivity);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [showContactForm, setShowContactForm] = useState(false);
  const [showActivityForm, setShowActivityForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const contactRequestId = useRef(crypto.randomUUID());
  const activityRequestId = useRef(crypto.randomUUID());

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [contactResponse, activityResponse, agreementResponse, siteResponse, reportResponse, quoteResponse, invoiceResponse] = await Promise.all([
      supabase.from('crm_contacts').select('id,first_name,last_name,role_title,email,phone,mobile,is_primary,is_emergency,notes,updated_at,deactivated_at').eq('organization_id', account.id).is('deactivated_at', null).order('is_primary', { ascending: false }).order('last_name'),
      supabase.from('crm_account_activities').select('id,activity_type,subject,details,outcome,occurred_at,follow_up_at,created_at,completed_at,completed_by,completion_notes').eq('account_organization_id', account.id).order('occurred_at', { ascending: false }).limit(50),
      supabase.from('service_agreements').select('id,name,agreement_type,invitation_status,provider_organization_id,client_organization_id').or(`client_organization_id.eq.${account.id},provider_organization_id.eq.${account.id}`),
      supabase.from('client_sites').select('id,name,address,site_type,active,location_id').eq('organization_id', account.id).order('name'),
      supabase.from('monthly_report_packs').select('id,template_code,period_start,period_end,status').eq('organization_id', account.id).order('period_start', { ascending: false }).limit(24),
      supabase.from('quotes').select('id,title,status,total_charge,created_at').eq('client_org_id', account.id).order('created_at', { ascending: false }).limit(24),
      supabase.from('invoices').select('id,invoice_number,status,total_amount,due_date').eq('client_organization_id', account.id).order('due_date', { ascending: false }).limit(24),
    ]);
    const failures = [contactResponse.error, activityResponse.error, agreementResponse.error, siteResponse.error, reportResponse.error, quoteResponse.error, invoiceResponse.error].filter(Boolean);
    if (failures.length) setError(failures[0]?.message ?? 'Account workspace could not be loaded.');
    else {
      setContacts((contactResponse.data as Contact[]) ?? []);
      setActivities((activityResponse.data as Activity[]) ?? []);
      setAgreements((agreementResponse.data as AgreementRow[]) ?? []);
      setReportPacks((reportResponse.data as ReportPackRow[]) ?? []);
      setQuotes((quoteResponse.data as QuoteRow[]) ?? []);
      setInvoices((invoiceResponse.data as InvoiceRow[]) ?? []);
      const siteRows = (siteResponse.data as SiteRow[]) ?? [];
      setSites(siteRows);
      const locationIds = [...new Set(siteRows.map((site) => site.location_id).filter((value): value is string => Boolean(value)))];
      const siteIds = siteRows.map((site) => site.id);
      const [zoneResponse, jobResponse] = await Promise.all([
        locationIds.length ? supabase.from('location_zones').select('id,name,zone_type,is_active,location_id').in('location_id', locationIds).order('name') : Promise.resolve({ data: [], error: null }),
        siteIds.length ? supabase.from('dispatch_jobs').select('id,job_type,status,priority,sla_breached,created_at,client_site_id').in('client_site_id', siteIds).order('created_at', { ascending: false }).limit(24) : Promise.resolve({ data: [], error: null }),
      ]);
      setZones((zoneResponse.data as ZoneRow[]) ?? []);
      setJobs((jobResponse.data as JobRow[]) ?? []);
    }
    setLoading(false);
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

  return <div className="crm-workspace-backdrop">
    <section className="crm-workspace" role="dialog" aria-modal="true" aria-labelledby="crm-workspace-title">
      <header><div><span>Account workspace</span><h2 id="crm-workspace-title">{account.name}</h2><p>Commercial, operational, and relationship context for this organisation.</p></div><button type="button" onClick={onClose} aria-label="Close account workspace"><X size={19} /></button></header>
      {error && <div className="crm-workspace-message is-error" role="alert">{error}</div>}
      {notice && <div className="crm-workspace-message is-success" role="status">{notice}</div>}
      <nav aria-label="Account workspace views">
        <button type="button" className={view === 'overview' ? 'is-active' : ''} onClick={() => setView('overview')}><Users size={16} />Overview</button>
        <button type="button" className={view === 'agreements' ? 'is-active' : ''} onClick={() => setView('agreements')}><Handshake size={16} />Agreements <strong>{agreements.length}</strong></button>
        <button type="button" className={view === 'sites' ? 'is-active' : ''} onClick={() => setView('sites')}><MapPin size={16} />Sites &amp; zones <strong>{sites.length}</strong></button>
        <button type="button" className={view === 'jobs' ? 'is-active' : ''} onClick={() => setView('jobs')}><Radio size={16} />Response <strong>{jobs.length}</strong></button>
        <button type="button" className={view === 'contacts' ? 'is-active' : ''} onClick={() => setView('contacts')}><Users size={16} />Contacts <strong>{contacts.length}</strong></button>
        <button type="button" className={view === 'activity' ? 'is-active' : ''} onClick={() => setView('activity')}><CalendarClock size={16} />Activity <strong>{activities.length}</strong></button>
        <button type="button" className={view === 'reports' ? 'is-active' : ''} onClick={() => setView('reports')}><FileBarChart size={16} />Reports <strong>{reportPacks.length}</strong></button>
        <button type="button" className={view === 'finance' ? 'is-active' : ''} onClick={() => setView('finance')}><WalletCards size={16} />Finance <strong>{quotes.length + invoices.length}</strong></button>
      </nav>
      <div className="crm-workspace-toolbar"><div><strong>{view === 'overview' ? 'Account overview' : view === 'contacts' ? 'Account contacts' : view === 'activity' ? 'Relationship timeline' : view === 'agreements' ? 'Service agreements' : view === 'sites' ? 'Sites and zones' : view === 'jobs' ? 'Field response' : view === 'reports' ? 'Report packs' : 'Finance'}</strong><span>{view === 'overview' ? 'Readiness, commercial state, locations, and relationship ownership.' : view === 'contacts' ? 'Maintain decision-makers, operational contacts, and emergency escalation.' : view === 'activity' ? 'Record human interactions and make follow-up visible.' : view === 'agreements' ? 'Every commercial and operational agreement linking this account.' : view === 'sites' ? 'Covered places and their operational zones.' : view === 'jobs' ? 'Dispatch response history for this account\'s sites.' : view === 'reports' ? 'Generated and delivered monthly report packs.' : 'Quotes and invoices for this account.'}</span></div>{view === 'contacts' ? <button type="button" onClick={() => openContact()}><UserPlus size={16} />Add contact</button> : view === 'activity' ? <button type="button" onClick={() => { setActivityForm({ ...emptyActivity, occurredAt: new Date().toISOString().slice(0, 16) }); setShowActivityForm(true); setError(null); }}><MessageSquarePlus size={16} />Log activity</button> : view === 'agreements' ? <button type="button" onClick={() => onNavigate?.('relationships', { accountId: account.id })}>Open relationships</button> : view === 'sites' ? <button type="button" onClick={() => onNavigate?.('locations', { accountId: account.id })}>Open locations</button> : view === 'jobs' ? <button type="button" onClick={() => onNavigate?.('field-ops', { accountId: account.id })}>Open dispatch console</button> : view === 'reports' ? <button type="button" onClick={() => onNavigate?.('reports', { accountId: account.id })}>Open reports</button> : view === 'finance' ? <button type="button" onClick={() => onNavigate?.('crm', { accountId: account.id })}>Open finance</button> : null}</div>
      {view === 'overview' && <div className="crm-account-overview"><div><span>Account status</span><strong>{account.status ?? 'Status not recorded'}</strong></div><div><span>Primary contact</span><strong>{account.primaryContactName ?? 'Not assigned'}</strong></div><div><span>Covered sites</span><strong>{account.siteCount ?? 0}</strong></div><div><span>Latest quote</span><strong>{account.latestQuoteStatus ?? 'No quote'}</strong></div><div className={account.readinessBlockers?.length ? 'is-attention' : 'is-ready'}><span>Next action</span><strong>{account.nextAction ?? 'Review account readiness'}</strong><small>{account.readinessBlockers?.length ? `${account.readinessBlockers.length} readiness item${account.readinessBlockers.length === 1 ? '' : 's'} remaining` : 'Current readiness evidence is complete'}</small></div></div>}
      <div className="crm-workspace-body">
        {loading ? <div className="crm-workspace-empty">Loading account record</div> : view === 'agreements' ? (agreements.length === 0 ? <div className="crm-workspace-empty"><Handshake size={24} />No service agreements linked to this account yet.</div> : <div className="crm-agreement-list">{agreements.map((agreement) => <article key={agreement.id}><div><strong>{agreement.name}</strong><span className={`crm-status-pill status-${agreement.invitation_status}`}>{agreement.invitation_status}</span></div><p>{agreement.agreement_type}</p></article>)}</div>)
          : view === 'sites' ? (sites.length === 0 ? <div className="crm-workspace-empty"><MapPin size={24} />No sites recorded for this account yet.</div> : <div className="crm-site-list">{sites.map((site) => <article key={site.id}><div><strong>{site.name}</strong><span className={site.active ? 'is-ready' : 'is-attention'}>{site.active ? 'Active' : 'Inactive'}</span></div><p>{site.address ?? 'No address recorded'} · {site.site_type ?? 'Site'}</p><div className="crm-zone-chip-row">{zones.filter((zone) => zone.location_id === site.location_id).map((zone) => <span key={zone.id} className={`crm-zone-chip ${zone.is_active ? '' : 'is-inactive'}`}>{zone.name}</span>)}</div></article>)}</div>)
          : view === 'jobs' ? (jobs.length === 0 ? <div className="crm-workspace-empty"><Radio size={24} />No dispatch response history for this account's sites yet.</div> : <div className="crm-job-list">{jobs.map((job) => <article key={job.id}><div><strong>{job.job_type}</strong><span className={job.sla_breached ? 'is-attention' : 'is-ready'}>{job.status}</span></div><p>Priority {job.priority} · {new Date(job.created_at).toLocaleString('en-NZ')}</p></article>)}</div>)
          : view === 'reports' ? (reportPacks.length === 0 ? <div className="crm-workspace-empty"><FileBarChart size={24} />No report packs generated for this account yet.</div> : <div className="crm-report-list">{reportPacks.map((pack) => <article key={pack.id}><div><strong>{pack.template_code}</strong><span className={`crm-status-pill status-${pack.status}`}>{pack.status}</span></div><p>{pack.period_start} – {pack.period_end}</p></article>)}</div>)
          : view === 'finance' ? ((quotes.length + invoices.length) === 0 ? <div className="crm-workspace-empty"><WalletCards size={24} />No quotes or invoices recorded for this account yet.</div> : <div className="crm-finance-list"><h4>Quotes</h4>{quotes.length === 0 ? <p className="crm-workspace-subtle">No quotes yet.</p> : quotes.map((quote) => <article key={quote.id}><div><strong>{quote.title}</strong><span className={`crm-status-pill status-${quote.status}`}>{quote.status}</span></div><p>${quote.total_charge.toFixed(2)} · {new Date(quote.created_at).toLocaleDateString('en-NZ')}</p></article>)}<h4>Invoices</h4>{invoices.length === 0 ? <p className="crm-workspace-subtle">No invoices yet.</p> : invoices.map((invoice) => <article key={invoice.id}><div><strong>{invoice.invoice_number}</strong><span className={`crm-status-pill status-${invoice.status}`}>{invoice.status}</span></div><p>${invoice.total_amount.toFixed(2)} · due {invoice.due_date}</p></article>)}</div>)
          : view === 'contacts' ? contacts.length === 0 ? <div className="crm-workspace-empty"><Users size={24} />No active contacts. Add the person your team should call first.</div> : <div className="crm-contact-list">{contacts.map((contact) => <article key={contact.id}><div className="crm-contact-avatar">{contact.first_name[0]}{contact.last_name[0]}</div><div><div className="crm-contact-name"><strong>{contact.first_name} {contact.last_name}</strong>{contact.is_primary && <span><Star size={11} />Primary</span>}{contact.is_emergency && <span className="is-emergency">Emergency</span>}</div><p>{contact.role_title ?? 'Role not recorded'}</p><div className="crm-contact-methods">{contact.email && <a href={`mailto:${contact.email}`}><Mail size={13} />{contact.email}</a>}{(contact.mobile ?? contact.phone) && <a href={`tel:${contact.mobile ?? contact.phone}`}><Phone size={13} />{contact.mobile ?? contact.phone}</a>}</div></div><div className="crm-contact-actions"><button type="button" onClick={() => openContact(contact)}>Edit</button><button type="button" disabled={saving} onClick={() => void deactivateContact(contact)}>Deactivate</button></div></article>)}</div> : activities.length === 0 ? <div className="crm-workspace-empty"><MessageSquarePlus size={24} />No relationship activity recorded yet.</div> : <div className="crm-activity-list">{activities.map((activity) => <article key={activity.id}><div className={`crm-activity-kind kind-${activity.activity_type}`}>{activity.activity_type}</div><div><header><strong>{activity.subject}</strong><time>{new Date(activity.occurred_at).toLocaleString('en-NZ')}</time></header>{activity.details && <p>{activity.details}</p>}{activity.outcome && <small>Outcome: {activity.outcome}</small>}{activity.follow_up_at && <div className="crm-follow-up"><CalendarClock size={13} />Follow up {new Date(activity.follow_up_at).toLocaleString('en-NZ')}{activity.completed_at ? <span className="crm-completed-badge"> — Completed {new Date(activity.completed_at).toLocaleDateString('en-NZ')}</span> : <button type="button" disabled={saving} onClick={() => void completeFollowUp(activity)}>Mark complete</button>}</div>}</div></article>)}</div>}
      </div>
      {showContactForm && <form className="crm-workspace-form" onSubmit={saveContact}><header><strong>{editing ? 'Edit contact' : 'New contact'}</strong><button type="button" onClick={() => setShowContactForm(false)}><X size={16} /></button></header><div className="crm-form-grid"><label><span>First name</span><input required value={contactForm.firstName} onChange={(e) => setContactForm({ ...contactForm, firstName: e.target.value })} /></label><label><span>Last name</span><input required value={contactForm.lastName} onChange={(e) => setContactForm({ ...contactForm, lastName: e.target.value })} /></label></div><label><span>Role or title</span><input value={contactForm.roleTitle} onChange={(e) => setContactForm({ ...contactForm, roleTitle: e.target.value })} /></label><div className="crm-form-grid"><label><span>Email</span><input type="email" value={contactForm.email} onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })} /></label><label><span>Mobile</span><input value={contactForm.mobile} onChange={(e) => setContactForm({ ...contactForm, mobile: e.target.value })} /></label></div><label><span>Phone</span><input value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })} /></label><div className="crm-checks"><label><input type="checkbox" checked={contactForm.isPrimary} onChange={(e) => setContactForm({ ...contactForm, isPrimary: e.target.checked })} />Primary contact</label><label><input type="checkbox" checked={contactForm.isEmergency} onChange={(e) => setContactForm({ ...contactForm, isEmergency: e.target.checked })} />Emergency contact</label></div><label><span>Internal notes</span><textarea rows={3} value={contactForm.notes} onChange={(e) => setContactForm({ ...contactForm, notes: e.target.value })} /></label><footer><span>At least one email or phone number is required.</span><div><button type="button" onClick={() => setShowContactForm(false)}>Cancel</button><button type="submit" disabled={saving || !contactForm.firstName.trim() || !contactForm.lastName.trim() || !(contactForm.email.trim() || contactForm.phone.trim() || contactForm.mobile.trim())}>{saving ? 'Saving' : editing ? 'Save changes' : 'Add contact'}</button></div></footer></form>}
      {showActivityForm && <form className="crm-workspace-form" onSubmit={saveActivity}><header><strong>Log relationship activity</strong><button type="button" onClick={() => setShowActivityForm(false)}><X size={16} /></button></header><div className="crm-form-grid"><label><span>Activity type</span><select value={activityForm.type} onChange={(e) => setActivityForm({ ...activityForm, type: e.target.value })}><option value="call">Call</option><option value="email">Email</option><option value="meeting">Meeting</option><option value="note">Note</option><option value="task">Task</option></select></label><label><span>Occurred at</span><input type="datetime-local" required value={activityForm.occurredAt} onChange={(e) => setActivityForm({ ...activityForm, occurredAt: e.target.value })} /></label></div><label><span>Subject</span><input required value={activityForm.subject} onChange={(e) => setActivityForm({ ...activityForm, subject: e.target.value })} /></label><label><span>Details</span><textarea rows={4} value={activityForm.details} onChange={(e) => setActivityForm({ ...activityForm, details: e.target.value })} /></label><label><span>Outcome</span><input value={activityForm.outcome} onChange={(e) => setActivityForm({ ...activityForm, outcome: e.target.value })} /></label><label><span>Follow up at</span><input type="datetime-local" value={activityForm.followUpAt} onChange={(e) => setActivityForm({ ...activityForm, followUpAt: e.target.value })} /></label><footer><span>Activities are append-only account history.</span><div><button type="button" onClick={() => setShowActivityForm(false)}>Cancel</button><button type="submit" disabled={saving || !activityForm.subject.trim()}>{saving ? 'Recording' : 'Record activity'}</button></div></footer></form>}
    </section>
  </div>;
}
