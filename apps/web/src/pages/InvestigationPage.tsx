import React, { useEffect, useState } from 'react';
import { ClipboardPlus, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { describeLoadFailures } from '../lib/friendlyLoadError';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface Investigation {
  id: string;
  investigation_reference: string;
  title: string;
  investigation_type: string;
  status: string;
  priority: string;
  summary: string | null;
  opened_at: string;
}
interface InvestigationLink { id: string; entity_type: string; entity_id: string; link_role: string; link_reason: string; linked_at: string; }
interface InvestigationEvent { id: string; event_type: string; description: string; created_at: string; }
interface Agreement { id: string; name: string; client_organization_id: string; }
interface Site { id: string; name: string; address: string | null; }
interface Officer { id: string; display_name: string | null; email: string | null; }
interface DispatchJob { id: string; status: string; origin_type: string; assigned_officer_id: string | null; briefing_notes: string | null; }
// investigations_summary is the redacted, org-visible projection (no narrative) -
// safe for the list view; the detail view below still reads the base tables,
// which are admin-or-assigned-lead only.
interface InvestigationSummary { id: string; investigation_reference: string; title: string; investigation_type: string; status: string; priority: string; legal_hold: boolean; opened_at: string; resolved_at: string | null; closed_at: string | null; }

const InvestigationPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const { profile, operatingOrganizationId } = useAuth();
  const investigationId = params.get('id');
  const [investigation, setInvestigation] = useState<Investigation | null>(null);
  const [links, setLinks] = useState<InvestigationLink[]>([]);
  const [events, setEvents] = useState<InvestigationEvent[]>([]);
  const [list, setList] = useState<InvestigationSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [officers, setOfficers] = useState<Officer[]>([]);
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [officerId, setOfficerId] = useState('');
  const [agreementId, setAgreementId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [jobType, setJobType] = useState('incident');
  const [priority, setPriority] = useState('high');
  const [slaMinutes, setSlaMinutes] = useState('1440');
  const [instructions, setInstructions] = useState('');
  const [eventType, setEventType] = useState('case_note');
  const [eventDescription, setEventDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const orgId = operatingOrganizationId ?? profile?.organizationId;
    if (!investigationId) {
      setListLoading(true); setListError(null);
      const { data, error: listErr } = await supabase.from('investigations_summary')
        .select('id,investigation_reference,title,investigation_type,status,priority,legal_hold,opened_at,resolved_at,closed_at')
        .eq('organization_id', orgId ?? '')
        .order('opened_at', { ascending: false });
      if (listErr) setListError(describeLoadFailures([['investigations list', listErr]]) ?? 'Investigations list could not be loaded.');
      else setList((data as InvestigationSummary[]) ?? []);
      setListLoading(false); setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    const [investigationResponse, linksResponse, eventsResponse, agreementsResponse, sitesResponse, jobsResponse] = await Promise.all([
      supabase.from('investigations').select('id,investigation_reference,title,investigation_type,status,priority,summary,opened_at').eq('id', investigationId).single(),
      supabase.from('investigation_links').select('id,entity_type,entity_id,link_role,link_reason,linked_at').eq('investigation_id', investigationId).order('linked_at', { ascending: true }),
      supabase.from('investigation_events').select('id,event_type,description,created_at').eq('investigation_id', investigationId).order('created_at', { ascending: false }),
      orgId ? supabase.from('service_agreements').select('id,name,client_organization_id').eq('provider_organization_id', orgId).eq('agreement_type', 'operational').eq('invitation_status', 'accepted').order('name') : Promise.resolve({ data: [], error: null }),
      orgId ? supabase.from('client_sites').select('id,name,address').eq('organization_id', orgId).eq('active', true).order('name') : Promise.resolve({ data: [], error: null }),
      supabase.from('dispatch_jobs').select('id,status,origin_type,assigned_officer_id,briefing_notes').eq('investigation_id', investigationId).order('created_at', { ascending: false }),
    ]);
    let resolvedSitesResponse = sitesResponse;
    const agreementRows = (agreementsResponse.data as Agreement[]) ?? [];
    if (!sitesResponse.error && (!sitesResponse.data || sitesResponse.data.length === 0) && agreementRows.length > 0) {
      resolvedSitesResponse = await supabase
        .from('client_sites')
        .select('id,name,address')
        .in('client_organization_id', agreementRows.map((agreement) => agreement.client_organization_id))
        .eq('active', true)
        .order('name');
    }
    const officersResponse = agreementRows[0]
      ? await supabase.rpc('list_dispatch_target_officers', { p_service_agreement_id: agreementRows[0].id })
      : { data: [], error: null };
    const firstError = investigationResponse.error ?? linksResponse.error ?? eventsResponse.error ?? agreementsResponse.error ?? resolvedSitesResponse.error ?? officersResponse.error ?? jobsResponse.error;
    if (investigationResponse.error?.code === 'PGRST116') {
      setError("You do not have access to this investigation's full detail - only an organisation administrator or the assigned lead can open it.");
    } else if (firstError) {
      setError(describeLoadFailures([['investigation workspace', firstError]]) ?? 'Investigation workspace could not be loaded.');
    } else {
      setInvestigation(investigationResponse.data as Investigation);
      setLinks((linksResponse.data as InvestigationLink[]) ?? []);
      setEvents((eventsResponse.data as InvestigationEvent[]) ?? []);
      setAgreements((agreementsResponse.data as Agreement[]) ?? []);
      setSites((resolvedSitesResponse.data as Site[]) ?? []);
      setAgreementId((agreementsResponse.data?.[0] as Agreement | undefined)?.id ?? '');
      setSiteId((resolvedSitesResponse.data?.[0] as Site | undefined)?.id ?? '');
      setOfficers((officersResponse.data as Officer[]) ?? []);
      setOfficerId((officersResponse.data?.[0] as Officer | undefined)?.id ?? '');
      setJobs((jobsResponse.data as DispatchJob[]) ?? []);
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [investigationId, operatingOrganizationId, profile?.organizationId]);

  async function createFollowUp(event: React.FormEvent) {
    event.preventDefault();
    if (!investigation || !agreementId || !siteId || !instructions.trim()) return;
    setSaving(true); setError(null); setNotice(null);
    const { data, error: createError } = await supabase.rpc('create_investigation_follow_up_job', {
      p_investigation_id: investigation.id,
      p_client_request_id: crypto.randomUUID(),
      p_service_agreement_id: agreementId,
      p_client_site_id: siteId,
      p_job_type: jobType,
      p_priority: priority,
      p_sla_minutes: Number(slaMinutes),
      p_briefing_notes: instructions.trim(),
      p_dispatch_resource_id: null,
      p_shift_id: null,
    });
    if (createError || !data?.length) setError(describeLoadFailures([['follow-up dispatch', createError]]) ?? 'Follow-up dispatch was not confirmed.');
    else {
      let assignmentError: { message: string } | null = null;
      if (officerId) {
        const assignment = await supabase.rpc('assign_dispatch_job_to_officer', { p_job_id: data[0].id, p_officer_user_id: officerId });
        assignmentError = assignment.error;
      }
      if (assignmentError) setError(`Job created, but ${describeLoadFailures([['officer assignment', assignmentError]]) ?? 'officer assignment could not be saved.'}`);
      else setNotice(`Investigation follow-up job ${data[0].id.slice(0, 8)} queued${officerId ? ' for the selected officer' : ''}.`);
      setInstructions(''); await load();
    }
    setSaving(false);
  }

  async function assignJob(jobId: string, targetOfficerId: string) {
    if (!targetOfficerId) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: assignmentError } = await supabase.rpc('assign_dispatch_job_to_officer', { p_job_id: jobId, p_officer_user_id: targetOfficerId });
    if (assignmentError) setError(describeLoadFailures([['officer assignment', assignmentError]]) ?? 'Officer assignment could not be saved.');
    else { setNotice('Investigation dispatch assigned to the selected officer.'); await load(); }
    setSaving(false);
  }

  async function addTimelineEvent(event: React.FormEvent) {
    event.preventDefault();
    if (!investigation || !eventType.trim() || !eventDescription.trim()) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: eventError } = await supabase.rpc('add_investigation_event', {
      p_investigation_id: investigation.id,
      p_event_type: eventType.trim(),
      p_description: eventDescription.trim(),
      p_occurred_at: null,
    });
    if (eventError) setError(eventError.message);
    else {
      setEventDescription('');
      setNotice('Investigation timeline event recorded.');
      await load();
    }
    setSaving(false);
  }

  if (!investigationId) {
    if (listLoading) return <div className="page-container investigation-page"><div className="loading-state"><RefreshCw className="is-spinning" /> Loading investigations</div></div>;
    return <div className="page-container investigation-page">
      <header className="page-header"><div><span>Evidence / Investigations</span><h1>Investigations</h1><p>Existence and status only - open an investigation to see its full detail, if you are the assigned lead or an organisation administrator.</p></div><button type="button" onClick={() => void load()}><RefreshCw size={16} /> Refresh</button></header>
      {listError && <div className="alert alert-error" role="alert">{listError}</div>}
      {!listError && list.length === 0 && <div className="empty-state">No investigations recorded for this organisation.</div>}
      {list.length > 0 && <div className="contacts-list">{list.map((item) => <article className="contact-card" key={item.id}><div className="contact-header"><strong>{item.investigation_reference}</strong><small>{new Date(item.opened_at).toLocaleDateString('en-NZ')}</small></div><p>{item.title}</p><span>{item.investigation_type} · {item.priority} · {item.status}{item.legal_hold ? ' · legal hold' : ''}</span><button type="button" onClick={() => setParams({ id: item.id })}>Open</button></article>)}</div>}
    </div>;
  }
  if (loading) return <div className="page-container investigation-page"><div className="loading-state"><RefreshCw className="is-spinning" /> Loading investigation</div></div>;
  if (error && !investigation) return <div className="page-container investigation-page"><div className="alert alert-error">{error}</div></div>;
  if (!investigation) return <div className="page-container investigation-page"><div className="empty-state">Investigation not found.</div></div>;
  return <div className="page-container investigation-page">
    <header className="page-header"><div><span>Evidence / Investigation</span><h1>{investigation.investigation_reference}</h1><p>{investigation.title}</p></div><button type="button" onClick={() => void load()}><RefreshCw size={16} /> Refresh</button></header>
    {notice && <div className="alert alert-success" role="status">{notice}</div>}
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <section className="reports-section"><h2>Investigation overview</h2><p>{investigation.summary ?? 'No summary recorded.'}</p><p><strong>{investigation.investigation_type}</strong> · {investigation.priority} · {investigation.status} · opened {new Date(investigation.opened_at).toLocaleString('en-NZ')}</p></section>
    <section className="reports-section"><h2>Linked evidence and records</h2>{links.length === 0 ? <p>No records linked yet.</p> : <div className="contacts-list">{links.map((link) => <article className="contact-card" key={link.id}><div className="contact-header"><strong>{link.entity_type} · {link.link_role}</strong><small>{new Date(link.linked_at).toLocaleString('en-NZ')}</small></div><p>{link.entity_id}</p><span>{link.link_reason}</span></article>)}</div>}</section>
    <section className="reports-section"><h2>Timeline</h2><form onSubmit={addTimelineEvent} className="crm-form-grid"><label><span>Event type</span><select value={eventType} onChange={(event) => setEventType(event.target.value)}><option value="case_note">Case note</option><option value="contact">Contact or call</option><option value="correspondence">Correspondence received</option><option value="decision">Investigation decision</option><option value="evidence_review">Evidence review</option></select></label><label className="is-wide"><span>Timeline note</span><textarea required rows={3} maxLength={4000} value={eventDescription} onChange={(event) => setEventDescription(event.target.value)} placeholder="Record what happened, what was learned, and the next action" /></label><button type="submit" disabled={saving || !eventDescription.trim()}><ClipboardPlus size={16} />{saving ? 'Recording event' : 'Add timeline event'}</button></form>{events.length === 0 ? <p>No timeline events recorded.</p> : <div className="contacts-list">{events.map((event) => <article className="contact-card" key={event.id}><strong>{event.event_type}</strong><p>{event.description}</p><small>{new Date(event.created_at).toLocaleString('en-NZ')}</small></article>)}</div>}</section>
    <section className="reports-section"><h2>Investigation dispatch jobs</h2>{jobs.length === 0 ? <p>No investigation dispatch jobs yet.</p> : <div className="contacts-list">{jobs.map((job) => <article className="contact-card" key={job.id}><div className="contact-header"><strong>{job.origin_type} · {job.status}</strong><small>{job.id}</small></div><p>{job.briefing_notes ?? 'No briefing instructions recorded.'}</p>{job.status === 'pending' && <label><span>Assign to officer</span><select value={job.assigned_officer_id ?? ''} onChange={(event) => void assignJob(job.id, event.target.value)} disabled={saving}><option value="">Select officer</option>{officers.map((officer) => <option key={officer.id} value={officer.id}>{officer.display_name ?? officer.email ?? officer.id}</option>)}</select></label>}</article>)}</div>}</section>
    <section className="reports-section"><h2>Investigation follow-up dispatch</h2><p>This is an investigation-origin job. Its dispatch lifecycle remains standard, but the job is linked back to this matter and its officer report should be linked here when completed.</p><form onSubmit={createFollowUp} className="crm-form-grid"><label><span>Agreement</span><select required value={agreementId} onChange={(e) => setAgreementId(e.target.value)}><option value="">Select agreement</option>{agreements.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label><span>Site</span><select required value={siteId} onChange={(e) => setSiteId(e.target.value)}><option value="">Select site</option>{sites.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.address ?? 'Address not recorded'}</option>)}</select></label><label><span>Officer queue</span><select value={officerId} onChange={(e) => setOfficerId(e.target.value)}><option value="">Leave in general queue</option>{officers.map((item) => <option value={item.id} key={item.id}>{item.display_name ?? item.email ?? item.id}</option>)}</select></label><label><span>Job type</span><input value={jobType} onChange={(e) => setJobType(e.target.value)} /></label><label><span>Priority</span><select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label><span>SLA minutes</span><input type="number" min="1" max="1440" value={slaMinutes} onChange={(e) => setSlaMinutes(e.target.value)} /></label><label className="is-wide"><span>Officer instructions</span><textarea required rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="What must be checked, captured, and reported on re-attendance" /></label><button type="submit" disabled={saving || !agreementId || !siteId || !instructions.trim()}><Send size={16} />{saving ? 'Creating follow-up job' : 'Create investigation follow-up job'}</button></form></section>
  </div>;
};
export default InvestigationPage;
