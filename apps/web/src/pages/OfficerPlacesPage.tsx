import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { FieldPointMap } from '../components/FieldPointMap';
import { latestFieldVerification, placeFailure, type FieldPlaceWorkspace, type FieldPoint } from '../lib/fieldPlaces';
import { supabase } from '../lib/supabase';
import '../styles/PlaceWorkspace.css';

export default function OfficerPlacesPage() {
  const { profile, operatingOrganizationId } = useAuth();
  const provider = operatingOrganizationId ?? profile?.organizationId;
  return provider ? <FieldCaptureWorkspace key={provider} providerId={provider} /> : <p role="alert">Choose your operating organisation before recording a place.</p>;
}

function FieldCaptureWorkspace({ providerId }: { providerId: string }) {
  const route = useLocation();
  const params = new URLSearchParams(route.search);
  const [clientId, setClientId] = useState(params.get('account') ?? '');
  const [locationId, setLocationId] = useState(params.get('location') ?? '');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<FieldPlaceWorkspace | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'site' | 'zone'>('site');
  const [facetId, setFacetId] = useState('');
  const [point, setPoint] = useState<FieldPoint | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [locating, setLocating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const request = useRef(crypto.randomUUID());
  const gpsRequest = useRef(0);
  const selected = data?.places.find(place => place.id === locationId);
  const facets = useMemo(() => [
    ...(selected?.sites.map(site => ({ value: `site:${site.id}`, name: `Site - ${site.name}` })) ?? []),
    ...(selected?.zones.filter(zone => !zone.is_verification_point).map(zone => ({ value: `zone:${zone.id}`, name: `Area - ${zone.name}` })) ?? []),
  ], [selected]);
  const boundaries = useMemo(() => [...(selected?.sites ?? []), ...(selected?.zones.filter(zone => !zone.is_verification_point) ?? [])]
    .flatMap(place => place.boundary ? [place.boundary] : []), [selected]);
  const invalidate = () => { setConfirmed(false); setReceipt(null); request.current = crypto.randomUUID(); };

  useEffect(() => () => { gpsRequest.current += 1; }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    void Promise.resolve(supabase.rpc('get_field_place_workspace', {
      p_provider_id: providerId, p_client_id: clientId || null, p_search: search, p_offset: offset,
      p_location_id: null,
    })).then(async ({ data: response, error: loadError }) => {
      if (cancelled) return;
      if (loadError || !response) { setLoading(false); setData(null); setError(loadError?.message ?? 'Location workspace returned no data.'); return; }
      const workspace = response as FieldPlaceWorkspace;
      if (locationId && !workspace.places.some(place => place.id === locationId)) {
        const detail = await supabase.rpc('get_field_place_workspace', { p_provider_id: providerId, p_client_id: clientId, p_location_id: locationId });
        if (cancelled) return;
        if (detail.error) { setLoading(false); setData(null); setError(detail.error.message); return; }
        const place = (detail.data as FieldPlaceWorkspace | null)?.places.find(item => item.id === locationId);
        if (place) workspace.places = [place, ...workspace.places];
      }
      setLoading(false); setData(workspace);
    }).catch(failure => {
      if (!cancelled) { setLoading(false); setData(null); setError(placeFailure(failure)); }
    });
    return () => { cancelled = true; };
  }, [providerId, clientId, locationId, search, offset, revision]);

  useEffect(() => {
    if (selected) { setName(selected.name); setKind(selected.sites.length ? 'site' : 'zone'); }
    setFacetId(facets.length === 1 ? facets[0].value : '');
  }, [selected?.id]);

  const acquire = () => {
    invalidate(); setError(null); setPoint(null); setMapReady(false);
    if (!navigator.geolocation) { setError('GPS is not available in this browser. Use a device with location access.'); return; }
    setLocating(true);
    const version = ++gpsRequest.current;
    navigator.geolocation.getCurrentPosition(position => {
      if (version !== gpsRequest.current) return;
      setLocating(false);
      const { latitude: lat, longitude: lng, accuracy } = position.coords;
      if (![lat, lng, accuracy, position.timestamp].every(Number.isFinite) || accuracy <= 0) {
        setError('The device returned an invalid position. Try capturing GPS again.'); return;
      }
      setPoint({ lat, lng, accuracy, captured_at: new Date(position.timestamp).toISOString(), confirmed_lat: lat, confirmed_lng: lng });
    }, failure => {
      if (version !== gpsRequest.current) return;
      setLocating(false);
      setError(failure.code === 1 ? 'Location permission was denied. Allow location access in your browser and retry.' : `GPS could not be captured: ${failure.message}`);
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  };
  const correctPoint = useCallback((lat: number, lng: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      setError('Enter a latitude between -90 and 90 and longitude between -180 and 180.'); return;
    }
    setPoint(current => current ? { ...current, confirmed_lat: lat, confirmed_lng: lng } : null);
    setConfirmed(false); setReceipt(null); request.current = crypto.randomUUID();
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !point || !confirmed || !mapReady || !clientId || !name.trim() || (locationId && !selected) || (facets.length > 0 && !facetId)) return;
    setBusy(true); setError(null); setReceipt(null);
    try {
      const response = await supabase.rpc('capture_field_place', {
        p_request_id: request.current, p_provider_id: providerId, p_client_id: clientId,
        p_location_id: selected?.id ?? null, p_expected_updated_at: selected?.updated_at ?? null,
        p_place_kind: facetId ? (facetId.startsWith('zone:') ? 'zone' : 'site') : kind,
        p_name: name.trim(), p_capture: point, p_map_confirmed: confirmed,
        p_parent_zone_id: facetId.startsWith('zone:') ? facetId.slice(5) : null,
        p_target_site_id: facetId.startsWith('site:') ? facetId.slice(5) : null,
      });
      if (response.error) throw response.error;
      if (!response.data?.location_id || response.data.radius_m !== 10) throw new Error('The verification receipt is incomplete. Reload the location before retrying.');
      setReceipt(`${name.trim()} is officer verified. Its 10 m point is saved; existing boundaries are unchanged.`);
      setLocationId(response.data.location_id); setConfirmed(false); setRevision(value => value + 1);
    } catch (failure) { setError(placeFailure(failure)); }
    finally { setBusy(false); }
  };

  return <div className="place-workspace">
    <header><div><h1>Places</h1><p>Select a client and location, or add the place you are at.</p></div></header>
    {error && <div role="alert" className="place-message is-error">{error}<button type="button" onClick={() => setRevision(value => value + 1)}>Reload places</button></div>}
    {receipt && <p role="status" className="place-message">{receipt}</p>}
    <label>Client<select value={clientId} disabled={busy} onChange={event => {
      setClientId(event.target.value); setLocationId(''); setName(''); setSearch(''); setOffset(0); setData(null); invalidate();
    }}><option value="">Choose client</option>{data?.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
    {loading && <p role="status">Loading places...</p>}
    {!loading && !error && !data?.clients.length && <p>No operational clients are available. An administrator can confirm the engagement on the client page.</p>}
    {clientId && <section className="place-section" aria-label="Choose location">
      <div className="place-actions"><label>Find location<input type="search" value={search} disabled={busy} onChange={event => { setSearch(event.target.value); setLocationId(''); setOffset(0); invalidate(); }} /></label>
        <button type="button" disabled={busy} onClick={() => { setLocationId(''); setName(''); setSearch(''); setOffset(0); invalidate(); }}>Add new place</button></div>
      {!loading && data && <><label>Existing location<select value={locationId} disabled={busy} onChange={event => { setLocationId(event.target.value); invalidate(); }}>
        <option value="">New place</option>{data.places.map(place => <option key={place.id} value={place.id}>{place.name}{latestFieldVerification(place) ? ' - officer verified' : ''}</option>)}
      </select></label>
        {data.total > 100 && <div className="place-actions"><button disabled={offset === 0 || busy} onClick={() => setOffset(value => Math.max(0, value - 100))}>Previous</button><span>{offset + 1}-{Math.min(offset + 100, data.total)} of {data.total}</span><button disabled={offset + 100 >= data.total || busy} onClick={() => setOffset(value => value + 100)}>Next</button></div>}
      </>}
    </section>}
    {locationId && !loading && !selected && <p role="alert">The selected location is unavailable. Choose another location; no new place will be created in its place.</p>}
    {clientId && !loading && data && (!locationId || selected) && <form className="place-section" onSubmit={event => void save(event)} aria-label="Verify or add location">
      <fieldset disabled={busy}>
        <label>Location name<input required maxLength={200} value={name} onChange={event => { setName(event.target.value); invalidate(); }} /></label>
        {!selected && <label className="place-check"><input type="checkbox" checked={kind === 'zone'} onChange={event => { setKind(event.target.checked ? 'zone' : 'site'); invalidate(); }} />This is an area or zone, rather than a site</label>}
        {selected && facets.length > 1 && <label>Boundary to check<select required value={facetId} onChange={event => { setFacetId(event.target.value); invalidate(); }}><option value="">Choose site or area</option>{facets.map(facet => <option key={facet.value} value={facet.value}>{facet.name}</option>)}</select></label>}
        <p className="place-help">{selected ? 'The existing perimeter stays intact. This records a separate 10 m verification zone on the same place.' : 'No street address is required. An administrator can add further details later.'}</p>
        <p className="place-help">A connection is required to save verification. These captures are not queued offline; wait for the saved receipt.</p>
        <button type="button" disabled={locating} onClick={acquire}>{locating ? 'Getting GPS...' : point ? 'Capture GPS again' : 'Use my current GPS'}</button>
        {point && <>
          <p>GPS accuracy: {Math.round(point.accuracy)} m. Verification radius: <strong>10 m</strong>.</p>
          {point.accuracy > 10 && <p role="status" className="place-message">GPS accuracy is worse than 10 m. Check the map carefully and correct the point if needed.</p>}
          <FieldPointMap point={point} boundaries={boundaries} onChange={correctPoint} onReady={setMapReady} />
          <details><summary>Adjust coordinates using the keyboard</summary><div className="place-fields">
            <label>Confirmed latitude<input type="number" min="-90" max="90" step="any" value={point.confirmed_lat} onChange={event => correctPoint(Number(event.target.value), point.confirmed_lng)} /></label>
            <label>Confirmed longitude<input type="number" min="-180" max="180" step="any" value={point.confirmed_lng} onChange={event => correctPoint(point.confirmed_lat, Number(event.target.value))} /></label>
          </div></details>
          <label className="place-check"><input type="checkbox" disabled={!mapReady} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I have checked this point on the map and confirm this location</label>
        </>}
        <button type="submit" className="btn btn-primary" disabled={!point || !confirmed || !mapReady || !name.trim() || (facets.length > 0 && !facetId)}>{busy ? 'Saving...' : 'Save officer verification'}</button>
      </fieldset>
    </form>}
  </div>;
}
