import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Binoculars,
  Car,
  ClipboardCheck,
  FileWarning,
  FileSearch,
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
import { SafetyGate } from '../components/SafetyGate';
import { ACTIVE_DISPATCH_JOB_STATUSES } from '../lib/dispatchStatus';
import { describeLoadFailures } from '../lib/friendlyLoadError';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { supabase } from '../lib/supabase';
import './AdminHubPage.css';

interface AdminHubPageProps {
  onNavigate?: (page: string) => void;
}

interface MetricState {
  value: number | null;
  error: string | null;
}

interface Metrics {
  onDuty: MetricState;
  activeDispatch: MetricState;
  welfare: MetricState;
  breaches: MetricState;
  observations: MetricState;
}

type QueueKind = 'welfare' | 'dispatch' | 'breach' | 'report' | 'video';

interface QueueItem {
  id: string;
  kind: QueueKind;
  title: string;
  detail: string;
  status: string;
  priority: number;
  occurredAt: string;
  navigate: string;
}

const EMPTY_METRICS: Metrics = {
  onDuty: { value: null, error: null },
  activeDispatch: { value: null, error: null },
  welfare: { value: null, error: null },
  breaches: { value: null, error: null },
  observations: { value: null, error: null },
};

function metricFrom(response: { count: number | null; error: { message: string } | null }): MetricState {
  return response.error
    ? { value: null, error: response.error.message }
    : { value: response.count ?? 0, error: null };
}

