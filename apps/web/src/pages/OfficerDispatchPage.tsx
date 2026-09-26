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
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { ACTIVE_DISPATCH_JOB_STATUSES } from '../lib/dispatchStatus';
import { OfficerRouteGuidance } from '../components/OfficerRouteGuidance';
import { supabase } from '../lib/supabase';
import './PageStyles.css';
import './OfficerDispatchPage.css';

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

interface DispatchJobRow extends Omit<DispatchJob, 'site'> {
  site: DispatchJob['site'] | DispatchJob['site'][];
  zone: { name: string; zone_type: string | null } | Array<{ name: string; zone_type: string | null }> | null;
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

// Button wording: what the officer is telling dispatch right now.
const STATUS_LABEL: Record<string, string> = {
  pending: 'Accept job',
  dispatched: 'Acknowledge job',
  acknowledged: 'On my way',
  en_route: 'Arrived on site',
  on_scene: 'Complete job',
};
const STATUS_TEXT: Record<string, string> = {
  pending: 'Waiting to be dispatched',
  dispatched: 'Dispatched to you',
  acknowledged: 'Acknowledged',
  en_route: 'On the way',
  on_scene: 'On site',
  completed: 'Finished',
};
const JOB_STEPS = [
  { rank: 1, label: 'Acknowledge' },
  { rank: 2, label: 'Travel' },
  { rank: 3, label: 'Attend' },
  { rank: 4, label: 'Complete' },
];
const STEP_RANK: Record<string, number> = { pending: 0, dispatched: 0, acknowledged: 1, en_route: 2, on_scene: 3, completed: 4 };
const PRIORITY_WEIGHT: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

const humanise = (value: string) => {
  const words = value.replaceAll('_', ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
};

// Amber once three quarters of the response window has gone, red once it has passed.
function responseTone(job: DispatchJob, now: number): { tone: 'on_track' | 'due_soon' | 'overdue'; label: string } | null {
  if (!job.sla_respond_by || STEP_RANK[job.status] >= 3) return null;
  const deadline = new Date(job.sla_respond_by).getTime();
  const created = new Date(job.created_at).getTime();
  const time = new Date(deadline).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' });
  if (now > deadline) return { tone: 'overdue', label: `Response time passed at ${time}` };
  const elapsed = deadline > created ? (now - created) / (deadline - created) : 0;
  if (elapsed >= 0.75) return { tone: 'due_soon', label: `Respond by ${time} · due soon` };
  return { tone: 'on_track', label: `Respond by ${time}` };
}

const OfficerDispatchPage: React.FC<{ onNavigate?: (destination: 'home' | 'map' | 'report' | 'debrief') => void }> = ({ onNavigate }) => {
  const location = useLocation();
  const requestedJobId = new URLSearchParams(location.search).get('job');
  const { profile } = useAuth();
  const { selectedAgreementZones } = useServiceRelationships();
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
      const activeZoneIds = selectedAgreementZones.length > 0 ? selectedAgreementZones.map((zone) => zone.id) : null;

      const shiftQuery = supabase
        .from('shifts')
        .select('id')
        .eq('officer_user_id', profile.id)
        .in('status', ['accepted', 'in_progress']);
      const scopedShiftQuery = activeZoneIds && activeZoneIds.length > 0
        ? shiftQuery.in('zone_id', activeZoneIds)
        : shiftQuery;
      const { data: shifts, error: shiftErr } = await scopedShiftQuery;

      if (shiftErr) throw shiftErr;

      const shiftIds = (shifts || []).map((s: { id: string }) => s.id);
      if (shiftIds.length === 0 && !profile.id) {
        setJobs([]);
        return;
      }

      const jobQuery = supabase
        .from('dispatch_jobs')
        .select('id, job_type, priority, status, briefing_notes, sla_respond_by, expected_dwell_minutes, timing_source, created_at, investigation_id, site:client_site_id(name, address, hs_notes, access_instructions), zone:zone_id(name, zone_type)')
        .or(`${shiftIds.length ? `shift_id.in.(${shiftIds.join(',')}),` : ''}assigned_officer_id.eq.${profile.id}`)
        .in('status', ACTIVE_DISPATCH_JOB_STATUSES as readonly string[]);
      const scopedJobQuery = activeZoneIds && activeZoneIds.length > 0
        ? jobQuery.in('zone_id', activeZoneIds)
        : jobQuery;
      const { data, error: err } = await scopedJobQuery
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });

