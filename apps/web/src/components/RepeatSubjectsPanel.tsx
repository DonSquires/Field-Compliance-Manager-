import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { supabase } from '../lib/supabase';
import './RepeatSubjectsPanel.css';

interface SubjectRow {
  plate: string;
  sightings: number;
  places: number;
  officers: number;
  patrol_sightings: number;
  cctv_sightings: number;
  first_seen: string;
  last_seen: string;
  owner_identified: boolean;
  total_count: number;
}

interface HistoryRow {
  source: 'patrol' | 'cctv';
  record_id: string;
  observed_at: string;
  place_id: string | null;
  officer_id: string | null;
  note: string | null;
}

const PAGE_SIZE = 25;
const RANGES: Array<{ label: string; days: number | null }> = [
  { label: 'Last 12 months', days: 365 },
  { label: 'Last 90 days', days: 90 },
  { label: 'All time', days: null },
];

function describe(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : 'Repeat vehicles could not be loaded.';
}

export const RepeatSubjectsPanel: React.FC = () => {
  const { zones, sites } = useServiceRelationships();
  const [minSightings, setMinSightings] = useState(3);
  const [rangeIndex, setRangeIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<SubjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<SubjectRow | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [officerNames, setOfficerNames] = useState<Record<string, string>>({});

  const placeNames = useMemo(() => {
    const names = new Map<string, string>();
    zones.forEach((zone) => names.set(zone.id, zone.name));
    sites.forEach((site) => names.set(site.id, site.name));
    return names;
  }, [sites, zones]);

  useEffect(() => { setPage(0); }, [minSightings, rangeIndex]);

  // ATLAS READS: observations, cctv_entity_observations via list_repeat_vehicle_subjects
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const days = RANGES[rangeIndex].days;
      const from = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null;
      const { data, error: rpcError } = await supabase.rpc('list_repeat_vehicle_subjects', {
        p_min_sightings: minSightings, p_from: from, p_to: null, p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
      });
      if (cancelled) return;
      if (rpcError) setError(describe(rpcError)); else setRows((data ?? []) as SubjectRow[]);
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [minSightings, rangeIndex, page]);

  const open = async (row: SubjectRow) => {
    setSelected(row);
    setHistory([]);
    setHistoryLoading(true);
    const { data, error: rpcError } = await supabase.rpc('list_vehicle_subject_history', { p_plate: row.plate, p_limit: 200 });
    if (rpcError) { setError(describe(rpcError)); setHistoryLoading(false); return; }
    const list = (data ?? []) as HistoryRow[];
    setHistory(list);
    const wanted = [...new Set(list.map((item) => item.officer_id).filter((id): id is string => Boolean(id)))].filter((id) => !officerNames[id]);
    if (wanted.length) {
      const { data: people } = await supabase.from('user_profiles').select('id,display_name').in('id', wanted);
      setOfficerNames((current) => ({ ...current, ...Object.fromEntries((people ?? []).map((person) => [person.id as string, (person.display_name as string | null) ?? 'Officer'])) }));
    }
    setHistoryLoading(false);
  };

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  const total = rows[0]?.total_count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const visible = filter.trim() ? rows.filter((row) => row.plate.includes(filter.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))) : rows;

  return (
    <section className="reports-section repeat-subjects" aria-labelledby="repeat-subjects-title">
      <div className="repeat-subjects__head">
        <div>
          <h2 id="repeat-subjects-title">Repeat vehicles</h2>
          <p className="subtitle">Vehicles seen more than once, across patrol sightings and CCTV detections a person has accepted.</p>
        </div>
        <div className="repeat-subjects__controls">
          <label>Seen at least
            <select value={minSightings} onChange={(event) => setMinSightings(Number(event.target.value))}>
              {[2, 3, 5, 10].map((n) => <option key={n} value={n}>{n} times</option>)}
            </select>
          </label>
          <label>Period
            <select value={rangeIndex} onChange={(event) => setRangeIndex(Number(event.target.value))}>
              {RANGES.map((range, index) => <option key={range.label} value={index}>{range.label}</option>)}
            </select>
          </label>
          <label>Find plate <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter this page" /></label>
        </div>
      </div>

      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <p className="repeat-subjects__count" role="status">{loading ? 'Loading repeat vehicles…' : `${total.toLocaleString('en-NZ')} ${total === 1 ? 'vehicle' : 'vehicles'}`}</p>
      <div className="reports-table-wrapper">
        <table className="reports-table">
          <thead><tr><th>Plate</th><th>Seen</th><th>Places</th><th>Officers</th><th>Patrol / CCTV</th><th>First seen</th><th>Last seen</th><th>Owner</th></tr></thead>
          <tbody>
            {!loading && visible.length === 0 && <tr><td colSpan={8} className="text-center">No vehicles meet this threshold in this period.</td></tr>}
            {visible.map((row) => (
              <tr key={row.plate}>
                <td><button type="button" className="repeat-subjects__plate" onClick={() => void open(row)} aria-label={`Open sighting history for ${row.plate}`}>{row.plate}</button></td>
                <td>{row.sightings}</td>
                <td>{row.places}</td>
                <td>{row.officers || '—'}</td>
                <td>{row.patrol_sightings} / {row.cctv_sightings}</td>
                <td>{new Date(row.first_seen).toLocaleDateString('en-NZ')}</td>
                <td>{new Date(row.last_seen).toLocaleDateString('en-NZ')}</td>
                <td>{row.owner_identified ? 'Identified by R&M' : 'Not identified'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="repeat-subjects__pager">
        <button type="button" className="btn btn-secondary" disabled={page === 0 || loading} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</button>
        <span>Page {page + 1} of {pageCount}</span>
        <button type="button" className="btn btn-secondary" disabled={page + 1 >= pageCount || loading} onClick={() => setPage((current) => current + 1)}>Next</button>
      </div>

      {selected && (
        <div className="activity-browser__overlay" onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <aside className="activity-browser__detail" role="dialog" aria-modal="true" aria-labelledby="subject-history-title">
            <div className="activity-browser__detail-head">
              <h3 id="subject-history-title">{selected.plate} · {selected.sightings} sightings</h3>
              <button type="button" className="activity-browser__close" onClick={() => setSelected(null)} aria-label="Close sighting history"><X size={16} aria-hidden="true" /></button>
            </div>
            <p className="subtitle">{selected.places} {selected.places === 1 ? 'place' : 'places'} · first seen {new Date(selected.first_seen).toLocaleDateString('en-NZ')} · last seen {new Date(selected.last_seen).toLocaleDateString('en-NZ')}</p>
            {historyLoading && <p role="status">Loading history…</p>}
            <ol className="repeat-subjects__history">
              {history.map((item) => (
                <li key={`${item.source}-${item.record_id}`}>
                  <strong>{new Date(item.observed_at).toLocaleString('en-NZ')}</strong>
                  <span>{item.place_id ? placeNames.get(item.place_id) ?? 'Unnamed place' : 'No place recorded'} · {item.source === 'cctv' ? 'CCTV (accepted)' : 'Patrol'}{item.officer_id ? ` · ${officerNames[item.officer_id] ?? '…'}` : ''}</span>
                  {item.note && <em>{item.note}</em>}
                </li>
              ))}
            </ol>
          </aside>
        </div>
      )}
    </section>
  );
};

export default RepeatSubjectsPanel;
