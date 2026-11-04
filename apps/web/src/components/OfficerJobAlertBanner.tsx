import { useState } from 'react';
import { BellRing, Volume2, X } from 'lucide-react';
import type { NewDispatchJob } from '../hooks/useNewDispatchJobAlerts';
import { enableJobAlerts, jobAlertsEnabled, notificationPermission, type AlertPermission } from '../lib/officerJobAlerts';

const humanise = (value: string) => { const words = value.replaceAll('_', ' ').trim(); return words ? words.charAt(0).toUpperCase() + words.slice(1) : value; };

/**
 * Prominent "New job" banner at the top of the officer portal, plus the one-tap "Enable alerts" control.
 * Announced through the assertive live region rather than an alert role, so it never competes with a
 * page's own error alert.
 */
export function OfficerJobAlertBanner({ jobs, onOpen, onDismiss }: { jobs: NewDispatchJob[]; onOpen: (jobId: string) => void; onDismiss: (jobId: string) => void }) {
  const [enabled, setEnabled] = useState(() => jobAlertsEnabled());
  const [permission, setPermission] = useState<AlertPermission>(() => notificationPermission());
  const enable = async () => { setPermission(await enableJobAlerts()); setEnabled(true); };
  const job = jobs[0] ?? null;

  return (
    <div className="officer-job-alert-region">
      <div aria-live="assertive" aria-atomic="true">
        {job && (
          <section className={`officer-job-alert priority-${job.priority}`} aria-label="New dispatch job">
            <BellRing size={26} aria-hidden="true" />
            <div>
              <strong>New job{jobs.length > 1 ? ` (+${jobs.length - 1} more)` : ''}</strong>
              <span>{humanise(job.job_type)}{job.site_name ? ` · ${job.site_name}` : ''}{job.priority === 'urgent' || job.priority === 'high' ? ` · ${job.priority}` : ''}</span>
            </div>
            <button type="button" className="officer-job-alert-open" onClick={() => onOpen(job.id)}>Open job</button>
            <button type="button" className="officer-job-alert-dismiss" aria-label="Dismiss new job alert" onClick={() => onDismiss(job.id)}><X size={20} aria-hidden="true" /></button>
          </section>
        )}
      </div>
      {(!enabled || permission === 'default') && (
        <button type="button" className="officer-enable-alerts" onClick={() => void enable()}>
          <Volume2 size={18} aria-hidden="true" />Enable job alerts (sound{permission === 'unsupported' ? '' : ' & notifications'})
        </button>
      )}
      {enabled && permission === 'denied' && <p className="officer-alerts-note">Sound alerts are on. Phone notifications are blocked — allow them in your browser settings to be alerted when the screen is off.</p>}
    </div>
  );
}
