import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, MapPin, RefreshCw, ScanLine, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PatrolOversightPage.css';

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

interface NamedRecord { id: string; name: string; }
interface PatrolRecord { id: string; status: string; shift_id: string | null; }

type EvidenceFilter = 'all' | 'verified' | 'exception';

const PatrolOversightPage: React.FC = () => {
  const { profile } = useAuth();
  const [visits, setVisits] = useState<CheckpointVisit[]>([]);
  const [checkpoints, setCheckpoints] = useState<Record<string, string>>({});
  const [officers, setOfficers] = useState<Record<string, string>>({});
  const [patrols, setPatrols] = useState<Record<string, PatrolRecord>>({});
  const [filter, setFilter] = useState<EvidenceFilter>('all');
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
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error: visitError } = await supabase
        .from('patrol_checkpoint_visits')
        .select('id, patrol_id, checkpoint_id, officer_user_id, shift_stop_id, visited_at, scan_method, gps_accuracy, gps_distance_from_checkpoint, within_radius, notes')
        .eq('organization_id', organizationId)
        .gte('visited_at', since)
        .order('visited_at', { ascending: false })
        .limit(200);
      if (visitError) throw visitError;
      const rows = (data as CheckpointVisit[]) ?? [];
      setVisits(rows);

      const checkpointIds = [...new Set(rows.map((visit) => visit.checkpoint_id))];
      const officerIds = [...new Set(rows.map((visit) => visit.officer_user_id).filter(Boolean) as string[])];
      const patrolIds = [...new Set(rows.map((visit) => visit.patrol_id))];
      const [checkpointResponse, officerResponse, patrolResponse] = await Promise.all([
        checkpointIds.length ? supabase.from('patrol_checkpoints').select('id, name').in('id', checkpointIds) : Promise.resolve({ data: [], error: null }),
        officerIds.length ? supabase.from('user_profiles').select('id, display_name, email').in('id', officerIds) : Promise.resolve({ data: [], error: null }),
        patrolIds.length ? supabase.from('patrols').select('id, status, shift_id').in('id', patrolIds) : Promise.resolve({ data: [], error: null }),
      ]);
      const contextError = checkpointResponse.error ?? officerResponse.error ?? patrolResponse.error;
      if (contextError) throw contextError;
      setCheckpoints(Object.fromEntries(((checkpointResponse.data ?? []) as NamedRecord[]).map((row) => [row.id, row.name])));
      setOfficers(Object.fromEntries(((officerResponse.data ?? []) as Array<{ id: string; display_name: string | null; email: string | null }>).map((row) => [row.id, row.display_name || row.email || row.id])));
      setPatrols(Object.fromEntries(((patrolResponse.data ?? []) as PatrolRecord[]).map((row) => [row.id, row])));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Checkpoint evidence could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => { void loadEvidence(); }, [loadEvidence]);

  const visibleVisits = useMemo(() => visits.filter((visit) => {
    if (filter === 'verified') return visit.within_radius === true;
    if (filter === 'exception') return visit.within_radius !== true;
    return true;
  }), [filter, visits]);
  const verifiedCount = visits.filter((visit) => visit.within_radius === true).length;
  const exceptionCount = visits.length - verifiedCount;

  return <div className="patrol-oversight">
    <header className="patrol-oversight-header"><div><span>Field operations / Patrol</span><h1>Patrol evidence</h1><p>Checkpoint attendance recorded by officers during the last seven days.</p></div><button type="button" onClick={() => void loadEvidence()} disabled={loading}><RefreshCw size={17} className={loading ? 'is-spinning' : ''} />Refresh</button></header>
    {error && <div className="patrol-oversight-message" role="alert"><AlertTriangle size={17} /><span>{error}</span></div>}
    <section className="patrol-oversight-summary" aria-label="Checkpoint evidence summary"><div><ScanLine size={18} /><span>Total visits</span><strong>{visits.length}</strong></div><div><ShieldCheck size={18} /><span>Within checkpoint</span><strong>{verifiedCount}</strong></div><div className={exceptionCount ? 'is-warning' : ''}><AlertTriangle size={18} /><span>Evidence exceptions</span><strong>{exceptionCount}</strong></div></section>
    <div className="patrol-oversight-toolbar"><div role="tablist" aria-label="Evidence confidence">{(['all','verified','exception'] as EvidenceFilter[]).map((item) => <button type="button" role="tab" aria-selected={filter === item} className={filter === item ? 'is-active' : ''} onClick={() => setFilter(item)} key={item}>{item}</button>)}</div><span>{visibleVisits.length} records</span></div>
    <div className="patrol-oversight-table"><table><thead><tr><th>Checkpoint</th><th>Officer</th><th>Visited</th><th>Capture</th><th>GPS accuracy</th><th>Evidence</th></tr></thead><tbody>{loading ? <tr><td colSpan={6} className="patrol-oversight-empty"><RefreshCw size={17} className="is-spinning" />Loading checkpoint evidence</td></tr> : visibleVisits.length === 0 ? <tr><td colSpan={6} className="patrol-oversight-empty">No checkpoint evidence matches this view</td></tr> : visibleVisits.map((visit) => { const patrol = patrols[visit.patrol_id];return <tr key={visit.id}><td><strong>{checkpoints[visit.checkpoint_id] ?? 'Checkpoint'}</strong><small>{visit.shift_stop_id ? `Stop ${visit.shift_stop_id.slice(0,8)}` : 'No shift stop link'}</small></td><td>{visit.officer_user_id ? officers[visit.officer_user_id] ?? 'Officer' : 'Officer unavailable'}</td><td>{new Date(visit.visited_at).toLocaleString('en-NZ')}</td><td>{visit.scan_method.replaceAll('_',' ')}</td><td><span className={visit.within_radius === true ? 'is-verified' : 'is-exception'}><MapPin size={13} />{visit.gps_accuracy == null ? 'Not captured' : `${Math.round(visit.gps_accuracy)} m`}</span><small>{visit.gps_distance_from_checkpoint == null ? 'Distance unavailable' : `${Math.round(visit.gps_distance_from_checkpoint)} m from checkpoint`}</small></td><td><strong>{visit.within_radius === true ? 'Verified proximity' : 'Review required'}</strong><small>Evidence ID {visit.id.slice(0,8)} · patrol {visit.patrol_id.slice(0,8)}{patrol?.shift_id ? ` · shift ${patrol.shift_id.slice(0,8)}` : ''}</small>{visit.notes && <p>{visit.notes}</p>}</td></tr>; })}</tbody></table></div>
  </div>;
};

export default PatrolOversightPage;
