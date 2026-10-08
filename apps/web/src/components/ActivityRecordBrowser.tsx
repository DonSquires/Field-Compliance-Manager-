import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { ACTIVITY_PAGE_SIZE, sanitiseSearchTerm } from '../lib/activitySearch';
import { RecordEvidencePanel } from './RecordEvidencePanel';
import { supabase } from '../lib/supabase';
import './ActivityRecordBrowser.css';

export type ActivityRecordKind = 'visits' | 'sightings';

interface Props {
  zoneIds: string[];
  siteIds: string[];
  /** Plain-language label for the current scope, e.g. the selected agreement. */
  scopeLabel: string;
}

interface VisitRecord {
  id: string;
  organization_id: string;
  event_type: string;
  occurred_at: string;
  module_key: string | null;
  source: string | null;
  distance_km: number | string | null;
  zone_id: string | null;
  client_site_id: string | null;
  observed_entity_id: string | null;
  payload: Record<string, unknown> | null;
}

interface SightingRecord {
  id: string;
  organization_id: string;
  observed_at: string;
  plate_number: string;
  officer_id: string | null;
  zone_id: string | null;
  site_id: string | null;
  distance_km: number | string | null;
  officer_notes: string | null;
  is_compliant: boolean | null;
  compliance_reason: string | null;
  external_refs: Record<string, unknown> | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function startOfDayIso(date: string) {
  return `${date}T00:00:00.000Z`;
}

function nextDayIso(date: string) {
  const end = new Date(`${date}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return end.toISOString();
}

function formatDistance(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(1)} km` : '—';
}

function daysAgoDate(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
}

function shiftDate(date: string, days: number) {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().split('T')[0];
}

// Row-level security is evaluated per row, so a long window across hundreds of places exceeds the statement timeout.
const WINDOW_DAY_OPTIONS = [7, 14, 30];

function describeLoadError(err: unknown): string {
  const message = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : '';
  if (/statement timeout/i.test(message)) return 'That window is too large to load for this many places. Choose a shorter window.';
  return message || 'Records could not be loaded.';
}

export const ActivityRecordBrowser: React.FC<Props> = ({ zoneIds, siteIds, scopeLabel }) => {
  const navigate = useNavigate();
  const { zones, sites } = useServiceRelationships();
  const [kind, setKind] = useState<ActivityRecordKind>('visits');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [windowDays, setWindowDays] = useState(14);
  const [to, setTo] = useState(() => daysAgoDate(0));
  const from = shiftDate(to, -windowDays);
  const [page, setPage] = useState(0);
  const [visits, setVisits] = useState<VisitRecord[]>([]);
  const [sightings, setSightings] = useState<SightingRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [officerNames, setOfficerNames] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const scopeKey = `${zoneIds.join(',')}|${siteIds.join(',')}`;
  const placeNames = useMemo(() => {
    const names = new Map<string, string>();
    zones.forEach((zone) => names.set(`z:${zone.id}`, zone.name));
    sites.forEach((site) => names.set(`s:${site.id}`, site.name));
    return names;
  }, [sites, zones]);
  const placeName = useCallback((zoneId: string | null, siteId: string | null) => (
    (zoneId && placeNames.get(`z:${zoneId}`)) || (siteId && placeNames.get(`s:${siteId}`)) || 'Unnamed place'
  ), [placeNames]);

  // Debounce typing so each keystroke is not a database round trip.
  useEffect(() => {
    const handle = window.setTimeout(() => { setSearch(sanitiseSearchTerm(searchInput)); setPage(0); }, 350);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => { setPage(0); setSelectedId(null); }, [kind, from, to, scopeKey]);

  // ATLAS READS: location_events, observations, user_profiles
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (zoneIds.length === 0 && siteIds.length === 0) {
        setVisits([]); setSightings([]); setTotal(0); setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const rangeFrom = page * ACTIVITY_PAGE_SIZE;
        const rangeTo = rangeFrom + ACTIVITY_PAGE_SIZE - 1;
        const wild = `*${search}*`;
        if (kind === 'visits') {
          const places = [
            ...(zoneIds.length ? [`zone_id.in.(${zoneIds.join(',')})`] : []),
            ...(siteIds.length ? [`client_site_id.in.(${siteIds.join(',')})`] : []),
          ].join(',');
          let query = supabase
            .from('location_events')
            .select('id,organization_id,event_type,occurred_at,module_key,source,distance_km,zone_id,client_site_id,observed_entity_id,payload', { count: 'estimated' })
            .or(places);
          if (from) query = query.gte('occurred_at', startOfDayIso(from));
          if (to) query = query.lt('occurred_at', nextDayIso(to));
          if (search) {
            query = query.or(['comments', 'issue', 'action_notes', 'action_by', 'closed_by', 'source_file']
              .map((key) => `payload->>${key}.ilike.${wild}`).join(','));
          }
          const { data, error: queryError, count } = await query.order('occurred_at', { ascending: false }).range(rangeFrom, rangeTo);
          if (queryError) throw queryError;
          if (cancelled) return;
          const rows = (data ?? []) as VisitRecord[];
          setVisits(rows);
          setTotal(count ?? rows.length);
          await loadOfficers(rows.map((row) => row.observed_entity_id));
        } else {
          const places = [
            ...(zoneIds.length ? [`zone_id.in.(${zoneIds.join(',')})`] : []),
            ...(siteIds.length ? [`site_id.in.(${siteIds.join(',')})`] : []),
          ].join(',');
          let query = supabase
            .from('observations')
            .select('id,organization_id,observed_at,plate_number,officer_id,zone_id,site_id,distance_km,officer_notes,is_compliant,compliance_reason,external_refs', { count: 'estimated' })
            .or(places);
          if (from) query = query.gte('observed_at', startOfDayIso(from));
          if (to) query = query.lt('observed_at', nextDayIso(to));
          if (search) {
            query = query.or([
              `plate_number.ilike.${wild}`,
              `officer_notes.ilike.${wild}`,
              ...['comments', 'issue', 'action_notes', 'action_by'].map((key) => `external_refs->import->>${key}.ilike.${wild}`),
            ].join(','));
          }
          const { data, error: queryError, count } = await query.order('observed_at', { ascending: false }).range(rangeFrom, rangeTo);
          if (queryError) throw queryError;
          if (cancelled) return;
          const rows = (data ?? []) as SightingRecord[];
          setSightings(rows);
          setTotal(count ?? rows.length);
          await loadOfficers(rows.map((row) => row.officer_id));
        }
      } catch (err) {
        if (!cancelled) setError(describeLoadError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const loadOfficers = async (ids: Array<string | null>) => {
      const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))].filter((id) => !officerNames[id]);
      if (wanted.length === 0) return;
      const { data } = await supabase.from('user_profiles').select('id,display_name').in('id', wanted);
      if (cancelled || !data) return;
      setOfficerNames((current) => ({ ...current, ...Object.fromEntries(data.map((row) => [row.id as string, (row.display_name as string | null) ?? 'Officer'])) }));
    };

    void load();
    return () => { cancelled = true; };
    // officerNames is read only to skip names already resolved; it must not retrigger the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, page, search, from, to, scopeKey]);

  const pageCount = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));
  const selectedVisit = kind === 'visits' ? visits.find((row) => row.id === selectedId) ?? null : null;
  const selectedSighting = kind === 'sightings' ? sightings.find((row) => row.id === selectedId) ?? null : null;
  const hasFilters = Boolean(searchInput);
  const today = daysAgoDate(0);

