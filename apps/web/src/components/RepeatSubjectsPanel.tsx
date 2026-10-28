import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { supabase } from '../lib/supabase';
import { RecordEvidencePanel } from './RecordEvidencePanel';
import { RepeatPeoplePanel } from './RepeatPeoplePanel';
import { VehicleOwnerPanel } from './VehicleOwnerPanel';
import { RecordUpdatesPanel } from './RecordUpdatesPanel';
import { ObservationIndicators, useObservationAnnotations } from './ObservationIndicators';
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
  source: 'patrol' | 'cctv' | 'patrol_comment';
  record_id: string;
  organization_id: string;
  observed_at: string;
  place_id: string | null;
  officer_id: string | null;
  note: string | null;
  canonical_vehicle_id: string | null;
  evidence_item_id: string | null;
  compliance_status: string | null;
  compliance_reason: string | null;
  photo_url: string | null;
}

interface PersonIdentification {
  canonical_person_id: string;
  person_record_id: string;
  display_name: string | null;
  identification_basis: string | null;
  linked_at: string;
}

interface VehicleDetails {
  canonical_vehicle_id: string;
  plate: string;
  make: string | null;
  model: string | null;
  year: number | null;
  colour: string | null;
  body_type: string | null;
  fuel_type: string | null;
  owner_identified: boolean;
}

