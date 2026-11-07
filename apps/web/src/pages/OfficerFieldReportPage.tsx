import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardPlus, Crosshair, FileText, IdCard, MapPin, RefreshCw, Search, Send, Upload, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { useOfficerUnsavedWork } from '../context/OfficerUnsavedWorkContext';
import { resolveAddressCandidates, resolveAddressForCoordinates } from '../lib/locationAddress';
import { describeLoadFailures } from '../lib/friendlyLoadError';
import { supabase } from '../lib/supabase';
import { ShellLayout } from '../layouts/ShellLayout';
import { OfficerPhotoAttachments } from '../components/OfficerPhotoAttachments';
import type { OfficerPhotoTarget } from '../lib/officerRecordPhotos';
import { reportReceiptMatchesShift, resolveReportShift, validReportShiftId } from '../lib/officerReportShift';
import './OfficerFieldReportPage.css';
import './OfficerIncidentIdentity.css';

type ReportType = 'incident' | 'maintenance' | 'health_safety';
type ReportSeverity = 'low' | 'medium' | 'high' | 'critical';
interface ShiftOption { id: string; service_type: string; scheduled_start: string; status: string; }
interface ReportRecord { id: string; report_type: ReportType; severity: ReportSeverity; status: string; title: string; description: string; location_name: string | null; reported_at: string; follow_up_required: boolean; review_notes: string | null; reviewed_at: string | null; }
interface IncidentOption { id: string; incident_type: string; status: string; occurred_at: string; }
interface DocumentTypeOption { document_kind: string; display_name: string; }
interface GpsState { status: 'idle' | 'locating' | 'captured' | 'unavailable'; lat: number | null; lng: number | null; accuracy: number | null; }
type AddressResolution = 'idle' | 'resolving' | 'resolved' | 'unavailable';

const initialForm = { reportType: 'incident' as ReportType, severity: 'medium' as ReportSeverity, shiftId: '', title: '', description: '', locationName: '', address: '', immediateAction: '', followUp: false, followUpNotes: '' };
const initialIdentityForm = { incidentId: '', displayName: '', involvementRole: 'subject', notes: '', documentKind: 'national_id' };