  const detailRows = (): Array<[string, string]> => {
    if (selectedVisit) {
      const payload = selectedVisit.payload ?? {};
      return [
        ['When', new Date(selectedVisit.occurred_at).toLocaleString('en-NZ')],
        ['Activity', selectedVisit.event_type.replaceAll('_', ' ')],
        ['Place', placeName(selectedVisit.zone_id, selectedVisit.client_site_id)],
        ['Officer', selectedVisit.observed_entity_id ? officerNames[selectedVisit.observed_entity_id] ?? 'Loading…' : text(payload.patroller) ?? 'Not recorded'],
        ['Job number', text(payload.job_number) ?? '—'],
        ['Distance', formatDistance(selectedVisit.distance_km)],
        ['Officer comments', text(payload.comments) ?? 'No comments recorded'],
        ['Issue', text(payload.issue) ?? '—'],
        ['Action by', text(payload.action_by) ?? '—'],
        ['Action notes', text(payload.action_notes) ?? '—'],
        ['Last action', text(payload.last_action_date) ?? '—'],
        ['Closed by', text(payload.closed_by) ?? '—'],
        ['Source', [text(payload.source_file), text(payload.source_sheet), payload.source_row != null ? `row ${String(payload.source_row)}` : null].filter(Boolean).join(' · ') || selectedVisit.source || '—'],
      ];
    }
    if (selectedSighting) {
      const imported = ((selectedSighting.external_refs ?? {}) as { import?: Record<string, unknown> }).import ?? {};
      return [
        ['When', new Date(selectedSighting.observed_at).toLocaleString('en-NZ')],
        ['Plate', selectedSighting.plate_number],
        ['Place', placeName(selectedSighting.zone_id, selectedSighting.site_id)],
        ['Officer', selectedSighting.officer_id ? officerNames[selectedSighting.officer_id] ?? 'Loading…' : 'Not recorded'],
        ['Distance', formatDistance(selectedSighting.distance_km)],
        ['Officer notes', selectedSighting.officer_notes?.trim() || 'No notes recorded'],
        ['Issue', text(imported.issue) ?? '—'],
        ['Action by', text(imported.action_by) ?? '—'],
        ['Action notes', text(imported.action_notes) ?? '—'],
        ['Last action', text(imported.last_action_date) ?? '—'],
        ['Closed by', text(imported.closed_by) ?? '—'],
        ['Compliance', selectedSighting.is_compliant === null ? 'Not assessed' : `${selectedSighting.is_compliant ? 'Compliant' : 'Non-compliant'}${selectedSighting.compliance_reason ? ` — ${selectedSighting.compliance_reason}` : ''}`],
        ['Source', [text(imported.source_file), text(imported.source_sheet), imported.source_row != null ? `row ${String(imported.source_row)}` : null].filter(Boolean).join(' · ') || '—'],
      ];
    }
    return [];
  };