interface PlateMention {
  plate: string;
  mentions: number;
  first_seen: string;
  last_seen: string;
  total_count: number;
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
  const { profile } = useAuth();
  const { agreements, zones, sites } = useServiceRelationships();
  const [agreementId, setAgreementId] = useState('');
  const [canManageIdentity, setCanManageIdentity] = useState(false);
  const [minSightings, setMinSightings] = useState(3);
  const [rangeIndex, setRangeIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<SubjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<SubjectRow | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [identifications, setIdentifications] = useState<PersonIdentification[]>([]);
  const [vehicleDetails, setVehicleDetails] = useState<VehicleDetails | null>(null);
  const [plateMentions, setPlateMentions] = useState<PlateMention[]>([]);
  const [expandedEvidenceId, setExpandedEvidenceId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [officerNames, setOfficerNames] = useState<Record<string, string>>({});
  const [identityLinkOrgIds, setIdentityLinkOrgIds] = useState<Set<string>>(() => new Set());
  const historyRequest = useRef(0);
  const patrolIds = useMemo(() => history.filter((item) => item.source === 'patrol').map((item) => item.record_id), [history]);
  const { annotations, reload: reloadAnnotations } = useObservationAnnotations(patrolIds);

  const providerAgreements = useMemo(() => agreements.filter((agreement) =>
    agreement.agreement_type === 'operational' && agreement.invitation_status === 'accepted' && agreement.client_organization_id !== profile?.organizationId,
  ), [agreements, profile?.organizationId]);

  const placeNames = useMemo(() => {
    const names = new Map<string, string>();
    zones.forEach((zone) => names.set(zone.id, zone.name));
    sites.forEach((site) => names.set(site.id, site.name));
    return names;
  }, [sites, zones]);

  useEffect(() => {
    let cancelled = false;
    void supabase.rpc('can_manage_r_and_m_identity').then(({ data, error: accessError }) => {
      if (cancelled) return;
      if (accessError) setError(describe(accessError));
      else setCanManageIdentity(data === true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    historyRequest.current += 1;
    setPage(0); setSelected(null);
  }, [agreementId, minSightings, rangeIndex]);

  // ATLAS READS: observations, cctv_entity_observations via list_repeat_vehicle_subjects
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!canManageIdentity) { setLoading(false); return; }
      setLoading(true);
      setError(null);
      setRows([]);
      setPlateMentions([]);
      const days = RANGES[rangeIndex].days;
      const from = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null;
      const [subjects, mentions] = await Promise.all([
        supabase.rpc('list_repeat_vehicle_subjects_for_agreement', {
          p_service_agreement_id: agreementId || null, p_min_sightings: minSightings, p_from: from, p_to: new Date().toISOString(),
          p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
        }),
        supabase.rpc('list_unlinked_plate_mentions_for_agreement', {
          p_service_agreement_id: agreementId || null, p_from: from, p_to: new Date().toISOString(), p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
        }),
      ]);
      if (cancelled) return;
      const failure = subjects.error ?? mentions.error;
      if (failure) setError(describe(failure));
      else {
        setRows((subjects.data ?? []) as SubjectRow[]);
        setPlateMentions((mentions.data ?? []) as PlateMention[]);
      }
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [agreementId, canManageIdentity, minSightings, rangeIndex, page]);

  const open = async (row: SubjectRow) => {
    const requestId = ++historyRequest.current;
    setError(null);
    setSelected(row);
    setHistory([]);
    setIdentifications([]);
    setVehicleDetails(null);
    setExpandedEvidenceId(null);
    setIdentityLinkOrgIds(new Set());
    setHistoryLoading(true);
    const [historyResult, detailsResult, identityResult] = await Promise.all([
      supabase.rpc('list_vehicle_subject_history_for_agreement', { p_plate: row.plate, p_service_agreement_id: agreementId || null, p_limit: 200 }),
      supabase.rpc('get_vehicle_subject_details_for_agreement', { p_plate: row.plate, p_service_agreement_id: agreementId || null }),
      supabase.rpc('list_vehicle_subject_identifications', { p_plate: row.plate, p_service_agreement_id: agreementId || null }),
    ]);
    if (requestId !== historyRequest.current) return;
    const rpcError = historyResult.error ?? detailsResult.error ?? identityResult.error;
    if (rpcError) { setError(describe(rpcError)); setHistoryLoading(false); return; }
    const list = (historyResult.data ?? []) as HistoryRow[];
    setHistory(list);
    setVehicleDetails(((detailsResult.data ?? [])[0] ?? null) as VehicleDetails | null);
    setIdentifications((identityResult.data ?? []) as PersonIdentification[]);
    // Person links are enforced per observation organisation, not by the
    // panel-wide R&M gate, so only offer the control where the server allows it.
    const linkOrgIds = [...new Set(list.filter((item) => item.source === 'patrol' && item.canonical_vehicle_id).map((item) => item.organization_id))];
    if (linkOrgIds.length) {
      const scopes = await Promise.all(linkOrgIds.map((organizationId) => supabase.rpc('can_view_rnm_identity_for_organization', { p_organization_id: organizationId })));
      if (requestId !== historyRequest.current) return;
      setIdentityLinkOrgIds(new Set(linkOrgIds.filter((_, index) => scopes[index].data === true)));
    }
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
  const mentionTotal = plateMentions[0]?.total_count ?? 0;
  const visible = filter.trim() ? rows.filter((row) => row.plate.includes(filter.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))) : rows;

  if (!canManageIdentity) return error ? <div className="alert alert-error" role="alert">{error}</div> : null;

  return (
    <section className="reports-section repeat-subjects" aria-labelledby="repeat-subjects-title">
      <div className="repeat-subjects__head">
        <div>
          <h2 id="repeat-subjects-title">Repeat vehicles</h2>
          <p className="subtitle">Vehicles seen more than once, across patrol sightings and CCTV detections a person has accepted.</p>
        </div>
        <div className="repeat-subjects__controls">
          <label>Agreement
            <select value={agreementId} onChange={(event) => setAgreementId(event.target.value)}>
              <option value="">All authorised agreements and observations</option>
              {providerAgreements.map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.client_name ? `${agreement.client_name} · ` : ''}{agreement.name}</option>)}
            </select>
          </label>
          <label>Seen at least
            <select value={minSightings} onChange={(event) => setMinSightings(Number(event.target.value))}>
              {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n} {n === 1 ? 'time (all subjects)' : 'times'}</option>)}
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
      <p className="subtitle">{agreementId ? 'Selected agreement only.' : 'Across all authorised R&M organisations, including observations without an agreement. Unrelated organisations remain excluded.'}</p>
      <p className="repeat-subjects__count" role="status">{loading ? 'Loading repeat vehicles…' : `${total.toLocaleString('en-NZ')} ${total === 1 ? 'vehicle' : 'vehicles'}`}</p>
      <div className="reports-table-wrapper repeat-subjects__table-wrap" role="region" aria-label="Repeat vehicle results" tabIndex={0}>
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

