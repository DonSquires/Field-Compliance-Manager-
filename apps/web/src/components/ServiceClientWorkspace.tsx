import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { latestFieldVerification, placeFailure, type FieldPlaceWorkspace } from '../lib/fieldPlaces';
import { isAdminTierRole } from '../lib/roles';
import { supabase } from '../lib/supabase';
import { readWorkflowContext, workflowContextQuery, type NavigateWithContext } from '../lib/workflowNavigation';
import '../styles/PlaceWorkspace.css';

interface Client {
  id: string;
  name: string;
  updated_at: string;
  contact_email: string | null;
  contact_phone: string | null;
  account_notes: string | null;
}

interface Props {
  accountId?: string;
  providerOrganizationId?: string;
  embedded?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onNavigate: NavigateWithContext;
  onOpenDetails?: () => void;
}

export function ServiceClientWorkspace(props: Props) {
  const { profile, operatingOrganizationId } = useAuth();
  const location = useLocation();
  const account = props.accountId ?? new URLSearchParams(location.search).get('account') ?? '';
  const provider = props.providerOrganizationId ?? readWorkflowContext(location.search).providerId ?? operatingOrganizationId ?? profile?.organizationId;
  if (!provider || !isAdminTierRole(profile?.role)) return <p role="alert">Provider administrator access is required to set up a client.</p>;
  return <ClientEditor key={`${provider}:${account}`} {...props} accountId={account} providerId={provider} />;
}

