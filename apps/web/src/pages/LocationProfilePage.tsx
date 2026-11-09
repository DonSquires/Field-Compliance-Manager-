import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ActivityRecordBrowser } from '../components/ActivityRecordBrowser';
import { LocationHouseMap } from '../components/LocationHouseMap';
import { OperationalPlaceManager } from '../components/OperationalPlaceManager';
import { latestFieldVerification, placeFailure, type FieldPlace, type FieldPlaceWorkspace } from '../lib/fieldPlaces';
import { supabase } from '../lib/supabase';
import { resolveAddressCandidates, type AddressCandidate } from '../lib/locationAddress';
import { readWorkflowContext, workflowContextQuery } from '../lib/workflowNavigation';
import '../styles/PlaceWorkspace.css';

export default function LocationProfilePage({ locationId }: { locationId: string }) {
  const { profile, operatingOrganizationId } = useAuth();
  const route = useLocation();
  const workflowContext = readWorkflowContext(route.search);
  const providerId = readWorkflowContext(route.search).providerId ?? operatingOrganizationId ?? profile?.organizationId ?? undefined;
  const navigate = useNavigate();
  const [place, setPlace] = useState<FieldPlace | null>(null);
  const [clientName, setClientName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [section, setSection] = useState<'profile' | 'reports'>('profile');
  const [manage, setManage] = useState(() => new URLSearchParams(route.search).get('manage') === 'geofences');
  const [addressSearch, setAddressSearch] = useState('');
  const [addressMatches, setAddressMatches] = useState<AddressCandidate[]>([]);
  const [address, setAddress] = useState<AddressCandidate | null>(null);
  const [findingAddress, setFindingAddress] = useState(false);
  const [deliverySiteId, setDeliverySiteId] = useState('');
  const addressRequest = useRef(0);
  const [form, setForm] = useState({ name: '', notes: '', brief: '', access: '', safety: '', risk: '', active: true });
  useEffect(() => {
    addressRequest.current++;
    setFindingAddress(false); setAddressMatches([]); setAddress(null);
    if (!providerId) { setLoading(false); setError('Choose an operating organisation first.'); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    void (async () => {
      try {
        const response = await supabase.rpc('get_field_place_workspace', { p_provider_id: providerId, p_location_id: locationId });
        if (response.error || !response.data) throw response.error ?? new Error('Location profile returned no data.');
        const workspace = response.data as FieldPlaceWorkspace;
        const next = workspace.places.find(item => item.id === locationId);
        if (!next) throw new Error('Location is not covered by a current operational agreement.');
        if (cancelled) return;
        const site = next.sites[0];
        setPlace(next); setClientName(workspace.clients.find(item => item.id === next.organization_id)?.name ?? '');
        const activeSites = next.sites.filter(item => item.active);
        setDeliverySiteId(activeSites.length === 1 ? activeSites[0].id : '');
        setForm({ name: next.name, notes: next.notes ?? '', brief: site?.site_brief ?? '', access: site?.access_instructions ?? '', safety: site?.hs_notes ?? '', risk: site?.risk_level ?? '', active: site?.active ?? true });
        setDirty(false); setAddress(null); setAddressMatches([]); setAddressSearch('');
      } catch (failure) { if (!cancelled) { setPlace(null); setError(placeFailure(failure)); } }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; addressRequest.current++; };
  }, [providerId, locationId, revision]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  const confirmLeave = () => !dirty || window.confirm('Leave without saving location changes?');
  const change = (field: keyof typeof form, value: string | boolean) => { setForm(current => ({ ...current, [field]: value })); setDirty(true); setNotice(null); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!place || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const site = place.sites.length === 1 ? place.sites[0] : undefined;
      const areas = place.zones.filter(item => !item.is_verification_point);
      const zone = !place.sites.length && areas.length === 1 ? areas[0] : undefined;
      const response = await supabase.rpc('save_service_location_profile', {
        p_provider_id: providerId, p_location_id: place.id, p_expected_updated_at: place.updated_at,
        p_name: form.name, p_notes: form.notes, p_site_id: site?.id ?? null, p_site_version: site?.configuration_version ?? null,
        p_site_profile: site ? { risk_level: form.risk || null, site_brief: form.brief, access_instructions: form.access, hs_notes: form.safety, active: form.active } : null,
        p_resolved_address: address,
        p_zone_id: zone?.id ?? null, p_zone_version: zone?.configuration_version ?? null,
      });
      if (response.error) throw response.error;
      if (!response.data?.updated_at) throw new Error('No location receipt was returned. Reload before retrying.');
      setDirty(false); setNotice('Location profile saved. Officer verification history is preserved.'); setRevision(value => value + 1);
    } catch (failure) { setError(placeFailure(failure)); }
    finally { setBusy(false); }
  };
  const site = place?.sites.length === 1 ? place.sites[0] : undefined;
  const deliverySite = place?.sites.find(item => item.id === deliverySiteId && item.active);
  const verification = place ? latestFieldVerification(place) : undefined;
  const context = place ? { accountId: place.organization_id, locationId: place.id, siteId: deliverySite?.id, providerId } : {};

  return <div className="place-workspace">
    <header><div><h1>{place?.name ?? 'Location profile'}</h1><p>{clientName}</p></div><button disabled={busy} onClick={() => { if (confirmLeave()) navigate(`/admin/client-setup${workflowContextQuery({ accountId: place?.organization_id, providerId })}`); }}>Client and locations</button></header>
    {error && <p role="alert" className="place-message is-error">{error} <button onClick={() => { if (confirmLeave()) setRevision(value => value + 1); }}>Reload profile</button></p>}
    {notice && <p role="status" className="place-message">{notice}</p>}
    {loading ? <p role="status">Loading location...</p> : place && <>
      <nav className="place-actions" aria-label="Location work">
        <button aria-pressed={section === 'profile'} onClick={() => setSection('profile')}>Profile</button>
        {place.sites.length > 1 && <label>Site for scheduling<select value={deliverySiteId} onChange={event => setDeliverySiteId(event.target.value)}><option value="">Choose an active site</option>{place.sites.filter(item => item.active).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        {place.sites.length ? <button disabled={!deliverySite || busy} onClick={() => { if (confirmLeave()) navigate(`/admin/client-setup${workflowContextQuery(context)}&view=delivery`); }}>Scheduling and services</button>
          : <button onClick={() => { if (confirmLeave()) navigate(`/admin/relationships${workflowContextQuery(context)}`); }}>Agreements and services</button>}
        <button aria-pressed={section === 'reports'} onClick={() => setSection('reports')}>Reporting and activity</button>
        <button disabled={busy} onClick={() => { if (confirmLeave()) setManage(true); }}>Map, areas and restrictions</button>
      </nav>
      {section === 'reports' ? <ActivityRecordBrowser zoneIds={place.zones.map(zone => zone.id)} siteIds={place.sites.map(item => item.id)} scopeLabel={place.name} />
        : <>
          <section className="place-section" aria-label="Field verification">
            <h2>{verification ? 'Officer verified' : 'Not field verified'}</h2>
            {verification ? <><p>{verification.verified_by ?? 'Recorded officer'} · {new Date(verification.verified_at!).toLocaleString('en-NZ')} · 10 m reference point</p>
              <p className="place-help">The point was checked in the field. This does not certify the whole property boundary or its rules.</p>
              {verification.capture && <p className="place-help">Original GPS accuracy: {verification.capture.accuracy.toFixed(1)} m. {verification.capture.lat !== verification.capture.confirmed_lat || verification.capture.lng !== verification.capture.confirmed_lng ? 'Point was corrected on the map; the original fix is retained.' : 'GPS point was confirmed on the map.'}</p>}</>
              : <p>An officer can select this location in Places and capture its GPS point.</p>}
          </section>
          <form className="place-section" aria-label="Location details" onSubmit={event => void save(event)}>
            <fieldset disabled={busy}>
              <div className="place-fields"><label>Location name<input required maxLength={200} value={form.name} onChange={event => change('name', event.target.value)} /></label>
                <label>Location notes<textarea maxLength={10000} value={form.notes} onChange={event => change('notes', event.target.value)} /></label></div>
              <p>Address: {place.address ?? 'No street address recorded'}</p>
              <details><summary>Add or change street address</summary>
                <label>Find address<input disabled={findingAddress} value={addressSearch} onChange={event => { setAddressSearch(event.target.value); setAddressMatches([]); setAddress(null); }} /></label>
                <button type="button" disabled={findingAddress || addressSearch.trim().length < 3} onClick={async () => {
                  const version = ++addressRequest.current;
                  setFindingAddress(true); setError(null);
                  try {
                    const matches = await resolveAddressCandidates(addressSearch);
                    if (version !== addressRequest.current) return;
                    setAddressMatches(matches);
                    if (!matches.length) setError('No address matched. Refine the search, or leave the street address blank.');
                  } catch (failure) { if (version === addressRequest.current) setError(placeFailure(failure)); }
                  finally { if (version === addressRequest.current) setFindingAddress(false); }
                }}>{findingAddress ? 'Finding...' : 'Find address'}</button>
                {addressMatches.map((candidate, index) => <button type="button" disabled={findingAddress} key={`${candidate.label}:${index}`} aria-pressed={address === candidate} onClick={() => { setAddress(candidate); setDirty(true); }}>{candidate.label}</button>)}
                {address && <p>Address to save: {address.label}. The officer GPS evidence will be retained.</p>}
              </details>
              {site && <><div className="place-fields">
                <label>Officer briefing<textarea value={form.brief} onChange={event => change('brief', event.target.value)} /></label>
                <label>Access instructions<textarea value={form.access} onChange={event => change('access', event.target.value)} /></label>
                <label>Health and safety notes<textarea value={form.safety} onChange={event => change('safety', event.target.value)} /></label>
                <label>Risk level<select value={form.risk} onChange={event => change('risk', event.target.value)}><option value="">Not assessed</option>{['low', 'medium', 'high', 'critical'].map(risk => <option key={risk} value={risk}>{risk}</option>)}</select></label>
              </div><label className="place-check"><input type="checkbox" checked={form.active} onChange={event => change('active', event.target.checked)} />Site is active</label></>}
              {place.sites.length > 1 && <p>Multiple site facets share this location. Edit their briefings through Map, areas and restrictions.</p>}
              <button type="submit" className="btn btn-primary" disabled={!dirty || !form.name.trim()}>{busy ? 'Saving...' : 'Save location'}</button>
            </fieldset>
          </form>
          <section className="place-section" aria-label="Location map"><LocationHouseMap organizationId={place.organization_id} house={place} sites={place.sites} zones={place.zones} /></section>
        </>}
    </>}
    {manage && place && <OperationalPlaceManager locationId={place.id} initialZoneId={workflowContext.zoneId} onClose={() => { setManage(false); setRevision(value => value + 1); const params = new URLSearchParams(route.search); params.delete('manage'); navigate({ pathname: route.pathname, search: params.toString() ? `?${params.toString()}` : '' }, { replace: true }); }} onSaved={() => setDirty(false)} />}
  </div>;
}