  const details = detailRows();
  const detailOpen = details.length > 0;
  const closeRef = useRef<HTMLButtonElement>(null);
  const selectedRecord = selectedVisit
    ? { kind: 'location_event' as const, id: selectedVisit.id, organizationId: selectedVisit.organization_id }
    : selectedSighting ? { kind: 'observation' as const, id: selectedSighting.id, organizationId: selectedSighting.organization_id } : null;

  useEffect(() => {
    if (!detailOpen) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailOpen, selectedId]);

  return (
    <section className="reports-section activity-browser" aria-labelledby="activity-browser-title">
      <div className="activity-browser__head">
        <div>
          <h2 id="activity-browser-title">Logged activity and officer notes</h2>
          <p className="subtitle">Every patrol visit, camera activation and vehicle sighting for {scopeLabel}, with what the officer recorded.</p>
        </div>
        <div className="activity-browser__tabs" role="tablist" aria-label="Record type">
          <button type="button" role="tab" aria-selected={kind === 'visits'} className={kind === 'visits' ? 'is-active' : ''} onClick={() => setKind('visits')}>Patrol visits</button>
          <button type="button" role="tab" aria-selected={kind === 'sightings'} className={kind === 'sightings' ? 'is-active' : ''} onClick={() => setKind('sightings')}>Vehicle sightings</button>
        </div>
      </div>

      <div className="activity-browser__filters">
        <label className="activity-browser__search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={kind === 'visits' ? 'Search comments, issue, action notes, officer action…' : 'Search plate, officer notes, issue, action notes…'}
            aria-label="Search records"
          />
        </label>
        <div className="activity-browser__window" role="group" aria-label="Date window">
          <button type="button" className="btn btn-secondary" onClick={() => setTo(shiftDate(to, -windowDays))}>← Earlier</button>
          <strong>{new Date(`${from}T00:00:00`).toLocaleDateString('en-NZ')} – {new Date(`${to}T00:00:00`).toLocaleDateString('en-NZ')}</strong>
          <button type="button" className="btn btn-secondary" disabled={to >= today} onClick={() => setTo(shiftDate(to, windowDays) > today ? today : shiftDate(to, windowDays))}>Later →</button>
          <label>Window <select value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value))}>{WINDOW_DAY_OPTIONS.map((days) => <option key={days} value={days}>{days} days</option>)}</select></label>
          <label>Jump to <input type="date" value={to} max={today} onChange={(event) => { if (event.target.value) setTo(event.target.value); }} /></label>
        </div>
        {searchInput && <button type="button" className="btn btn-secondary" onClick={() => setSearchInput('')}>Clear search</button>}
      </div>

      {error && <div className="alert alert-error" role="alert">{error}</div>}

      <div className="activity-browser__body">
        <div className="activity-browser__list" aria-busy={loading}>
          <p className="activity-browser__count" role="status">
            {loading ? 'Loading records…' : `${total === ACTIVITY_PAGE_SIZE * pageCount && pageCount > 1 ? 'About ' : ''}${total.toLocaleString('en-NZ')} ${total === 1 ? 'record' : 'records'}${hasFilters ? ' in this view' : ''}`}
          </p>
          <div className="reports-table-wrapper">
            <table className="reports-table">
              <thead>
                {kind === 'visits'
                  ? <tr><th>Date</th><th>Place</th><th>Officer</th><th>Activity</th><th>What was noted</th></tr>
                  : <tr><th>Date</th><th>Plate</th><th>Place</th><th>Officer</th><th>What was noted</th></tr>}
              </thead>
              <tbody>
                {!loading && total === 0 && (
                  <tr><td colSpan={5} className="text-center">{zoneIds.length + siteIds.length === 0 ? 'No places are linked to this agreement yet.' : hasFilters ? 'Nothing matches this search in this date window. Clear the search, or step Earlier.' : 'No records in this date window. Use Earlier to look further back.'}</td></tr>
                )}
                {kind === 'visits' && visits.map((row) => {
                  const note = text(row.payload?.comments) ?? text(row.payload?.issue);
                  return (
                    <tr key={row.id} className={row.id === selectedId ? 'is-selected' : ''}>
                      <td><button type="button" className="activity-browser__row-link" onClick={() => setSelectedId(row.id)} aria-label={`Open record from ${new Date(row.occurred_at).toLocaleString('en-NZ')}`}>{new Date(row.occurred_at).toLocaleString('en-NZ')}</button></td>
                      <td>{placeName(row.zone_id, row.client_site_id)}</td>
                      <td>{row.observed_entity_id ? officerNames[row.observed_entity_id] ?? '…' : row.event_type === 'camera_activation' ? 'Camera' : '—'}</td>
                      <td>{row.event_type.replaceAll('_', ' ')}</td>
                      <td className="activity-browser__note">{note ?? '—'}</td>
                    </tr>
                  );
                })}
                {kind === 'sightings' && sightings.map((row) => (
                  <tr key={row.id} className={row.id === selectedId ? 'is-selected' : ''}>
                    <td><button type="button" className="activity-browser__row-link" onClick={() => setSelectedId(row.id)} aria-label={`Open sighting of ${row.plate_number}`}>{new Date(row.observed_at).toLocaleString('en-NZ')}</button></td>
                    <td>{row.plate_number}</td>
                    <td>{placeName(row.zone_id, row.site_id)}</td>
                    <td>{row.officer_id ? officerNames[row.officer_id] ?? '…' : '—'}</td>
                    <td className="activity-browser__note">{row.officer_notes?.trim() || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="activity-browser__pager">
            <button type="button" className="btn btn-secondary" disabled={page === 0 || loading} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</button>
            <span>Page {page + 1} of {pageCount}</span>
            <button type="button" className="btn btn-secondary" disabled={page + 1 >= pageCount || loading} onClick={() => setPage((current) => current + 1)}>Next</button>
          </div>
        </div>

        {detailOpen && selectedRecord && (
          <div className="activity-browser__overlay" onClick={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}>
            <aside className="activity-browser__detail" role="dialog" aria-modal="true" aria-labelledby="record-detail-title">
              <div className="activity-browser__detail-head">
                <h3 id="record-detail-title">Record detail</h3>
                <button ref={closeRef} type="button" className="activity-browser__close" onClick={() => setSelectedId(null)} aria-label="Close record detail"><X size={16} aria-hidden="true" /></button>
              </div>
              <dl>
                {details.map(([label, value]) => (<div key={label}><dt>{label}</dt><dd>{value}</dd></div>))}
              </dl>
              <RecordEvidencePanel key={selectedRecord.id} recordKind={selectedRecord.kind} recordId={selectedRecord.id} organizationId={selectedRecord.organizationId} canAdd />
              <button type="button" className="btn btn-secondary" onClick={() => navigate('/admin/investigations')}>Open investigations</button>
            </aside>
          </div>
        )}
      </div>
    </section>
  );
};

export default ActivityRecordBrowser;