      if (err) throw err;
      setJobs(((data as unknown as DispatchJobRow[]) || []).map((row) => {
        const site = Array.isArray(row.site) ? row.site[0] ?? null : row.site;
        const zone = Array.isArray(row.zone) ? row.zone[0] ?? null : row.zone;
        return {
          ...row,
          site: site ?? (zone ? { name: zone.name, address: null, hs_notes: null, access_instructions: null } : null),
        };
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dispatch jobs');
    } finally {
      setLoading(false);
    }
  }, [profile?.id, profile?.organizationId, selectedAgreementZones]);

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
        <p className="subtitle">{jobs.length === 0 ? 'No jobs assigned to you right now' : `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} assigned to you`}</p>
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
          <div className="empty-state officer-dispatch-empty">
            <p>No active dispatch jobs right now.</p>
            <small>New jobs appear here the moment dispatch assigns them to you. Until then, carry on with your shift.</small>
            <button type="button" className="btn btn-secondary" onClick={() => onNavigate?.('home')}><Home size={16} />Back to shift home</button>
          </div>
        ) : (
          jobs.map((job) => {
            const rank = STEP_RANK[job.status] ?? 0;
            const response = responseTone(job, Date.now());
            const isFocused = job.id === requestedJobId;
            const briefHeading = rank >= 3 ? 'On-site notes' : 'Before you arrive';
            return (
              <article key={job.id} id={`officer-dispatch-${job.id}`} className={`contact-card officer-dispatch-job ${isFocused ? 'is-context-focus' : ''}`} aria-label={`${humanise(job.job_type)} at ${job.site?.name ?? 'unconfirmed site'}`}>
                <div className="contact-header">
                  <div>
                    <h3>{humanise(job.job_type)}</h3>
                    {job.site && <p className="officer-dispatch-site"><strong>{job.site.name}</strong>{job.site.address && ` · ${job.site.address}`}</p>}
                  </div>
                  <span className={`officer-dispatch-priority priority-${job.priority}`}>{job.priority}</span>
                </div>

                <ol className="officer-dispatch-steps" aria-label="Job progress">
                  {JOB_STEPS.map((step) => {
                    const state = rank >= step.rank ? 'done' : rank === step.rank - 1 ? 'next' : 'later';
                    return <li key={step.rank} className={`is-${state}`} data-step={step.rank} aria-current={state === 'next' ? 'step' : undefined}>{step.label}</li>;
                  })}
                </ol>

                <p className={`officer-dispatch-status tone-${response?.tone ?? 'none'}`}>
                  <strong>{STATUS_TEXT[job.status] ?? humanise(job.status)}</strong>
                  {response ? ` · ${response.label}` : ''}
                  {` · expect about ${job.expected_dwell_minutes} min on site`}
                </p>

                <section className="officer-dispatch-brief" aria-label={briefHeading}>
                  <h4>{briefHeading}</h4>
                  {job.site?.access_instructions && <p>Access: {job.site.access_instructions}</p>}
                  {job.site?.hs_notes && <p className="is-safety"><strong>Safety: </strong>{job.site.hs_notes}</p>}
                  {job.briefing_notes && <p>{job.briefing_notes}</p>}
                  {!job.site?.access_instructions && !job.site?.hs_notes && !job.briefing_notes && <p>No access, safety, or briefing notes were recorded for this job.</p>}
                </section>

                {job.status === 'on_scene' && (
                  <div className="form-group officer-dispatch-outcome">
                    <label htmlFor={`dispatch-outcome-${job.id}`}>Outcome notes</label>
                    <textarea
                      id={`dispatch-outcome-${job.id}`}
                      rows={3}
                      required
                      value={outcomeNotes[job.id] ?? ''}
                      onChange={(event) => setOutcomeNotes((current) => ({ ...current, [job.id]: event.target.value }))}
                      placeholder="Record actions taken and the verified outcome"
                    />
                    <small>Say what you found, what you did, and who you told. This goes on the client record.</small>
                  </div>
                )}
                {NEXT_STATUS[job.status] && (
                  <button
                    className="btn btn-primary officer-dispatch-action"
                    disabled={busyId === job.id || (job.status === 'on_scene' && !(outcomeNotes[job.id]?.trim()))}
                    onClick={() => handleAdvanceStatus(job)}
                  >
                    {busyId === job.id ? 'Updating…' : STATUS_LABEL[job.status]}
                  </button>
                )}
              </article>
            );
          })
        )}
      </div>
    </div>
  );
};

export default OfficerDispatchPage;
