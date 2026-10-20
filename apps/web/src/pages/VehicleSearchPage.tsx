import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { normalizePlateNumber, vehicleHistoryOrFilter } from '../lib/canonicalIdentity';
import { SAFETY_HAZARD_CLASSES, hazardClassLabel, describeWarningSource, warningContactPath, type SafetyWarning } from '../lib/safetyWarnings';
import { supabase } from '../lib/supabase';
import './VehicleSearchPage.css';

interface Vehicle {
  id: string;
  plate_number: string;
  make: string | null;
  model: string | null;
  year: number | null;
  colour: string | null;
  body_type: string | null;
  rego_status: string | null;
  rego_expiry: string | null;
  wof_status: string | null;
  wof_expiry: string | null;
  cof_status: string | null;
  cof_expiry: string | null;
  homeless_status: string | null;
  external_data_source_name: string | null;
  external_data_source_url: string | null;
  external_data_source_location: string | null;
  external_data_source_checked_at: string | null;
}
interface EntityFlag {
  id: string;
  entity_id: string;
  flag_type: string;
  alert_level: string | null;
  reason: string | null;
  active: boolean;
  raised_at: string;
  raised_by: string | null;
}
interface ScvRecord {
  id: string;
  certificate_number: string | null;
  certificate_status: string;
  expiry_date: string | null;
  issued_date: string | null;
}
interface Observation {
  id: string;
  observed_at: string;
  is_compliant: boolean | null;
  compliance_reason: string | null;
  nights_this_zone: number | null;
  zone: { name: string } | null;
}
interface Breach {
  id: string;
  breach_type: string;
  status: string;
  nights_count: number | null;
  notes: string | null;
  created_at: string;
  zone: { name: string } | null;
}
interface Permit {
  id: string;
  holder_name: string | null;
  permit_number: string;
  permit_type: string | null;
  forest_areas: string[] | null;
  date_from: string | null;
  date_to: string | null;
  status: string;
  firearm_licence_valid: boolean | null;
  conditions: string | null;
}
interface Dossier {
  safety: SafetyWarning[];
  flags: EntityFlag[];
  scv: ScvRecord | null;
  observations: Observation[];
  breaches: Breach[];
  permits: Permit[];
  errors: Record<string, string>;
}
type Filter = 'All' | 'VOI / Stolen' | 'Site Banned' | 'Compliance Expired';
const FILTERS: Filter[] = ['All', 'VOI / Stolen', 'Site Banned', 'Compliance Expired'];
const VEHICLE_COLUMNS = 'id, plate_number, make, model, year, colour, body_type, rego_status, rego_expiry, wof_status, wof_expiry, cof_status, cof_expiry, homeless_status, external_data_source_name, external_data_source_url, external_data_source_location, external_data_source_checked_at';
const FLAG_COLUMNS = 'id, entity_id, flag_type, alert_level, reason, active, raised_at, raised_by';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emptyDossier = (): Dossier => ({ safety: [], flags: [], scv: null, observations: [], breaches: [], permits: [], errors: {} });
const message = (error: unknown): string => error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Query unavailable. Check your access or connection.';
const date = (value: string | null | undefined): string => value ? new Date(value).toLocaleString('en-NZ') : 'Unavailable';
const platePattern = (input: string): string => input.toUpperCase().split('%').map(normalizePlateNumber).join('%');