      <section className="repeat-subjects__mentions" aria-labelledby="plate-mentions-title">
          <h3 id="plate-mentions-title">Plate mentions to review</h3>
          <p className="subtitle">These plate-shaped strings were found in patrol comments but are not linked to a structured observation. They are suggestions only and have not been counted as sightings.</p>
          <p className="repeat-subjects__count" role="status">{loading ? 'Loading mentions…' : `${mentionTotal.toLocaleString('en-NZ')} unlinked plate mentions`}</p>
          <div className="reports-table-wrapper repeat-subjects__table-wrap" role="region" aria-label="Unlinked plate mentions" tabIndex={0}>
            <table className="reports-table">
              <thead><tr><th>Plate text</th><th>Mentions</th><th>First mention</th><th>Last mention</th><th>Review</th></tr></thead>
              <tbody>
                {!loading && plateMentions.length === 0 && <tr><td colSpan={5} className="text-center">No unlinked plate-shaped comments in this period.</td></tr>}
                {plateMentions.map((mention) => <tr key={mention.plate}>
                  <td>{mention.plate}</td><td>{mention.mentions}</td>
                  <td>{new Date(mention.first_seen).toLocaleDateString('en-NZ')}</td>
                  <td>{new Date(mention.last_seen).toLocaleDateString('en-NZ')}</td>
                  <td><button type="button" className="repeat-subjects__plate" onClick={() => void open({ plate: mention.plate, sightings: 0, places: 0, officers: 0, patrol_sightings: 0, cctv_sightings: 0, first_seen: mention.first_seen, last_seen: mention.last_seen, owner_identified: false, total_count: 0 })}>Review comments</button></td>
                </tr>)}
              </tbody>
            </table>
          </div>
      </section>

      <RepeatPeoplePanel agreementId={agreementId} rangeDays={RANGES[rangeIndex].days} />

