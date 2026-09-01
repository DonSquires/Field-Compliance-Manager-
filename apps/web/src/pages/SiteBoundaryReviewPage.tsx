import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, CheckCircle2, Clock3, ExternalLink, History, MapPin, RefreshCw, Ruler, Search, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './SiteBoundaryReviewPage.css';
import './SiteBoundaryVisualReview.css';

interface BoundarySite {
  site_id: string;
  account_organization_id: string;
  account_name: string;
  site_name: string;
  address: string | null;
  site_type: string | null;
  active: boolean;
  gps_lat: number | null;
  gps_lng: number | null;
  boundary_status: 'authoritative' | 'provisional';
  boundary_verification: 'verified' | 'unverified';
  boundary_verified_at: string | null;
  has_boundary: boolean;
  boundary_geojson: GeoJSON.GeoJsonObject | null;
}

interface BoundaryHistory {
  id: string;
  boundary_source: string | null;
  verification_state: string;
  changed_via: string;
  change_reason: string;
  version: number;
  created_at: string;
  has_boundary: boolean;
}

type QueueFilter = 'review' | 'all' | 'verified';

const SiteBoundaryReviewPage = () => {
  const [sites, setSites] = useState<BoundarySite[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<BoundaryHistory[]>([]);
  const [filter, setFilter] = useState<QueueFilter>('review');
  const [query, setQuery] = useState('');
  const [coordinates, setCoordinates] = useState({ latitude: '', longitude: '', radius: '50' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [visualReviewConfirmed, setVisualReviewConfirmed] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  const selected = sites.find((site) => site.site_id === selectedId) ?? null;

  const loadHistory = useCallback(async (siteId: string) => {
    const { data, error: historyError } = await supabase.rpc('get_boundary_history', { p_entity_type: 'client_site', p_entity_id: siteId });
    if (historyError) throw historyError;
    setHistory((data as BoundaryHistory[]) ?? []);
  }, []);

  const loadQueue = useCallback(async (preferredSiteId?: string) => {
    setLoading(true); setError(null);
    try {
      const { data, error: queueError } = await supabase.rpc('get_crm_site_boundary_queue');
      if (queueError) throw queueError;
      const rows = (data as BoundarySite[]) ?? [];
      const nextId = preferredSiteId && rows.some((site) => site.site_id === preferredSiteId) ? preferredSiteId : rows[0]?.site_id ?? null;
      setSites(rows); setSelectedId(nextId);
      if (nextId) await loadHistory(nextId); else setHistory([]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'The site boundary queue could not be loaded.');
    } finally { setLoading(false); }
  }, [loadHistory]);

  useEffect(() => { void loadQueue(); }, [loadQueue]);

  useEffect(() => {
    if (!selected) return;
    setCoordinates({ latitude: selected.gps_lat?.toString() ?? '', longitude: selected.gps_lng?.toString() ?? '', radius: '50' });
    setVisualReviewConfirmed(false);
  }, [selectedId]);

  useEffect(() => {
    if (!mapContainerRef.current || !selected?.boundary_geojson) return;
    mapRef.current?.remove();
    const map = L.map(mapContainerRef.current, { zoomControl: true, attributionControl: true });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    const boundary = L.geoJSON(selected.boundary_geojson, { style: { color: '#2fc4a7', weight: 3, fillColor: '#2fc4a7', fillOpacity: 0.16 } }).bindTooltip(selected.site_name).addTo(map);
    const bounds = boundary.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: 19 });
    window.setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; };
  }, [selected?.site_id, selected?.boundary_geojson, selected?.site_name]);

  const chooseSite = async (site: BoundarySite) => {
    setSelectedId(site.site_id); setError(null); setNotice(null);
    try { await loadHistory(site.site_id); }
    catch (historyError) { setError(historyError instanceof Error ? historyError.message : 'Boundary history could not be loaded.'); }
  };

  const establishProvisionalBoundary = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: actionError } = await supabase.rpc('manage_crm_site_boundary', {
      p_site_id: selected.site_id,
      p_action: 'set_provisional',
      p_expected_verification: selected.boundary_verification,
      p_center_lat: Number(coordinates.latitude),
      p_center_lng: Number(coordinates.longitude),
      p_radius_m: Number(coordinates.radius),
    });
    if (actionError) setError(actionError.message);
    else { setNotice(`${selected.site_name} now has a provisional point-radius boundary. Visual polygon review is still required.`); await loadQueue(selected.site_id); }
    setSaving(false);
  };

  const verifyBoundary = async () => {
    if (!selected?.has_boundary || !visualReviewConfirmed) return;
    setSaving(true); setError(null); setNotice(null);
    const { error: actionError } = await supabase.rpc('manage_crm_site_boundary', {
      p_site_id: selected.site_id,
      p_action: 'verify',
      p_expected_verification: selected.boundary_verification,
    });
    if (actionError) setError(actionError.message);
    else { setNotice(`${selected.site_name} boundary verified from visual map review.`); await loadQueue(selected.site_id); }
    setSaving(false);
  };

  const reviewCount = sites.filter((site) => site.boundary_verification === 'unverified').length;
  const missingCount = sites.filter((site) => !site.has_boundary).length;
  const verifiedCount = sites.filter((site) => site.boundary_verification === 'verified').length;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSites = sites.filter((site) => {
    if (filter === 'review' && site.boundary_verification !== 'unverified') return false;
    if (filter === 'verified' && site.boundary_verification !== 'verified') return false;
    return !normalizedQuery || `${site.site_name} ${site.account_name} ${site.address ?? ''}`.toLowerCase().includes(normalizedQuery);
  });

  return <div className="boundary-page">
    <header className="boundary-heading"><div><span>Site operations</span><h1>Boundary review</h1><p>Establish geofence evidence and track review provenance across managed accounts.</p></div><button type="button" onClick={() => void loadQueue()} disabled={loading}><RefreshCw size={16} className={loading ? 'is-spinning' : ''} />Refresh</button></header>
    {error && <div className="boundary-message is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span></div>}
    {notice && <div className="boundary-message is-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span></div>}

    <section className="boundary-summary" aria-label="Boundary review status"><div><AlertTriangle size={18} /><span>Awaiting review</span><strong>{reviewCount}</strong></div><div><MapPin size={18} /><span>No geometry</span><strong>{missingCount}</strong></div><div><ShieldCheck size={18} /><span>Verified</span><strong>{verifiedCount}</strong></div></section>

    <div className="boundary-workspace">
      <aside className="boundary-queue"><div className="boundary-tools"><div className="boundary-search"><Search size={15} /><input aria-label="Search sites" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search site, account, address" /></div><div className="boundary-filters" role="group" aria-label="Boundary queue filter"><button className={filter === 'review' ? 'is-active' : ''} onClick={() => setFilter('review')}>Review</button><button className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>All</button><button className={filter === 'verified' ? 'is-active' : ''} onClick={() => setFilter('verified')}>Verified</button></div></div>
        <div className="boundary-list" aria-label="Managed sites">{loading && !sites.length ? <div className="boundary-empty"><RefreshCw size={18} className="is-spinning" />Loading managed sites</div> : visibleSites.length ? visibleSites.map((site) => <button type="button" key={site.site_id} className={selectedId === site.site_id ? 'is-selected' : ''} onClick={() => void chooseSite(site)}><span className={`boundary-state is-${site.boundary_verification}`}><MapPin size={16} /></span><span><strong>{site.site_name}</strong><small>{site.account_name}</small><small>{site.address ?? 'Address not recorded'}</small></span><em>{site.boundary_verification === 'verified' ? 'Verified' : site.has_boundary ? 'Review' : 'No geometry'}</em></button>) : <div className="boundary-empty">No sites match this queue.</div>}</div>
      </aside>

      <main className="boundary-detail">{selected ? <>
        <header><div><span>{selected.account_name}</span><h2>{selected.site_name}</h2><p>{selected.address ?? 'Address not recorded'}</p></div><div className={`boundary-verdict is-${selected.boundary_verification}`}><strong>{selected.boundary_verification === 'verified' ? 'Verified boundary' : selected.has_boundary ? 'Visual review required' : 'Geometry required'}</strong><span>{selected.boundary_status} provenance</span></div></header>
        <section className="boundary-facts"><div><span>Geometry</span><strong>{selected.has_boundary ? 'Recorded' : 'Missing'}</strong></div><div><span>Coordinates</span><strong>{selected.gps_lat != null && selected.gps_lng != null ? `${selected.gps_lat.toFixed(5)}, ${selected.gps_lng.toFixed(5)}` : 'Not recorded'}</strong></div><div><span>Operational state</span><strong>{selected.active ? 'Active site' : 'Inactive site'}</strong></div></section>

        <section className="boundary-action-panel"><div className="boundary-panel-heading"><div><MapPin size={18} /><span><strong>Provisional point boundary</strong><small>Set a temporary operating radius from confirmed coordinates.</small></span></div>{selected.gps_lat != null && selected.gps_lng != null && <a href={`https://www.google.com/maps?q=${selected.gps_lat},${selected.gps_lng}`} target="_blank" rel="noreferrer">Inspect point <ExternalLink size={14} /></a>}</div>
          <form onSubmit={establishProvisionalBoundary}><label><span>Latitude</span><input aria-label="Latitude" type="number" min="-90" max="90" step="any" required value={coordinates.latitude} onChange={(event) => setCoordinates({ ...coordinates, latitude: event.target.value })} /></label><label><span>Longitude</span><input aria-label="Longitude" type="number" min="-180" max="180" step="any" required value={coordinates.longitude} onChange={(event) => setCoordinates({ ...coordinates, longitude: event.target.value })} /></label><label><span>Radius (metres)</span><div><Ruler size={14} /><input aria-label="Radius in metres" type="number" min="5" max="5000" required value={coordinates.radius} onChange={(event) => setCoordinates({ ...coordinates, radius: event.target.value })} /></div></label><button type="submit" disabled={saving || !coordinates.latitude || !coordinates.longitude}>{saving ? 'Saving' : selected.has_boundary ? 'Replace provisional boundary' : 'Establish provisional boundary'}</button></form>
          {selected.boundary_geojson ? <div className="boundary-map" ref={mapContainerRef} aria-label={`Boundary map for ${selected.site_name}`} /> : <div className="boundary-map-empty"><MapPin size={20} /><span><strong>No boundary to inspect</strong>Establish provisional geometry before visual review.</span></div>}
          <div className="boundary-review-gate"><ShieldCheck size={18} /><div><strong>Visual verification</strong><span>Confirm the rendered boundary encloses the intended operating site before certifying it for runtime use.</span><label><input type="checkbox" checked={visualReviewConfirmed} onChange={(event) => setVisualReviewConfirmed(event.target.checked)} disabled={!selected.has_boundary || selected.boundary_verification === 'verified'} />I inspected the full boundary against the site address.</label></div><button type="button" onClick={() => void verifyBoundary()} disabled={saving || !visualReviewConfirmed || !selected.has_boundary || selected.boundary_verification === 'verified'}>{selected.boundary_verification === 'verified' ? 'Verified' : saving ? 'Verifying' : 'Verify boundary'}</button></div>
        </section>

        <section className="boundary-history"><div className="boundary-panel-heading"><div><History size={18} /><span><strong>Boundary history</strong><small>{history.length} recorded {history.length === 1 ? 'event' : 'events'}</small></span></div></div>{history.length ? <div>{history.map((event) => <article key={event.id}><span className={`boundary-history-icon is-${event.verification_state}`}>{event.verification_state === 'verified' ? <CheckCircle2 size={16} /> : <Clock3 size={16} />}</span><div><strong>{event.change_reason}</strong><span>{event.boundary_source ?? 'No source recorded'} · {event.changed_via.replaceAll('_', ' ')}</span></div><time dateTime={event.created_at}>v{event.version} · {new Date(event.created_at).toLocaleString('en-NZ')}</time></article>)}</div> : <div className="boundary-empty">No boundary events have been recorded for this site.</div>}</section>
      </> : <div className="boundary-empty boundary-empty-main"><MapPin size={22} />Select a site to inspect its boundary evidence.</div>}</main>
    </div>
  </div>;
};

export default SiteBoundaryReviewPage;