function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return 'Now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const AdminHubPage: React.FC<AdminHubPageProps> = ({ onNavigate }) => {
  const { profile } = useAuth();
  const { status: moduleStatus, isModuleEnabled } = useEnabledModules(profile?.organizationId);
  const welfareEnabled = isModuleEnabled('welfare', { safetyRelevant: true });
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [queueWarnings, setQueueWarnings] = useState<string[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadDashboard = useCallback(async () => {
    if (!profile?.organizationId) return;
    setLoading(true);
    setQueueWarnings([]);

    const organizationId = profile.organizationId;
    const now = new Date();
    const nowIso = now.toISOString();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    try {
      const [onDuty, dispatchCount, welfareCount, breachCount, observationCount, welfareRows, dispatchRows, breachRows, reportRows, videoRows] = await Promise.all([
        supabase.from('shifts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).lte('scheduled_start', nowIso).gte('scheduled_end', nowIso).in('status', ['accepted', 'in_progress']),
        supabase.from('dispatch_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ACTIVE_DISPATCH_JOB_STATUSES),
        welfareEnabled
          ? supabase.from('welfare_alerts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['pending', 'acknowledged'])
          : Promise.resolve({ count: 0, error: null }),
        supabase.from('breach_alerts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['open', 'acknowledged', 'actioned']),
        supabase.from('observations').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).gte('observed_at', todayStart),
        welfareEnabled
          ? supabase.from('welfare_alerts').select('id, officer_user_id, alert_type, status, escalation_level, triggered_at').eq('organization_id', organizationId).in('status', ['pending', 'acknowledged']).order('triggered_at', { ascending: false }).limit(6)
          : Promise.resolve({ data: [], error: null }),
        supabase.from('dispatch_jobs').select('id, job_type, priority, status, sla_respond_by, created_at').eq('organization_id', organizationId).in('status', ACTIVE_DISPATCH_JOB_STATUSES).order('created_at', { ascending: false }).limit(6),
        supabase.from('breach_alerts').select('id, plate_number, breach_type, status, created_at').eq('organization_id', organizationId).in('status', ['open', 'acknowledged', 'actioned']).order('created_at', { ascending: false }).limit(6),
        supabase.from('officer_field_reports').select('id, title, severity, status, reported_at').eq('organization_id', organizationId).eq('follow_up_required', true).eq('status', 'submitted').order('reported_at', { ascending: false }).limit(6),
        supabase.from('inference_jobs').select('id, evidence_item_id, domain, status, created_at').eq('organization_id', organizationId).in('domain', ['video_motion', 'vehicle', 'face']).in('status', ['queued', 'processing', 'manual_review_required']).order('created_at', { ascending: false }).limit(6),
      ]);

      setMetrics({
        onDuty: metricFrom(onDuty),
        activeDispatch: metricFrom(dispatchCount),
        welfare: metricFrom(welfareCount),
        breaches: metricFrom(breachCount),
        observations: metricFrom(observationCount),
      });

      const warnings: Array<[string, { message: string } | null | undefined]> = [];
      const items: QueueItem[] = [];

      if (welfareRows.error) warnings.push(['welfare alerts', welfareRows.error]);
      else {
        for (const alert of welfareRows.data ?? []) {
          items.push({
            id: alert.id,
            kind: 'welfare',
            title: `${String(alert.alert_type).replace(/_/g, ' ')} alert`,
            detail: `Officer ${String(alert.officer_user_id).slice(0, 8)} · escalation level ${alert.escalation_level}`,
            status: alert.status,
            priority: alert.alert_type === 'sos' ? 100 : 80 + Number(alert.escalation_level ?? 1),
            occurredAt: alert.triggered_at,
            navigate: 'welfare-alerts',
          });
        }
      }

      if (dispatchRows.error) warnings.push(['dispatch jobs', dispatchRows.error]);
      else {
        for (const job of dispatchRows.data ?? []) {
          const deadline = job.sla_respond_by ? new Date(job.sla_respond_by).getTime() : null;
          items.push({
            id: job.id,
            kind: 'dispatch',
            title: String(job.job_type).replace(/_/g, ' '),
            detail: deadline ? `${deadline < Date.now() ? 'SLA overdue' : 'SLA due'} ${new Date(job.sla_respond_by).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}` : 'No SLA deadline',
            status: job.status,
            priority: job.priority === 'urgent' ? 90 : job.priority === 'high' ? 70 : 40,
            occurredAt: job.created_at,
            navigate: `dispatch?job=${encodeURIComponent(job.id)}`,
          });
        }
      }

      if (breachRows.error) warnings.push(['breach alerts', breachRows.error]);
      else {
        for (const breach of breachRows.data ?? []) {
          items.push({
            id: breach.id,
            kind: 'breach',
            title: `${breach.plate_number} · ${String(breach.breach_type).replace(/_/g, ' ')}`,
            detail: 'Compliance review required',
            status: breach.status,
            priority: 60,
            occurredAt: breach.created_at,
            navigate: 'breach-review',
          });
        }
      }

      if (reportRows.error) warnings.push(['field reports', reportRows.error]);
      else {
        for (const report of reportRows.data ?? []) {
          items.push({
            id: report.id,
            kind: 'report',
            title: report.title,
            detail: `${String(report.severity)} severity · follow-up required`,
            status: report.status,
            priority: report.severity === 'critical' ? 95 : report.severity === 'high' ? 75 : 35,
            occurredAt: report.reported_at,
            navigate: 'field-reports',
          });
        }
      }

      if (videoRows.error) warnings.push(['CCTV inference jobs', videoRows.error]);
      else {
        for (const job of videoRows.data ?? []) {
          items.push({
            id: job.id,
            kind: 'video',
            title: 'CCTV evidence review',
            detail: `Video evidence ${String(job.evidence_item_id).slice(0, 8)} · ${job.status === 'processing' ? 'analysis in progress' : 'review required'}`,
            status: job.status,
            priority: job.status === 'manual_review_required' ? 78 : 45,
            occurredAt: job.created_at,
            navigate: 'cctv-review',
          });
        }
      }

      setQueue(items.sort((left, right) => right.priority - left.priority || right.occurredAt.localeCompare(left.occurredAt)).slice(0, 12));
      const failure = describeLoadFailures(warnings);
      setQueueWarnings(failure ? [failure] : []);
      setLastUpdated(new Date());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Operations data could not be loaded.';
      setMetrics(Object.fromEntries(Object.keys(EMPTY_METRICS).map((key) => [key, { value: null, error: message }])) as unknown as Metrics);
      setQueue([]);
      setQueueWarnings([message]);
    } finally {
      setLoading(false);
    }
  }, [profile?.organizationId, welfareEnabled]);

  useEffect(() => {
    void loadDashboard();
    const interval = window.setInterval(() => void loadDashboard(), 60_000);
    return () => window.clearInterval(interval);
  }, [loadDashboard]);

  useEffect(() => {
    if (!profile?.organizationId) return;
    const organizationId = profile.organizationId;
    const channel = supabase
      .channel(`admin-hub-${organizationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'breach_alerts', filter: `organization_id=eq.${organizationId}` }, () => void loadDashboard())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dispatch_jobs', filter: `organization_id=eq.${organizationId}` }, () => void loadDashboard())
      .subscribe();
    const welfareChannel = welfareEnabled
      ? supabase
          .channel(`admin-hub-welfare-${organizationId}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'welfare_alerts', filter: `organization_id=eq.${organizationId}` }, () => void loadDashboard())
          .subscribe()
      : null;
    return () => {
      void supabase.removeChannel(channel);
      if (welfareChannel) void supabase.removeChannel(welfareChannel);
    };
  }, [loadDashboard, profile?.organizationId, welfareEnabled]);

  const attentionMetrics = [metrics.welfare.value, metrics.breaches.value, metrics.activeDispatch.value];
  const attentionCount = attentionMetrics.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const attentionUnavailable = attentionMetrics.some((value) => value === null);

  return (
    <div className="admin-overview">
      <header className="admin-overview-header">
        <div>
          <span>Operations control</span>
          <h1>Today at a glance</h1>
          <p>{attentionUnavailable ? 'Some active safety, dispatch, or compliance counts are unavailable. Review metric status below.' : attentionCount > 0 ? `${attentionCount} active items across safety, dispatch, and compliance.` : 'No active safety, dispatch, or compliance items.'}</p>
        </div>
        <div className="admin-refresh-block">
          {lastUpdated && <time dateTime={lastUpdated.toISOString()}>Updated {lastUpdated.toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</time>}
          <button type="button" onClick={() => void loadDashboard()} disabled={loading} title="Refresh operations overview">
            <RefreshCw size={18} className={loading ? 'is-spinning' : ''} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      <section className="admin-metric-grid" aria-label="Current operations metrics">
        <Metric icon={Users} label="On duty now" metric={metrics.onDuty} tone="blue" onClick={() => onNavigate?.('roster')} />
        <Metric icon={Radio} label="Active dispatch" metric={metrics.activeDispatch} tone="teal" onClick={() => onNavigate?.('dispatch')} />
        <SafetyGate
          status={moduleStatus}
          isEnabled={welfareEnabled}
          moduleLabel="Welfare monitoring"
          safetyRelevant
          renderUnavailable={(message) => <Metric icon={HeartPulse} label="Welfare alerts" metric={{ value: null, error: message.description }} tone="red" onClick={() => onNavigate?.('welfare-alerts')} />}
        >
          <Metric icon={HeartPulse} label="Welfare alerts" metric={metrics.welfare} tone="red" onClick={() => onNavigate?.('welfare-alerts')} />
        </SafetyGate>
        <Metric icon={ShieldAlert} label="Open breaches" metric={metrics.breaches} tone="amber" onClick={() => onNavigate?.('breach-review')} />
        <Metric icon={Binoculars} label="Observations today" metric={metrics.observations} tone="green" onClick={() => onNavigate?.('reports')} />
      </section>

      {queueWarnings.length > 0 && (
        <div className="admin-data-warning" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div><strong>Some operational data is unavailable</strong><span>{queueWarnings.join(' · ')}</span></div>
        </div>
      )}

      <div className="admin-overview-layout">
        <section className="admin-priority-queue" aria-labelledby="priority-queue-heading">
          <div className="admin-section-heading">
            <div><span>Live work</span><h2 id="priority-queue-heading">Priority queue</h2></div>
            <strong>{queue.length}</strong>
          </div>

          {!loading && queue.length === 0 && queueWarnings.length === 0 ? (
            <div className="admin-queue-empty"><ClipboardCheck size={24} aria-hidden="true" /><strong>Queue clear</strong><span>No active items require review.</span></div>
          ) : (
            <div className="admin-queue-list">
              {queue.map((item) => <QueueRow key={`${item.kind}-${item.id}`} item={item} onOpen={() => onNavigate?.(item.navigate)} />)}
            </div>
          )}
        </section>

        <aside className="admin-command-panel">
          <div className="admin-section-heading"><div><span>Navigation</span><h2>Command areas</h2></div></div>
          <CommandLink icon={Radio} label="Dispatch console" detail="Jobs, resources, and SLA state" onClick={() => onNavigate?.('dispatch')} />
          <CommandLink icon={Map} label="Live operations map" detail="Officers, sites, and zones" onClick={() => onNavigate?.('live-map')} />
          <CommandLink icon={FileSearch} label="Officer activity timeline" detail="Evidence and investigation chronology" onClick={() => onNavigate?.('officer-activity')} />
          <CommandLink icon={Route} label="Patrol operations" detail="Shifts, routes, and checkpoints" onClick={() => onNavigate?.('patrol')} />
          <CommandLink icon={FileWarning} label="Field reports" detail="Review and follow-up" onClick={() => onNavigate?.('field-reports')} />
          <CommandLink icon={Car} label="Vehicle search" detail="Observation and compliance history" onClick={() => onNavigate?.('vehicle-search')} />
        </aside>
      </div>
    </div>
  );
};

function Metric({ icon: Icon, label, metric, tone, onClick }: { icon: LucideIcon; label: string; metric: MetricState; tone: string; onClick: () => void }) {
  const unavailable = metric.value === null;
  return (
    <button type="button" className={`admin-metric tone-${tone} ${unavailable ? 'is-unavailable' : ''}`} onClick={onClick} title={metric.error ?? undefined}>
      <span className="admin-metric-icon"><Icon size={19} aria-hidden="true" /></span>
      <span>{label}</span>
      <strong>{unavailable ? 'Unavailable' : metric.value}</strong>
      <ArrowRight size={16} aria-hidden="true" />
    </button>
  );
}

function QueueRow({ item, onOpen }: { item: QueueItem; onOpen: () => void }) {
  const Icon = item.kind === 'welfare' ? HeartPulse : item.kind === 'dispatch' ? Radio : item.kind === 'breach' ? ShieldAlert : item.kind === 'video' ? Binoculars : FileWarning;
  return (
    <button type="button" className={`admin-queue-row kind-${item.kind}`} onClick={onOpen}>
      <span className="admin-queue-icon"><Icon size={18} aria-hidden="true" /></span>
      <div><strong>{item.title}</strong><span>{item.detail}</span></div>
      <span className="admin-queue-status">{item.status.replace(/_/g, ' ')}</span>
      <time dateTime={item.occurredAt}>{relativeTime(item.occurredAt)}</time>
      <ArrowRight size={16} aria-hidden="true" />
    </button>
  );
}

function CommandLink({ icon: Icon, label, detail, onClick }: { icon: LucideIcon; label: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" className="admin-command-link" onClick={onClick}>
      <span><Icon size={18} aria-hidden="true" /></span>
      <div><strong>{label}</strong><small>{detail}</small></div>
      <ArrowRight size={16} aria-hidden="true" />
    </button>
  );
}

export default AdminHubPage;