function ClientEditor({ accountId, providerId, embedded, onDirtyChange, onNavigate, onOpenDetails }: Props & { providerId: string }) {
  const navigate = useNavigate();
  const route = useLocation();
  const [client, setClient] = useState<Client | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });
  const [engaged, setEngaged] = useState(false);
  const [engagementSaved, setEngagementSaved] = useState(false);
  const [places, setPlaces] = useState<FieldPlaceWorkspace | null>(null);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const [placeName, setPlaceName] = useState('');
  const [isZone, setIsZone] = useState(false);
  const [loading, setLoading] = useState(Boolean(accountId));
  const [placesLoading, setPlacesLoading] = useState(false);
  const [placesError, setPlacesError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(route.state?.serviceClientSaved === true ? 'Client saved. Add locations below; prices, schedules and invitations can follow.' : null);
  const [revision, setRevision] = useState(0);
  const [matches, setMatches] = useState<Array<{ id: string; name: string }>>([]);
  const request = useRef(crypto.randomUUID());
  const placeRequest = useRef(crypto.randomUUID());
  const hasDraft = dirty || (adding && Boolean(placeName.trim()));

  useEffect(() => {
    if (client || form.name.trim().length < 3) { setMatches([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const name = form.name.trim().replace(/[\\%_]/g, '\\$&');
        const response = await supabase.from('organizations').select('id,name').ilike('name', `%${name}%`).neq('id', providerId).limit(5);
        if (response.error) throw response.error;
        if (!cancelled) setMatches(response.data ?? []);
      } catch (failure) {
        if (!cancelled) { setMatches([]); setError(`Existing client matching failed: ${placeFailure(failure)}. Check the client directory before creating a duplicate.`); }
      }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [client, form.name, providerId]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true); setError(null);
    void (async () => {
      try {
        const [org, agreements] = await Promise.all([
          supabase.from('organizations').select('id,name,updated_at,contact_email,contact_phone,account_notes').eq('id', accountId).single(),
          supabase.from('service_agreements').select('id,starts_on,ends_on')
            .eq('provider_organization_id', providerId).eq('client_organization_id', accountId).eq('agreement_type', 'operational'),
        ]);
        if (org.error || agreements.error || !org.data) throw org.error ?? agreements.error ?? new Error('Client is not available.');
        if (cancelled) return;
        const next = org.data as Client;
        setClient(next); setForm({ name: next.name, email: next.contact_email ?? '', phone: next.contact_phone ?? '', notes: next.account_notes ?? '' });
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
        const confirmed = (agreements.data ?? []).some(item => (!item.starts_on || item.starts_on <= today)
          && (!item.ends_on || item.ends_on >= today));
        setEngaged(confirmed); setEngagementSaved(confirmed);
      } catch (failure) { if (!cancelled) setError(placeFailure(failure)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [accountId, providerId]);

  useEffect(() => {
    if (!client || !engagementSaved) { setPlaces(null); return; }
    let cancelled = false;
    setPlacesLoading(true); setPlacesError(null);
    void supabase.rpc('get_field_place_workspace', {
      p_provider_id: providerId, p_client_id: client.id, p_search: search, p_offset: offset,
    }).then(({ data, error: loadError }) => {
      if (cancelled) return;
      setPlacesLoading(false);
      if (loadError || !data) { setPlaces(null); setPlacesError(loadError?.message ?? 'Location list returned no data.'); }
      else setPlaces(data as FieldPlaceWorkspace);
    }, failure => {
      if (!cancelled) { setPlacesLoading(false); setPlaces(null); setPlacesError(placeFailure(failure)); }
    });
    return () => { cancelled = true; };
  }, [client?.id, engagementSaved, providerId, search, offset, revision]);

  useEffect(() => {
    onDirtyChange?.(hasDraft);
    if (!hasDraft) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [hasDraft, onDirtyChange]);

  const change = (field: keyof typeof form, value: string) => {
    setForm(current => ({ ...current, [field]: value })); setDirty(true); setNotice(null); request.current = crypto.randomUUID();
  };
  const leave = useCallback((destination: string, locationId?: string) => {
    if (hasDraft && !window.confirm('Leave without saving the client or new-location changes?')) return;
    onNavigate(destination, { accountId: client?.id, locationId, providerId });
  }, [hasDraft, client?.id, providerId, onNavigate]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await supabase.rpc('save_service_client', {
        p_request_id: request.current, p_provider_id: providerId, p_client_id: client?.id ?? null,
        p_expected_updated_at: client?.updated_at ?? null, p_name: form.name,
        p_email: form.email, p_phone: form.phone, p_notes: form.notes, p_confirm_engagement: engaged && !engagementSaved,
      });
      if (response.error) throw response.error;
      if (!response.data?.id || !response.data?.updated_at || typeof response.data.engagement_confirmed !== 'boolean') throw new Error('No complete client receipt was returned. Reload before retrying.');
      setClient(response.data as Client); setEngagementSaved(response.data.engagement_confirmed); setDirty(false);
      request.current = crypto.randomUUID();
      setNotice('Client saved. Add locations below; prices, schedules and invitations can follow.');
      if (!embedded && !accountId) navigate(`${route.pathname}${workflowContextQuery({ accountId: response.data.id, providerId })}`, { replace: true, state: { serviceClientSaved: true } });
    } catch (failure) { setError(placeFailure(failure)); }
    finally { setBusy(false); }
  };
  const addPlace = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!client || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await supabase.rpc('create_service_location', {
        p_request_id: placeRequest.current, p_provider_id: providerId, p_client_id: client.id,
        p_name: placeName, p_kind: isZone ? 'zone' : 'site',
      });
      if (result.error) throw result.error;
      if (!result.data?.location_id) throw new Error('No location receipt was returned. Reload the list before retrying.');
      setAdding(false); setPlaceName(''); setIsZone(false); setSearch(''); setOffset(0); setRevision(value => value + 1);
      placeRequest.current = crypto.randomUUID();
      setNotice('Location added. Open its row to edit the profile, or have an officer verify it on site.');
    } catch (failure) { setError(placeFailure(failure)); }
    finally { setBusy(false); }
  };

  if (loading) return <p role="status">Loading client...</p>;
  return <div className="place-workspace">
    {!embedded && <header><div><h1>{client ? client.name : 'Add client'}</h1><p>Client details and locations in one place.</p></div><button onClick={() => leave('crm')}>All clients</button></header>}
    {error && <div className="place-message is-error" role="alert">{error}</div>}
    {notice && <p className="place-message" role="status">{notice}</p>}
    {!client && matches.length > 0 && <section className="place-message" aria-label="Existing client matches"><p>Already on the books? Open the existing client instead of creating a duplicate.</p>
      {matches.map(match => <button key={match.id} type="button" onClick={() => {
        if (!dirty || window.confirm('Discard this new-client draft and open the existing client?')) onNavigate('client-setup', { accountId: match.id, providerId });
      }}>{match.name}</button>)}</section>}
    <form onSubmit={event => void save(event)} aria-label="Client details">
      <fieldset disabled={busy || Boolean(accountId && !client)}>
        <div className="place-fields">
          <label>Client name<input required maxLength={200} value={form.name} onChange={event => change('name', event.target.value)} /></label>
          <label>Contact email (optional)<input type="email" value={form.email} onChange={event => change('email', event.target.value)} /></label>
          <label>Contact phone (optional)<input type="tel" value={form.phone} onChange={event => change('phone', event.target.value)} /></label>
          <label>Notes (optional)<textarea maxLength={10000} value={form.notes} onChange={event => change('notes', event.target.value)} /></label>
        </div>
        {engagementSaved ? <p className="place-point-status">A current operational agreement is in place. Service does not wait for client approval; the client-portal invitation is separate.</p>
          : <label className="place-check"><input type="checkbox" checked={engaged} required={!client} onChange={event => {
            setEngaged(event.target.checked); setDirty(true); request.current = crypto.randomUUID();
          }} />I confirm this provider is engaged to deliver services for this client</label>}
        <div className="place-actions"><button className="btn btn-primary" type="submit" disabled={!form.name.trim() || (!client && !engaged)}>{busy ? 'Saving...' : 'Save client'}</button>
          {client && <button type="button" onClick={() => onOpenDetails ? onOpenDetails() : leave('relationships')}>Contacts, agreement and invitation</button>}</div>
      </fieldset>
    </form>
    <section className="place-section" aria-label="Client locations">
      <header><h2>Locations</h2><button type="button" disabled={!client || !engagementSaved || busy} onClick={() => setAdding(true)}>Add location</button></header>
      {!client ? <p>Save the client to add locations.</p> : !engagementSaved ? <p>Confirm the operational engagement above to add and use locations.</p> : <>
        <label>Search locations<input type="search" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} /></label>
        {adding && <form onSubmit={event => void addPlace(event)} aria-label="Add location" className="place-section">
          <fieldset disabled={busy}>
            <label>Location name<input autoFocus required maxLength={200} value={placeName} onChange={event => { setPlaceName(event.target.value); placeRequest.current = crypto.randomUUID(); }} /></label>
            <label className="place-check"><input type="checkbox" checked={isZone} onChange={event => { setIsZone(event.target.checked); placeRequest.current = crypto.randomUUID(); }} />This is an area or zone, rather than a site</label>
            <p className="place-help">A street address is optional. An officer can capture and verify the GPS point later.</p>
            <div className="place-actions"><button type="submit" className="btn btn-primary">Add location</button><button type="button" onClick={() => setAdding(false)}>Cancel</button></div>
          </fieldset>
        </form>}
        {placesLoading && <p role="status">Loading locations...</p>}
        {placesError && <p role="alert">{placesError} <button onClick={() => setRevision(value => value + 1)}>Retry locations</button></p>}
        {!placesLoading && places && <><div className="place-table-wrap"><table className="place-table">
          <thead><tr><th>Location</th><th>Type</th><th>Verification</th></tr></thead>
          <tbody>{places.places.map(place => {
            const verification = latestFieldVerification(place);
            return <tr key={place.id}><td><button type="button" onClick={() => leave('locations', place.id)}>{place.name}</button><small>{place.address ?? 'No street address recorded'}</small></td>
              <td>{place.sites.length ? 'Site' : 'Area / zone'}</td>
              <td>{verification ? <>Officer verified<small>{verification.verified_by ?? 'Recorded officer'} · {new Date(verification.verified_at!).toLocaleDateString('en-NZ')} · 10 m point</small></> : 'Not field verified'}</td></tr>;
          })}</tbody>
        </table></div>
          {!places.places.length && <p>{search ? 'No locations match this search.' : 'No locations yet. Add the first location above.'}</p>}
          {places.total > 100 && <div className="place-actions"><button disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 100))}>Previous</button><span>{offset + 1}-{Math.min(offset + 100, places.total)} of {places.total}</span><button disabled={offset + 100 >= places.total} onClick={() => setOffset(value => value + 100)}>Next</button></div>}
        </>}
      </>}
    </section>
  </div>;
}
