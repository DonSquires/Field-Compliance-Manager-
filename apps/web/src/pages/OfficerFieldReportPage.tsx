import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardPlus, Crosshair, FileText, MapPin, RefreshCw, Send, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { resolveAddressForCoordinates } from '../lib/locationAddress';
import { supabase } from '../lib/supabase';
import './OfficerFieldReportPage.css';

type ReportType = 'incident' | 'maintenance' | 'health_safety';
type ReportSeverity = 'low' | 'medium' | 'high' | 'critical';
interface ShiftOption { id: string; service_type: string; scheduled_start: string; status: string; }
interface ReportRecord { id: string; report_type: ReportType; severity: ReportSeverity; status: string; title: string; description: string; location_name: string | null; reported_at: string; follow_up_required: boolean; review_notes: string | null; reviewed_at: string | null; }
interface GpsState { status: 'idle' | 'locating' | 'captured' | 'unavailable'; lat: number | null; lng: number | null; accuracy: number | null; }
type AddressResolution = 'idle' | 'resolving' | 'resolved' | 'unavailable';

const initialForm = { reportType: 'incident' as ReportType, severity: 'medium' as ReportSeverity, shiftId: '', title: '', description: '', locationName: '', address: '', immediateAction: '', followUp: false, followUpNotes: '' };

