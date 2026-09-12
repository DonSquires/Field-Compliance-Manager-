import React, { useCallback, useEffect, useState } from 'react';
import { Car, CheckCircle2, Eye, FileSearch, Link2, MapPin, RefreshCw, Search, UserRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import './PageStyles.css';
import './ObservationSearchPage.css';
import './ObservationSearchFilters.css';
import './ObservationSearchTheme.css';

type Observation = {
  observation_id: string;
  observed_at: string;
  plate_number: string | null;
  vehicle_id: string | null;
  vehicle_label: string | null;
  person_id: string | null;
  person_label: string | null;
  site_id: string | null;
  site_name: string | null;
  zone_id: string | null;
  zone_name: string | null;
  location_id: string | null;
  location_name: string | null;
  incident_id: string | null;
  incident_label: string | null;
  poi: boolean;
  loi: boolean;
  compliance_status: string | null;
  officer_notes: string | null;
};

type Option = { id: string; name?: string | null; display_name?: string | null; plate_number?: string | null; incident_type?: string | null; description?: string | null };
type FlagFilter = '' | 'true' | 'false';

const fieldStyle: React.CSSProperties = { display: 'grid', gap: 6 };
const inputStyle: React.CSSProperties = { minHeight: 40, padding: '0 12px', border: '1px solid var(--border, #cbd5e1)', borderRadius: 6, background: 'var(--surface, #fff)' };

export default function ObservationSearchPage() {
  const { profile } = useAuth();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get('search') ?? '');
  const [siteId, setSiteId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [personId, setPersonId] = useState('');
  const [incidentId, setIncidentId] = useState('');
  const [poi, setPoi] = useState<FlagFilter>('');
  const [loi, setLoi] = useState<FlagFilter>('');
  const [results, setResults] = useState<Observation[]>([]);
  const [sites, setSites] = useState<Option[]>([]);
  const [zones, setZones] = useState<Option[]>([]);
  const [vehicles, setVehicles] = useState<Option[]>([]);
  const [people, setPeople] = useState<Option[]>([]);
  const [locations, setLocations] = useState<Option[]>([]);
  const [incidents, setIncidents] = useState<Option[]>([]);
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadOptions = useCallback(async () => {
    if (!profile?.organizationId) return;
    const [siteResult, zoneResult, vehicleResult, peopleResult, locationResult, incidentResult] = await Promise.all([
      supabase.from('client_sites').select('id, name').eq('organization_id', profile.organizationId).order('name').limit(200),
      supabase.from('location_zones').select('id, name').eq('organization_id', profile.organizationId).order('name').limit(200),
      supabase.from('canonical_vehicles').select('id, plate_number, make, model').order('plate_number').limit(200),
      supabase.from('person_records').select('id, display_name').eq('organization_id', profile.organizationId).order('display_name').limit(200),
      supabase.from('locations').select('id, name, address').eq('organization_id', profile.organizationId).order('name').limit(200),
      supabase.from('incidents').select('id, incident_type, description').eq('organization_id', profile.organizationId).order('created_at', { ascending: false }).limit(200),
    ]);
    setSites((siteResult.data ?? []) as Option[]);
    setZones((zoneResult.data ?? []) as Option[]);
    setVehicles((vehicleResult.data ?? []) as Option[]);
    setPeople((peopleResult.data ?? []) as Option[]);
    setLocations((locationResult.data ?? []) as Option[]);
    setIncidents((incidentResult.data ?? []) as Option[]);
  }, [profile?.organizationId]);

  const runSearch = useCallback(async () => {
    if (!profile?.organizationId) return;
    setError(null);
    const { data, error: searchError } = await supabase.rpc('search_observations', {
      p_organization_id: profile.organizationId,
      p_search: search.trim() || null,
      p_site_id: siteId || null,
      p_zone_id: zoneId || null,
      p_location_id: locationId || null,
      p_vehicle_id: vehicleId || null,
      p_person_id: personId || null,
      p_incident_id: incidentId || null,
      p_poi: poi === '' ? null : poi === 'true',
      p_loi: loi === '' ? null : loi === 'true',
      p_limit: 100,
    });
    if (searchError) setError(searchError.message);
    else setResults((data ?? []) as Observation[]);
  }, [profile?.organizationId, search, siteId, zoneId, locationId, vehicleId, personId, incidentId, poi, loi]);

  useEffect(() => { void loadOptions(); void runSearch(); }, [loadOptions, runSearch]);

  useEffect(() => {
    const routedSearch = searchParams.get('search') ?? '';
    if (routedSearch !== search) setSearch(routedSearch);
  }, [searchParams, search]);

  const selected = results.find((row) => row.observation_id === selectedId) ?? results[0] ?? null;

  const linkObservation = async (observationId: string, values: Record<string, string>) => {
    if (!profile?.organizationId) return;
    setLinking(observationId);
    setError(null);
    const { error: linkError } = await supabase.rpc('link_observation_entities', {
      p_observation_id: observationId,
      p_organization_id: profile.organizationId,
      p_canonical_vehicle_id: values.vehicleId || null,
      p_person_record_id: values.personId || null,
      p_site_id: values.siteId || null,
      p_zone_id: values.zoneId || null,
      p_location_id: null,
      p_incident_id: values.incidentId || null,
    });
    if (linkError) setError(linkError.message);
    else await runSearch();
    setLinking(null);
  };

  return (
    <main className="observation-workspace">
      <header className="observation-header">
        <div><span>Field operations / Intelligence</span><h1>Observation search</h1><p>Find the evidence trail across places, people, vehicles, incidents, and field notes.</p></div>
        <button type="button" className="page-action" onClick={() => void runSearch()}><RefreshCw size={16} /> Refresh</button>
      </header>
      <section className="observation-search-bar" aria-label="Observation filters">
        <label className="observation-search-input"><span>Search all observations</span><div><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }} placeholder="Plate, person, site, zone, incident, or note" /></div><small>Use % as a wildcard anywhere: %squires, squires%, or %squ%s%</small></label>
        <label><span>Site</span><select value={siteId} onChange={(event) => setSiteId(event.target.value)}><option value="">All sites</option>{sites.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>Zone</span><select value={zoneId} onChange={(event) => setZoneId(event.target.value)}><option value="">All zones</option>{zones.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>Location house</span><select value={locationId} onChange={(event) => setLocationId(event.target.value)}><option value="">All locations</option>{locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>Canonical vehicle</span><select value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}><option value="">All vehicles</option>{vehicles.map((item) => <option key={item.id} value={item.id}>{item.plate_number}</option>)}</select></label>
        <label><span>Canonical person</span><select value={personId} onChange={(event) => setPersonId(event.target.value)}><option value="">All people</option>{people.map((item) => <option key={item.id} value={item.id}>{item.display_name || 'Unnamed person'}</option>)}</select></label>
        <label><span>Incident</span><select value={incidentId} onChange={(event) => setIncidentId(event.target.value)}><option value="">All incidents</option>{incidents.map((item) => <option key={item.id} value={item.id}>{[item.incident_type, item.description].filter(Boolean).join(': ') || item.name || 'Incident'}</option>)}</select></label>
        <label><span>POI / VOI</span><select value={poi} onChange={(event) => setPoi(event.target.value as FlagFilter)}><option value="">Any POI / VOI</option><option value="true">Flagged</option><option value="false">Not flagged</option></select></label>
        <label><span>LOI</span><select value={loi} onChange={(event) => setLoi(event.target.value as FlagFilter)}><option value="">Any LOI</option><option value="true">Flagged</option><option value="false">Not flagged</option></select></label>
        <button type="button" className="observation-search-button" onClick={() => void runSearch()}>Search</button>
      </section>
      {error && <div className="page-error">{error}</div>}
      <section className="observation-content" aria-label="Observation results">
        <div className="observation-queue"><div className="observation-queue-header"><div><span>Review queue</span><h2>{results.length} observation{results.length === 1 ? '' : 's'}</h2></div><small>{search || siteId || zoneId ? 'Filtered results' : 'Most recent first'}</small></div>{results.map((row) => <ObservationRow key={row.observation_id} row={row} selected={row.observation_id === selected?.observation_id} onSelect={() => setSelectedId(row.observation_id)} />)}{!results.length && <div className="observation-empty"><FileSearch size={25} /><strong>No observations found</strong><span>Try a plate, place, person, incident, or note.</span></div>}</div>
        <aside className="observation-detail" aria-label="Selected observation detail">{selected ? <ObservationDetail row={selected} sites={sites} zones={zones} vehicles={vehicles} people={people} linking={linking === selected.observation_id} onLink={linkObservation} /> : <div className="observation-detail-empty"><Eye size={28} /><strong>Select an observation</strong><span>Choose a result to inspect its links and compliance context.</span></div>}</aside>
      </section>
    </main>
  );
}

function ObservationRow({ row, selected, onSelect }: { row: Observation; selected: boolean; onSelect: () => void }) {
  const title = row.plate_number || row.vehicle_label || row.person_label || 'Unidentified observation';
  return <button type="button" className={`observation-row ${selected ? 'is-selected' : ''}`} onClick={onSelect}><span className="observation-row-icon">{row.plate_number || row.vehicle_label ? <Car size={17} /> : <UserRound size={17} />}</span><span className="observation-row-main"><strong>{title}</strong><small>{new Date(row.observed_at).toLocaleString('en-NZ')} · {row.site_name || row.zone_name || 'Unassigned place'}</small></span><span className={`observation-status observation-status-${row.compliance_status || 'unknown'}`}>{row.compliance_status || 'Unclassified'}</span></button>;
}

function ObservationDetail({ row, sites, zones, vehicles, people, linking, onLink }: { row: Observation; sites: Option[]; zones: Option[]; vehicles: Option[]; people: Option[]; linking: boolean; onLink: (id: string, values: Record<string, string>) => Promise<void> }) {
  const [vehicleId, setVehicleId] = useState(row.vehicle_id ?? '');
  const [personId, setPersonId] = useState(row.person_id ?? '');
  const [nextSiteId, setNextSiteId] = useState(row.site_id ?? '');
  const [nextZoneId, setNextZoneId] = useState(row.zone_id ?? '');
  return <div className="observation-detail-inner"><header><div><span>Observation record</span><h2>{row.plate_number || row.vehicle_label || row.person_label || 'Unidentified observation'}</h2><small>{new Date(row.observed_at).toLocaleString('en-NZ')}</small></div><span className={`observation-detail-status observation-status-${row.compliance_status || 'unknown'}`}>{row.compliance_status || 'Unclassified'}</span></header><div className="observation-context-grid"><div><span>Place</span><strong>{row.site_name || 'No site'}{row.zone_name ? ` · ${row.zone_name}` : ''}</strong></div><div><span>Flags</span><strong>{row.poi ? 'POI' : ''}{row.poi && row.loi ? ' · ' : ''}{row.loi ? 'LOI' : ''}{!row.poi && !row.loi ? 'None' : ''}</strong></div><div><span>Person</span><strong>{row.person_label || 'Unlinked'}</strong></div><div><span>Vehicle</span><strong>{row.vehicle_label || row.plate_number || 'Unlinked'}</strong></div></div>{row.incident_label || row.officer_notes ? <div className="observation-note"><strong>{row.incident_label ? 'Incident context' : 'Officer note'}</strong><span>{row.incident_label || row.officer_notes}</span></div> : null}<details className="observation-link-editor"><summary><Link2 size={15} /> Link records</summary><div className="observation-link-grid"><label style={fieldStyle}><span>Vehicle</span><select style={inputStyle} value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}><option value="">None</option>{vehicles.map((item) => <option key={item.id} value={item.id}>{item.plate_number}</option>)}</select></label><label style={fieldStyle}><span>Person</span><select style={inputStyle} value={personId} onChange={(event) => setPersonId(event.target.value)}><option value="">None</option>{people.map((item) => <option key={item.id} value={item.id}>{item.display_name || 'Unnamed person'}</option>)}</select></label><label style={fieldStyle}><span>Site</span><select style={inputStyle} value={nextSiteId} onChange={(event) => setNextSiteId(event.target.value)}><option value="">Keep current</option>{sites.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label style={fieldStyle}><span>Zone</span><select style={inputStyle} value={nextZoneId} onChange={(event) => setNextZoneId(event.target.value)}><option value="">Keep current</option>{zones.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="button" className="observation-save-button" disabled={linking} onClick={() => void onLink(row.observation_id, { vehicleId, personId, siteId: nextSiteId, zoneId: nextZoneId, incidentId: '' })}>{linking ? 'Saving...' : 'Save links'}</button></div></details><div className="observation-governance"><CheckCircle2 size={16} /><span>Link changes are tenant-scoped and governed. Confirm place and identity context before using this record for compliance action.</span></div></div>;
}
