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
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { SafetyGate } from '../components/SafetyGate';
import { MetricCard } from '../components/MetricCard/MetricCard';
import { QueueCard } from '../components/QueueCard/QueueCard';
import { StatusStrip, type StatusTone } from '../components/StatusStrip/StatusStrip';
import { ACTIVE_DISPATCH_JOB_STATUSES } from '../lib/dispatchStatus';
import { describeLoadFailures } from '../lib/friendlyLoadError';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { supabase } from '../lib/supabase';
import { ShellLayout } from '../layouts/ShellLayout';
import { ADMIN_COMMAND_CENTRE_GROUPS } from '../config/adminCommandCentre';
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

interface TrendPoint {
  label: string;
  jobs: number;
  completed: number;
}

export type QueueKind = 'welfare' | 'dispatch' | 'breach' | 'report' | 'video';

export interface QueueItem {
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

function displayMetric(metric: MetricState): number | string {
  const unavailable = metric.value === null;
  return unavailable ? 'Unavailable' : metric.value ?? 0;
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
  const { selectedAgreementZones } = useServiceRelationships();
  const { status: moduleStatus, isModuleEnabled } = useEnabledModules(profile?.organizationId);
  const welfareEnabled = isModuleEnabled('welfare', { safetyRelevant: true });
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [queueWarnings, setQueueWarnings] = useState<string[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);

  const loadDashboard = useCallback(async () => {
    if (!profile?.organizationId) {
      const message = 'Organisation access could not be confirmed. Operational metrics are unavailable.';
      setMetrics(Object.fromEntries(Object.keys(EMPTY_METRICS).map((key) => [key, { value: null, error: message }])) as unknown as Metrics);
      setQueue([]);
      setTrend([]);
      setQueueWarnings([message]);
      setLastUpdated(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setQueueWarnings([]);

    const organizationId = profile.organizationId;
    const activeZoneIds = selectedAgreementZones.length > 0 ? selectedAgreementZones.map((zone) => zone.id) : null;
    const now = new Date();
    const nowIso = now.toISOString();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const trendStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);

    try {
      const [onDuty, dispatchCount, welfareCount, breachCount, observationCount, dispatchTrend, welfareRows, dispatchRows, breachRows, reportRows, videoRows] = await Promise.all([
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('shifts').select('id', { count: 'exact', head: true }).in('zone_id', activeZoneIds).lte('scheduled_start', nowIso).gte('scheduled_end', nowIso).in('status', ['accepted', 'in_progress'])
          : supabase.from('shifts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).lte('scheduled_start', nowIso).gte('scheduled_end', nowIso).in('status', ['accepted', 'in_progress']),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('dispatch_jobs').select('id', { count: 'exact', head: true }).in('zone_id', activeZoneIds).in('status', ACTIVE_DISPATCH_JOB_STATUSES)
          : supabase.from('dispatch_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ACTIVE_DISPATCH_JOB_STATUSES),
        welfareEnabled
          ? activeZoneIds && activeZoneIds.length > 0
            ? supabase.from('welfare_alerts').select('id', { count: 'exact', head: true }).in('zone_id', activeZoneIds).in('status', ['pending', 'acknowledged'])
            : supabase.from('welfare_alerts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['pending', 'acknowledged'])
          : Promise.resolve({ count: 0, error: null }),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('breach_alerts').select('id', { count: 'exact', head: true }).in('zone_id', activeZoneIds).in('status', ['open', 'acknowledged', 'actioned'])
          : supabase.from('breach_alerts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['open', 'acknowledged', 'actioned']),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('observations').select('id', { count: 'exact', head: true }).in('zone_id', activeZoneIds).gte('observed_at', todayStart)
          : supabase.from('observations').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).gte('observed_at', todayStart),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('dispatch_jobs').select('created_at,status').in('zone_id', activeZoneIds).gte('created_at', trendStart.toISOString()).order('created_at', { ascending: true }).limit(1000)
          : supabase.from('dispatch_jobs').select('created_at,status').eq('organization_id', organizationId).gte('created_at', trendStart.toISOString()).order('created_at', { ascending: true }).limit(1000),
        welfareEnabled
          ? activeZoneIds && activeZoneIds.length > 0
            ? supabase.from('welfare_alerts').select('id, officer_user_id, alert_type, status, escalation_level, triggered_at').in('zone_id', activeZoneIds).in('status', ['pending', 'acknowledged']).order('triggered_at', { ascending: false }).limit(6)
            : supabase.from('welfare_alerts').select('id, officer_user_id, alert_type, status, escalation_level, triggered_at').eq('organization_id', organizationId).in('status', ['pending', 'acknowledged']).order('triggered_at', { ascending: false }).limit(6)
          : Promise.resolve({ data: [], error: null }),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('dispatch_jobs').select('id, job_type, priority, status, sla_respond_by, created_at').in('zone_id', activeZoneIds).in('status', ACTIVE_DISPATCH_JOB_STATUSES).order('created_at', { ascending: false }).limit(6)
          : supabase.from('dispatch_jobs').select('id, job_type, priority, status, sla_respond_by, created_at').eq('organization_id', organizationId).in('status', ACTIVE_DISPATCH_JOB_STATUSES).order('created_at', { ascending: false }).limit(6),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('breach_alerts').select('id, plate_number, breach_type, status, created_at').in('zone_id', activeZoneIds).in('status', ['open', 'acknowledged', 'actioned']).order('created_at', { ascending: false }).limit(6)
          : supabase.from('breach_alerts').select('id, plate_number, breach_type, status, created_at').eq('organization_id', organizationId).in('status', ['open', 'acknowledged', 'actioned']).order('created_at', { ascending: false }).limit(6),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('officer_field_reports').select('id, title, severity, status, reported_at').in('zone_id', activeZoneIds).eq('follow_up_required', true).eq('status', 'submitted').order('reported_at', { ascending: false }).limit(6)
          : supabase.from('officer_field_reports').select('id, title, severity, status, reported_at').eq('organization_id', organizationId).eq('follow_up_required', true).eq('status', 'submitted').order('reported_at', { ascending: false }).limit(6),
        supabase.from('inference_jobs').select('id, evidence_item_id, domain, status, created_at').eq('organization_id', organizationId).in('domain', ['video_motion', 'vehicle', 'face']).in('status', ['queued', 'processing', 'manual_review_required']).order('created_at', { ascending: false }).limit(6),
      ]);

      setMetrics({
        onDuty: metricFrom(onDuty),
        activeDispatch: metricFrom(dispatchCount),
        welfare: metricFrom(welfareCount),
        breaches: metricFrom(breachCount),
        observations: metricFrom(observationCount),
      });
      if (dispatchTrend.error) {
        setTrend([]);
      } else {
        const trendByDay = new globalThis.Map<string, TrendPoint>();
        for (let offset = 0; offset < 7; offset += 1) {
          const day = new Date(trendStart);
          day.setDate(trendStart.getDate() + offset);
          const key = day.toISOString().slice(0, 10);
          trendByDay.set(key, { label: day.toLocaleDateString('en-NZ', { weekday: 'short' }), jobs: 0, completed: 0 });
        }
        for (const job of dispatchTrend.data ?? []) {
          const point = trendByDay.get(String(job.created_at).slice(0, 10));
          if (point) {
            point.jobs += 1;
            if (job.status === 'completed') point.completed += 1;
          }
        }
        setTrend([...trendByDay.values()]);
      }

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
  }, [profile?.organizationId, selectedAgreementZones, welfareEnabled]);

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
  const overviewTone: StatusTone = attentionUnavailable ? 'watch' : attentionCount > 0 ? 'action' : 'normal';
  const overviewMessage = attentionUnavailable
    ? 'Some operational counts are unavailable. Review metric status before relying on the queue.'
    : attentionCount > 0
      ? `${attentionCount} active items need attention across safety, dispatch, and compliance.`
      : 'Operations are clear across safety, dispatch, and compliance.';
  const maxTrendJobs = Math.max(1, ...trend.map((point) => point.jobs));
  const visibleCommandGroups = ADMIN_COMMAND_CENTRE_GROUPS.filter((group) => group.allowedRoles.some((role) => role === profile?.role));

  return (
    <ShellLayout shell="admin" className="admin-shell-surface">
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

      <StatusStrip tone={overviewTone}>{overviewMessage}</StatusStrip>

      <section className="admin-dashboard" aria-labelledby="dashboard-heading">
        <div className="admin-dashboard-heading">
          <div><span>Operational intelligence</span><h2 id="dashboard-heading">Dashboard</h2></div>
          <small>Live totals and the last seven days</small>
        </div>
        <section className="admin-metric-grid" aria-label="Current operations metrics">
          <MetricCard icon={Users} label="On duty now" value={displayMetric(metrics.onDuty)} unavailable={metrics.onDuty.value === null} title={metrics.onDuty.error ?? undefined} tone="blue" onClick={() => onNavigate?.('roster')} />
          <MetricCard icon={Radio} label="Active dispatch" value={displayMetric(metrics.activeDispatch)} unavailable={metrics.activeDispatch.value === null} title={metrics.activeDispatch.error ?? undefined} tone="teal" onClick={() => onNavigate?.('dispatch')} />
          <MetricCard icon={ShieldAlert} label="Open breaches" value={displayMetric(metrics.breaches)} unavailable={metrics.breaches.value === null} title={metrics.breaches.error ?? undefined} tone="amber" onClick={() => onNavigate?.('breach-review')} />
          <MetricCard icon={Binoculars} label="Observations today" value={displayMetric(metrics.observations)} unavailable={metrics.observations.value === null} title={metrics.observations.error ?? undefined} tone="green" onClick={() => onNavigate?.('reports')} />
          <SafetyGate status={moduleStatus} isEnabled={welfareEnabled} moduleLabel="Welfare monitoring" safetyRelevant renderUnavailable={(message) => <MetricCard icon={HeartPulse} label="Welfare alerts" value="Unavailable" unavailable title={message.description} tone="red" onClick={() => onNavigate?.('welfare-alerts')} />}>
            <MetricCard icon={HeartPulse} label="Welfare alerts" value={displayMetric(metrics.welfare)} unavailable={metrics.welfare.value === null} title={metrics.welfare.error ?? undefined} tone="red" onClick={() => onNavigate?.('welfare-alerts')} />
          </SafetyGate>
        </section>
        <section className="admin-trend-panel" aria-labelledby="dispatch-trend-heading">
          <div className="admin-section-heading"><div><span>Work volume</span><h2 id="dispatch-trend-heading">Dispatch jobs</h2></div><small>Created versus completed</small></div>
          <div className="admin-trend-chart" role="img" aria-label="Seven day dispatch jobs trend">
            {trend.map((point) => <div className="admin-trend-column" key={point.label}><div className="admin-trend-bars"><span style={{ height: `${(point.jobs / maxTrendJobs) * 100}%` }} title={`${point.jobs} jobs`} /><span className="is-completed" style={{ height: `${(point.completed / maxTrendJobs) * 100}%` }} title={`${point.completed} completed`} /></div><small>{point.label}</small></div>)}
          </div>
          <div className="admin-trend-legend"><span><i /> Jobs created</span><span><i className="is-completed" /> Completed</span></div>
        </section>
      </section>

      <section className="admin-command-centre" aria-labelledby="command-centre-heading">
        <div className="admin-command-centre-heading">
          <div>
            <span>Service provider portal</span>
            <h2 id="command-centre-heading">Command Centre</h2>
          </div>
          <small>All organisations</small>
        </div>
        <div className="admin-domain-grid">
          {visibleCommandGroups.map((group) => {
            const Icon = group.icon;
            const metric = group.stat ? metrics[group.stat] : null;
            return (
              <section key={group.key} className={`admin-domain-card admin-domain-card--${group.accent}`}>
                <header>
                  <span className="admin-domain-icon"><Icon size={18} aria-hidden="true" /></span>
                  <div><h3>{group.label}</h3><p>{group.description}</p></div>
                  <span className="admin-domain-stat"><strong>{metric?.value ?? '—'}</strong><small>{group.statLabel}</small></span>
                </header>
                <div className="admin-domain-links">
                  {group.links.map(([label, destination]) => (
                    <button key={`${group.key}-${label}`} type="button" onClick={() => onNavigate?.(destination)}>
                      {label}
                    </button>
                  ))}
                </div>
                <button type="button" className="admin-domain-open" onClick={() => onNavigate?.(group.open)}>{group.openLabel}<ArrowRight size={14} aria-hidden="true" /></button>
              </section>
            );
          })}
        </div>
      </section>

      {queueWarnings.length > 0 && (
        <div className="admin-data-warning" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div><strong>Some operational data is unavailable</strong><span>{queueWarnings.join(' · ')}</span><small>Refresh the view. If the warning persists, check service health and access scope before relying on the queue.</small></div>
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
              {queue.map((item, index) => <QueueCard key={`${item.kind}-${item.id}`} item={item} isNext={index === 0} onOpen={() => onNavigate?.(item.navigate)} />)}
            </div>
          )}
        </section>

        <aside className="admin-command-panel">
          <div className="admin-section-heading"><div><span>Navigation</span><h2>Command areas</h2></div></div>
          <div className="admin-command-group"><span>Respond now</span>
          <CommandLink icon={Radio} label="Dispatch console" detail="Jobs, resources, and SLA state" onClick={() => onNavigate?.('dispatch')} />
          <CommandLink icon={Map} label="Operational map" detail="Officers, sites, and zones" onClick={() => onNavigate?.('live-map')} />
          <CommandLink icon={Route} label="Patrol operations" detail="Shifts, routes, and checkpoints" onClick={() => onNavigate?.('patrol')} />
          </div>
          <div className="admin-command-group"><span>Review and investigate</span>
          <CommandLink icon={FileWarning} label="Field reports" detail="Review and follow-up" onClick={() => onNavigate?.('field-reports')} />
          <CommandLink icon={FileSearch} label="Officer timeline" detail="Evidence and investigation chronology" onClick={() => onNavigate?.('officer-activity')} />
          <CommandLink icon={Car} label="Vehicle lookup" detail="Observation and compliance history" onClick={() => onNavigate?.('vehicle-search')} />
          </div>
        </aside>
      </div>
      </div>
    </ShellLayout>
  );
};

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