/**
 * OfficerDispatchPage.tsx (Officer module: 'dispatch')
 *
 * Canonical schema: dispatch_jobs, filtered to jobs assigned via this
 * officer's active shift (shift_id). Officer-scoped view/status updates,
 * distinct from the admin DispatchConsolePage (multi-officer console).
 */

import React, { useEffect, useState, useCallback } from 'react';
import { CheckCircle2, FileText, Home, Map, ShieldCheck } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ACTIVE_DISPATCH_JOB_STATUSES } from '../lib/dispatchStatus';
import { OfficerRouteGuidance } from '../components/OfficerRouteGuidance';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface DispatchJob {
  id: string;
  job_type: string;
  priority: string;
  status: string;
  briefing_notes: string | null;
  sla_respond_by: string | null;
  expected_dwell_minutes: number;
  timing_source: string;
  created_at: string;
  investigation_id: string | null;
  site: { name: string; address: string | null; hs_notes: string | null; access_instructions: string | null } | null;
}

interface CompletionReceipt {
  id: string;
  shiftId: string | null;
  jobType: string;
  completedAt: string;
  investigationId: string | null;
}

const NEXT_STATUS: Record<string, string> = {
  pending: 'dispatched',
  acknowledged: 'en_route',
  dispatched: 'acknowledged',
  en_route: 'on_scene',
  on_scene: 'completed',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Accept Job',
  acknowledged: 'Start En Route',
  dispatched: 'Acknowledge Job',
  en_route: 'Mark On Scene',
  on_scene: 'Mark Completed',
};
const PRIORITY_WEIGHT: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

