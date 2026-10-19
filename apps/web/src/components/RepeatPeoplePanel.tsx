import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { supabase } from '../lib/supabase';
import { RecordEvidencePanel } from './RecordEvidencePanel';

interface PersonRow {
  canonical_person_id: string;
  display_name: string | null;
  sightings: number;
  places: number;
  patrol_sightings: number;
  cctv_sightings: number;
  first_seen: string;
  last_seen: string;
  total_count: number;
}

interface PersonHistoryRow {
  source: 'patrol' | 'cctv';
  record_id: string;
  organization_id: string;
  observed_at: string;
  place_id: string | null;
  plate: string | null;
  note: string | null;
  evidence_item_id: string | null;
}

const PAGE_SIZE = 25;

function describe(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : 'Person observations could not be loaded.';
}

export const RepeatPeoplePanel: React.FC<{ agreementId: string; rangeDays?: number | null }> = ({ agreementId, rangeDays = 365 }) => {
  const { zones, sites } = useServiceRelationships();
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [history, setHistory] = useState<PersonHistoryRow[]>([]);
  const [selected, setSelected] = useState<PersonRow | null>(null);
  const [minimum, setMinimum] = useState(2);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const historyRequest = useRef(0);

  const placeNames = useMemo(() => new Map([...zones.map((zone) => [zone.id, zone.name] as const), ...sites.map((site) => [site.id, site.name] as const)]), [sites, zones]);
  const total = rows[0]?.total_count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    historyRequest.current += 1;
    setPage(0); setSelected(null);
  }, [agreementId, minimum, rangeDays]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setRows([]);
      setLoading(true); setError(null);
      const { data, error: rpcError } = await supabase.rpc('list_repeat_person_subjects_for_agreement', {
        p_service_agreement_id: agreementId || null,
        p_min_sightings: minimum,
        p_from: rangeDays === null ? null : new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString(),
        p_to: new Date().toISOString(),
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (cancelled) return;
      if (rpcError) setError(describe(rpcError)); else setRows((data ?? []) as PersonRow[]);
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [agreementId, minimum, rangeDays, page]);

  const open = async (row: PersonRow) => {
    const requestId = ++historyRequest.current;
    setSelected(row); setHistory([]); setHistoryLoading(true); setError(null);
    const { data, error: rpcError } = await supabase.rpc('list_person_subject_history_for_agreement', {
      p_canonical_person_id: row.canonical_person_id,
      p_service_agreement_id: agreementId || null,
      p_limit: 200,
    });
    if (requestId !== historyRequest.current) return;
    if (rpcError) setError(describe(rpcError)); else setHistory((data ?? []) as PersonHistoryRow[]);
    setHistoryLoading(false);
  };

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  return (
    <section className="reports-section repeat-subjects repeat-people" aria-labelledby="repeat-people-title">
      <div className="repeat-subjects__head">
        <div><h2 id="repeat-people-title">People observed more than once</h2><p className="subtitle">Only R&amp;M admin, master and grandmaster roles can view verified canonical identities. Records pending human review are excluded.</p></div>
        <label>Seen at least <select value={minimum} onChange={(event) => setMinimum(Number(event.target.value))}>{[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n} {n === 1 ? 'time (all subjects)' : 'times'}</option>)}</select></label>
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <p className="repeat-subjects__count" role="status">{loading ? 'Loading people…' : `${total.toLocaleString('en-NZ')} verified canonical people`}</p>
      <div className="reports-table-wrapper">
        <table className="reports-table">
          <thead><tr><th>Person</th><th>Observations</th><th>Places</th><th>Patrol / CCTV</th><th>First seen</th><th>Last seen</th><th>Open</th></tr></thead>
          <tbody>
            {!loading && rows.length === 0 && <tr><td colSpan={7} className="text-center">No verified canonical people meet this threshold in the selected scope and period.</td></tr>}
            {rows.map((row) => <tr key={row.canonical_person_id}>
              <td>{row.display_name || 'Unnamed person record'}</td><td>{row.sightings}</td><td>{row.places}</td><td>{row.patrol_sightings} / {row.cctv_sightings}</td>
              <td>{new Date(row.first_seen).toLocaleDateString('en-NZ')}</td><td>{new Date(row.last_seen).toLocaleDateString('en-NZ')}</td>
              <td><button type="button" className="repeat-subjects__plate" onClick={() => void open(row)}>View history</button></td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <div className="repeat-subjects__pager">
        <button type="button" className="btn btn-secondary" disabled={page === 0 || loading} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</button>
        <span>Page {page + 1} of {pages}</span>
        <button type="button" className="btn btn-secondary" disabled={page + 1 >= pages || loading} onClick={() => setPage((value) => value + 1)}>Next</button>
      </div>
      {selected && <div className="activity-browser__overlay" onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
        <aside className="activity-browser__detail" role="dialog" aria-modal="true" aria-labelledby="person-history-title">
          <div className="activity-browser__detail-head"><h3 id="person-history-title">{selected.display_name || 'Unnamed person record'}</h3><button type="button" className="activity-browser__close" aria-label="Close person history" onClick={() => setSelected(null)}>×</button></div>
          <p className="subtitle">{selected.sightings} observations across {selected.places} places.</p>
          {historyLoading && <p role="status">Loading observations…</p>}
          <ol className="repeat-subjects__history">{history.map((item) => <li key={`${item.source}-${item.record_id}`}>
            <strong>{new Date(item.observed_at).toLocaleString('en-NZ')}</strong>
            <span>{item.place_id ? placeNames.get(item.place_id) ?? 'Unnamed place' : 'No place recorded'} · {item.source === 'cctv' ? 'CCTV (accepted)' : 'Patrol'}{item.plate ? ` · ${item.plate}` : ''}</span>
            {item.note && <em>{item.note}</em>}
            {item.source === 'patrol' && <details><summary>Photos and evidence</summary><RecordEvidencePanel recordKind="observation" recordId={item.record_id} organizationId={item.organization_id} canAdd={false} /></details>}
            {item.source === 'cctv' && item.evidence_item_id && <CctvEvidenceLink evidenceId={item.evidence_item_id} />}
          </li>)}</ol>
        </aside>
      </div>}
    </section>
  );
};

export default RepeatPeoplePanel;

function CctvEvidenceLink({ evidenceId }: { evidenceId: string }) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [kind, setKind] = useState('evidence');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.from('evidence_items').select('storage_path,evidence_kind').eq('id', evidenceId).maybeSingle();
      if (error || !data?.storage_path || cancelled) return;
      setKind(data.evidence_kind);
      const { data: signed } = await supabase.storage.from('bob-uploads').createSignedUrl(data.storage_path, 900);
      if (!cancelled && signed?.signedUrl) setSignedUrl(signed.signedUrl);
    })();
    return () => { cancelled = true; };
  }, [evidenceId]);
  if (!signedUrl) return <small>Source evidence unavailable</small>;
  return <a href={signedUrl} target="_blank" rel="noopener noreferrer">Open CCTV {kind === 'video' ? 'video' : 'image'}</a>;
}
