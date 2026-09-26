/**
 * Live officer map — where the branch's people are right now, and whether they are safe.
 * One governed read (get_live_officer_positions) for the operating branch and its branches; one Leaflet map
 * that keeps its viewport and base layer; realtime + 30 s polling so the picture never goes stale.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, Crosshair, LocateFixed, MapPin, RefreshCw, ShieldAlert, ShieldCheck, WifiOff } from 'lucide-react';
import type { SafetyStatus } from '../hooks/useOfficerSafety';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { useActiveModuleContext } from '../hooks/useActiveModuleContext';
import { SafetyGate } from '../components/SafetyGate';
import { deriveAdminSafetyStatus, deriveOfficerPinStatus, type OfficerPinStatus } from '../lib/officerPinStatus';
import { addLinzBaseLayers, rememberViewport, restoreViewportOr } from '../lib/mapPreferences';
import { STATUS_LABEL, alertWords, clock, gpsAgeWords, officerActivityWords, safetyWords, type LiveAlert, type LiveOfficer, type LiveShift } from '../lib/liveMapWords';
import { plainWords } from '../lib/rosterWords';
import { supabase } from '../lib/supabase';
import './LiveMapPage.css';

export type { LiveOfficer } from '../lib/liveMapWords';
interface LivePicture { organization_id: string; reach: string[]; since: string; refreshed_at: string; officers: LiveOfficer[] }
interface OfficerView extends LiveOfficer { safety_status: SafetyStatus | null; pin_status: OfficerPinStatus }
interface OpenJob { id: string; job_type: string; priority: string; status: string; site: { name: string; gps_lat: number | null; gps_lng: number | null } | null }
interface OpenJobRow extends Omit<OpenJob, 'site'> {
  site: OpenJob['site'] | OpenJob['site'][];
  zone: { name: string; center_point: { coordinates?: [number, number] } | null } | Array<{ name: string; center_point: { coordinates?: [number, number] } | null }> | null;
}
interface ZoneShape { id: string; name: string; boundary: GeoJSON.GeoJsonObject | null }

const ACTIVE_JOB_STATUSES = ['pending', 'assigned', 'dispatched', 'acknowledged', 'en_route', 'on_scene'];
/** Worst first: alerts, overdue and due check-ins, then people on shift, then everyone else seen recently. */
const rank = (officer: { alert: LiveAlert | null; safety_status: SafetyStatus | null; shift: LiveShift | null }): number =>
  officer.alert ? 0 : officer.safety_status === 'overdue' ? 1 : officer.safety_status === 'due' ? 2 : officer.shift ? 3 : 4;
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';

