import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { supabase } from '../lib/supabase';
import './LoggedActivityPanel.css';

interface Props {
  onOpenRecords: () => void;
  refreshKey?: number;
}

interface RecentRecord {
  id: string;
  occurred_at: string;
  event_type: string;
  zone_id: string | null;
  client_site_id: string | null;
  payload: Record<string, unknown> | null;
}

interface Totals {
  visits: number;
  sightings: number;
}

const WINDOW_DAYS = 14;

/**
 * Historical record of what has been logged against the provider's agreements. The priority queue above it is
 * live work only, so without this a tenant with imported history would see an apparently empty overview.
 */
export const LoggedActivityPanel: React.FC<Props> = ({ onOpenRecords, refreshKey }) => {
  const { profile, operatingOrganizationId } = useAuth();
  const organizationId = operatingOrganizationId ?? profile?.organizationId;
  const { agreements, zones, sites, loadedOrganizationId } = useServiceRelationships();
  const [totals, setTotals] = useState<Totals | null>(null);
  const [recent, setRecent] = useState<RecentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const agreementIds = useMemo(() => agreements
    .filter((agreement) => loadedOrganizationId === organizationId && agreement.agreement_type === 'operational' && agreement.client_organization_id !== organizationId)
    .map((agreement) => agreement.id), [agreements, organizationId, loadedOrganizationId]);
  const agreementKey = agreementIds.join(',');

  useLayoutEffect(() => {
    setTotals(null);
    setRecent([]);
    setError(null);
    setLoading(true);
  }, [organizationId, loadedOrganizationId, agreementKey]);

  const placeName = (zoneId: string | null, siteId: string | null) => (
    zones.find((zone) => zone.id === zoneId)?.name ?? sites.find((site) => site.id === siteId)?.name ?? 'Unnamed place'
  );

  // ATLAS READS: service_agreement_locations, location_events, observations
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!organizationId || loadedOrganizationId !== organizationId) {
        setTotals(null); setRecent([]);
        setError('Agreement activity is unavailable until the selected organisation context is loaded.');
        setLoading(false);
        return;
      }
      if (agreementIds.length === 0) { setTotals(null); setRecent([]); setLoading(false); return; }
      setLoading(true);
      setError(null);
      try {
        const { data: links, error: linksError } = await supabase
          .from('service_agreement_locations').select('zone_id,site_id').in('service_agreement_id', agreementIds).eq('status', 'active');
        if (cancelled) return;
        if (linksError) throw linksError;
        const zoneIds = [...new Set((links ?? []).map((link) => link.zone_id).filter((id): id is string => Boolean(id)))];
        const siteIds = [...new Set((links ?? []).map((link) => link.site_id).filter((id): id is string => Boolean(id)))];
        if (zoneIds.length === 0 && siteIds.length === 0) { if (!cancelled) { setTotals(null); setRecent([]); } return; }
        const eventPlaces = [...(zoneIds.length ? [`zone_id.in.(${zoneIds.join(',')})`] : []), ...(siteIds.length ? [`client_site_id.in.(${siteIds.join(',')})`] : [])].join(',');
        const sightingPlaces = [...(zoneIds.length ? [`zone_id.in.(${zoneIds.join(',')})`] : []), ...(siteIds.length ? [`site_id.in.(${siteIds.join(',')})`] : [])].join(',');
        // Row-level security is evaluated per row, so counts across every place are only quick over a short window.
        const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const until = new Date().toISOString();
        const [visits, sightings, recentVisits] = await Promise.all([
          supabase.from('location_events').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).or(eventPlaces).gte('occurred_at', since).lte('occurred_at', until),
          supabase.from('observations').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).or(sightingPlaces).gte('observed_at', since).lte('observed_at', until),
          supabase.from('location_events').select('id,occurred_at,event_type,zone_id,client_site_id,payload').eq('organization_id', organizationId).or(eventPlaces).gte('occurred_at', since).lte('occurred_at', until).order('occurred_at', { ascending: false }).limit(5),
        ]);
        const failure = visits.error ?? sightings.error ?? recentVisits.error;
        if (failure) throw failure;
        if (cancelled) return;
        setTotals({ visits: visits.count ?? 0, sightings: sightings.count ?? 0 });
        setRecent((recentVisits.data ?? []) as RecentRecord[]);
      } catch (err) {
        if (!cancelled) setError(err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : 'Logged activity could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
    // agreementKey stands in for agreementIds so a new array with the same ids does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agreementKey, refreshKey, organizationId, loadedOrganizationId]);

  return (
    <section className="admin-logged-activity" aria-labelledby="logged-activity-heading">
      <div className="admin-section-heading">
        <div><span>Record</span><h2 id="logged-activity-heading">Logged activity</h2></div>
        <button type="button" className="btn btn-secondary" onClick={onOpenRecords}>Browse and search records <ArrowRight size={15} aria-hidden="true" /></button>
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {loading && !totals && <p className="subtitle" role="status">Loading logged activity…</p>}
      {!loading && !error && !totals && <p className="subtitle">No agreement places have logged activity yet.</p>}
      {totals && (
        <>
          <dl className="admin-logged-activity__totals">
            <div><dt>Patrol visits and camera activations, last {WINDOW_DAYS} days</dt><dd>{totals.visits.toLocaleString('en-NZ')}</dd></div>
            <div><dt>Vehicle sightings, last {WINDOW_DAYS} days</dt><dd>{totals.sightings.toLocaleString('en-NZ')}</dd></div>
          </dl>
          {recent.length === 0 && <p className="subtitle">Nothing logged in the last {WINDOW_DAYS} days. Browse records to look further back.</p>}
          {recent.length > 0 && (
            <ul className="admin-logged-activity__recent" aria-label="Most recent logged visits">
              {recent.map((record) => (
                <li key={record.id}>
                  <strong>{new Date(record.occurred_at).toLocaleDateString('en-NZ')}</strong> · {placeName(record.zone_id, record.client_site_id)} · {record.event_type.replaceAll('_', ' ')}
                  {typeof record.payload?.comments === 'string' && record.payload.comments.trim() ? <span>{record.payload.comments.trim()}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
};

export default LoggedActivityPanel;