const OfficerFieldReportPage: React.FC = () => {
  const location = useLocation();
  const requestedReportId = new URLSearchParams(location.search).get('report');
  const investigationId = new URLSearchParams(location.search).get('investigation');
  const dispatchJobId = new URLSearchParams(location.search).get('job');
  const requestedShiftId = new URLSearchParams(location.search).get('shift');
  const { profile } = useAuth();
  const { selectedSite, selectedZone, locationStatus } = useServiceRelationships();
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [shifts, setShifts] = useState<ShiftOption[]>([]);
  const [shiftContextError, setShiftContextError] = useState<string | null>(null);
  const [incidents, setIncidents] = useState<IncidentOption[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentTypeOption[]>([]);
  const [form, setForm] = useState(initialForm);
  const [gps, setGps] = useState<GpsState>({ status: 'idle', lat: null, lng: null, accuracy: null });
  const [addressResolution, setAddressResolution] = useState<AddressResolution>('idle');
  const [addressResolutionMessage, setAddressResolutionMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ id: string; receivedAt: string; shiftId: string | null; shiftLabel: string | null } | null>(null);
  const [photoTarget, setPhotoTarget] = useState<OfficerPhotoTarget | null>(null);
  const [photoPending, setPhotoPending] = useState(false);
  const [identityForm, setIdentityForm] = useState(initialIdentityForm);
  const [identityFiles, setIdentityFiles] = useState<File[]>([]);
  const [identityInputKey, setIdentityInputKey] = useState(0);
  const [identitySubmitting, setIdentitySubmitting] = useState(false);
  const [identityMessage, setIdentityMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const eventIdRef = useRef(crypto.randomUUID());
  const capturedAtRef = useRef(new Date().toISOString());
  const shiftScope = JSON.stringify([profile?.id, profile?.organizationId, requestedShiftId]);
  const shiftSelectionRef = useRef<{ scope: string; shiftId: string } | null>(null);
  const loadRequestRef = useRef(0);
  useOfficerUnsavedWork(Boolean(
    submitting || identitySubmitting || form.reportType !== initialForm.reportType || form.severity !== initialForm.severity
    || form.title || form.description || form.locationName || form.address || form.immediateAction || form.followUp || form.followUpNotes
    || gps.status === 'captured' || gps.status === 'locating'
    || identityForm.incidentId || identityForm.displayName || identityForm.notes
    || identityForm.involvementRole !== initialIdentityForm.involvementRole
    || identityForm.documentKind !== initialIdentityForm.documentKind || identityFiles.length,
  ));

  const loadData = useCallback(async () => {
    const request = ++loadRequestRef.current;
    if (!profile?.id || !profile.organizationId) {
      setReports([]);
      setShifts([]);
      setError('Organisation access could not be confirmed. Field reports are unavailable.');
      setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const [reportResponse, shiftResponse, incidentResponse, documentTypeResponse, requestedShiftResponse] = await Promise.all([
      supabase.from('officer_field_reports').select('id, report_type, severity, status, title, description, location_name, reported_at, follow_up_required, review_notes, reviewed_at').eq('officer_id', profile.id).order('reported_at', { ascending: false }).limit(20),
      supabase.from('shifts').select('id, service_type, scheduled_start, status').eq('officer_user_id', profile.id).eq('organization_id', profile.organizationId).in('status', ['accepted', 'in_progress', 'completed']).or(`status.eq.in_progress,and(scheduled_end.gte.${since},scheduled_start.lte.${now})`).order('status', { ascending: false }).order('scheduled_start', { ascending: false }).limit(10),
      supabase.from('incidents').select('id,incident_type,status,occurred_at').eq('officer_user_id', profile.id).in('status', ['open', 'in_review', 'escalated']).order('occurred_at', { ascending: false }).limit(50),
      supabase.rpc('get_identity_document_types'),
      validReportShiftId(requestedShiftId)
        ? supabase.from('shifts').select('id, service_type, scheduled_start, status').eq('id', requestedShiftId).eq('officer_user_id', profile.id).eq('organization_id', profile.organizationId).in('status', ['accepted', 'in_progress', 'completed']).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (request !== loadRequestRef.current) return;
    const availableShifts = shiftResponse.error ? [] : [...((shiftResponse.data as ShiftOption[] | null) ?? [])];
    const requestedShift = requestedShiftResponse.error ? null : requestedShiftResponse.data as ShiftOption | null;
    if (requestedShift && requestedShift.id === requestedShiftId && !availableShifts.some((shift) => shift.id === requestedShift.id)) availableShifts.push(requestedShift);
    setReports((reportResponse.data as ReportRecord[]) ?? []); setShifts(availableShifts);
    setIncidents((incidentResponse.data as IncidentOption[]) ?? []);
    setDocumentTypes(((documentTypeResponse.data as DocumentTypeOption[]) ?? []).filter((definition) => definition.document_kind !== 'person_photo'));
    // The query lists the in-progress shift first, then started shifts newest first, so the default is never a future shift.
    const selection = resolveReportShift(availableShifts.map((shift) => shift.id), requestedShiftId,
      shiftSelectionRef.current?.scope === shiftScope ? shiftSelectionRef.current.shiftId : null);
    shiftSelectionRef.current = { scope: shiftScope, shiftId: selection.shiftId };
    setForm((current) => ({ ...current, shiftId: selection.shiftId }));
    setShiftContextError(selection.error);
    const failure = describeLoadFailures([['reports', reportResponse.error], ['shifts', shiftResponse.error], ['requested shift', requestedShiftResponse.error], ['assigned incidents', incidentResponse.error], ['identity document types', documentTypeResponse.error]]);
    if (failure) setError(failure); setLoading(false);
  }, [profile?.id, profile?.organizationId, requestedShiftId, shiftScope]);
  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => { if (requestedReportId) document.getElementById(`officer-report-${requestedReportId}`)?.scrollIntoView({ block: 'center' }); }, [reports, requestedReportId]);

  const acquireGps = () => {
    if (!navigator.geolocation) { setGps({ status: 'unavailable', lat: null, lng: null, accuracy: null }); return; }
    setGps({ status: 'locating', lat: null, lng: null, accuracy: null });
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        setGps({ status: 'captured', lat: latitude, lng: longitude, accuracy });
        setAddressResolution('resolving');
        try {
          const resolved = await resolveAddressForCoordinates(latitude, longitude);
          if (resolved) setForm((current) => current.address.trim() ? current : { ...current, address: resolved.label });
          setAddressResolution(resolved ? 'resolved' : 'unavailable');
        } catch {
          setAddressResolution('unavailable');
        }
      },
      () => { setGps({ status: 'unavailable', lat: null, lng: null, accuracy: null }); setAddressResolution('unavailable'); },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 8_000 },
    );
  };

  const resolveTypedAddress = async () => {
    const query = form.address.trim() || form.locationName.trim();
    if (!query) return;
    setAddressResolution('resolving');
    setAddressResolutionMessage(null);
    try {
      const candidate = (await resolveAddressCandidates(query, 1))[0];
      if (!candidate) {
        setAddressResolution('unavailable');
        setAddressResolutionMessage('No address match was returned.');
        return;
      }
      setForm((current) => ({ ...current, address: candidate.label }));
      setAddressResolution('resolved');
      setAddressResolutionMessage(candidate.label);
    } catch (error) {
      setAddressResolution('unavailable');
      setAddressResolutionMessage(describeLoadFailures([['address', error instanceof Error ? error : { message: 'Address could not be resolved.' }]]) ?? 'Address could not be resolved.');
    }
  };

  const submitIncidentIdentity = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile?.id || !profile.organizationId || !identityForm.incidentId || !identityForm.displayName.trim() || !identityForm.notes.trim()) return;
    setIdentitySubmitting(true); setIdentityMessage(null);
    try {
      const { data: personLink, error: personError } = await supabase.rpc('record_incident_person_identity', {
        p_incident_id: identityForm.incidentId,
        p_involvement_role: identityForm.involvementRole,
        p_notes: identityForm.notes.trim(),
        p_person_record_id: null,
        p_staff_profile_id: null,
        p_display_name: identityForm.displayName.trim(),
        p_identity_document_id: null,
      });
      if (personError || !personLink?.person_record_id) throw personError ?? new Error('The incident person receipt was not returned.');
      const personRecordId = personLink.person_record_id as string;
      const failures: string[] = [];
      let queued = 0;
      for (const file of identityFiles) {
        if (file.size > 25 * 1024 * 1024) { failures.push(`${file.name} is larger than 25 MB.`); continue; }
        const attachmentId = crypto.randomUUID();
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-180);
        const storagePath = `org/${profile.organizationId}/identity/${profile.id}/incident-${identityForm.incidentId}/${attachmentId}-${safeName}`;
        let uploaded = false;
        let registered = false;
        try {
          const upload = await supabase.storage.from('identity-evidence').upload(storagePath, file, { contentType: file.type || 'application/octet-stream', upsert: false });
          if (upload.error) throw upload.error;
          uploaded = true;
          const registration = await supabase.rpc('register_incident_identity_attachment', {
            p_incident_id: identityForm.incidentId,
            p_person_record_id: personRecordId,
            p_document_kind: identityForm.documentKind,
            p_attachment_id: attachmentId,
            p_file_name: file.name,
            p_file_type: file.type || 'application/octet-stream',
            p_file_size_bytes: file.size,
            p_storage_path: storagePath,
          });
          if (registration.error) throw registration.error;
          registered = true;
          const perception = await supabase.functions.invoke('bob-perceive-image', { body: {
            mode: 'incident_identity_document', attachment_id: attachmentId, organization_id: profile.organizationId,
            incident_id: identityForm.incidentId, person_record_id: personRecordId, document_kind: identityForm.documentKind,
          } });
          if (perception.error || !perception.data?.success) throw perception.error ?? new Error(perception.data?.error || 'Identity extraction failed');
          queued += 1;
        } catch (identityError) {
          if (registered) await supabase.from('bob_attachments').update({ processing_state: 'failed' }).eq('id', attachmentId).eq('uploaded_by', profile.id);
          else if (uploaded) await supabase.storage.from('identity-evidence').remove([storagePath]);
          failures.push(`${file.name}: ${identityError instanceof Error ? identityError.message : 'could not be processed'}`);
        }
      }
      setIdentityForm(initialIdentityForm); setIdentityFiles([]); setIdentityInputKey((value) => value + 1);
      setIdentityMessage({ tone: failures.length ? 'error' : 'success', text: queued
        ? `${queued} identity source${queued === 1 ? '' : 's'} sent for administrator review. The incident person remains unverified until approval.${failures.length ? ` ${failures.join(' ')}` : ''}`
        : `Person recorded on the incident for administrator review.${failures.length ? ` ${failures.join(' ')}` : ''}` });
    } catch (identityError) {
      setIdentityMessage({ tone: 'error', text: identityError instanceof Error ? identityError.message : 'The incident identity could not be recorded.' });
    } finally { setIdentitySubmitting(false); }
  };

  const canSubmit = Boolean(profile?.id && profile.organizationId) && form.title.trim().length >= 5 && form.description.trim().length >= 10 && (!form.followUp || form.followUpNotes.trim().length > 0) && !submitting && !photoPending && !loading && !shiftContextError && (!form.shiftId || shifts.some((shift) => shift.id === form.shiftId));
  const submitReport = async (event: React.FormEvent) => {
    event.preventDefault(); if (!canSubmit) return;
    setSubmitting(true); setError(null); setReceipt(null);
    const submittedShiftId = form.shiftId || null;
    const { data, error: submitError } = await supabase.rpc('submit_officer_field_report', {
      p_client_event_id: eventIdRef.current, p_reported_at: capturedAtRef.current, p_report_type: form.reportType, p_severity: form.severity,
      p_title: form.title.trim(), p_description: form.description.trim(), p_location_name: form.locationName.trim() || null,
      p_address: form.address.trim() || null, p_gps_lat: gps.lat, p_gps_lng: gps.lng, p_shift_id: form.shiftId || null,
      p_immediate_action: form.immediateAction.trim() || null, p_follow_up_required: form.followUp,
      p_follow_up_notes: form.followUp ? form.followUpNotes.trim() : null,
      // Structured place from the already-live geofence resolution (ServiceRelationshipContext),
      // not the free-text address/GPS pair above - complements it, never overrides the narrative.
      p_site_id: selectedSite?.id ?? null, p_zone_id: selectedZone?.id ?? null,
    });
    const result = (data as Array<{ id: string; received_at: string; shift_id: string | null }> | null)?.[0];
    const receiptConfirmed = reportReceiptMatchesShift(result, submittedShiftId);
    if (!submitError && receiptConfirmed && result && profile?.organizationId) {
      setPhotoTarget({ kind: 'field_report', id: result.id, organizationId: profile.organizationId });
    }
    if (submitError || !result || !receiptConfirmed) setError(describeLoadFailures([['report submission', submitError]]) ?? (result ? 'Report receipt did not confirm the selected shift. The report may already be saved; your entries and submission identity remain available for retry. Do not start a new report.' : 'Report receipt was not confirmed. Your entries remain available for retry.'));
    else { const linkedShift = shifts.find((shift) => shift.id === result.shift_id); if (investigationId) { const { error: linkError } = await supabase.rpc('link_investigation_entity', { p_investigation_id: investigationId, p_entity_type: 'field_report', p_entity_id: result.id, p_link_role: 'primary', p_link_reason: dispatchJobId ? `Follow-up report from investigation dispatch ${dispatchJobId}` : 'Officer report submitted from investigation context' }); if (linkError) { setError(`Report confirmed, but ${describeLoadFailures([['investigation link', linkError]]) ?? 'the investigation link could not be saved.'}`); } } setReceipt({ id: result.id, receivedAt: result.received_at, shiftId: result.shift_id, shiftLabel: linkedShift ? `${linkedShift.service_type.replaceAll('_', ' ')} · ${new Date(linkedShift.scheduled_start).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}` : null }); setForm(initialForm); setGps({ status: 'idle', lat: null, lng: null, accuracy: null }); setAddressResolution('idle'); eventIdRef.current = crypto.randomUUID(); capturedAtRef.current = new Date().toISOString(); await loadData(); }
    setSubmitting(false);
  };

  return <ShellLayout shell="officer" className="officer-report-shell">
    <div className="officer-report-page">
    <header className="officer-report-header"><div><span>Field evidence</span><h1>Field report</h1><p>{investigationId ? 'Investigation follow-up report. This submission will be linked to the investigation.' : 'Submit operational, maintenance, or health and safety concerns.'}</p></div><button type="button" onClick={() => void loadData()} disabled={loading} title="Refresh reports" aria-label="Refresh field reports"><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /></button></header>
    {error && <div className="officer-report-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)} title="Dismiss" aria-label="Dismiss error"><X size={16} /></button></div>}
    {receipt && <div className="officer-report-message is-success" role="status"><CheckCircle2 size={17} /><span>Report confirmed · receipt {receipt.id.slice(0, 8)} · {receipt.shiftId ? `linked to ${receipt.shiftLabel ?? `shift ${receipt.shiftId.slice(0, 8)}`}` : 'not linked to a shift'} · {new Date(receipt.receivedAt).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</span><button type="button" onClick={() => setReceipt(null)} title="Dismiss" aria-label="Dismiss receipt"><X size={16} /></button></div>}
    <section className="officer-incident-identity" aria-labelledby="officer-photos-title">
      <h2 id="officer-photos-title">Report and incident photos</h2>
      <p>Submit a new report first, then attach camera or gallery photos to its confirmed receipt here. You can also add photos to your existing reports and assigned incidents. Failed photo uploads do not require a new report.</p>
      <label><span>Saved report or assigned incident</span><select
        aria-label="Photo attachment target" disabled={photoPending || submitting}
        value={photoTarget ? `${photoTarget.kind}:${photoTarget.id}` : ''}
        onChange={(event) => {
          const [kind, id] = event.target.value.split(':');
          setPhotoTarget(id && profile?.organizationId ? { kind: kind as OfficerPhotoTarget['kind'], id, organizationId: profile.organizationId } : null);
        }}>
        <option value="">Select a saved record</option>
        <optgroup label="My reports">
          {receipt && !reports.some((report) => report.id === receipt.id) && <option value={`field_report:${receipt.id}`}>Just submitted · {receipt.id.slice(0, 8)}</option>}
          {reports.map((report) => <option key={report.id} value={`field_report:${report.id}`}>{report.title} · {new Date(report.reported_at).toLocaleDateString('en-NZ')}</option>)}
        </optgroup>
        <optgroup label="Assigned incidents">
          {incidents.map((incident) => <option key={incident.id} value={`incident:${incident.id}`}>{incident.incident_type.replaceAll('_', ' ')} · {new Date(incident.occurred_at).toLocaleDateString('en-NZ')}</option>)}
        </optgroup>
      </select></label>
      {photoTarget && profile?.organizationId === photoTarget.organizationId && <OfficerPhotoAttachments key={`${photoTarget.organizationId}:${photoTarget.kind}:${photoTarget.id}`} target={photoTarget} onPendingChange={setPhotoPending} />}
      {photoPending && <p role="status">Upload or remove the selected photos before switching records or submitting another report.</p>}
    </section>
    <section className="officer-incident-identity" aria-labelledby="officer-incident-identity-title">
      <div className="officer-report-panel-heading"><div><span>Incident identity</span><h2 id="officer-incident-identity-title">Record a person and ID source</h2></div><IdCard size={20} /></div>
      <p>Use only for an active incident assigned to you. The person and source go to administrator review; this does not verify identity or grant staff authority.</p>
      {identityMessage && <div className={`officer-report-message is-${identityMessage.tone}`} role={identityMessage.tone === 'error' ? 'alert' : 'status'}><span>{identityMessage.text}</span></div>}
      {incidents.length === 0 ? <div className="officer-report-empty"><IdCard size={20} />No active incidents are assigned to you.</div> : (
        <form onSubmit={submitIncidentIdentity}>
          <div className="officer-report-grid">
            <label><span>Assigned incident</span><select required value={identityForm.incidentId} onChange={(event) => setIdentityForm({ ...identityForm, incidentId: event.target.value })}><option value="">Select an incident</option>{incidents.map((incident) => <option value={incident.id} key={incident.id}>{incident.incident_type.replaceAll('_', ' ')} · {incident.status} · {new Date(incident.occurred_at).toLocaleDateString('en-NZ')}</option>)}</select></label>
            <label><span>Person's involvement</span><select value={identityForm.involvementRole} onChange={(event) => setIdentityForm({ ...identityForm, involvementRole: event.target.value })}><option value="subject">Subject</option><option value="reporting_party">Reporting party</option><option value="witness">Witness</option><option value="affected_person">Affected person</option><option value="staff_involved">Staff involved</option><option value="other">Other</option></select></label>
          </div>
          <div className="officer-report-grid">
            <label><span>Name stated or shown</span><input required value={identityForm.displayName} onChange={(event) => setIdentityForm({ ...identityForm, displayName: event.target.value })} placeholder="Enter exactly what was stated or shown" /></label>
            <label><span>Evidence type</span><select value={identityForm.documentKind} onChange={(event) => setIdentityForm({ ...identityForm, documentKind: event.target.value })}>{documentTypes.map((definition) => <option value={definition.document_kind} key={definition.document_kind}>{definition.display_name}</option>)}</select></label>
          </div>
          <label><span>How was identity obtained?</span><textarea required rows={2} value={identityForm.notes} onChange={(event) => setIdentityForm({ ...identityForm, notes: event.target.value })} placeholder="For example: person stated their name and presented a driver licence" /></label>
          <label><span>ID source files (optional)</span><input key={identityInputKey} type="file" multiple accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,application/pdf" onChange={(event) => setIdentityFiles(Array.from(event.target.files ?? []))} /></label>
          <div className="officer-identity-submit"><span>{identityFiles.length ? `${identityFiles.length} source file${identityFiles.length === 1 ? '' : 's'} selected` : 'You may record the stated identity now and add evidence later.'}</span><button type="submit" disabled={identitySubmitting || !identityForm.incidentId || !identityForm.displayName.trim() || !identityForm.notes.trim()}>{identitySubmitting ? <><RefreshCw size={16} className="is-spinning" />Processing</> : <><Upload size={16} />Record identity</>}</button></div>
        </form>
      )}
    </section>
    <div className="officer-report-layout">
      <form className="officer-report-form" onSubmit={submitReport}><div className="officer-report-panel-heading"><div><span>New submission</span><h2>Report details</h2></div><ClipboardPlus size={20} /></div>
        <div className="officer-report-grid"><label><span>Type</span><select aria-label="Report type" value={form.reportType} onChange={(e) => setForm({ ...form, reportType: e.target.value as ReportType })}><option value="incident">Incident</option><option value="maintenance">Maintenance</option><option value="health_safety">Health & safety</option></select></label><label><span>Severity</span><select aria-label="Report severity" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as ReportSeverity })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label></div>
        <label><span>Related shift</span><select aria-label="Related shift" disabled={loading || submitting} value={form.shiftId} onChange={(e) => {
          const selection = resolveReportShift(shifts.map((shift) => shift.id), requestedShiftId, e.target.value);
          shiftSelectionRef.current = { scope: shiftScope, shiftId: selection.shiftId };
          setForm({ ...form, shiftId: selection.shiftId }); setShiftContextError(selection.error);
        }}><option value="">No related shift</option>{form.shiftId && !shifts.some((shift) => shift.id === form.shiftId) && <option value={form.shiftId} disabled>Requested / selected shift unavailable</option>}{shifts.map((shift) => <option value={shift.id} key={shift.id}>{new Date(shift.scheduled_start).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })} · {shift.service_type.replaceAll('_', ' ')} · {shift.status}</option>)}</select></label>
        {shiftContextError && <p role="alert">{shiftContextError}</p>}
        <label><span>Title</span><input aria-label="Report title" required minLength={5} maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Short operational summary" /></label>
        <label><span>Description</span><textarea aria-label="Report description" required minLength={10} maxLength={10000} rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What happened, who or what was affected, and current conditions" /></label>
        <div className="officer-report-grid"><label><span>Location name</span><input aria-label="Location name" value={form.locationName} onChange={(e) => setForm({ ...form, locationName: e.target.value })} placeholder="Site or area" /></label><label><span>Address {addressResolution === 'resolving' ? '(resolving)' : addressResolution === 'resolved' ? '(resolved)' : ''}</span><input aria-label="Street address" value={form.address} onChange={(e) => { setForm({ ...form, address: e.target.value }); setAddressResolution('idle'); setAddressResolutionMessage(null); }} placeholder="Street address" /></label></div>
        <div className={`officer-report-gps state-${addressResolution === 'unavailable' ? 'unavailable' : addressResolution === 'resolved' ? 'captured' : 'idle'}`}><MapPin size={18} /><div><strong>{addressResolution === 'resolving' ? 'Resolving address' : addressResolution === 'resolved' ? 'Address resolved' : addressResolution === 'unavailable' ? 'Address unavailable' : 'Resolve address'}</strong><span>{addressResolutionMessage ?? 'Ready to resolve from the entered place.'}</span></div><button type="button" onClick={() => void resolveTypedAddress()} disabled={addressResolution === 'resolving' || !(form.address.trim() || form.locationName.trim())} aria-label="Resolve address from location">{addressResolution === 'resolving' ? <RefreshCw size={15} className="is-spinning" /> : <Search size={15} />}Resolve</button></div>
        <div className={`officer-report-gps state-${gps.status}`}><Crosshair size={18} /><div><strong>{gps.status === 'captured' ? 'GPS captured' : gps.status === 'locating' ? 'Locating' : gps.status === 'unavailable' ? 'GPS unavailable' : 'Add GPS evidence'}</strong><span>{gps.status === 'captured' ? `${gps.lat?.toFixed(5)}, ${gps.lng?.toFixed(5)} · ±${Math.round(gps.accuracy ?? 0)} m` : 'Optional. Reporting remains available if location services fail.'}</span></div><button type="button" onClick={acquireGps} disabled={gps.status === 'locating'} aria-label={gps.status === 'captured' ? 'Refresh GPS location' : 'Capture GPS location'}>{gps.status === 'captured' ? 'Refresh' : 'Capture'}</button></div>
        <label><span>Immediate action taken</span><textarea aria-label="Immediate action taken" rows={3} value={form.immediateAction} onChange={(e) => setForm({ ...form, immediateAction: e.target.value })} placeholder="Controls applied, notifications made, or area isolated" /></label>
        <label className="officer-report-followup"><input aria-label="Mark as follow-up required" type="checkbox" checked={form.followUp} onChange={(e) => setForm({ ...form, followUp: e.target.checked })} /><span><CheckCircle2 size={17} /><b>Follow-up required</b><small>Route this submission into the supervisor follow-up queue</small></span></label>
        {form.followUp && <label><span>Required follow-up</span><textarea aria-label="Required follow-up action" required rows={3} value={form.followUpNotes} onChange={(e) => setForm({ ...form, followUpNotes: e.target.value })} placeholder="Action required, urgency, and owner if known" /></label>}
        <div className="officer-report-submit"><span>Submission is timestamped and audited. Failed receipts retain this form for retry.</span><button type="submit" disabled={!canSubmit}>{submitting ? <><RefreshCw size={16} className="is-spinning" />Submitting</> : <><Send size={16} />Submit report</>}</button></div>
      </form>
      <aside className="officer-report-history"><div className="officer-report-panel-heading"><div><span>My records</span><h2>Recent reports</h2></div><strong>{reports.length}</strong></div>{loading ? <div className="officer-report-empty"><RefreshCw size={19} className="is-spinning" />Loading reports</div> : reports.length === 0 ? <div className="officer-report-empty"><FileText size={22} />No reports submitted yet</div> : <div className="officer-report-list">{reports.map((report) => <article id={`officer-report-${report.id}`} className={`severity-${report.severity} ${report.id===requestedReportId?'is-context-focus':''}`} key={report.id}><div><strong>{report.title}</strong><span>{report.status}</span></div><p>{report.description}</p>{report.review_notes&&<section className="officer-report-review"><strong>Supervisor review</strong><span>{report.review_notes}</span><small>{report.reviewed_at?new Date(report.reviewed_at).toLocaleString('en-NZ'):'Review time unavailable'}</small></section>}<small><MapPin size={12} />{report.location_name || 'Location not named'} · {new Date(report.reported_at).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></article>)}</div>}</aside>
    </div>
    </div>
  </ShellLayout>;
};
export default OfficerFieldReportPage;