async function bounded<T>(operation: PromiseLike<T>, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('Query timed out after 10 seconds.')); controller.abort(); }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const VehicleSearchPage: React.FC = () => {
  const { profile } = useAuth();
  const [params] = useSearchParams();
  const [plate, setPlate] = useState('');
  const [results, setResults] = useState<Vehicle[]>([]);
  const [resultFlags, setResultFlags] = useState<EntityFlag[] | null>(null);
  const [resultFlagError, setResultFlagError] = useState('');
  const [filter, setFilter] = useState<Filter>('All');
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [dossier, setDossier] = useState<Dossier>(emptyDossier);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [latency, setLatency] = useState<number | null>(null);
  const [detailLatency, setDetailLatency] = useState<number | null>(null);
  const [mobilePane, setMobilePane] = useState<'results' | 'dossier'>('results');
  const [form, setForm] = useState<null | 'interest' | 'safety'>(null);
  const [flagType, setFlagType] = useState('watchlist');
  const [hazard, setHazard] = useState('violence_or_aggression');
  const [severity, setSeverity] = useState('medium');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [writeNotice, setWriteNotice] = useState('');
  const [writeError, setWriteError] = useState('');
  const searchRequest = useRef(0);
  const detailRequest = useRef(0);
  const searchAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const selectedId = useRef<string | null>(null);
  const lastQuery = useRef<{ input: string; id?: string }>({ input: '' });
  const dossierHeading = useRef<HTMLHeadingElement>(null);
  const resultButtons = useRef(new Map<string, HTMLButtonElement>());
  const requestId = useRef<string | null>(null);
  const canRaise = Boolean(profile?.id && profile.organizationId);

  const loadDossier = useCallback(async (selected: Vehicle) => {
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    const sequence = ++detailRequest.current;
    const start = performance.now();
    requestId.current = null;
    selectedId.current = selected.id;
    setVehicle(selected);
    setDossier(emptyDossier());
    setDetailLoading(true);
    setDetailError('');
    setDetailLatency(null);
    setForm(null);
    setWriteNotice('');
    setWriteError('');
    try {
      if (!UUID.test(selected.id)) throw new Error('Canonical vehicle identity is unavailable.');
      const resolvedPlate = normalizePlateNumber(selected.plate_number);
      const historyFilter = vehicleHistoryOrFilter(resolvedPlate, selected.id);
      // Canonical Tier 0 attributes are global; flags remain explicitly org-scoped plus RLS.
      const [safety, flags, scv, observations, breaches, permits] = await bounded(Promise.all([
        supabase.rpc('get_safety_warnings', { p_entity_type: 'vehicle', p_entity_ids: [selected.id] }).abortSignal(controller.signal),
        profile?.organizationId
          ? supabase.from('entity_flags').select(FLAG_COLUMNS).eq('entity_type', 'vehicle').eq('entity_id', selected.id).eq('organization_id', profile.organizationId).is('hazard_class', null).order('raised_at', { ascending: false }).limit(100).abortSignal(controller.signal)
          : Promise.resolve({ data: null, error: { message: 'An active organisation is required to read flags.' } }),
        supabase.from('canonical_scv_public').select('id, certificate_number, certificate_status, expiry_date, issued_date').eq('plate_number', resolvedPlate).maybeSingle().abortSignal(controller.signal),
        supabase.from('observations').select('id, observed_at, is_compliant, compliance_reason, nights_this_zone, zone:zone_id(name)').or(historyFilter).order('observed_at', { ascending: false }).limit(25).abortSignal(controller.signal),
        supabase.from('breach_alerts').select('id, breach_type, status, nights_count, notes, created_at, zone:location_zones!breach_alerts_zone_id_fkey(name)').eq('plate_number', resolvedPlate).order('created_at', { ascending: false }).limit(25).abortSignal(controller.signal),
        supabase.from('person_permits_fieldwork').select('id, holder_name, permit_number, permit_type, forest_areas, date_from, date_to, status, firearm_licence_valid, conditions').contains('vehicle_plates', [resolvedPlate]).order('date_to', { ascending: false }).limit(50).abortSignal(controller.signal),
      ]), controller);
      if (sequence !== detailRequest.current) return;
      const errors: Record<string, string> = {};
      for (const [key, response] of Object.entries({ safety, flags, scv, observations, breaches, permits })) {
        if (response.error) errors[key] = message(response.error);
      }
      setDossier({
        safety: (safety.data ?? []) as SafetyWarning[],
        flags: (flags.data ?? []) as EntityFlag[],
        scv: scv.data as ScvRecord | null,
        observations: (observations.data ?? []) as unknown as Observation[],
        breaches: (breaches.data ?? []) as unknown as Breach[],
        permits: (permits.data ?? []) as Permit[],
        errors,
      });
    } catch (error) {
      if (sequence === detailRequest.current) setDetailError(message(error));
    } finally {
      if (sequence === detailRequest.current) {
        setDetailLoading(false);
        setDetailLatency(Math.round(performance.now() - start));
      }
    }
  }, [profile?.organizationId]);

  const search = useCallback(async (input: string, id?: string) => {
    searchAbort.current?.abort();
    detailAbort.current?.abort();
    ++detailRequest.current;
    selectedId.current = null;
    const controller = new AbortController();
    searchAbort.current = controller;
    const sequence = ++searchRequest.current;
    lastQuery.current = { input, id };
    const start = performance.now();
    setLoading(true);
    setDetailLoading(false);
    setQueryError('');
    setResultFlagError('');
    setLatency(null);
    setSearched(true);
    setResults([]);
    setResultFlags(null);
    setVehicle(null);
    setDossier(emptyDossier());
    setMobilePane('results');
    try {
      const pattern = platePattern(input);
      if (id ? !UUID.test(id) : !/[A-Z0-9]/.test(pattern)) throw new Error('Enter a plate or wildcard pattern such as RJ%9%8.');
      let query = supabase.from('canonical_vehicle_public').select(VEHICLE_COLUMNS);
      query = id ? query.eq('id', id) : query.ilike('plate_number', pattern);
      const response = await bounded(query.order('plate_number', { ascending: true }).limit(50).abortSignal(controller.signal), controller);
      if (response.error) throw response.error;
      if (sequence !== searchRequest.current) return;
      const rows = (response.data ?? []) as Vehicle[];
      setResults(rows);
      if (rows.length) {
        const ids = rows.map(row => row.id).filter(value => UUID.test(value));
        if (profile?.organizationId && ids.length) {
          const flags = await bounded(supabase.from('entity_flags').select(FLAG_COLUMNS).eq('organization_id', profile.organizationId).eq('entity_type', 'vehicle').in('entity_id', ids).is('hazard_class', null).eq('active', true).limit(1000).abortSignal(controller.signal), controller);
          if (sequence !== searchRequest.current) return;
          if (flags.error || (flags.data?.length ?? 0) >= 1000) {
            setResultFlagError(flags.error ? message(flags.error) : 'Flag result limit reached; flag filters are unavailable.');
          } else setResultFlags((flags.data ?? []) as EntityFlag[]);
        } else setResultFlagError('An active organisation is required to read flags.');
        if (rows.length === 1) void loadDossier(rows[0]);
      } else setResultFlags([]);
    } catch (error) {
      if (sequence === searchRequest.current) setQueryError(message(error));
    } finally {
      if (sequence === searchRequest.current) {
        setLoading(false);
        setLatency(Math.round(performance.now() - start));
      }
    }
  }, [profile?.organizationId, loadDossier]);

  useEffect(() => {
    const id = params.get('vehicle')?.trim();
    const input = params.get('plate')?.trim();
    if (id || input) { setPlate(input ?? ''); void search(input ?? '', id); }
    return () => {
      ++searchRequest.current;
      ++detailRequest.current;
      searchAbort.current?.abort();
      detailAbort.current?.abort();
      selectedId.current = null;
    };
  }, [params, search]);

  const selectVehicle = (row: Vehicle) => {
    setMobilePane('dossier');
    void loadDossier(row);
    requestAnimationFrame(() => dossierHeading.current?.focus());
  };
  const showResults = () => {
    setMobilePane('results');
    requestAnimationFrame(() => { if (vehicle) resultButtons.current.get(vehicle.id)?.focus(); });
  };
  const updateFlag = async (event?: React.FormEvent, flagId?: string) => {
    event?.preventDefault();
    if (!vehicle || !canRaise || saving) return;
    const id = vehicle.id;
    setSaving(true);
    setWriteError('');
    setWriteNotice('');
    try {
      // Writes are not cancelled: the audited server operation may already have committed.
      const response = flagId
        ? await supabase.rpc('resolve_entity_flag', { p_flag_id: flagId, p_note: null })
        : await supabase.rpc('raise_entity_flag', {
          p_client_request_id: requestId.current ?? (requestId.current = crypto.randomUUID()),
          p_entity_type: 'vehicle', p_entity_id: id,
          p_flag_type: form === 'safety' ? 'safety_warning' : flagType.trim(),
          p_alert_level: severity, p_reason: reason.trim(),
          p_hazard_class: form === 'safety' ? hazard : null,
        });
      if (response.error) throw response.error;
      requestId.current = null;
      if (selectedId.current !== id) return;
      const returned = response.data as EntityFlag;
      // Refresh authoritative reads; never synthesize a server flag from form values.
      setResultFlags(current => current && returned?.id ? [...current.filter(flag => flag.id !== returned.id), ...(returned.active && !('hazard_class' in returned && returned.hazard_class) ? [returned] : [])] : null);
      await loadDossier(vehicle);
      if (selectedId.current === id) {
        setReason('');
        setWriteNotice(flagId ? 'Flag resolved · audited by the server.' : 'Flag raised · audited by the server.');
      }
    } catch (error) {
      if (selectedId.current === id) setWriteError(message(error));
    } finally {
      setSaving(false);
    }
  };
  const openForm = (kind: 'interest' | 'safety') => {
    requestId.current = null;
    setForm(form === kind ? null : kind);
    setReason('');
  };
  const visibleResults = results.filter(row => {
    if (filter === 'All') return true;
    if (filter === 'Compliance Expired') return [row.rego_status, row.wof_status, row.cof_status].includes('expired');
    const types = resultFlags?.filter(flag => flag.entity_id === row.id && flag.active).map(flag => flag.flag_type.toLowerCase()) ?? [];
    return filter === 'Site Banned' ? types.some(type => ['site_banned', 'site_ban', 'trespass'].includes(type)) : types.some(type => ['voi', 'stolen', 'watchlist', 'vehicle_of_interest'].includes(type));
  });
  const sectionUnavailable = (key: string) => detailLoading ? <p>Loading evidence…</p> : detailError || dossier.errors[key] ? <p className="vehicle-inline-error" role="alert">{key === 'safety' ? 'Safety status unavailable. ' : 'Evidence unavailable. '}{detailError || dossier.errors[key]}</p> : null;
  const canResolve = (flag: EntityFlag) => canRaise && (flag.raised_by === profile?.id || ['admin', 'master', 'grand_master'].includes(profile?.role ?? ''));
  const filterUnavailable = (filter === 'VOI / Stolen' || filter === 'Site Banned') && resultFlags === null;
  const priorityWarnings = dossier.safety.filter(warning => warning.alert_level === 'critical' || warning.alert_level === 'high');
  const activeFlags = dossier.flags.filter(flag => flag.active);
  const history = [
    ...dossier.observations.map(row => ({ id: row.id, at: row.observed_at, kind: 'Observation', title: row.zone?.name ?? 'Place unavailable', status: row.is_compliant === true ? 'Compliant' : row.is_compliant === false ? 'Breach recorded' : 'Compliance unavailable', detail: [row.compliance_reason, row.nights_this_zone != null ? `${row.nights_this_zone} nights in zone` : null].filter(Boolean).join(' · ') })),
    ...dossier.breaches.map(row => ({ id: row.id, at: row.created_at, kind: 'Breach alert', title: `${row.breach_type.replace(/_/g, ' ')} · ${row.zone?.name ?? 'Place unavailable'}`, status: row.status, detail: [row.notes, row.nights_count != null ? `${row.nights_count} nights` : null].filter(Boolean).join(' · ') })),
    ...dossier.permits.filter(row => row.date_from).map(row => ({ id: row.id, at: row.date_from!, kind: 'Permit starts', title: `Permit ${row.permit_number}`, status: row.status, detail: row.permit_type ?? 'Permit type unavailable' })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <div className="vehicle-search-page" data-mobile-pane={mobilePane}>
      <nav className="vehicle-mobile-tabs" aria-label="Vehicle workbench panes">
        <button type="button" aria-pressed={mobilePane === 'results'} onClick={showResults}>Results</button>
        <button type="button" aria-pressed={mobilePane === 'dossier'} disabled={!vehicle} onClick={() => { setMobilePane('dossier'); requestAnimationFrame(() => dossierHeading.current?.focus()); }}>Dossier</button>
      </nav>
      <div className="vehicle-workbench">
        <aside className="vehicle-master" aria-label="Vehicle search and results">
          <div className="vehicle-master-controls">
            <p className="vehicle-eyebrow">FIELD OPERATIONS / VEHICLES</p>
            <h1>Vehicle Search &amp; Flags</h1>
            <p>Search the register. Review evidence before acting.</p>
            <form className="vehicle-search-form" onSubmit={event => { event.preventDefault(); void search(plate); }}>
              <label htmlFor="vehicle-plate">Plate or wildcard</label>
              <div><input id="vehicle-plate" placeholder="e.g. RJ%9%8" autoComplete="off" spellCheck={false} value={plate} maxLength={40} onChange={event => setPlate(event.target.value.toUpperCase())} /><button type="submit" disabled={loading}>Search</button></div>
              <small>% matches any sequence · up to 50 vehicles</small>
            </form>
            <div className="vehicle-query-status" role="status">
              {loading ? 'Query running…' : queryError || (searched ? `${results.length} matches${results.length === 50 ? ' · limit reached; refine your query' : ''}` : 'Ready to query')}
              {latency != null && <span className="vehicle-mono">{latency} ms</span>}
              {(queryError || resultFlagError) && <button type="button" disabled={loading} onClick={() => void search(lastQuery.current.input, lastQuery.current.id)}>Retry Query</button>}
            </div>
            {resultFlagError && <p className="vehicle-inline-error" role="alert">Flag summary unavailable: {resultFlagError}</p>}
            <div className="vehicle-quick-filters" aria-label="Filter fetched vehicles">
              {FILTERS.map(item => <button key={item} type="button" aria-pressed={filter === item} disabled={(item === 'VOI / Stolen' || item === 'Site Banned') && resultFlags === null} onClick={() => setFilter(item)}>{item}</button>)}
            </div>
            <small>Filters apply to fetched vehicles only. VOI = voi, stolen, watchlist or vehicle_of_interest; site ban = site_ban, site_banned or trespass. Expired = recorded registry status.</small>
          </div>
          <div className="vehicle-result-list" aria-label="Vehicle results" tabIndex={0} aria-busy={loading}>
            {visibleResults.map(row => {
              const active = resultFlags?.filter(flag => flag.entity_id === row.id && flag.active);
              return <button type="button" key={row.id} className="vehicle-result" aria-current={vehicle?.id === row.id ? 'true' : undefined} ref={node => { if (node) resultButtons.current.set(row.id, node); else resultButtons.current.delete(row.id); }} onClick={() => selectVehicle(row)}>
                <strong className="vehicle-mono">{row.plate_number}</strong>
                <span>{[row.make, row.model].filter(Boolean).join(' ') || 'Make / model unavailable'}</span>
                <small>{active ? active.length ? active.map(flag => flag.flag_type.replace(/_/g, ' ')).join(' · ') : 'No active organisation flags' : 'Flags unavailable'}</small>
              </button>;
            })}
            {!loading && !queryError && filterUnavailable && searched && <p className="vehicle-empty">Flag filter unavailable. Retry the query or choose All.</p>}
            {!loading && !queryError && !filterUnavailable && searched && !visibleResults.length && <p className="vehicle-empty">{results.length ? 'No fetched vehicles match this filter.' : 'No matching vehicles visible in the register. Refine the plate or wildcard.'}</p>}
            {!searched && <p className="vehicle-empty">Enter an exact plate or a wildcard to begin.</p>}
          </div>
        </aside>
        <main className="vehicle-dossier" aria-label="Selected vehicle dossier" tabIndex={0}>
          {!vehicle ? <div className="vehicle-dossier-placeholder"><p className="vehicle-eyebrow">VEHICLE DOSSIER</p><h2>Select a vehicle</h2><p>Safety, compliance and chronological evidence appear here.</p><p>Registry attributes are shared. Organisation records remain subject to your permissions and row-level security.</p></div> : <>
            <header className="vehicle-dossier-header">
              <p className="vehicle-eyebrow">VEHICLE DOSSIER</p>
              <h2 tabIndex={-1} ref={dossierHeading} className="vehicle-mono">{vehicle.plate_number}</h2>
              <p>{[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' ') || 'Make / model unavailable'} · {vehicle.colour ?? 'Colour unavailable'} · {vehicle.body_type ?? 'Body type unavailable'}</p>
              <small className="vehicle-mono">ID {vehicle.id}</small>
              {!detailLoading && !detailError && !dossier.errors.safety && priorityWarnings.length > 0 && <div className="vehicle-priority-banner vehicle-priority-banner--danger" role="alert" data-testid="vehicle-priority-safety">
                <span className="vehicle-priority-icon" aria-hidden="true">!</span>
                <div><strong>Active safety warning · {priorityWarnings.some(warning => warning.alert_level === 'critical') ? 'CRITICAL — do not approach; call for support' : 'HIGH — do not attend alone'}</strong><p>{priorityWarnings.map(warning => hazardClassLabel(warning.hazard_class)).join(' · ')}</p></div>
              </div>}
              {!detailLoading && !detailError && !dossier.errors.flags && activeFlags.length > 0 && <div className={`vehicle-priority-banner ${activeFlags.some(flag => flag.alert_level === 'critical' || flag.alert_level === 'high') ? 'vehicle-priority-banner--danger' : 'vehicle-priority-banner--attention'}`} data-testid="vehicle-active-flags">
                <span className="vehicle-priority-icon" aria-hidden="true">!</span>
                <div><strong>Active organisation flags ({activeFlags.length})</strong><p>{activeFlags.map(flag => `${flag.flag_type.replace(/_/g, ' ')}${flag.alert_level ? ` · ${flag.alert_level}` : ''}`).join(' / ')} · Review the recorded basis before acting.</p></div>
              </div>}
              <div className="vehicle-detail-status" role="status">{detailLoading ? 'Loading dossier…' : detailError ? 'Dossier unavailable' : 'Dossier query complete'}{detailLatency != null && <span className="vehicle-mono">{detailLatency} ms</span>}<button type="button" disabled={detailLoading || saving} onClick={() => void loadDossier(vehicle)}>{detailError || Object.keys(dossier.errors).length ? 'Retry Query' : 'Refresh dossier'}</button></div>
            </header>
            <section className="vehicle-section vehicle-safety" data-testid="vehicle-safety">
              <div className="vehicle-section-heading"><h3>Safety warnings</h3><button type="button" disabled={!canRaise || saving || detailLoading} onClick={() => openForm('safety')}>Raise a safety warning</button></div>
              <p>Platform-wide hazards; other organisations’ notes stay private. Contact the raising organisation before attending.</p>
              {sectionUnavailable('safety') || (dossier.safety.length ? dossier.safety.map(warning => <article key={warning.id} className="vehicle-evidence-row">
                <strong>{hazardClassLabel(warning.hazard_class)} · {warning.alert_level}</strong>
                <p>{describeWarningSource(warning)} · <time className="vehicle-mono">{date(warning.raised_at)}</time></p>
                {warning.is_own_organization && warning.reason && <p>{warning.reason}</p>}
                {!warning.is_own_organization && <p>{warningContactPath(warning).join(' · ') || 'Contact path unavailable. Ask your supervisor before attending.'}</p>}
                {warning.is_own_organization && <button type="button" disabled={saving || !canRaise} onClick={() => void updateFlag(undefined, warning.id)}>Resolve safety warning (server checks authority)</button>}
              </article>) : <p>No active safety warnings returned by the safety service.</p>)}
              {vehicle.homeless_status && vehicle.homeless_status !== 'none' && <p className="vehicle-welfare"><strong>Welfare: {vehicle.homeless_status}</strong> · Someone may be living in this vehicle. Approach with care and follow your welfare procedure.</p>}
            </section>
            {form && <section className="vehicle-section"><h3>{form === 'safety' ? 'Raise safety warning' : 'Raise of-interest flag'}</h3><p>Recorded for your profile organisation. The server checks authority and writes an audit receipt.</p>
              <form className="vehicle-flag-form" onSubmit={event => void updateFlag(event)}>
                {form === 'safety' ? <div className="vehicle-flag-field"><label htmlFor="vehicle-flag-hazard">Hazard</label><select id="vehicle-flag-hazard" value={hazard} onChange={event => { requestId.current = null; setHazard(event.target.value); }}>{SAFETY_HAZARD_CLASSES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div> : <label>Flag type<input required maxLength={80} value={flagType} onChange={event => { requestId.current = null; setFlagType(event.target.value); }} /></label>}
                <div className="vehicle-flag-field"><label htmlFor="vehicle-flag-severity">Severity</label><select id="vehicle-flag-severity" value={severity} onChange={event => { requestId.current = null; setSeverity(event.target.value); }}>{['low', 'medium', 'high', 'critical'].map(level => <option key={level}>{level}</option>)}</select></div>
                <label className="vehicle-flag-reason">Reason / details (organisation-private)<textarea required minLength={5} maxLength={4000} rows={3} value={reason} onChange={event => { requestId.current = null; setReason(event.target.value); }} /></label>
                <button type="submit" disabled={saving || !canRaise}>{saving ? 'Saving…' : 'Confirm & Raise Flag'}</button><button type="button" disabled={saving} onClick={() => setForm(null)}>Cancel</button>
              </form></section>}
            {writeError && <p className="vehicle-write-status" role="alert">Flag write failed: {writeError}</p>}
            {writeNotice && <p className="vehicle-write-status" role="status">{writeNotice}</p>}
            <section className="vehicle-section">
              <div className="vehicle-section-heading"><h3>Organisation flags</h3><button type="button" disabled={!canRaise || saving || detailLoading} onClick={() => openForm('interest')}>+ Raise of-interest flag</button></div>
              {!canRaise && <p>Flag writes require an active organisation identity.</p>}
              <p>Resolution is restricted to the raiser or an administrator of their organisation.</p>
              {sectionUnavailable('flags') || (dossier.flags.length ? dossier.flags.map(flag => <article key={flag.id} className="vehicle-evidence-row"><strong>{flag.flag_type.replace(/_/g, ' ')} · {flag.active ? 'Active' : 'Resolved'} · {flag.alert_level ?? 'Severity unavailable'}</strong><p>{flag.reason ?? 'Reason unavailable'}</p><time className="vehicle-mono">{date(flag.raised_at)}</time>{flag.active && canResolve(flag) && <button type="button" disabled={saving} onClick={() => void updateFlag(undefined, flag.id)}>Resolve flag</button>}</article>) : <p>No organisation flags visible for this vehicle.</p>)}
              {dossier.flags.length === 100 && <small>Latest 100 flags shown.</small>}
            </section>
            <section className="vehicle-section"><h3>Compliance &amp; certification</h3><div className="vehicle-compliance-grid">
              {([['Registration', vehicle.rego_status, vehicle.rego_expiry], ['WOF', vehicle.wof_status, vehicle.wof_expiry], ['COF', vehicle.cof_status, vehicle.cof_expiry]] as const).map(([label, status, expiry]) => <div key={label}><h4>{label}</h4><strong>{status ?? 'Unavailable'}</strong><p className="vehicle-mono">Expiry: {expiry ?? 'Unavailable'}</p></div>)}
              <div><h4>Self-containment (NZSCV)</h4>{sectionUnavailable('scv') || (dossier.scv ? <><strong>{dossier.scv.certificate_status}</strong><p className="vehicle-mono">Certificate {dossier.scv.certificate_number ?? 'Unavailable'}<br />Issued {dossier.scv.issued_date ?? 'Unavailable'}<br />Expiry {dossier.scv.expiry_date ?? 'Unavailable'}</p></> : <p>No certification record returned. Certification unavailable.</p>)}</div>
            </div><p>Registry statuses are recorded evidence, not a fresh external compliance check.</p>
              <h4>Licensed enrichment receipt</h4><p>{vehicle.external_data_source_name ?? 'Source unavailable'} · {vehicle.external_data_source_location ?? 'Location unavailable'} · <time className="vehicle-mono">{date(vehicle.external_data_source_checked_at)}</time></p>
              {vehicle.external_data_source_url && /^https?:\/\//i.test(vehicle.external_data_source_url) && <a href={vehicle.external_data_source_url} target="_blank" rel="noreferrer">Open recorded source</a>}
            </section>
            <section className="vehicle-section"><h3>Chronological evidence</h3><p>Newest first · latest 25 observations, 25 breaches and 50 permits · visible records only, not a complete incident record.</p>
              {['observations', 'breaches', 'permits'].map(key => <React.Fragment key={key}>{sectionUnavailable(key)}</React.Fragment>)}
              {!detailLoading && !detailError && history.map(entry => <article className="vehicle-evidence-row" key={`${entry.kind}-${entry.id}`}><div className="vehicle-evidence-meta"><strong>{entry.kind}</strong><time className="vehicle-mono">{date(entry.at)}</time></div><h4>{entry.title}</h4><p>{entry.status} {entry.detail && `· ${entry.detail}`}</p><small className="vehicle-mono">{entry.id}</small></article>)}
              {!detailLoading && !detailError && !history.length && !['observations', 'breaches', 'permits'].some(key => dossier.errors[key]) && <p>No observations, breaches or dated permits visible for this vehicle.</p>}
            </section>
            <section className="vehicle-section"><h3>Forest / site access permits</h3>{sectionUnavailable('permits') || (dossier.permits.length ? dossier.permits.map(permit => <article className="vehicle-evidence-row" key={permit.id}><h4>Permit <span className="vehicle-mono">{permit.permit_number}</span> · {permit.status}</h4><p>{permit.holder_name ?? 'Holder unavailable'} · {permit.permit_type ?? 'Type unavailable'}</p><p>{permit.forest_areas?.join(', ') || 'Areas unavailable'}</p><p className="vehicle-mono">{permit.date_from ?? 'Start unavailable'} — {permit.date_to ?? 'End unavailable'}</p><p>Firearm licence: {permit.firearm_licence_valid === true ? 'Recorded valid' : permit.firearm_licence_valid === false ? 'Recorded invalid' : 'Unavailable'}</p><p>{permit.conditions ?? 'Conditions unavailable'}</p><small className="vehicle-mono">{permit.id}</small></article>) : <p>No access permits visible for this plate.</p>)}</section>
          </>}
        </main>
      </div>
    </div>
  );
};

export default VehicleSearchPage;
