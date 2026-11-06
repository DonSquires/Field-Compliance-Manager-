import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock3, MapPin, RefreshCw, ShieldCheck, Signpost, TriangleAlert } from 'lucide-react';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { useActiveModuleContext } from '../hooks/useActiveModuleContext';
import { supabase } from '../lib/supabase';
import { EndShiftDialog } from '../components/EndShiftDialog';
import { OfficerShiftBreakControl } from '../components/OfficerShiftBreakControl';
import './OfficerStaticGuardPage.css';

interface StaticPost {
  shift: { id: string; status: string; scheduled_start: string; scheduled_end: string; notes: string | null };
  stop: { id: string; status: string; sla_arrive_by: string; actual_arrived_at: string | null; actual_departed_at: string | null; officer_notes: string | null };
  module: { id: string; status: string; started_at: string | null; completed_at: string | null };
  place: { id: string; name: string; address: string | null; risk_level: string | null; site_brief: string | null; access_instructions: string | null; hs_notes: string | null };
  attendance_evidence: { arrival: StaticPostReceipt | null; departure: StaticPostReceipt | null };
}

interface StaticPostReceipt {
  reference: string;
  action: 'arrive' | 'depart';
  occurred_at: string;
  gps_result: string;
  timing_status: string;
  dwell_minutes: number | null;
  handover_recorded: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStoredReceipt(value: unknown): value is StaticPostReceipt | null {
  if (value === null) return true;
  return isRecord(value)
    && isString(value.reference)
    && (value.action === 'arrive' || value.action === 'depart')
    && isString(value.occurred_at)
    && isString(value.gps_result)
    && isString(value.timing_status)
    && (value.dwell_minutes === null || typeof value.dwell_minutes === 'number')
    && typeof value.handover_recorded === 'boolean';
}

function isStaticPost(value: unknown): value is StaticPost {
  if (!isRecord(value) || !isRecord(value.shift) || !isRecord(value.stop) || !isRecord(value.module) || !isRecord(value.place) || !isRecord(value.attendance_evidence)) return false;
  const { shift, stop, module, place, attendance_evidence: evidence } = value;
  return isString(shift.id) && isString(shift.status) && isString(shift.scheduled_start) && isString(shift.scheduled_end) && isNullableString(shift.notes)
    && isString(stop.id) && isString(stop.status) && isString(stop.sla_arrive_by) && isNullableString(stop.actual_arrived_at) && isNullableString(stop.actual_departed_at) && isNullableString(stop.officer_notes)
    && isString(module.id) && isString(module.status) && isNullableString(module.started_at) && isNullableString(module.completed_at)
    && isString(place.id) && isString(place.name) && isNullableString(place.address) && isNullableString(place.risk_level) && isNullableString(place.site_brief) && isNullableString(place.access_instructions) && isNullableString(place.hs_notes)
    && isStoredReceipt(evidence.arrival) && isStoredReceipt(evidence.departure);
}

function parseStaticPost(value: unknown): StaticPost | null {
  if (value === null) return null;
  if (!isStaticPost(value)) throw new Error('Static post data was incomplete. Refresh the page or contact operations.');
  return value;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : (error as { message?: string }).message ?? fallback;
}

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
}

