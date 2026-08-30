import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarRange, Clock3, ExternalLink, FileSearch, MapPin, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './OfficerActivityTimelinePage.css';

interface OfficerOption {
  id: string;
  display_name: string | null;
  email: string | null;
  deactivated_at: string | null;
}

interface TimelineEvent {
  event_key: string;
  event_type: string;
  event_at: string;
  received_at: string;
  source_table: string;
  source_id: string;
  gps_lat: number | null;
  gps_lng: number | null;
  shift_id: string | null;
  site_id: string | null;
  zone_id: string | null;
  summary: string;
  details: Record<string, unknown> | null;
}

function toLocalInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDetail(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replaceAll('_', ' ');
}

const OfficerActivityTimelinePage: React.FC = () => {
  const { profile } = useAuth();
  const [officers, setOfficers] = useState<OfficerOption[]>([]);
  const [officerId, setOfficerId] = useState('');
  const [from, setFrom] = useState(() => toLocalInput(new Date(Date.now() - 12 * 60 * 60 * 1000)));
  const [to, setTo] = useState(() => toLocalInput(new Date()));
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);

  useEffect(() => {
    const loadOfficers = async () => {
      if (!profile?.organizationId) return;
      const { data, error: officerError } = await supabase
        .from('user_profiles')
        .select('id, display_name, email, deactivated_at')
        .eq('organization_id', profile.organizationId)
        .in('role', ['officer', 'scan_operator'])
        .order('display_name', { ascending: true });
      if (officerError) {
        setError(officerError.message);
        return;
      }
      const options = (data as OfficerOption[]) ?? [];
      setOfficers(options);
      setOfficerId((current) => current || options[0]?.id || '');
    };
    void loadOfficers();
  }, [profile?.organizationId]);

  const runInvestigation = useCallback(async () => {
    if (!officerId || !from || !to) return;
    setLoading(true);
    setError(null);
    setHasRun(true);
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();
    if (fromIso >= toIso) {
      setError('The investigation start must be before the end time.');
      setLoading(false);
      return;
    }
    const { data, error: timelineError } = await supabase.rpc('get_officer_activity_timeline', {
      p_officer_id: officerId,
      p_from: fromIso,
      p_to: toIso,
      p_limit: 5000,
    });
    if (timelineError) {
      setError(timelineError.message);
      setEvents([]);
    } else {
      setEvents((data as TimelineEvent[]) ?? []);
    }
    setLoading(false);
  }, [from, officerId, to]);

  const selectedOfficer = officers.find((officer) => officer.id === officerId);
  const sourceCount = useMemo(() => new Set(events.map((event) => event.source_table)).size, [events]);

  return (
    <div className="evidence-page">
      <header className="evidence-header">
        <div><span>Field operations / Investigation</span><h1>Officer activity timeline</h1><p>Reconstruct recorded activity before, during, and after an operational event.</p></div>
        <div className="evidence-header-mark"><FileSearch size={24} aria-hidden="true" /><span>Read-only evidence view</span></div>
      </header>

      <section className="evidence-controls" aria-label="Investigation parameters">
        <label><span>Officer</span><select value={officerId} onChange={(event) => setOfficerId(event.target.value)}><option value="">Select an officer</option>{officers.map((officer) => <option key={officer.id} value={officer.id}>{officer.display_name || officer.email || officer.id}{officer.deactivated_at ? ' (inactive)' : ''}</option>)}</select></label>
        <label><span>From</span><input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label><span>To</span><input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <button type="button" onClick={() => void runInvestigation()} disabled={loading || !officerId}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} aria-hidden="true" />{loading ? 'Loading' : 'Build timeline'}</button>
      </section>

      {error && <div className="evidence-message is-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><div><strong>Timeline unavailable</strong><span>{error}</span></div></div>}

      {hasRun && !error && (
        <section className="evidence-summary" aria-label="Timeline summary">
          <div><strong>{events.length}</strong><span>recorded events</span></div><div><strong>{sourceCount}</strong><span>canonical sources</span></div><div><strong>{selectedOfficer?.display_name || selectedOfficer?.email || 'Officer'}</strong><span>investigation subject</span></div>
        </section>
      )}

      <section className="evidence-timeline" aria-live="polite">
        {!hasRun && <div className="evidence-empty"><CalendarRange size={28} aria-hidden="true" /><strong>Define the event window</strong><span>Select an officer and a bounded time range. The server permits a maximum of 31 days.</span></div>}
        {hasRun && !loading && !error && events.length === 0 && <div className="evidence-empty"><Clock3 size={28} aria-hidden="true" /><strong>No activity found</strong><span>No canonical records were found in this time window.</span></div>}
        {events.map((event) => {
          const details = Object.entries(event.details ?? {}).filter(([, value]) => value !== null && value !== '');
          const receiptDelay = Math.max(0, new Date(event.received_at).getTime() - new Date(event.event_at).getTime());
          return (
            <article className="evidence-event" key={event.event_key}>
              <div className="evidence-rail"><span /><i /></div>
              <div className="evidence-event-body">
                <div className="evidence-event-heading"><div><span>{event.event_type.replaceAll('_', ' ')}</span><h2>{event.summary}</h2></div><time dateTime={event.event_at}>{formatTime(event.event_at)}</time></div>
                <div className="evidence-provenance"><span>Source: {event.source_table}</span><span>ID: {event.source_id}</span><span>Received: {formatTime(event.received_at)}{receiptDelay >= 60_000 ? ` (+${Math.round(receiptDelay / 60_000)} min)` : ''}</span></div>
                {(event.shift_id || event.site_id || event.zone_id) && <div className="evidence-links">{event.shift_id && <span>Shift {event.shift_id}</span>}{event.site_id && <span>Site {event.site_id}</span>}{event.zone_id && <span>Zone {event.zone_id}</span>}</div>}
                {details.length > 0 && <dl>{details.map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{formatDetail(value)}</dd></div>)}</dl>}
                {event.gps_lat !== null && event.gps_lng !== null && <a href={`https://www.google.com/maps?q=${event.gps_lat},${event.gps_lng}`} target="_blank" rel="noreferrer"><MapPin size={15} aria-hidden="true" />{event.gps_lat.toFixed(5)}, {event.gps_lng.toFixed(5)}<ExternalLink size={13} aria-hidden="true" /></a>}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
};

export default OfficerActivityTimelinePage;