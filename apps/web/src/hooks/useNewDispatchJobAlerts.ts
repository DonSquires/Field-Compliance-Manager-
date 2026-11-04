import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { alertForNewJob, markJobsSeen, unseenJobIds } from '../lib/officerJobAlerts';

export interface NewDispatchJob { id: string; job_type: string; priority: string; status: string; created_at: string; site_name: string | null }

/** Statuses where the officer has not yet acknowledged the job: these raise an alert. */
export const NEW_JOB_STATUSES = ['pending', 'dispatched'] as const;
const POLL_MS = 20_000;

type Row = { id: string; job_type: string; priority: string; status: string; created_at: string; site: { name: string } | Array<{ name: string }> | null; zone: { name: string } | Array<{ name: string }> | null };
const first = <T,>(value: T | T[] | null): T | null => (Array.isArray(value) ? value[0] ?? null : value);

/**
 * Watches for dispatch jobs newly assigned to this officer. Realtime is used when
 * the dispatch_jobs publication delivers it; polling every 20s is the fallback so
 * a phone that missed the event (sleep, network change) still gets the alert.
 * Each job chimes once per device: seen ids are kept in localStorage.
 */
export function useNewDispatchJobAlerts(officerId: string | null | undefined) {
  const [jobs, setJobs] = useState<NewDispatchJob[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  // ATLAS READS: dispatch_jobs (assigned_officer_id = officer, not yet acknowledged)
  const check = useCallback(async () => {
    if (!officerId) { setJobs([]); return; }
    const { data, error: queryError } = await supabase
      .from('dispatch_jobs')
      .select('id, job_type, priority, status, created_at, site:client_site_id(name), zone:zone_id(name)')
      .eq('assigned_officer_id', officerId)
      .in('status', NEW_JOB_STATUSES as unknown as string[])
      .order('created_at', { ascending: false })
      .limit(10);
    if (!mounted.current) return;
    if (queryError) { setError(queryError.message); return; }
    setError(null);
    const next = ((data ?? []) as unknown as Row[]).map((row) => ({ id: row.id, job_type: row.job_type, priority: row.priority, status: row.status, created_at: row.created_at, site_name: first(row.site)?.name ?? first(row.zone)?.name ?? null }));
    setJobs(next);
    const fresh = unseenJobIds(next.map((job) => job.id));
    if (fresh.length) {
      markJobsSeen(fresh);
      const newest = next.find((job) => job.id === fresh[0])!;
      const label = newest.job_type.replaceAll('_', ' ');
      alertForNewJob('New dispatch job', `${label}${newest.site_name ? ` · ${newest.site_name}` : ''}`, `/officer/dispatch?job=${newest.id}`);
    }
  }, [officerId]);

  useEffect(() => {
    mounted.current = true;
    if (!officerId) return () => { mounted.current = false; };
    void check();
    const interval = window.setInterval(() => void check(), POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    const channel = supabase
      .channel(`officer-job-alerts-${officerId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dispatch_jobs', filter: `assigned_officer_id=eq.${officerId}` }, () => void check())
      .subscribe();
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      void supabase.removeChannel(channel);
    };
  }, [check, officerId]);

  const dismiss = useCallback((id: string) => setDismissed((current) => [...current, id]), []);
  return { jobs: jobs.filter((job) => !dismissed.includes(job.id)), allNewJobs: jobs, error, dismiss, refresh: check };
}