const OfficerDispatchPage: React.FC<{ onNavigate?: (destination: 'home' | 'map' | 'report' | 'debrief') => void }> = ({ onNavigate }) => {
  const location = useLocation();
  const requestedJobId = new URLSearchParams(location.search).get('job');
  const { profile } = useAuth();
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcomeNotes, setOutcomeNotes] = useState<Record<string, string>>({});
  const [completionReceipt, setCompletionReceipt] = useState<CompletionReceipt | null>(null);
  const [plannedJobId, setPlannedJobId] = useState<string | null>(null);
  const recommendedJob = [...jobs].sort((left, right) => {
    const leftDeadline = left.sla_respond_by ? new Date(left.sla_respond_by).getTime() : Number.MAX_SAFE_INTEGER;
    const rightDeadline = right.sla_respond_by ? new Date(right.sla_respond_by).getTime() : Number.MAX_SAFE_INTEGER;
    return leftDeadline - rightDeadline || (PRIORITY_WEIGHT[left.priority] ?? 9) - (PRIORITY_WEIGHT[right.priority] ?? 9);
  })[0] ?? null;
  const routedJob = jobs.find((job) => job.id === plannedJobId) ?? recommendedJob;

  // ATLAS READS: dispatch_jobs (via shifts assigned to this officer)
  const loadJobs = useCallback(async () => {
    if (!profile?.id || !profile?.organizationId) {
      setJobs([]);
      setError('Organisation access could not be confirmed. Dispatch jobs are unavailable.');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const { data: shifts, error: shiftErr } = await supabase
        .from('shifts')
        .select('id')
        .eq('officer_user_id', profile.id)
        .in('status', ['accepted', 'in_progress']);

      if (shiftErr) throw shiftErr;

      const shiftIds = (shifts || []).map((s: { id: string }) => s.id);
      if (shiftIds.length === 0 && !profile.id) {
        setJobs([]);
        return;
      }

      const { data, error: err } = await supabase
        .from('dispatch_jobs')
        .select('id, job_type, priority, status, briefing_notes, sla_respond_by, expected_dwell_minutes, timing_source, created_at, investigation_id, site:client_site_id(name, address, hs_notes, access_instructions)')
        .or(`${shiftIds.length ? `shift_id.in.(${shiftIds.join(',')}),` : ''}assigned_officer_id.eq.${profile.id}`)
        .in('status', ACTIVE_DISPATCH_JOB_STATUSES as readonly string[])
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });

      if (err) throw err;
      setJobs((data as unknown as DispatchJob[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dispatch jobs');
    } finally {
      setLoading(false);
    }
  }, [profile?.id, profile?.organizationId]);

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 30000);
    return () => clearInterval(interval);
  }, [loadJobs]);

  useEffect(() => { if (requestedJobId) document.getElementById(`officer-dispatch-${requestedJobId}`)?.scrollIntoView({ block: 'center' }); }, [jobs, requestedJobId]);

  const handleAdvanceStatus = async (job: DispatchJob) => {
    const nextStatus = NEXT_STATUS[job.status];
    if (!nextStatus) return;
    const outcome = outcomeNotes[job.id]?.trim() ?? '';
    if (nextStatus === 'completed' && !outcome) {
      setError('Record the dispatch outcome before completing the job.');
      return;
    }

    try {
      setBusyId(job.id);
      setError(null);

      // Server owns authorization, expected-state race checks, timestamps, and
      // resource release on terminal transitions.
      const { data, error } = await supabase.rpc('advance_dispatch_job_status', {
        p_job_id: job.id,
        p_expected_status: job.status,
        p_next_status: nextStatus,
        p_outcome_notes: nextStatus === 'completed' ? outcome : null,
      });

      if (error) throw error;
      const result = (data as Array<{ id: string; status: string; shift_id: string | null; completed_at: string | null }> | null)?.[0];
      if (!result || result.id !== job.id || result.status !== nextStatus) throw new Error('The dispatch status change was not confirmed.');

      if (nextStatus === 'completed') {
        setCompletionReceipt({ id: result.id, shiftId: result.shift_id, jobType: job.job_type, completedAt: result.completed_at ?? new Date().toISOString(), investigationId: job.investigation_id });
        setJobs((current) => current.filter((item) => item.id !== job.id));
        setOutcomeNotes((current) => {
          const next = { ...current };
          delete next[job.id];
          return next;
        });
      } else {
        setJobs(jobs.map((j) => (j.id === job.id ? { ...j, status: nextStatus } : j)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update job status');
      await loadJobs();
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading dispatch jobs...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Dispatch</h1>
        <p className="subtitle">{jobs.length} active jobs on your shift</p>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">
            ×
          </button>
          {error}
        </div>
      )}

      {completionReceipt && (
        <section className="dispatch-completion" aria-label="Dispatch completion receipt">
          <div className="dispatch-completion-summary">
            <CheckCircle2 size={22} />
            <div>
              <span>Dispatch completed</span>
              <strong>{completionReceipt.jobType}</strong>
              <p>Receipt {completionReceipt.id.slice(0, 8)} · shift {completionReceipt.shiftId?.slice(0, 8) ?? 'not linked'} · {new Date(completionReceipt.completedAt).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</p>
              <small>Your shift remains active. Continue with assigned work or use Debrief only when all shift work is finished.</small>
            </div>
          </div>
          <div className="dispatch-completion-actions" aria-label="Dispatch next actions">
            <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('home')}><Home size={16} />Shift home</button>
            <button type="button" className="btn btn-secondary" onClick={() => onNavigate?.('map')}><Map size={16} />Open map</button>
            <button type="button" className="btn btn-secondary" onClick={() => completionReceipt.investigationId ? window.location.assign(`/officer/report?job=${completionReceipt.id}&investigation=${completionReceipt.investigationId}`) : onNavigate?.('report')}><FileText size={16} />{completionReceipt.investigationId ? 'Submit investigation report' : 'Field report'}</button>
            <button type="button" className="btn btn-secondary" onClick={() => onNavigate?.('debrief')}><ShieldCheck size={16} />Debrief</button>
          </div>
        </section>
      )}

      {routedJob && <OfficerRouteGuidance job={routedJob} onRecommendation={setPlannedJobId} />}

      <div className="contacts-list">
        {jobs.length === 0 ? (
          <div className="empty-state">
            <p>No active dispatch jobs right now.</p>
          </div>
        ) : (
          jobs.map((job) => (
            <div key={job.id} id={`officer-dispatch-${job.id}`} className={`contact-card ${job.id === requestedJobId ? 'is-context-focus' : ''}`}>
              <div className="contact-header">
                <h3>{job.job_type}</h3>
                <span className={`severity-badge severity-${job.priority === 'high' ? 'high' : 'low'}`}>
                  {job.priority}
                </span>
              </div>
              <div className="contact-details">
                {job.site && <><p><strong>{job.site.name}</strong>{job.site.address && ` · ${job.site.address}`}</p>{job.site.access_instructions && <p>Access: {job.site.access_instructions}</p>}{job.site.hs_notes && <p><strong>Safety: </strong>{job.site.hs_notes}</p>}</>}
                {job.briefing_notes && <p>{job.briefing_notes}</p>}
                <p className="contact-meta">
                  {job.status}
                  {job.sla_respond_by ? ` · respond by ${new Date(job.sla_respond_by).toLocaleTimeString()}` : ''}
                  {` · ${job.expected_dwell_minutes} min dwell`}
                </p>
              </div>
              {job.status === 'on_scene' && (
                <div className="form-group" style={{ marginTop: '10px' }}>
                  <label htmlFor={`dispatch-outcome-${job.id}`}>Outcome notes</label>
                  <textarea
                    id={`dispatch-outcome-${job.id}`}
                    rows={3}
                    required
                    value={outcomeNotes[job.id] ?? ''}
                    onChange={(event) => setOutcomeNotes((current) => ({ ...current, [job.id]: event.target.value }))}
                    placeholder="Record actions taken and the verified outcome"
                  />
                </div>
              )}
              {NEXT_STATUS[job.status] && (
                <button
                  className="btn btn-sm btn-primary"
                  disabled={busyId === job.id || (job.status === 'on_scene' && !(outcomeNotes[job.id]?.trim()))}
                  onClick={() => handleAdvanceStatus(job)}
                >
                  {STATUS_LABEL[job.status]}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OfficerDispatchPage;