export default function OfficerStaticGuardPage() {
  const [params] = useSearchParams();
  const requestedShiftId = params.get('shift');
  const navigate = useNavigate();
  const { selectedAgreementZones } = useServiceRelationships();
  const moduleContext = useActiveModuleContext('site_guard');
  const [post, setPost] = useState<StaticPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const contextLabel = moduleContext.governingJurisdictionName
    ?? (selectedAgreementZones.length > 0 ? `${selectedAgreementZones.length} agreement area${selectedAgreementZones.length === 1 ? '' : 's'}` : null);

  const load = useCallback(async () => {
    try {
      setLoading(true);setError(null);
      const { data, error: rpcError } = await supabase.rpc('get_officer_static_post', {
        p_shift_id: requestedShiftId,
      });
      if (rpcError) throw rpcError;
      const next = parseStaticPost(data);
      if (next && requestedShiftId && next.shift.id !== requestedShiftId) throw new Error('The requested shift was not confirmed.');
      setPost(next);
    } catch (loadError) {
      setError(errorMessage(loadError, 'Static post could not be loaded.'));
    } finally { setLoading(false); }
  }, [requestedShiftId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <div className="static-post-loading"><RefreshCw size={20} className="is-spinning" /> Loading static post</div>;
  return <main className="static-post-page">
    <header className="static-post-header"><div><span>Static guarding</span><h1>Assigned post</h1><p>Site instructions, attendance, and handover for your current assignment.{contextLabel ? ` Working context: ${contextLabel}.` : ''}</p></div><button type="button" onClick={() => void load()} title="Refresh static post"><RefreshCw size={18} /><span className="sr-only">Refresh static post</span></button></header>
    {error && <div className="static-post-message is-error" role="alert"><AlertTriangle size={18} />{error}</div>}
    {notice && <div className="static-post-message is-success" role="status"><CheckCircle2 size={18} />{notice}</div>}
    {!post ? <section className="static-post-empty"><ShieldCheck size={28} /><h2>No active static post</h2><p>Accepted static guarding assignments appear here when their contract and site are active.</p></section> : <>
      <section className="static-post-identity"><div><span>Current site</span><h2>{post.place.name}</h2><p>{post.place.address ?? 'Address not supplied'}</p></div><div className={`static-post-state state-${post.stop.status}`}><span>{post.stop.status.replaceAll('_', ' ')}</span><strong>{post.place.risk_level ? `${post.place.risk_level} risk` : 'Risk not rated'}</strong></div></section>
      <section className="static-post-timing" aria-label="Assignment timing"><div><Clock3 size={18} /><span>Rostered</span><strong>{formatDateTime(post.shift.scheduled_start)} - {new Date(post.shift.scheduled_end).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</strong></div><div><MapPin size={18} /><span>Arrival</span><strong>{formatDateTime(post.stop.actual_arrived_at)}</strong></div><div><Signpost size={18} /><span>Departure</span><strong>{formatDateTime(post.stop.actual_departed_at)}</strong></div></section>
      {(post.attendance_evidence.arrival || post.attendance_evidence.departure) && <section className="static-post-evidence" aria-label="Attendance receipts">
        <header><ShieldCheck size={18} /><h2>Attendance receipts</h2></header>
        <div>{post.attendance_evidence.arrival && <article><span>Arrival</span><strong>{post.attendance_evidence.arrival.reference}</strong><small>{formatDateTime(post.attendance_evidence.arrival.occurred_at)} · GPS {post.attendance_evidence.arrival.gps_result} · {post.attendance_evidence.arrival.timing_status.replaceAll('_', ' ')}</small></article>}{post.attendance_evidence.departure && <article><span>Departure</span><strong>{post.attendance_evidence.departure.reference}</strong><small>{formatDateTime(post.attendance_evidence.departure.occurred_at)} · GPS {post.attendance_evidence.departure.gps_result}{post.attendance_evidence.departure.dwell_minutes !== null ? ` · ${post.attendance_evidence.departure.dwell_minutes} min dwell` : ''}</small></article>}</div>
      </section>}
      <div className="static-post-columns">
        <section className="static-post-instructions"><header><ShieldCheck size={20} /><h2>Post brief</h2></header><dl><div><dt>Assignment</dt><dd>{post.place.site_brief ?? post.shift.notes ?? 'No site brief supplied.'}</dd></div><div><dt>Access</dt><dd>{post.place.access_instructions ?? 'No access instructions supplied.'}</dd></div><div className={post.place.hs_notes ? 'is-warning' : ''}><dt><TriangleAlert size={16} /> Safety</dt><dd>{post.place.hs_notes ?? 'No specific safety notes supplied.'}</dd></div></dl></section>
        <section className="static-post-actions"><header><h2>Shift attendance</h2><span>Module task: {post.module.status.replaceAll('_', ' ')}</span></header>
          <p>Start and end this single-site shift once. Attendance is recorded with those actions; there is no separate on-site or off-site button.</p>
          <button type="button" onClick={() => navigate(`/officer/schedule?shift=${encodeURIComponent(post.shift.id)}`)}>Open this shift in my schedule</button>
          {post.shift.status === 'in_progress' && <><OfficerShiftBreakControl shiftId={post.shift.id} /><button type="button" className="static-post-primary" onClick={() => setEnding(true)}>End shift and debrief</button></>}
          <button type="button" onClick={() => navigate(`/officer/report?shift=${encodeURIComponent(post.shift.id)}`)}>Report an observation or incident</button>
        </section>
      </div>
    </>}
    {ending && post && <EndShiftDialog shiftId={post.shift.id} shiftStatus={post.shift.status} serviceType="static_guarding" onClose={() => setEnding(false)} onEnded={({ completed_at }) => { setEnding(false); setNotice(`Shift completed at ${formatDateTime(completed_at)}.`); setPost(null); }} onNavigate={(destination) => { setEnding(false); navigate(destination === 'home' ? '/officer' : destination === 'stops' ? `/officer/site_guard?shift=${post.shift.id}` : `/officer/${destination}`); }} />}
  </main>;
}