const OfficerFieldReportPage: React.FC = () => {
  const location = useLocation();
  const requestedReportId = new URLSearchParams(location.search).get('report');
  const { profile } = useAuth();
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [shifts, setShifts] = useState<ShiftOption[]>([]);
  const [form, setForm] = useState(initialForm);
  const [gps, setGps] = useState<GpsState>({ status: 'idle', lat: null, lng: null, accuracy: null });
  const [addressResolution, setAddressResolution] = useState<AddressResolution>('idle');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ id: string; receivedAt: string; shiftId: string | null; shiftLabel: string | null } | null>(null);
  const eventIdRef = useRef(crypto.randomUUID());
  const capturedAtRef = useRef(new Date().toISOString());

  const loadData = useCallback(async () => {
    if (!profile?.id || !profile.organizationId) return;
    setLoading(true); setError(null);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [reportResponse, shiftResponse] = await Promise.all([
      supabase.from('officer_field_reports').select('id, report_type, severity, status, title, description, location_name, reported_at, follow_up_required, review_notes, reviewed_at').eq('officer_id', profile.id).order('reported_at', { ascending: false }).limit(20),
      supabase.from('shifts').select('id, service_type, scheduled_start, status').eq('organization_id', profile.organizationId).eq('officer_user_id', profile.id).in('status', ['accepted', 'in_progress', 'completed']).gte('scheduled_end', since).order('scheduled_start', { ascending: false }).limit(10),
    ]);
    setReports((reportResponse.data as ReportRecord[]) ?? []); setShifts((shiftResponse.data as ShiftOption[]) ?? []);
    setForm((current) => ({ ...current, shiftId: current.shiftId || (shiftResponse.data as ShiftOption[] | null)?.[0]?.id || '' }));
    const failures = [reportResponse.error && `Reports: ${reportResponse.error.message}`, shiftResponse.error && `Shifts: ${shiftResponse.error.message}`].filter(Boolean);
    if (failures.length) setError(failures.join(' · ')); setLoading(false);
  }, [profile?.id, profile?.organizationId]);
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

  const canSubmit = form.title.trim().length >= 5 && form.description.trim().length >= 10 && (!form.followUp || form.followUpNotes.trim().length > 0) && !submitting;
  const submitReport = async (event: React.FormEvent) => {
    event.preventDefault(); if (!canSubmit) return;
    setSubmitting(true); setError(null); setReceipt(null);
    const { data, error: submitError } = await supabase.rpc('submit_officer_field_report', {
      p_client_event_id: eventIdRef.current, p_reported_at: capturedAtRef.current, p_report_type: form.reportType, p_severity: form.severity,
      p_title: form.title.trim(), p_description: form.description.trim(), p_location_name: form.locationName.trim() || null,
      p_address: form.address.trim() || null, p_gps_lat: gps.lat, p_gps_lng: gps.lng, p_shift_id: form.shiftId || null,
      p_immediate_action: form.immediateAction.trim() || null, p_follow_up_required: form.followUp,
      p_follow_up_notes: form.followUp ? form.followUpNotes.trim() : null,
    });
    const result = (data as Array<{ id: string; received_at: string; shift_id: string | null }> | null)?.[0];
    if (submitError || !result) setError(submitError?.message ?? 'Report receipt was not confirmed. Your entries remain available for retry.');
    else { const linkedShift = shifts.find((shift) => shift.id === result.shift_id);setReceipt({ id: result.id, receivedAt: result.received_at, shiftId: result.shift_id, shiftLabel: linkedShift ? `${linkedShift.service_type.replaceAll('_', ' ')} · ${new Date(linkedShift.scheduled_start).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}` : null }); setForm(initialForm); setGps({ status: 'idle', lat: null, lng: null, accuracy: null }); setAddressResolution('idle'); eventIdRef.current = crypto.randomUUID(); capturedAtRef.current = new Date().toISOString(); await loadData(); }
    setSubmitting(false);
  };

  return <div className="officer-report-page">
    <header className="officer-report-header"><div><span>Field evidence</span><h1>Field report</h1><p>Submit operational, maintenance, or health and safety concerns.</p></div><button type="button" onClick={() => void loadData()} disabled={loading} title="Refresh reports"><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /></button></header>
    {error && <div className="officer-report-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)} title="Dismiss"><X size={16} /></button></div>}
    {receipt && <div className="officer-report-message is-success" role="status"><CheckCircle2 size={17} /><span>Report confirmed · receipt {receipt.id.slice(0, 8)} · {receipt.shiftId ? `linked to ${receipt.shiftLabel ?? `shift ${receipt.shiftId.slice(0, 8)}`}` : 'not linked to a shift'} · {new Date(receipt.receivedAt).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</span><button type="button" onClick={() => setReceipt(null)} title="Dismiss"><X size={16} /></button></div>}
    <div className="officer-report-layout">
      <form className="officer-report-form" onSubmit={submitReport}><div className="officer-report-panel-heading"><div><span>New submission</span><h2>Report details</h2></div><ClipboardPlus size={20} /></div>
        <div className="officer-report-grid"><label><span>Type</span><select value={form.reportType} onChange={(e) => setForm({ ...form, reportType: e.target.value as ReportType })}><option value="incident">Incident</option><option value="maintenance">Maintenance</option><option value="health_safety">Health & safety</option></select></label><label><span>Severity</span><select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as ReportSeverity })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label></div>
        <label><span>Related shift</span><select value={form.shiftId} onChange={(e) => setForm({ ...form, shiftId: e.target.value })}><option value="">No related shift</option>{shifts.map((shift) => <option value={shift.id} key={shift.id}>{new Date(shift.scheduled_start).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })} · {shift.service_type.replaceAll('_', ' ')} · {shift.status}</option>)}</select></label>
        <label><span>Title</span><input required minLength={5} maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Short operational summary" /></label>
        <label><span>Description</span><textarea required minLength={10} maxLength={10000} rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What happened, who or what was affected, and current conditions" /></label>
        <div className="officer-report-grid"><label><span>Location name</span><input value={form.locationName} onChange={(e) => setForm({ ...form, locationName: e.target.value })} placeholder="Site or area" /></label><label><span>Address {addressResolution === 'resolving' ? '(resolving)' : addressResolution === 'resolved' ? '(GPS resolved)' : ''}</span><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Street address" /></label></div>
        <div className={`officer-report-gps state-${gps.status}`}><Crosshair size={18} /><div><strong>{gps.status === 'captured' ? 'GPS captured' : gps.status === 'locating' ? 'Locating' : gps.status === 'unavailable' ? 'GPS unavailable' : 'Add GPS evidence'}</strong><span>{gps.status === 'captured' ? `${gps.lat?.toFixed(5)}, ${gps.lng?.toFixed(5)} · ±${Math.round(gps.accuracy ?? 0)} m` : 'Optional. Reporting remains available if location services fail.'}</span></div><button type="button" onClick={acquireGps} disabled={gps.status === 'locating'}>{gps.status === 'captured' ? 'Refresh' : 'Capture'}</button></div>
        <label><span>Immediate action taken</span><textarea rows={3} value={form.immediateAction} onChange={(e) => setForm({ ...form, immediateAction: e.target.value })} placeholder="Controls applied, notifications made, or area isolated" /></label>
        <label className="officer-report-followup"><input type="checkbox" checked={form.followUp} onChange={(e) => setForm({ ...form, followUp: e.target.checked })} /><span><CheckCircle2 size={17} /><b>Follow-up required</b><small>Route this submission into the supervisor follow-up queue</small></span></label>
        {form.followUp && <label><span>Required follow-up</span><textarea required rows={3} value={form.followUpNotes} onChange={(e) => setForm({ ...form, followUpNotes: e.target.value })} placeholder="Action required, urgency, and owner if known" /></label>}
        <div className="officer-report-submit"><span>Submission is timestamped and audited. Failed receipts retain this form for retry.</span><button type="submit" disabled={!canSubmit}>{submitting ? <><RefreshCw size={16} className="is-spinning" />Submitting</> : <><Send size={16} />Submit report</>}</button></div>
      </form>
      <aside className="officer-report-history"><div className="officer-report-panel-heading"><div><span>My records</span><h2>Recent reports</h2></div><strong>{reports.length}</strong></div>{loading ? <div className="officer-report-empty"><RefreshCw size={19} className="is-spinning" />Loading reports</div> : reports.length === 0 ? <div className="officer-report-empty"><FileText size={22} />No reports submitted yet</div> : <div className="officer-report-list">{reports.map((report) => <article id={`officer-report-${report.id}`} className={`severity-${report.severity} ${report.id===requestedReportId?'is-context-focus':''}`} key={report.id}><div><strong>{report.title}</strong><span>{report.status}</span></div><p>{report.description}</p>{report.review_notes&&<section className="officer-report-review"><strong>Supervisor review</strong><span>{report.review_notes}</span><small>{report.reviewed_at?new Date(report.reviewed_at).toLocaleString('en-NZ'):'Review time unavailable'}</small></section>}<small><MapPin size={12} />{report.location_name || 'Location not named'} · {new Date(report.reported_at).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></article>)}</div>}</aside>
    </div>
  </div>;
};
export default OfficerFieldReportPage;
