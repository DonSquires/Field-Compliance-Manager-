import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDot, Clock3, Eye, FileVideo2, RefreshCw, ShieldAlert, UserRound, XCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import './PageStyles.css';
import './CCTVReviewPage.css';

type ReviewFilter = 'all' | 'queued' | 'processing' | 'manual_review_required' | 'complete' | 'failed';

type CCTVJob = {
  id: string;
  evidence_item_id: string | null;
  domain: string;
  status: string;
  created_at: string;
  evidence: { storage_path: string | null; evidence_kind: string; metadata: Record<string, unknown> | null } | null;
  result: { status: string; result: Record<string, unknown> } | null;
};

const FILTERS: Array<{ value: ReviewFilter; label: string }> = [
  { value: 'all', label: 'All work' },
  { value: 'queued', label: 'Queued' },
  { value: 'processing', label: 'Processing' },
  { value: 'manual_review_required', label: 'Needs review' },
  { value: 'complete', label: 'Complete' },
  { value: 'failed', label: 'Failed' },
];

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' });
}

function resultCounts(result: Record<string, unknown> | undefined): { plates: number; faces: number; frames: number } {
  const segments = Array.isArray(result?.motion_segments) ? result.motion_segments : [];
  const frames: unknown[] = segments.flatMap((segment): unknown[] => segment && typeof segment === 'object' && Array.isArray((segment as Record<string, unknown>).frames) ? (segment as Record<string, unknown>).frames as unknown[] : []);
  const plates = frames.filter((frame) => frame && typeof frame === 'object' && (frame as Record<string, unknown>).alpr && ((frame as Record<string, unknown>).alpr as Record<string, unknown>).plate).length;
  const faces = frames.reduce<number>((count, frame) => {
    const faceResult = frame && typeof frame === 'object' ? (frame as Record<string, unknown>).face : null;
    return count + (faceResult && typeof faceResult === 'object' && Array.isArray((faceResult as Record<string, unknown>).faces) ? ((faceResult as Record<string, unknown>).faces as unknown[]).length : 0);
  }, 0);
  return { plates, faces, frames: frames.length };
}