      {selected && (
        <div className="activity-browser__overlay" onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <aside className="activity-browser__detail" role="dialog" aria-modal="true" aria-labelledby="subject-history-title">
            <div className="activity-browser__detail-head">
              <h3 id="subject-history-title">{selected.plate} · {selected.sightings} sightings</h3>
              <button type="button" className="activity-browser__close" onClick={() => setSelected(null)} aria-label="Close sighting history"><X size={16} aria-hidden="true" /></button>
            </div>
            <p className="subtitle">{selected.places} {selected.places === 1 ? 'place' : 'places'} · first seen {new Date(selected.first_seen).toLocaleDateString('en-NZ')} · last seen {new Date(selected.last_seen).toLocaleDateString('en-NZ')}</p>
            {vehicleDetails && <dl className="repeat-subjects__vehicle-details">
              <div><dt>Canonical vehicle</dt><dd>{[vehicleDetails.year, vehicleDetails.colour, vehicleDetails.make, vehicleDetails.model, vehicleDetails.body_type].filter(Boolean).join(' ') || 'No canonical detail recorded'}</dd></div>
              <div><dt>Fuel type</dt><dd>{vehicleDetails.fuel_type || '—'}</dd></div>
              <div><dt>Owner</dt><dd>{vehicleDetails.owner_identified ? 'Identified by R&M' : 'Not identified'}</dd></div>
            </dl>}
            {vehicleDetails && <p className="repeat-subjects__correct">
              <a className="btn btn-secondary btn-sm" href={`/admin/field-ops?area=vehicle-search&vehicle=${encodeURIComponent(vehicleDetails.canonical_vehicle_id)}`}>Correct canonical vehicle details</a>
              <small>Opens Vehicle Search &amp; Flags. Shared vehicle facts are audit-logged with your organisation and time.</small>
            </p>}
            {vehicleDetails && <VehicleOwnerPanel vehicleId={vehicleDetails.canonical_vehicle_id} organizationId={profile?.organizationId}
              onChanged={() => setVehicleDetails((current) => current ? { ...current, owner_identified: true } : current)} />}
            {identifications.length > 0 && <section className="repeat-subjects__identifications" aria-label="R&M person identifications">
              <h4>People related to these observations</h4>
              {identifications.map((item) => <p key={`${item.canonical_person_id}-${item.linked_at}`}><strong>{item.display_name || 'Unnamed person record'}</strong> · {item.identification_basis || 'Basis recorded in audit history'} · {new Date(item.linked_at).toLocaleDateString('en-NZ')}</p>)}
            </section>}
            {historyLoading && <p role="status">Loading history…</p>}
            <ol className="repeat-subjects__history">
              {history.map((item) => (
                <li key={`${item.source}-${item.record_id}`}>
                  <strong>{new Date(item.observed_at).toLocaleString('en-NZ')}</strong>
                  {item.source === 'patrol' && <ObservationIndicators annotation={annotations[item.record_id]} />}
                  <span>{item.place_id ? placeNames.get(item.place_id) ?? 'Unnamed place' : 'No place recorded'} · {item.source === 'cctv' ? 'CCTV (accepted)' : item.source === 'patrol_comment' ? 'Patrol comment mention' : 'Patrol'}{item.officer_id ? ` · ${officerNames[item.officer_id] ?? '…'}` : ''}</span>
                  {item.note && <em>{item.note}</em>}
                  {item.compliance_status && <span>Compliance: {item.compliance_status}</span>}
                  {item.compliance_reason && <em>{item.compliance_reason}</em>}
                  {item.source === 'patrol' && <details><summary>Photos and evidence</summary><RecordEvidencePanel recordKind="observation" recordId={item.record_id} organizationId={item.organization_id} canAdd /></details>}
                  {item.source === 'patrol' && <details><summary>Follow-up and notes{annotations[item.record_id]?.update_count ? ` (${annotations[item.record_id].update_count})` : ''}</summary>
                    <RecordUpdatesPanel recordKind="observation" recordId={item.record_id} onChanged={() => void reloadAnnotations()} />
                  </details>}
                  {item.source === 'cctv' && item.evidence_item_id && <CctvEvidenceLink evidenceId={item.evidence_item_id} />}
                  {item.source === 'patrol' && item.canonical_vehicle_id && identityLinkOrgIds.has(item.organization_id) && <PersonObservationLink item={item} onLinked={() => void open(selected)} />}
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

function PersonObservationLink({
  item,
  onLinked,
}: {
  item: HistoryRow;
  onLinked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<
    Array<{ id: string; display_name: string | null }>
  >([]);
  const [personId, setPersonId] = useState("");
  const [basis, setBasis] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void supabase
      .rpc("list_verified_person_projections_for_organization", {
        p_organization_id: item.organization_id,
      })
      .then(({ data, error: queryError }) => {
        if (cancelled) return;
        if (queryError) setError(queryError.message);
        else setPeople((data ?? []) as typeof people);
      });
    return () => {
      cancelled = true;
    };
  }, [item.organization_id, open]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!personId || basis.trim().length < 5) return;
    setBusy(true);
    setError(null);
    const { error: linkError } = await supabase.rpc(
      "link_observation_entities",
      {
        p_observation_id: item.record_id,
        p_organization_id: item.organization_id,
        p_canonical_vehicle_id: item.canonical_vehicle_id,
        p_person_record_id: personId,
        p_site_id: null,
        p_zone_id: null,
        p_location_id: null,
        p_incident_id: null,
        p_identity_basis: basis.trim(),
      },
    );
    if (linkError) setError(linkError.message);
    else {
      setOpen(false);
      setPersonId("");
      setBasis("");
      onLinked();
    }
    setBusy(false);
  };

  return (
    <div className="repeat-subjects__person-link">
      <button
        type="button"
        className="btn btn-secondary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Cancel person link" : "Link a verified person to this sighting"}
      </button>
      {open && (
        <form onSubmit={(event) => void save(event)}>
          <label>
            Person record
            <select
              required
              value={personId}
              onChange={(event) => setPersonId(event.target.value)}
            >
              <option value="">Select person</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.display_name || "Unnamed verified record"}
                </option>
              ))}
            </select>
            {people.length === 0 && (
              <small>
                No identity-reviewed people are available yet. To record who
                owns this vehicle, use the Owner identity section above; a
                sighting can only be linked to a person after their identity
                has been reviewed.
              </small>
            )}
          </label>
          <label>
            Identification basis
            <textarea
              required
              minLength={5}
              maxLength={1000}
              value={basis}
              onChange={(event) => setBasis(event.target.value)}
              placeholder="Record the source or evidence that supports this link"
            />
          </label>
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !personId || basis.trim().length < 5}
          >
            {busy ? "Saving…" : "Save link"}
          </button>
          <small>
            This link is organisation-scoped and audit-logged. It does not
            change the person record's review state.
          </small>
        </form>
      )}
    </div>
  );
}
