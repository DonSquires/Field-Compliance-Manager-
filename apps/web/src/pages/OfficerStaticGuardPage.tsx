import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, MapPin, RefreshCw, ShieldCheck, Signpost, TriangleAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
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

function requireReceipt(data: unknown, expectedAction: StaticPostReceipt['action']): StaticPostReceipt {
  const receipt = data as Partial<StaticPostReceipt> | null;
  if (!receipt?.reference || receipt.action !== expectedAction || !receipt.occurred_at || !receipt.gps_result || !receipt.timing_status) {
    throw new Error('Attendance receipt was not confirmed. Your action was not recorded locally.');
  }
  return receipt as StaticPostReceipt;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : (error as { message?: string }).message ?? fallback;
}

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
}

async function currentPosition(): Promise<{ latitude: number; longitude: number; accuracy: number }> {
  if (!navigator.geolocation) throw new Error('Location access is required to start a static post.');
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }),
    () => reject(new Error('Location could not be captured. Check location permission and try again.')),
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 10_000 },
  ));
}

export default function OfficerStaticGuardPage() {
  const [post, setPost] = useState<StaticPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<StaticPostReceipt | null>(null);
  const [pendingRequests] = useState<Record<'arrive' | 'depart', string | null>>({ arrive: null, depart: null });

  const load = useCallback(async () => {
    try {
      setLoading(true);setError(null);
      const { data, error: rpcError } = await supabase.rpc('get_officer_static_post', { p_shift_id: null });
      if (rpcError) throw rpcError;
      const next = data as StaticPost | null;
      setPost(next);setNotes(next?.stop.officer_notes ?? '');
    } catch (loadError) {
      setError(errorMessage(loadError, 'Static post could not be loaded.'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const arrive = async () => {
    if (!post) return;
    try {
      setSaving(true);setError(null);setReceipt(null);
      const position = await currentPosition();
      pendingRequests.arrive ??= crypto.randomUUID();
      const { data, error: rpcError } = await supabase.rpc('manage_officer_static_post', { p_stop_id: post.stop.id, p_expected_status: post.stop.status, p_action: 'arrive', p_request_id: pendingRequests.arrive, p_notes: null, p_gps_lat: position.latitude, p_gps_lng: position.longitude, p_gps_accuracy_metres: position.accuracy });
      if (rpcError) throw rpcError;
      setReceipt(requireReceipt(data, 'arrive'));pendingRequests.arrive=null;
      await load();
    } catch (actionError) { setError(errorMessage(actionError, 'Arrival could not be confirmed.')); }
    finally { setSaving(false); }
  };

  const depart = async (event: FormEvent) => {
    event.preventDefault();
    if (!post) return;
    try {
      setSaving(true);setError(null);setReceipt(null);
      const position = await currentPosition();
      pendingRequests.depart ??= crypto.randomUUID();
      const { data, error: rpcError } = await supabase.rpc('manage_officer_static_post', { p_stop_id: post.stop.id, p_expected_status: post.stop.status, p_action: 'depart', p_request_id: pendingRequests.depart, p_notes: notes, p_gps_lat: position.latitude, p_gps_lng: position.longitude, p_gps_accuracy_metres: position.accuracy });
      if (rpcError) throw rpcError;
      setReceipt(requireReceipt(data, 'depart'));pendingRequests.depart=null;
      await load();
    } catch (actionError) { setError(errorMessage(actionError, 'Departure could not be confirmed.')); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="static-post-loading"><RefreshCw size={20} className="is-spinning" /> Loading static post</div>;
  return <main className="static-post-page">
    <header className="static-post-header"><div><span>Static guarding</span><h1>Assigned post</h1><p>Site instructions, attendance, and handover for your current assignment.</p></div><button type="button" onClick={() => void load()} title="Refresh static post"><RefreshCw size={18} /><span className="sr-only">Refresh static post</span></button></header>
    {error && <div className="static-post-message is-error" role="alert"><AlertTriangle size={18} />{error}</div>}
    {receipt && <div className="static-post-message is-success" role="status"><CheckCircle2 size={18} /><span><strong>{receipt.action === 'arrive' ? 'Arrival' : 'Departure'} recorded</strong> at {formatDateTime(receipt.occurred_at)}. Receipt {receipt.reference}; GPS {receipt.gps_result}; timing {receipt.timing_status.replaceAll('_', ' ')}{receipt.dwell_minutes !== null ? `; dwell ${receipt.dwell_minutes} minutes` : ''}.</span></div>}
    {!post ? <section className="static-post-empty"><ShieldCheck size={28} /><h2>No active static post</h2><p>Accepted static guarding assignments appear here when their contract and site are active.</p></section> : <>
      <section className="static-post-identity"><div><span>Current site</span><h2>{post.place.name}</h2><p>{post.place.address ?? 'Address not supplied'}</p></div><div className={`static-post-state state-${post.stop.status}`}><span>{post.stop.status.replaceAll('_', ' ')}</span><strong>{post.place.risk_level ? `${post.place.risk_level} risk` : 'Risk not rated'}</strong></div></section>
      <section className="static-post-timing" aria-label="Assignment timing"><div><Clock3 size={18} /><span>Rostered</span><strong>{formatDateTime(post.shift.scheduled_start)} - {new Date(post.shift.scheduled_end).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</strong></div><div><MapPin size={18} /><span>Arrival</span><strong>{formatDateTime(post.stop.actual_arrived_at)}</strong></div><div><Signpost size={18} /><span>Departure</span><strong>{formatDateTime(post.stop.actual_departed_at)}</strong></div></section>
      {(post.attendance_evidence.arrival || post.attendance_evidence.departure) && <section className="static-post-evidence" aria-label="Attendance receipts">
        <header><ShieldCheck size={18} /><h2>Attendance receipts</h2></header>
        <div>{post.attendance_evidence.arrival && <article><span>Arrival</span><strong>{post.attendance_evidence.arrival.reference}</strong><small>{formatDateTime(post.attendance_evidence.arrival.occurred_at)} · GPS {post.attendance_evidence.arrival.gps_result} · {post.attendance_evidence.arrival.timing_status.replaceAll('_', ' ')}</small></article>}{post.attendance_evidence.departure && <article><span>Departure</span><strong>{post.attendance_evidence.departure.reference}</strong><small>{formatDateTime(post.attendance_evidence.departure.occurred_at)} · GPS {post.attendance_evidence.departure.gps_result}{post.attendance_evidence.departure.dwell_minutes !== null ? ` · ${post.attendance_evidence.departure.dwell_minutes} min dwell` : ''}</small></article>}</div>
      </section>}
      <div className="static-post-columns">
        <section className="static-post-instructions"><header><ShieldCheck size={20} /><h2>Post brief</h2></header><dl><div><dt>Assignment</dt><dd>{post.place.site_brief ?? post.shift.notes ?? 'No site brief supplied.'}</dd></div><div><dt>Access</dt><dd>{post.place.access_instructions ?? 'No access instructions supplied.'}</dd></div><div className={post.place.hs_notes ? 'is-warning' : ''}><dt><TriangleAlert size={16} /> Safety</dt><dd>{post.place.hs_notes ?? 'No specific safety notes supplied.'}</dd></div></dl></section>
        <section className="static-post-actions"><header><h2>Attendance</h2><span>Module task: {post.module.status.replaceAll('_', ' ')}</span></header>{['pending','en_route'].includes(post.stop.status) ? <><p>Confirm arrival from the assigned site. Your current GPS position is captured as evidence but is not described as verified.</p><button type="button" className="static-post-primary" onClick={() => void arrive()} disabled={saving}>{saving ? <RefreshCw size={18} className="is-spinning" /> : <MapPin size={18} />}Confirm arrival</button></> : post.stop.status === 'on_scene' ? <form onSubmit={depart}><label><span>Departure handover notes</span><textarea required minLength={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Post condition, keys, visitors, incidents, and follow-up." /></label><button type="submit" className="static-post-primary" disabled={saving || notes.trim().length < 3}>{saving ? <RefreshCw size={18} className="is-spinning" /> : <CheckCircle2 size={18} />}Complete post</button></form> : <div className="static-post-complete"><CheckCircle2 size={26} /><strong>Post attendance complete</strong><span>{post.stop.officer_notes}</span></div>}</section>
      </div>
    </>}
  </main>;
}