const CCTVReviewPage: React.FC = () => {
  const { profile } = useAuth();
  const [jobs, setJobs] = useState<CCTVJob[]>([]);
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from('inference_jobs')
        .select('id, evidence_item_id, domain, status, created_at, evidence:evidence_item_id(storage_path, evidence_kind, metadata), result:inference_results(status, result)')
        .eq('organization_id', profile.organizationId)
        .eq('domain', 'video_motion')
        .order('created_at', { ascending: false })
        .limit(100);
      if (filter !== 'all') query = query.eq('status', filter);
      const { data, error: queryError } = await query;
      if (queryError) throw queryError;
      setJobs(((data ?? []) as unknown as CCTVJob[]).map((job) => ({ ...job, result: Array.isArray(job.result) ? job.result[0] ?? null : job.result })));
      if (!selectedId && data?.[0]?.id) setSelectedId(data[0].id);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'CCTV review data could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [filter, profile?.organizationId, selectedId]);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  useEffect(() => {
    if (!profile?.organizationId) return;
    const channel = supabase.channel(`cctv-review-${profile.organizationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inference_jobs', filter: `organization_id=eq.${profile.organizationId}` }, () => void loadJobs())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [loadJobs, profile?.organizationId]);

  const selected = jobs.find((job) => job.id === selectedId) ?? null;
  const counts = useMemo(() => resultCounts(selected?.result?.result), [selected]);

  return (
    <div className="cctv-review-page">
      <header className="cctv-review-header">
        <div><span>Field outcomes</span><h1>CCTV review</h1><p>Review camera evidence, inference results, and items needing a human decision.</p></div>
        <button type="button" className="page-action" onClick={() => void loadJobs()} disabled={loading} title="Refresh CCTV review"><RefreshCw size={17} className={loading ? 'is-spinning' : ''} /> Refresh</button>
      </header>
      <div className="cctv-review-layout">
        <aside className="cctv-filter-rail" aria-label="CCTV review filters">
          <span>Review view</span>
          <h2>Work status</h2>
          {FILTERS.map((item) => <button key={item.value} type="button" className={filter === item.value ? 'is-active' : ''} onClick={() => setFilter(item.value)}>{item.label}<strong>{item.value === 'all' ? jobs.length : jobs.filter((job) => job.status === item.value).length}</strong></button>)}
          <div className="cctv-review-note"><ShieldAlert size={17} /><span>Inference is advisory. Confirm identity, plate readings, and incidents from the source evidence.</span></div>
        </aside>
        <section className="cctv-job-list" aria-label="CCTV review jobs">
          <div className="cctv-section-title"><div><span>Evidence queue</span><h2>{filter === 'all' ? 'Recent camera work' : statusLabel(filter)}</h2></div><strong>{jobs.length}</strong></div>
          {error && <div className="page-error"><AlertTriangle size={17} /> {error}</div>}
          {loading ? <div className="cctv-empty"><RefreshCw className="is-spinning" /> Loading review work</div> : jobs.length === 0 ? <div className="cctv-empty"><FileVideo2 size={24} /><strong>No CCTV work here</strong><span>Uploaded camera evidence will appear after an inference job is created.</span></div> : jobs.map((job) => {
            const jobCounts = resultCounts(job.result?.result);
            return <button key={job.id} type="button" className={`cctv-job-row ${selectedId === job.id ? 'is-selected' : ''}`} onClick={() => setSelectedId(job.id)}><span className="cctv-job-icon"><FileVideo2 size={19} /></span><span className="cctv-job-copy"><strong>{job.evidence?.evidence_kind === 'photo' ? 'Camera snapshot' : 'CCTV video'}</strong><small>{timeLabel(job.created_at)} · {String(job.id).slice(0, 8)}</small></span><span className="cctv-job-findings">{jobCounts.frames ? `${jobCounts.frames} frames` : 'No frames'}{jobCounts.plates ? ` · ${jobCounts.plates} plates` : ''}{jobCounts.faces ? ` · ${jobCounts.faces} faces` : ''}</span><span className={`cctv-status status-${job.status}`}><CircleDot size={13} /> {statusLabel(job.status)}</span></button>;
          })}
        </section>
        <aside className="cctv-detail" aria-label="Selected CCTV evidence">
          {selected ? <><div className="cctv-detail-heading"><div><span>Evidence detail</span><h2>{selected.evidence?.evidence_kind === 'photo' ? 'Camera snapshot' : 'CCTV video'}</h2></div><Eye size={19} /></div><dl><div><dt>Job</dt><dd>{selected.id}</dd></div><div><dt>Captured</dt><dd>{timeLabel(selected.created_at)}</dd></div><div><dt>Source</dt><dd>{selected.evidence?.storage_path ?? 'Storage path unavailable'}</dd></div><div><dt>Pipeline</dt><dd>{statusLabel(selected.status)}</dd></div></dl><div className="cctv-finding-grid"><div><FileVideo2 size={17} /><strong>{counts.frames}</strong><span>Derived frames</span></div><div><CarIcon /><strong>{counts.plates}</strong><span>Plate candidates</span></div><div><UserRound size={17} /><strong>{counts.faces}</strong><span>Face observations</span></div></div><div className="cctv-review-callout"><Clock3 size={17} /><div><strong>Human review required</strong><span>Open the source evidence before linking a person, vehicle, or incident.</span></div></div><div className="cctv-actions"><button type="button" disabled title="Governed review action is the next backend slice"><CheckCircle2 size={16} /> Confirm finding</button><button type="button" disabled title="Governed review action is the next backend slice"><XCircle size={16} /> Dismiss</button></div></> : <div className="cctv-empty"><FileVideo2 size={24} /><strong>Select evidence</strong><span>Choose a queue item to inspect its provenance and findings.</span></div>}
        </aside>
      </div>
    </div>
  );
};

function CarIcon() { return <span aria-hidden="true" className="cctv-car-icon">ALPR</span>; }

export default CCTVReviewPage;
