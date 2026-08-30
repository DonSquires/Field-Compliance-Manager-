/**
 * OfficerDispatchPage.tsx (Officer module: 'dispatch')
 *
 * Canonical schema: dispatch_jobs, filtered to jobs assigned via this
 * officer's active shift (shift_id). Officer-scoped view/status updates,
 * distinct from the admin DispatchConsolePage (multi-officer console).
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { ACTIVE_DISPATCH_JOB_STATUSES } from '../lib/dispatchStatus';
import { supabase } from '../lib/supabase';
import './PageStyles.css';

interface DispatchJob {
  id: string;
  job_type: string;
  priority: string;
  status: string;
  briefing_notes: string | null;
  sla_respond_by: string | null;
  created_at: string;
}

const NEXT_STATUS: Record<string, string> = {
  acknowledged: 'en_route',
  dispatched: 'acknowledged',
  en_route: 'on_scene',
  on_scene: 'completed',
};

const STATUS_LABEL: Record<string, string> = {
  acknowledged: 'Start En Route',
  dispatched: 'Acknowledge Job',
  en_route: 'Mark On Scene',
  on_scene: 'Mark Completed',
};

const OfficerDispatchPage: React.FC = () => {
  const { profile } = useAuth();
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcomeNotes, setOutcomeNotes] = useState<Record<string, string>>({});

  // ATLAS READS: dispatch_jobs (via shifts assigned to this officer)
  const loadJobs = useCallback(async () => {
    if (!profile?.id || !profile?.organizationId) return;

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
      if (shiftIds.length === 0) {
        setJobs([]);
        return;
      }

      const { data, error: err } = await supabase
        .from('dispatch_jobs')
        .select('id, job_type, priority, status, briefing_notes, sla_respond_by, created_at')
        .in('shift_id', shiftIds)
        .in('status', ACTIVE_DISPATCH_JOB_STATUSES as readonly string[])
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });

      if (err) throw err;
      setJobs((data as DispatchJob[]) || []);
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
      if (!data?.length) throw new Error('The dispatch status change was not confirmed.');

      if (nextStatus === 'completed') {
        setJobs(jobs.filter((j) => j.id !== job.id));
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

      <div className="contacts-list">
        {jobs.length === 0 ? (
          <div className="empty-state">
            <p>No active dispatch jobs right now.</p>
          </div>
        ) : (
          jobs.map((job) => (
            <div key={job.id} className="contact-card">
              <div className="contact-header">
                <h3>{job.job_type}</h3>
                <span className={`severity-badge severity-${job.priority === 'high' ? 'high' : 'low'}`}>
                  {job.priority}
                </span>
              </div>
              <div className="contact-details">
                {job.briefing_notes && <p>{job.briefing_notes}</p>}
                <p className="contact-meta">
                  {job.status}
                  {job.sla_respond_by ? ` · respond by ${new Date(job.sla_respond_by).toLocaleTimeString()}` : ''}
                </p>
              </div>
              {job.status === 'on_scene' && (
                <div className="form-group" style={{ marginTop: '10px' }}>
                  <label>Outcome notes</label>
                  <textarea
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
