import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CalendarClock, Mail, MessageSquarePlus, Phone, Star, UserPlus, Users, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './CrmAccountWorkspace.css';

export interface CrmWorkspaceAccount {
  id: string;
  name: string;
  agreementId?: string | null;
}

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

export function CrmAccountWorkspace({ account, onClose }: { account: CrmWorkspaceAccount; onClose: () => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [view, setView] = useState<'contacts' | 'activity'>('contacts');
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
    const [contactResponse, activityResponse] = await Promise.all([
      supabase.from('crm_contacts').select('id,first_name,last_name,role_title,email,phone,mobile,is_primary,is_emergency,notes,updated_at,deactivated_at').eq('organization_id', account.id).is('deactivated_at', null).order('is_primary', { ascending: false }).order('last_name'),
      supabase.from('crm_account_activities').select('id,activity_type,subject,details,outcome,occurred_at,follow_up_at,created_at,completed_at,completed_by,completion_notes').eq('account_organization_id', account.id).order('occurred_at', { ascending: false }).limit(50),
    ]);
    if (contactResponse.error || activityResponse.error) setError(contactResponse.error?.message ?? activityResponse.error?.message ?? 'Account workspace could not be loaded.');
    else {
      setContacts((contactResponse.data as Contact[]) ?? []);
      setActivities((activityResponse.data as Activity[]) ?? []);
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
      <header><div><span>Account workspace</span><h2 id="crm-workspace-title">{account.name}</h2><p>People, communication history, and next actions.</p></div><button type="button" onClick={onClose} aria-label="Close account workspace"><X size={19} /></button></header>
      {error && <div className="crm-workspace-message is-error" role="alert">{error}</div>}
      {notice && <div className="crm-workspace-message is-success" role="status">{notice}</div>}
      <nav aria-label="Account workspace views"><button type="button" className={view === 'contacts' ? 'is-active' : ''} onClick={() => setView('contacts')}><Users size={16} />Contacts <strong>{contacts.length}</strong></button><button type="button" className={view === 'activity' ? 'is-active' : ''} onClick={() => setView('activity')}><CalendarClock size={16} />Activity <strong>{activities.length}</strong></button></nav>
      <div className="crm-workspace-toolbar"><div><strong>{view === 'contacts' ? 'Account contacts' : 'Relationship timeline'}</strong><span>{view === 'contacts' ? 'Maintain decision-makers, operational contacts, and emergency escalation.' : 'Record human interactions and make follow-up visible.'}</span></div>{view === 'contacts' ? <button type="button" onClick={() => openContact()}><UserPlus size={16} />Add contact</button> : <button type="button" onClick={() => { setActivityForm({ ...emptyActivity, occurredAt: new Date().toISOString().slice(0, 16) }); setShowActivityForm(true); setError(null); }}><MessageSquarePlus size={16} />Log activity</button>}</div>
      <div className="crm-workspace-body">
        {loading ? <div className="crm-workspace-empty">Loading account record</div> : view === 'contacts' ? contacts.length === 0 ? <div className="crm-workspace-empty"><Users size={24} />No active contacts. Add the person your team should call first.</div> : <div className="crm-contact-list">{contacts.map((contact) => <article key={contact.id}><div className="crm-contact-avatar">{contact.first_name[0]}{contact.last_name[0]}</div><div><div className="crm-contact-name"><strong>{contact.first_name} {contact.last_name}</strong>{contact.is_primary && <span><Star size={11} />Primary</span>}{contact.is_emergency && <span className="is-emergency">Emergency</span>}</div><p>{contact.role_title ?? 'Role not recorded'}</p><div className="crm-contact-methods">{contact.email && <a href={`mailto:${contact.email}`}><Mail size={13} />{contact.email}</a>}{(contact.mobile ?? contact.phone) && <a href={`tel:${contact.mobile ?? contact.phone}`}><Phone size={13} />{contact.mobile ?? contact.phone}</a>}</div></div><div className="crm-contact-actions"><button type="button" onClick={() => openContact(contact)}>Edit</button><button type="button" disabled={saving} onClick={() => void deactivateContact(contact)}>Deactivate</button></div></article>)}</div> : activities.length === 0 ? <div className="crm-workspace-empty"><MessageSquarePlus size={24} />No relationship activity recorded yet.</div> : <div className="crm-activity-list">{activities.map((activity) => <article key={activity.id}><div className={`crm-activity-kind kind-${activity.activity_type}`}>{activity.activity_type}</div><div><header><strong>{activity.subject}</strong><time>{new Date(activity.occurred_at).toLocaleString('en-NZ')}</time></header>{activity.details && <p>{activity.details}</p>}{activity.outcome && <small>Outcome: {activity.outcome}</small>}{activity.follow_up_at && <div className="crm-follow-up"><CalendarClock size={13} />Follow up {new Date(activity.follow_up_at).toLocaleString('en-NZ')}{activity.completed_at ? <span className="crm-completed-badge"> — Completed {new Date(activity.completed_at).toLocaleDateString('en-NZ')}</span> : <button type="button" disabled={saving} onClick={() => void completeFollowUp(activity)}>Mark complete</button>}</div>}</div></article>)}</div>}
      </div>
      {showContactForm && <form className="crm-workspace-form" onSubmit={saveContact}><header><strong>{editing ? 'Edit contact' : 'New contact'}</strong><button type="button" onClick={() => setShowContactForm(false)}><X size={16} /></button></header><div className="crm-form-grid"><label><span>First name</span><input required value={contactForm.firstName} onChange={(e) => setContactForm({ ...contactForm, firstName: e.target.value })} /></label><label><span>Last name</span><input required value={contactForm.lastName} onChange={(e) => setContactForm({ ...contactForm, lastName: e.target.value })} /></label></div><label><span>Role or title</span><input value={contactForm.roleTitle} onChange={(e) => setContactForm({ ...contactForm, roleTitle: e.target.value })} /></label><div className="crm-form-grid"><label><span>Email</span><input type="email" value={contactForm.email} onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })} /></label><label><span>Mobile</span><input value={contactForm.mobile} onChange={(e) => setContactForm({ ...contactForm, mobile: e.target.value })} /></label></div><label><span>Phone</span><input value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })} /></label><div className="crm-checks"><label><input type="checkbox" checked={contactForm.isPrimary} onChange={(e) => setContactForm({ ...contactForm, isPrimary: e.target.checked })} />Primary contact</label><label><input type="checkbox" checked={contactForm.isEmergency} onChange={(e) => setContactForm({ ...contactForm, isEmergency: e.target.checked })} />Emergency contact</label></div><label><span>Internal notes</span><textarea rows={3} value={contactForm.notes} onChange={(e) => setContactForm({ ...contactForm, notes: e.target.value })} /></label><footer><span>At least one email or phone number is required.</span><div><button type="button" onClick={() => setShowContactForm(false)}>Cancel</button><button type="submit" disabled={saving || !contactForm.firstName.trim() || !contactForm.lastName.trim() || !(contactForm.email.trim() || contactForm.phone.trim() || contactForm.mobile.trim())}>{saving ? 'Saving' : editing ? 'Save changes' : 'Add contact'}</button></div></footer></form>}
      {showActivityForm && <form className="crm-workspace-form" onSubmit={saveActivity}><header><strong>Log relationship activity</strong><button type="button" onClick={() => setShowActivityForm(false)}><X size={16} /></button></header><div className="crm-form-grid"><label><span>Activity type</span><select value={activityForm.type} onChange={(e) => setActivityForm({ ...activityForm, type: e.target.value })}><option value="call">Call</option><option value="email">Email</option><option value="meeting">Meeting</option><option value="note">Note</option><option value="task">Task</option></select></label><label><span>Occurred at</span><input type="datetime-local" required value={activityForm.occurredAt} onChange={(e) => setActivityForm({ ...activityForm, occurredAt: e.target.value })} /></label></div><label><span>Subject</span><input required value={activityForm.subject} onChange={(e) => setActivityForm({ ...activityForm, subject: e.target.value })} /></label><label><span>Details</span><textarea rows={4} value={activityForm.details} onChange={(e) => setActivityForm({ ...activityForm, details: e.target.value })} /></label><label><span>Outcome</span><input value={activityForm.outcome} onChange={(e) => setActivityForm({ ...activityForm, outcome: e.target.value })} /></label><label><span>Follow up at</span><input type="datetime-local" value={activityForm.followUpAt} onChange={(e) => setActivityForm({ ...activityForm, followUpAt: e.target.value })} /></label><footer><span>Activities are append-only account history.</span><div><button type="button" onClick={() => setShowActivityForm(false)}>Cancel</button><button type="submit" disabled={saving || !activityForm.subject.trim()}>{saving ? 'Recording' : 'Record activity'}</button></div></footer></form>}
    </section>
  </div>;
}
