import React, { useCallback, useEffect, useState } from 'react';
import { Link2, Search, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

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
  incident_id: string | null;
  incident_label: string | null;
  poi: boolean;
  loi: boolean;
  compliance_status: string | null;
  officer_notes: string | null;
};

type Option = { id: string; name?: string | null; display_name?: string | null; plate_number?: string | null };

const fieldStyle: React.CSSProperties = { display: 'grid', gap: 6 };
const inputStyle: React.CSSProperties = { minHeight: 40, padding: '0 12px', border: '1px solid var(--border, #cbd5e1)', borderRadius: 6, background: 'var(--surface, #fff)' };

export default function ObservationSearchPage() {
  const { profile } = useAuth();
  const [search, setSearch] = useState('');
  const [siteId, setSiteId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [results, setResults] = useState<Observation[]>([]);
  const [sites, setSites] = useState<Option[]>([]);
  const [zones, setZones] = useState<Option[]>([]);
  const [vehicles, setVehicles] = useState<Option[]>([]);
  const [people, setPeople] = useState<Option[]>([]);
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadOptions = useCallback(async () => {
    if (!profile?.organizationId) return;
    const [siteResult, zoneResult, vehicleResult, peopleResult] = await Promise.all([
      supabase.from('client_sites').select('id, name').eq('organization_id', profile.organizationId).order('name').limit(200),
      supabase.from('location_zones').select('id, name').eq('organization_id', profile.organizationId).order('name').limit(200),
      supabase.from('canonical_vehicles').select('id, plate_number, make, model').order('plate_number').limit(200),
      supabase.from('person_records').select('id, display_name').eq('organization_id', profile.organizationId).order('display_name').limit(200),
    ]);
    setSites((siteResult.data ?? []) as Option[]);
    setZones((zoneResult.data ?? []) as Option[]);
    setVehicles((vehicleResult.data ?? []) as Option[]);
    setPeople((peopleResult.data ?? []) as Option[]);
  }, [profile?.organizationId]);

  const runSearch = useCallback(async () => {
    if (!profile?.organizationId) return;
    setError(null);
    const { data, error: searchError } = await supabase.rpc('search_observations', {
      p_organization_id: profile.organizationId,
      p_search: search.trim() || null,
      p_site_id: siteId || null,
      p_zone_id: zoneId || null,
      p_location_id: null,
      p_vehicle_id: null,
      p_person_id: null,
      p_incident_id: null,
      p_poi: null,
      p_loi: null,
      p_limit: 100,
    });
    if (searchError) setError(searchError.message);
    else setResults((data ?? []) as Observation[]);
  }, [profile?.organizationId, search, siteId, zoneId]);

  useEffect(() => { void loadOptions(); void runSearch(); }, [loadOptions, runSearch]);

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
    <main className="page-shell" style={{ maxWidth: 1440, margin: '0 auto', padding: 28 }}>
      <header className="page-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'end', flexWrap: 'wrap' }}>
        <div><span>Field intelligence</span><h1>Global observations</h1><p>Search linked observations across sites, zones, people, vehicles, POI, LOI, and incidents.</p></div>
        <button type="button" className="page-action" onClick={() => void runSearch()}><RefreshCw size={16} /> Refresh</button>
      </header>
      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 2fr) repeat(2, minmax(180px, 1fr)) auto', gap: 12, alignItems: 'end', margin: '24px 0' }}>
        <label style={fieldStyle}><span>Wildcard search</span><div style={{ display: 'flex', gap: 8 }}><Search size={18} style={{ alignSelf: 'center', marginLeft: 10 }} /><input style={{ ...inputStyle, width: '100%' }} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }} placeholder="plate, person, site, zone, incident, note" /></div></label>
        <label style={fieldStyle}><span>Site</span><select style={inputStyle} value={siteId} onChange={(event) => setSiteId(event.target.value)}><option value="">All sites</option>{sites.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label style={fieldStyle}><span>Zone</span><select style={inputStyle} value={zoneId} onChange={(event) => setZoneId(event.target.value)}><option value="">All zones</option>{zones.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" className="page-action" onClick={() => void runSearch()}>Search</button>
      </section>
      {error && <div className="page-error">{error}</div>}
      <section style={{ display: 'grid', gap: 12 }} aria-label="Observation results">
        {results.map((row) => <ObservationRow key={row.observation_id} row={row} sites={sites} zones={zones} vehicles={vehicles} people={people} linking={linking === row.observation_id} onLink={linkObservation} />)}
        {!results.length && <div className="page-empty">No observations match this search.</div>}
      </section>
    </main>
  );
}

function ObservationRow({ row, sites, zones, vehicles, people, linking, onLink }: { row: Observation; sites: Option[]; zones: Option[]; vehicles: Option[]; people: Option[]; linking: boolean; onLink: (id: string, values: Record<string, string>) => Promise<void> }) {
  const [vehicleId, setVehicleId] = useState(row.vehicle_id ?? '');
  const [personId, setPersonId] = useState(row.person_id ?? '');
  const [nextSiteId, setNextSiteId] = useState(row.site_id ?? '');
  const [nextZoneId, setNextZoneId] = useState(row.zone_id ?? '');
  return <article style={{ border: '1px solid var(--border, #dbe2ea)', borderRadius: 8, padding: 18, background: 'var(--surface, #fff)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}><div><strong>{row.plate_number || row.vehicle_label || 'Observation'}</strong><div>{new Date(row.observed_at).toLocaleString('en-NZ')} · {row.site_name || 'No site'} · {row.zone_name || 'No zone'}</div></div><span>{row.compliance_status || 'unclassified'}{row.poi ? ' · POI' : ''}{row.loi ? ' · LOI' : ''}</span></div>
    {row.person_label || row.vehicle_label || row.incident_label || row.officer_notes ? <p>{[row.person_label, row.vehicle_label, row.incident_label, row.officer_notes].filter(Boolean).join(' · ')}</p> : null}
    <details><summary><Link2 size={15} /> Link records</summary><div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(150px, 1fr)) auto', gap: 8, marginTop: 12, alignItems: 'end' }}>
      <label style={fieldStyle}><span>Vehicle</span><select style={inputStyle} value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}><option value="">None</option>{vehicles.map((item) => <option key={item.id} value={item.id}>{item.plate_number}</option>)}</select></label>
      <label style={fieldStyle}><span>Person</span><select style={inputStyle} value={personId} onChange={(event) => setPersonId(event.target.value)}><option value="">None</option>{people.map((item) => <option key={item.id} value={item.id}>{item.display_name || 'Unnamed person'}</option>)}</select></label>
      <label style={fieldStyle}><span>Site</span><select style={inputStyle} value={nextSiteId} onChange={(event) => setNextSiteId(event.target.value)}><option value="">Keep current</option>{sites.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label style={fieldStyle}><span>Zone</span><select style={inputStyle} value={nextZoneId} onChange={(event) => setNextZoneId(event.target.value)}><option value="">Keep current</option>{zones.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <button type="button" className="page-action" disabled={linking} onClick={() => void onLink(row.observation_id, { vehicleId, personId, siteId: nextSiteId, zoneId: nextZoneId, incidentId: '' })}>{linking ? 'Saving' : 'Save links'}</button>
    </div></details>
  </article>;
}