const LiveMapPage: React.FC = () => {
  const { profile, operatingOrganizationId } = useAuth();
  const { selectedAgreementZones } = useServiceRelationships();
  useActiveModuleContext('dispatch');
  const branchId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const { status: moduleStatus, isModuleEnabled } = useEnabledModules(profile?.organizationId);
  const welfareEnabled = isModuleEnabled('welfare', { safetyRelevant: true });
  const [picture, setPicture] = useState<LivePicture | null>(null);
  const [jobs, setJobs] = useState<OpenJob[]>([]);
  const [zoneShapes, setZoneShapes] = useState<ZoneShape[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [selectedOfficerId, setSelectedOfficerId] = useState<string | null>(null);
  const [tick, setTick] = useState(Date.now());
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);
  const framedRef = useRef(false);
  const viewKey = `live-map:${branchId ?? 'none'}`;

  const loadPositions = useCallback(async () => {
    if (!branchId) { setPicture(null); setError('Operating branch access could not be confirmed. Live positions are unavailable.'); setLoading(false); return; }
    setLoading(true); setError(null);
    const zoneIds = selectedAgreementZones.length ? selectedAgreementZones.map((zone) => zone.id) : null;
    // ATLAS READS: get_live_officer_positions (officer_gps_log, shifts, welfare_alerts, officer_welfare_settings for the branch reach)
    const [positionsResponse, jobsResponse, zonesResponse] = await Promise.all([
      supabase.rpc('get_live_officer_positions', { p_organization_id: branchId, p_since_minutes: 240, p_zone_ids: zoneIds }),
      supabase.from('dispatch_jobs').select('id, job_type, priority, status, site:client_site_id(name, gps_lat, gps_lng), zone:zone_id(name, center_point)').eq('organization_id', branchId).in('status', ACTIVE_JOB_STATUSES),
      zoneIds ? supabase.from('location_zones').select('id, name, boundary').in('id', zoneIds) : Promise.resolve({ data: [] as ZoneShape[], error: null }),
    ]);
    if (positionsResponse.error) setError(positionsResponse.error.message);
    else setPicture((positionsResponse.data as LivePicture | null) ?? null);
    if (!jobsResponse.error) setJobs(((jobsResponse.data as unknown as OpenJobRow[]) ?? []).map((job) => {
      const site = Array.isArray(job.site) ? job.site[0] ?? null : job.site;
      const zone = Array.isArray(job.zone) ? job.zone[0] ?? null : job.zone;
      const point = zone?.center_point?.coordinates;
      return {
        ...job,
        site: site ?? (zone ? { name: zone.name, gps_lat: point?.[1] ?? null, gps_lng: point?.[0] ?? null } : null),
      };
    }));
    if (!zonesResponse.error) setZoneShapes((zonesResponse.data as ZoneShape[]) ?? []);
    setRefreshedAt(new Date());
    setLoading(false);
  }, [branchId, selectedAgreementZones]);

  useEffect(() => {
    void loadPositions();
    const interval = window.setInterval(() => void loadPositions(), 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void loadPositions(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  }, [loadPositions]);

  // Ages and safety states move with the clock even when nothing new arrives.
  useEffect(() => { const timer = window.setInterval(() => setTick(Date.now()), 15_000); return () => window.clearInterval(timer); }, []);

  // Realtime: one channel, one listener per organisation in the branch's reach (breadcrumbs are stamped with the shift's branch).
  const reachKey = (picture?.reach ?? []).slice(0, 25).sort().join(',');
  useEffect(() => {
    if (!reachKey) return;
    const orgIds = reachKey.split(',');
    let channel = supabase.channel(`live_map_${branchId}`);
    orgIds.forEach((orgId) => {
      channel = channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'officer_gps_log', filter: `organization_id=eq.${orgId}` }, () => void loadPositions());
      if (welfareEnabled) channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: 'welfare_alerts', filter: `organization_id=eq.${orgId}` }, () => void loadPositions());
    });
    channel.subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [reachKey, branchId, welfareEnabled, loadPositions]);

  const officers = useMemo<OfficerView[]>(() => (picture?.officers ?? []).map((officer) => {
    const shiftBegun = officer.shift && new Date(officer.shift.scheduled_start).getTime() <= tick ? officer.shift.scheduled_start : null;
    const safety = welfareEnabled ? deriveAdminSafetyStatus({ hasActiveAlert: Boolean(officer.alert), welfareEnabled: officer.welfare?.enabled ?? null, lastCheckinAt: officer.welfare?.last_checkin_at ?? null, checkIntervalMinutes: officer.welfare?.check_interval_minutes ?? null, shiftStartedAt: shiftBegun, nowMs: tick }) : null;
    const hasGps = officer.gps_lat != null && officer.gps_lng != null && officer.recorded_at;
    return { ...officer, safety_status: safety, pin_status: deriveOfficerPinStatus({ gpsAgeMs: hasGps ? tick - new Date(officer.recorded_at as string).getTime() : null, safetyStatus: safety }) };
  }).sort((left, right) => rank(left) - rank(right) || left.officer_name.localeCompare(right.officer_name)), [picture, welfareEnabled, tick]);

  const counts = useMemo(() => officers.reduce<Record<OfficerPinStatus, number>>((result, officer) => { result[officer.pin_status] += 1; return result; }, { ok: 0, due: 0, overdue: 0, alerting: 0, offline: 0, unknown: 0 }), [officers]);
  const positioned = useMemo(() => officers.filter((officer) => officer.gps_lat != null && officer.gps_lng != null), [officers]);

  // One map for the life of the page; the overlay below is what changes.
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = L.map(mapContainerRef.current, { zoomControl: true, attributionControl: true });
    addLinzBaseLayers(map, { collapsed: true });
    overlayRef.current = L.layerGroup().addTo(map);
    framedRef.current = restoreViewportOr(map, viewKey, () => map.fitBounds(L.latLngBounds([-47.3, 166.4], [-34.4, 178.6])));
    rememberViewport(map, viewKey);
    mapRef.current = map;
    window.setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; overlayRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const frameEveryone = useCallback(() => {
    const map = mapRef.current; if (!map) return;
    const bounds = L.latLngBounds([]);
    positioned.forEach((officer) => bounds.extend([officer.gps_lat as number, officer.gps_lng as number]));
    jobs.forEach((job) => { if (job.site?.gps_lat != null && job.site?.gps_lng != null) bounds.extend([job.site.gps_lat, job.site.gps_lng]); });
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.25), { maxZoom: 16 });
  }, [positioned, jobs]);

  useEffect(() => {
    const map = mapRef.current; const overlay = overlayRef.current;
    if (!map || !overlay) return;
    overlay.clearLayers();
    zoneShapes.forEach((zone) => { if (zone.boundary) L.geoJSON(zone.boundary, { style: { color: '#f0b35a', weight: 2, dashArray: '7 5', fillColor: '#f0b35a', fillOpacity: 0.06 } }).bindTooltip(`Zone: ${zone.name}`).addTo(overlay); });
    jobs.forEach((job) => {
      if (job.site?.gps_lat == null || job.site?.gps_lng == null) return;
      L.marker([job.site.gps_lat, job.site.gps_lng], { keyboard: false, icon: L.divIcon({ className: `live-job-pin priority-${job.priority}`, html: '<span></span>', iconSize: [16, 16] }), title: `${plainWords(job.job_type)} at ${job.site.name}` })
        .bindTooltip(`${plainWords(job.job_type)} · ${job.site.name} · ${plainWords(job.status)}`).addTo(overlay);
    });
    positioned.forEach((officer) => {
      // Pins are pointer targets only; the officer list is the keyboard path. A focusable icon scrolls the shell's main pane
      // on pointerdown and slides out from under the pointer before the click lands.
      const marker = L.marker([officer.gps_lat as number, officer.gps_lng as number], {
        keyboard: false,
        icon: L.divIcon({ className: `live-pin status-${officer.pin_status}${selectedOfficerId === officer.officer_id ? ' is-selected' : ''}`, html: `<span>${initials(officer.officer_name)}</span>`, iconSize: [30, 30] }),
        title: officer.officer_name, zIndexOffset: selectedOfficerId === officer.officer_id ? 1000 : officer.pin_status === 'alerting' ? 500 : 0,
      }).bindTooltip(`${officer.officer_name} · ${STATUS_LABEL[officer.pin_status]} · ${gpsAgeWords(officer.recorded_at, tick)}`).addTo(overlay);
      if (officer.accuracy_meters != null && officer.accuracy_meters > 15) L.circle([officer.gps_lat as number, officer.gps_lng as number], { radius: officer.accuracy_meters, color: '#7dd3c7', weight: 1, fillOpacity: 0.05 }).addTo(overlay);
      marker.on('click', () => { setSelectedOfficerId(officer.officer_id); document.getElementById(`live-officer-${officer.officer_id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    });
    if (!framedRef.current && (positioned.length || jobs.length)) { frameEveryone(); framedRef.current = true; }
  }, [positioned, jobs, zoneShapes, selectedOfficerId, tick, frameEveryone]);

  const showOnMap = (officer: OfficerView) => {
    setSelectedOfficerId(officer.officer_id);
    if (officer.gps_lat != null && officer.gps_lng != null) mapRef.current?.setView([officer.gps_lat, officer.gps_lng], Math.max(mapRef.current.getZoom(), 16));
  };

  return (
    <div className="live-ops-page">
      <header className="live-ops-heading">
        <div><span>Field operations</span><h1>Live officer map</h1><p>Where your people are right now and whether they are safe. GPS position and welfare state are separate signals.</p></div>
        <button type="button" onClick={() => void loadPositions()} disabled={loading}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /> Refresh</button>
      </header>

      {error && <div className="live-ops-message is-error" role="alert"><AlertTriangle size={17} /> {error}</div>}

      <SafetyGate
        status={moduleStatus}
        isEnabled={welfareEnabled}
        moduleLabel="Welfare monitoring"
        safetyRelevant
        renderUnavailable={(message) => <div className="live-ops-message is-warning" role="status"><ShieldAlert size={17} /><div><strong>{message.title}</strong><span>{message.description}</span></div></div>}
      >
        <section className="live-ops-summary" aria-label="Officer safety status">
          <div className="status-alerting"><ShieldAlert size={18} /><span>Active alerts</span><strong>{counts.alerting}</strong></div>
          <div className="status-overdue"><AlertTriangle size={18} /><span>Overdue</span><strong>{counts.overdue}</strong></div>
          <div className="status-due"><Crosshair size={18} /><span>Due</span><strong>{counts.due}</strong></div>
          <div className="status-ok"><ShieldCheck size={18} /><span>Safety OK</span><strong>{counts.ok}</strong></div>
        </section>
      </SafetyGate>

      <div className="live-ops-meta">
        <span>{officers.length} {officers.length === 1 ? 'officer' : 'officers'} on shift or seen in the last four hours · {jobs.length} open {jobs.length === 1 ? 'job' : 'jobs'}{selectedAgreementZones.length ? ` · filtered to ${selectedAgreementZones.length} agreement ${selectedAgreementZones.length === 1 ? 'zone' : 'zones'}` : ''}</span>
        <span>{refreshedAt ? `Updated ${refreshedAt.toLocaleTimeString('en-NZ')} · live` : 'Not yet refreshed'}</span>
      </div>

      <div className="live-ops-layout">
        <section className="live-ops-map" aria-label="Live officer map">
          <div className="live-ops-map-canvas" ref={mapContainerRef} />
          <div className="live-ops-map-tools">
            <button type="button" onClick={frameEveryone} disabled={!positioned.length && !jobs.length}><LocateFixed size={14} /> Fit to everyone</button>
            <span className="live-ops-legend" aria-hidden="true"><i className="status-ok" />Safe<i className="status-due" />Due<i className="status-overdue" />Overdue<i className="status-alerting" />Alert<i className="status-offline" />No GPS<i className="is-job" />Open job</span>
          </div>
        </section>

        <section className="live-ops-people" aria-label="Officers">
          {loading && officers.length === 0 ? <div className="live-ops-empty"><RefreshCw size={21} className="is-spinning" /> Loading live positions</div>
            : officers.length === 0 ? <div className="live-ops-empty"><WifiOff size={21} /> Nobody is on shift here now, and no officer has reported a position in the last four hours</div>
            : <div className="live-ops-list">{officers.map((officer) => <OfficerRow officer={officer} selected={selectedOfficerId === officer.officer_id} showSafety={welfareEnabled} nowMs={tick} onShow={() => showOnMap(officer)} key={officer.officer_id} />)}</div>}
        </section>
      </div>
    </div>
  );
};

function OfficerRow({ officer, selected, showSafety, nowMs, onShow }: { officer: OfficerView; selected: boolean; showSafety: boolean; nowMs: number; onShow: () => void }) {
  const hasGps = officer.gps_lat != null && officer.gps_lng != null;
  const safety = safetyWords(officer, officer.pin_status, officer.safety_status, nowMs);
  return (
    <article id={`live-officer-${officer.officer_id}`} className={`live-officer-row status-${officer.pin_status}${selected ? ' is-selected' : ''}`} aria-current={selected ? 'true' : undefined}>
      <button type="button" className="live-officer-marker" onClick={onShow} title={hasGps ? 'Show on map' : 'No position to show'} disabled={!hasGps}><span>{initials(officer.officer_name)}</span></button>
      <div><strong>{officer.officer_name}</strong><small title={officerActivityWords(officer)}>{officerActivityWords(officer)}</small>{officer.shift?.organization_name && <small>{officer.shift.organization_name}</small>}</div>
      <div className="live-gps-fact"><span>GPS</span><strong>{gpsAgeWords(officer.recorded_at, nowMs)}</strong><small>{hasGps ? officer.physical_address ?? `${officer.gps_lat?.toFixed(5)}, ${officer.gps_lng?.toFixed(5)}` : officer.shift ? 'No position yet this shift' : 'Location unavailable'}</small></div>
      {showSafety ? <span className={`live-safety-status status-${officer.pin_status}`}><strong>{safety.headline}</strong>{safety.detail && <small>{safety.detail}</small>}</span> : <span className="live-safety-status status-unknown"><strong>Safety unavailable</strong></span>}
      {hasGps ? <a href={`https://www.google.com/maps?q=${officer.gps_lat},${officer.gps_lng}`} target="_blank" rel="noreferrer" title="Open in Google Maps for directions"><MapPin size={16} /><span className="sr-only">Open in Google Maps</span></a> : <span className="live-position-unavailable"><WifiOff size={15} /></span>}
    </article>
  );
}

export default LiveMapPage;
