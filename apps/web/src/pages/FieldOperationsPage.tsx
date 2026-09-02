import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Car,
  FileSearch,
  FileWarning,
  HeartPulse,
  Map,
  Radio,
  RefreshCw,
  Route,
  ShieldAlert,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ACTIVE_DISPATCH_JOB_STATUSES } from '../lib/dispatchStatus';
import { supabase } from '../lib/supabase';
import './FieldOperationsPage.css';

type FieldOpsArea = 'dispatch' | 'patrol' | 'live-map' | 'officer-activity' | 'welfare-alerts' | 'breach-review' | 'vehicle-search' | 'field-reports' | 'debrief-followup';

interface FieldOperationsPageProps {
  onNavigate: (area: FieldOpsArea) => void;
}

interface MetricState {
  value: number | null;
  error: string | null;
}

interface Metrics {
  onDuty: MetricState;
  activeDispatch: MetricState;
  welfareAlerts: MetricState;
  reportFollowUp: MetricState;
}

const EMPTY_METRIC: MetricState = { value: null, error: null };
const EMPTY_METRICS: Metrics = {
  onDuty: EMPTY_METRIC,
  activeDispatch: EMPTY_METRIC,
  welfareAlerts: EMPTY_METRIC,
  reportFollowUp: EMPTY_METRIC,
};

const WORKFLOWS: Array<{ area: FieldOpsArea; label: string; detail: string; icon: LucideIcon; tone: string }> = [
  { area: 'dispatch', label: 'Dispatch console', detail: 'Create jobs, assign resources, and manage SLA response', icon: Radio, tone: 'teal' },
  { area: 'live-map', label: 'Live operations', detail: 'Review GPS freshness and separately confirmed welfare state', icon: Map, tone: 'blue' },
  { area: 'welfare-alerts', label: 'Welfare response', detail: 'Acknowledge, investigate, and resolve active alerts', icon: HeartPulse, tone: 'red' },
  { area: 'patrol', label: 'Patrol operations', detail: 'Manage routes, checkpoints, visits, and exceptions', icon: Route, tone: 'green' },
  { area: 'field-reports', label: 'Field reports', detail: 'Triage submitted reports and required follow-up', icon: FileWarning, tone: 'amber' },
  { area: 'debrief-followup', label: 'Debrief follow-up', detail: 'Own safety, equipment, and handover actions', icon: FileWarning, tone: 'amber' },
  { area: 'breach-review', label: 'Breach review', detail: 'Assess compliance alerts and record governed outcomes', icon: ShieldAlert, tone: 'red' },
  { area: 'vehicle-search', label: 'Vehicle intelligence', detail: 'Search vehicle, observation, and compliance history', icon: Car, tone: 'blue' },
  { area: 'officer-activity', label: 'Officer investigations', detail: 'Build audited timelines and issue hashed evidence', icon: FileSearch, tone: 'slate' },
];

function toMetric(response: { count: number | null; error: { message: string } | null }): MetricState {
  return response.error ? { value: null, error: response.error.message } : { value: response.count ?? 0, error: null };
}

const FieldOperationsPage: React.FC<FieldOperationsPageProps> = ({ onNavigate }) => {
  const { profile } = useAuth();
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const loadMetrics = useCallback(async () => {
    if (!profile?.organizationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const now = new Date().toISOString();
    const organizationId = profile.organizationId;
    const [onDuty, dispatch, welfare, reports] = await Promise.all([
      supabase.from('shifts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).lte('scheduled_start', now).gte('scheduled_end', now).in('status', ['accepted', 'in_progress']),
      supabase.from('dispatch_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ACTIVE_DISPATCH_JOB_STATUSES),
      supabase.from('welfare_alerts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['pending', 'acknowledged']),
      supabase.from('officer_field_reports').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).eq('follow_up_required', true).eq('status', 'submitted'),
    ]);
    setMetrics({ onDuty: toMetric(onDuty), activeDispatch: toMetric(dispatch), welfareAlerts: toMetric(welfare), reportFollowUp: toMetric(reports) });
    setUpdatedAt(new Date());
    setLoading(false);
  }, [profile?.organizationId]);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  const warnings = Object.entries(metrics).filter(([, metric]) => metric.error);

  return (
    <div className="field-ops-home">
      <header className="field-ops-header">
        <div><span>Operations control</span><h1>Field Operations</h1><p>Live work queues, response controls, and evidential review for field delivery.</p></div>
        <div className="field-ops-refresh">
          {updatedAt && <time dateTime={updatedAt.toISOString()}>Updated {updatedAt.toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</time>}
          <button type="button" onClick={() => void loadMetrics()} disabled={loading} title="Refresh operational counts"><RefreshCw size={16} className={loading ? 'is-spinning' : ''} />Refresh</button>
        </div>
      </header>

      {warnings.length > 0 && <div className="field-ops-warning" role="alert"><AlertTriangle size={18} /><div><strong>Some operational counts are unavailable</strong><span>{warnings.map(([name, metric]) => `${name}: ${metric.error}`).join(' · ')}</span></div></div>}

      <section className="field-ops-metrics" aria-label="Current operational workload">
        <MetricButton icon={Users} label="Officers on duty" metric={metrics.onDuty} loading={loading} onClick={() => onNavigate('live-map')} />
        <MetricButton icon={Radio} label="Active dispatch" metric={metrics.activeDispatch} loading={loading} onClick={() => onNavigate('dispatch')} />
        <MetricButton icon={HeartPulse} label="Welfare alerts" metric={metrics.welfareAlerts} loading={loading} urgent onClick={() => onNavigate('welfare-alerts')} />
        <MetricButton icon={FileWarning} label="Reports for follow-up" metric={metrics.reportFollowUp} loading={loading} onClick={() => onNavigate('field-reports')} />
      </section>

      <section className="field-ops-workflows">
        <div className="field-ops-section-heading"><div><span>Workspaces</span><h2>Operational command areas</h2></div><small>Each area uses tenant-authorized live records</small></div>
        <div className="field-ops-workflow-grid">
          {WORKFLOWS.map(({ area, label, detail, icon: Icon, tone }) => (
            <button type="button" key={area} className={`field-ops-workflow tone-${tone}`} onClick={() => onNavigate(area)}>
              <span><Icon size={19} aria-hidden="true" /></span><div><strong>{label}</strong><small>{detail}</small></div><ArrowRight size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
};

function MetricButton({ icon: Icon, label, metric, loading, urgent = false, onClick }: { icon: LucideIcon; label: string; metric: MetricState; loading: boolean; urgent?: boolean; onClick: () => void }) {
  const unavailable = !loading && metric.value === null;
  return <button type="button" className={`field-ops-metric ${urgent && (metric.value ?? 0) > 0 ? 'is-urgent' : ''} ${unavailable ? 'is-unavailable' : ''}`} onClick={onClick} title={metric.error ?? `Open ${label.toLowerCase()}`}><span><Icon size={19} /></span><div><small>{label}</small><strong>{loading ? '—' : unavailable ? 'Unavailable' : metric.value}</strong></div><ArrowRight size={16} /></button>;
}

export default FieldOperationsPage;