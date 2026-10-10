import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, MapPin, RefreshCw, ScanLine, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { supabase } from '../lib/supabase';
import './PatrolOversightPage.css';
import './PatrolOversightPageControls.css';

interface CheckpointVisit {
  id: string;
  patrol_id: string;
  checkpoint_id: string;
  officer_user_id: string | null;
  shift_stop_id: string | null;
  visited_at: string;
  scan_method: string;
  gps_accuracy: number | null;
  gps_distance_from_checkpoint: number | null;
  within_radius: boolean | null;
  notes: string | null;
}

interface CheckpointRecord { id: string; name: string; client_site_id: string | null; zone_id: string | null; }
interface PatrolRecord { id: string; status: string; shift_id: string | null; zone_id: string | null; }

type EvidenceFilter = 'all' | 'verified' | 'exception';
type EvidencePeriodDays = 7 | 30 | 90;

const PatrolOversightPage: React.FC = () => {
  const { profile } = useAuth();
  const { selectedSite, selectedZone } = useServiceRelationships();
  const [visits, setVisits] = useState<CheckpointVisit[]>([]);
  const [checkpoints, setCheckpoints] = useState<Record<string, CheckpointRecord>>({});
  const [officers, setOfficers] = useState<Record<string, string>>({});
  const [patrols, setPatrols] = useState<Record<string, PatrolRecord>>({});
  const [filter, setFilter] = useState<EvidenceFilter>('all');
  const [periodDays, setPeriodDays] = useState<EvidencePeriodDays>(7);
  const [activeCheckpointCount, setActiveCheckpointCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEvidence = useCallback(async () => {
    const organizationId = profile?.organizationId;
    if (!organizationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();
      let checkpointIds: string[] | null = null;
      let patrolIds: string[] = [];
      if (selectedSite) {
        const { data: linkedCheckpoints, error: checkpointScopeError } = await supabase
          .from('patrol_checkpoints')
          .select('id')
          .eq('organization_id', organizationId)
          .eq('client_site_id', selectedSite.id);
        if (checkpointScopeError) throw checkpointScopeError;
        checkpointIds = (linkedCheckpoints ?? []).map((checkpoint) => checkpoint.id as string);
      } else if (selectedZone) {
        const [checkpointScopeResponse, patrolScopeResponse] = await Promise.all([
          supabase.from('patrol_checkpoints').select('id').eq('organization_id', organizationId).eq('zone_id', selectedZone.id),
          supabase.from('patrols').select('id').eq('organization_id', organizationId).eq('zone_id', selectedZone.id),
        ]);
        if (checkpointScopeResponse.error) throw checkpointScopeResponse.error;
        if (patrolScopeResponse.error) throw patrolScopeResponse.error;
        checkpointIds = (checkpointScopeResponse.data ?? []).map((checkpoint) => checkpoint.id as string);
        patrolIds = (patrolScopeResponse.data ?? []).map((patrol) => patrol.id as string);
      }

      let visitQuery = supabase
        .from('patrol_checkpoint_visits')
        .select('id, patrol_id, checkpoint_id, officer_user_id, shift_stop_id, visited_at, scan_method, gps_accuracy, gps_distance_from_checkpoint, within_radius, notes')
        .eq('organization_id', organizationId)
        .gte('visited_at', since)
        .order('visited_at', { ascending: false })
        .limit(200);
      if (selectedSite && checkpointIds?.length) visitQuery = visitQuery.in('checkpoint_id', checkpointIds);
      if (selectedZone) {
        const scopeFilters = [
          ...(checkpointIds?.length ? [`checkpoint_id.in.(${checkpointIds.join(',')})`] : []),
          ...(patrolIds.length ? [`patrol_id.in.(${patrolIds.join(',')})`] : []),
        ];
        if (scopeFilters.length) visitQuery = visitQuery.or(scopeFilters.join(','));
      }
      const noScopedCheckpoints = Boolean(selectedSite && !checkpointIds?.length)
        || Boolean(selectedZone && !checkpointIds?.length && !patrolIds.length);
      const [visitResponse, checkpointCountResponse] = await Promise.all([
        noScopedCheckpoints ? Promise.resolve({ data: [] as CheckpointVisit[], error: null }) : visitQuery,
        supabase.from('patrol_checkpoints').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).eq('active', true),
      ]);
      const { data, error: visitError } = visitResponse;
      if (visitError) throw visitError;
      if (checkpointCountResponse.error) throw checkpointCountResponse.error;
      setActiveCheckpointCount(checkpointCountResponse.count ?? 0);
      const rows = (data as CheckpointVisit[]) ?? [];
      setVisits(rows);

      const visitCheckpointIds = [...new Set(rows.map((visit) => visit.checkpoint_id))];
      const visitOfficerIds = [...new Set(rows.map((visit) => visit.officer_user_id).filter(Boolean) as string[])];
      const visitPatrolIds = [...new Set(rows.map((visit) => visit.patrol_id))];
      const [checkpointResponse, officerResponse, patrolResponse] = await Promise.all([
        visitCheckpointIds.length ? supabase.from('patrol_checkpoints').select('id, name, client_site_id, zone_id').in('id', visitCheckpointIds) : Promise.resolve({ data: [], error: null }),
        visitOfficerIds.length ? supabase.from('user_profiles').select('id, display_name, email').in('id', visitOfficerIds) : Promise.resolve({ data: [], error: null }),
        visitPatrolIds.length ? supabase.from('patrols').select('id, status, shift_id, zone_id').in('id', visitPatrolIds) : Promise.resolve({ data: [], error: null }),
      ]);
      const contextError = checkpointResponse.error ?? officerResponse.error ?? patrolResponse.error;
      if (contextError) throw contextError;
      setCheckpoints(Object.fromEntries(((checkpointResponse.data ?? []) as CheckpointRecord[]).map((row) => [row.id, row])));
      setOfficers(Object.fromEntries(((officerResponse.data ?? []) as Array<{ id: string; display_name: string | null; email: string | null }>).map((row) => [row.id, row.display_name || row.email || row.id])));
      setPatrols(Object.fromEntries(((patrolResponse.data ?? []) as PatrolRecord[]).map((row) => [row.id, row])));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Checkpoint evidence could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [periodDays, profile?.organizationId, selectedSite, selectedZone]);

  useEffect(() => { void loadEvidence(); }, [loadEvidence]);

  const placeVisits = useMemo(() => {
    if (selectedSite) return visits.filter((visit) => checkpoints[visit.checkpoint_id]?.client_site_id === selectedSite.id);
    if (selectedZone) return visits.filter((visit) => checkpoints[visit.checkpoint_id]?.zone_id === selectedZone.id || patrols[visit.patrol_id]?.zone_id === selectedZone.id);
    return visits;
  }, [checkpoints, patrols, selectedSite, selectedZone, visits]);
  const visibleVisits = useMemo(() => placeVisits.filter((visit) => {
    if (filter === 'verified') return visit.within_radius === true;
    if (filter === 'exception') return visit.within_radius !== true;
    return true;
  }), [filter, placeVisits]);
  const verifiedCount = placeVisits.filter((visit) => visit.within_radius === true).length;
  const exceptionCount = placeVisits.length - verifiedCount;
  const selectedPlaceName = selectedZone?.name ?? selectedSite?.name ?? null;
  const emptyStateTitle = placeVisits.length === 0
    ? selectedPlaceName ? `No checkpoint scans at ${selectedPlaceName}` : 'No checkpoint scans in this period'
    : 'No visits match this evidence filter';
  const emptyStateMessage = placeVisits.length === 0
    ? visits.length === 0
      ? `No checkpoint visits were recorded in the last ${periodDays} days. ${activeCheckpointCount} active checkpoint${activeCheckpointCount === 1 ? ' is' : 's are'} configured for this organisation. Visits appear here after an officer scans a checkpoint during a patrol.`
      : `There were no visits for ${selectedPlaceName ?? 'this place'} in the last ${periodDays} days. Choose another service place above or widen the date range.`
    : 'Try All to include both verified visits and evidence exceptions.';

  return <div className="patrol-oversight">
    <header className="patrol-oversight-header"><div><span>Field operations / Patrol</span><h1>Patrol evidence</h1><p>{selectedPlaceName ? `Checkpoint attendance at ${selectedPlaceName}` : 'Organisation-wide checkpoint attendance'} · last {periodDays} days.</p></div><button type="button" onClick={() => void loadEvidence()} disabled={loading}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} />Refresh</button></header>
    {error && <div className="patrol-oversight-message" role="alert"><AlertTriangle size={17} /><span>{error}</span></div>}
    <section className="patrol-oversight-summary" aria-label="Checkpoint evidence summary"><div><ScanLine size={18} /><span>{selectedPlaceName ? 'Visits at selected place' : 'Visits across organisation'}</span><strong>{placeVisits.length}</strong></div><div><ShieldCheck size={18} /><span>Within checkpoint</span><strong>{verifiedCount}</strong></div><div className={exceptionCount ? 'is-warning' : ''}><AlertTriangle size={18} /><span>Evidence exceptions</span><strong>{exceptionCount}</strong></div></section>
    <div className="patrol-oversight-toolbar"><div className="patrol-oversight-controls"><div className="patrol-oversight-period" role="group" aria-label="Evidence period">{([7, 30, 90] as EvidencePeriodDays[]).map((days) => <button type="button" aria-pressed={periodDays === days} onClick={() => setPeriodDays(days)} key={days}>{days} days</button>)}</div><div role="tablist" aria-label="Evidence confidence">{(['all','verified','exception'] as EvidenceFilter[]).map((item) => <button type="button" role="tab" aria-selected={filter === item} className={filter === item ? 'is-active' : ''} onClick={() => setFilter(item)} key={item}>{item}</button>)}</div></div><span>{visibleVisits.length} records</span></div>
    <p className="patrol-oversight-scroll-cue" role="note">Scroll horizontally to review all checkpoint fields.</p>
    <div className="patrol-oversight-table"><table><thead><tr><th>Checkpoint</th><th>Officer</th><th>Visited</th><th>Capture</th><th>GPS accuracy</th><th>Evidence</th></tr></thead><tbody>{loading ? <tr><td colSpan={6} className="patrol-oversight-empty"><RefreshCw size={17} className="is-spinning" />Loading checkpoint evidence</td></tr> : visibleVisits.length === 0 ? <tr><td colSpan={6} className="patrol-oversight-empty"><div className="patrol-oversight-empty-state"><strong>{emptyStateTitle}</strong><p>{emptyStateMessage}</p></div></td></tr> : visibleVisits.map((visit) => { const patrol = patrols[visit.patrol_id];return <tr key={visit.id}><td><strong>{checkpoints[visit.checkpoint_id]?.name ?? 'Checkpoint'}</strong><small>{visit.shift_stop_id ? `Stop ${visit.shift_stop_id.slice(0,8)}` : 'No shift stop link'}</small></td><td>{visit.officer_user_id ? officers[visit.officer_user_id] ?? 'Officer' : 'Officer unavailable'}</td><td>{new Date(visit.visited_at).toLocaleString('en-NZ')}</td><td>{visit.scan_method.replaceAll('_',' ')}</td><td><span className={visit.within_radius === true ? 'is-verified' : 'is-exception'}><MapPin size={13} />{visit.gps_accuracy == null ? 'Not captured' : `${Math.round(visit.gps_accuracy)} m`}</span><small>{visit.gps_distance_from_checkpoint == null ? 'Distance unavailable' : `${Math.round(visit.gps_distance_from_checkpoint)} m from checkpoint`}</small></td><td><strong>{visit.within_radius === true ? 'Verified proximity' : 'Review required'}</strong><small>Evidence ID {visit.id.slice(0,8)} · patrol {visit.patrol_id.slice(0,8)}{patrol?.shift_id ? ` · shift ${patrol.shift_id.slice(0,8)}` : ''}</small>{visit.notes && <p>{visit.notes}</p>}</td></tr>; })}</tbody></table></div>
  </div>;
};

export default PatrolOversightPage;
