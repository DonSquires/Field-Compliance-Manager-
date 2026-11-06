import { isAdminTierRole } from '../lib/roles';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Binoculars,
  ClipboardCheck,
  HeartPulse,
  Radio,
  RefreshCw,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { LoggedActivityPanel } from './LoggedActivityPanel';
import { SafetyGate } from '../components/SafetyGate';
import { MetricCard } from '../components/MetricCard/MetricCard';
import { QueueCard } from '../components/QueueCard/QueueCard';
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

function displayMetric(metric: MetricState, loading: boolean): number | string {
  if (metric.value === null && loading) return '…';
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
  const { profile, operatingOrganizationId } = useAuth();
  const organizationId = operatingOrganizationId ?? profile?.organizationId;
  const { selectedAgreementZones, loadedOrganizationId } = useServiceRelationships();
  const { status: moduleStatus, isModuleEnabled } = useEnabledModules(organizationId);
  const welfareEnabled = isModuleEnabled('welfare', { safetyRelevant: true });
  // A deliberate "off" switch is a setting, not missing evidence; loading and read errors still fail closed below.
  const welfareSwitchedOff = moduleStatus === 'configured' && !welfareEnabled;
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [queueWarnings, setQueueWarnings] = useState<string[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [activePane, setActivePane] = useState<'queue' | 'activity' | 'exceptions'>('queue');
  const requestGeneration = useRef(0);

  useLayoutEffect(() => {
    requestGeneration.current += 1;
    setMetrics(EMPTY_METRICS);
    setQueue([]);
    setTrend([]);
    setQueueWarnings([]);
    setLastUpdated(null);
    setLoading(true);
    return () => { requestGeneration.current += 1; };
  }, [organizationId, loadedOrganizationId, selectedAgreementZones, welfareEnabled]);

  const loadDashboard = useCallback(async () => {
    const request = ++requestGeneration.current;
    if (!organizationId) {
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

    const activeZoneIds = loadedOrganizationId === organizationId && selectedAgreementZones.length > 0 ? selectedAgreementZones.map((zone) => zone.id) : null;
    const now = new Date();
    const nowIso = now.toISOString();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const trendStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);

    try {
      const [onDuty, dispatchCount, welfareCount, breachCount, observationCount, dispatchTrend, welfareRows, dispatchRows, breachRows, reportRows, videoRows] = await Promise.all([
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('shifts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('zone_id', activeZoneIds).lte('scheduled_start', nowIso).gte('scheduled_end', nowIso).in('status', ['accepted', 'in_progress'])
          : supabase.from('shifts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).lte('scheduled_start', nowIso).gte('scheduled_end', nowIso).in('status', ['accepted', 'in_progress']),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('dispatch_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('zone_id', activeZoneIds).in('status', ACTIVE_DISPATCH_JOB_STATUSES)
          : supabase.from('dispatch_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ACTIVE_DISPATCH_JOB_STATUSES),
        welfareEnabled
          ? supabase.from('welfare_alerts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['pending', 'acknowledged'])
          : Promise.resolve({ count: null, error: { message: 'Welfare monitoring is unavailable until organisation entitlement is confirmed.' } }),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('breach_alerts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('zone_id', activeZoneIds).in('status', ['open', 'acknowledged', 'actioned'])
          : supabase.from('breach_alerts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['open', 'acknowledged', 'actioned']),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('observations').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('zone_id', activeZoneIds).gte('observed_at', todayStart)
          : supabase.from('observations').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).gte('observed_at', todayStart),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('dispatch_jobs').select('created_at,status').eq('organization_id', organizationId).in('zone_id', activeZoneIds).gte('created_at', trendStart.toISOString()).order('created_at', { ascending: true }).limit(1000)
          : supabase.from('dispatch_jobs').select('created_at,status').eq('organization_id', organizationId).gte('created_at', trendStart.toISOString()).order('created_at', { ascending: true }).limit(1000),
        welfareEnabled
          ? supabase.from('welfare_alerts').select('id, officer_user_id, alert_type, status, escalation_level, triggered_at').eq('organization_id', organizationId).in('status', ['pending', 'acknowledged']).order('triggered_at', { ascending: false }).limit(6)
          : Promise.resolve({ data: [], error: null }),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('dispatch_jobs').select('id, job_type, priority, status, sla_respond_by, created_at').eq('organization_id', organizationId).in('zone_id', activeZoneIds).in('status', ACTIVE_DISPATCH_JOB_STATUSES).order('created_at', { ascending: false }).limit(6)
          : supabase.from('dispatch_jobs').select('id, job_type, priority, status, sla_respond_by, created_at').eq('organization_id', organizationId).in('status', ACTIVE_DISPATCH_JOB_STATUSES).order('created_at', { ascending: false }).limit(6),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('breach_alerts').select('id, plate_number, breach_type, status, created_at').eq('organization_id', organizationId).in('zone_id', activeZoneIds).in('status', ['open', 'acknowledged', 'actioned']).order('created_at', { ascending: false }).limit(6)
          : supabase.from('breach_alerts').select('id, plate_number, breach_type, status, created_at').eq('organization_id', organizationId).in('status', ['open', 'acknowledged', 'actioned']).order('created_at', { ascending: false }).limit(6),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('officer_field_reports').select('id, title, severity, status, reported_at').eq('organization_id', organizationId).in('zone_id', activeZoneIds).eq('follow_up_required', true).eq('status', 'submitted').order('reported_at', { ascending: false }).limit(6)
          : supabase.from('officer_field_reports').select('id, title, severity, status, reported_at').eq('organization_id', organizationId).eq('follow_up_required', true).eq('status', 'submitted').order('reported_at', { ascending: false }).limit(6),
        supabase.from('inference_jobs').select('id, evidence_item_id, domain, status, created_at').eq('organization_id', organizationId).in('domain', ['video_motion', 'vehicle', 'face']).in('status', ['queued', 'processing', 'manual_review_required']).order('created_at', { ascending: false }).limit(6),
      ]);
      if (request !== requestGeneration.current) return;

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
      if (request !== requestGeneration.current) return;
      const message = error instanceof Error ? error.message : 'Operations data could not be loaded.';
      setMetrics(Object.fromEntries(Object.keys(EMPTY_METRICS).map((key) => [key, { value: null, error: message }])) as unknown as Metrics);
      setQueue([]);
      setQueueWarnings([message]);
    } finally {
      if (request === requestGeneration.current) setLoading(false);
    }
  }, [organizationId, loadedOrganizationId, selectedAgreementZones, welfareEnabled]);

  useEffect(() => {
    void loadDashboard();
    const interval = window.setInterval(() => void loadDashboard(), 60_000);
    return () => window.clearInterval(interval);
  }, [loadDashboard]);

  useEffect(() => {
    if (!organizationId) return;
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
  }, [loadDashboard, organizationId, welfareEnabled]);

  const attentionMetrics = [...(welfareSwitchedOff ? [] : [metrics.welfare.value]), metrics.breaches.value, metrics.activeDispatch.value];
  const attentionCount = attentionMetrics.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const attentionUnavailable = attentionMetrics.some((value) => value === null);
  const overviewMessage = attentionUnavailable
    ? 'Some operational counts are unavailable. Review metric status before relying on the queue.'
    : attentionCount > 0
      ? `${attentionCount} active items need attention across safety, dispatch, and compliance.`
      : 'Operations are clear across safety, dispatch, and compliance.';
  const exceptions = queue.filter((item) => item.kind === 'welfare' || item.kind === 'breach');

  return (
    <div className="admin-overview adminhub-command" data-active-pane={activePane}>
      <header className="admin-overview-header">
        <div>
          <h1>Today at a glance</h1>
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
        <MetricCard icon={Users} label="On duty now" value={displayMetric(metrics.onDuty, loading)} unavailable={!loading && metrics.onDuty.value === null} loading={loading && metrics.onDuty.value === null} title={metrics.onDuty.error ?? undefined} tone="blue" onClick={() => onNavigate?.('roster')} />
        <MetricCard icon={Radio} label="Active dispatch" value={displayMetric(metrics.activeDispatch, loading)} unavailable={!loading && metrics.activeDispatch.value === null} loading={loading && metrics.activeDispatch.value === null} title={metrics.activeDispatch.error ?? undefined} tone="teal" onClick={() => onNavigate?.('dispatch')} />
        <MetricCard icon={ShieldAlert} label="Open breaches" value={displayMetric(metrics.breaches, loading)} unavailable={!loading && metrics.breaches.value === null} loading={loading && metrics.breaches.value === null} title={metrics.breaches.error ?? undefined} tone="amber" onClick={() => onNavigate?.('breach-review')} />
        <MetricCard icon={Binoculars} label="Observations today" value={displayMetric(metrics.observations, loading)} unavailable={!loading && metrics.observations.value === null} loading={loading && metrics.observations.value === null} title={metrics.observations.error ?? undefined} tone="green" onClick={() => onNavigate?.('reports')} />
        {!welfareSwitchedOff && <SafetyGate status={moduleStatus} isEnabled={welfareEnabled} moduleLabel="Welfare monitoring" safetyRelevant renderUnavailable={(message) => <MetricCard icon={HeartPulse} label="Welfare alerts" value="Unavailable" unavailable title={message.description} tone="red" />}>
          <MetricCard icon={HeartPulse} label="Welfare alerts" value={displayMetric(metrics.welfare, loading)} unavailable={!loading && metrics.welfare.value === null} loading={loading && metrics.welfare.value === null} title={metrics.welfare.error ?? undefined} tone="red" onClick={() => onNavigate?.('welfare-alerts')} />
        </SafetyGate>}
      </section>
      <div className="admin-console-status" role="status">{loading ? 'Updating operational evidence…' : overviewMessage}</div>

      {queueWarnings.length > 0 && (
        <div className="admin-data-warning" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div><strong>Some operational data is unavailable</strong><span>{queueWarnings.join(' · ')}</span><small>Refresh the view. If the warning persists, check service health and access scope before relying on the queue.</small></div>
        </div>
      )}

      <nav className="admin-pane-switcher" aria-label="Overview panes">
        {(['queue', 'activity', 'exceptions'] as const).map((pane) => <button key={pane} type="button" aria-pressed={activePane === pane} onClick={() => setActivePane(pane)}>{pane === 'queue' ? 'Priority queue' : pane === 'activity' ? 'Activity ledger' : 'Exceptions'}</button>)}
      </nav>
      <div className="admin-overview-layout">
        <section className="admin-priority-queue admin-console-pane" aria-labelledby="priority-queue-heading" tabIndex={0}>
          <div className="admin-section-heading">
            <div><h2 id="priority-queue-heading">Priority queue</h2></div>
            <strong>{queue.length}</strong>
          </div>
          <p className="admin-queue-scope-note">
            Dispatch, breaches, reports, and observations use {selectedAgreementZones.length > 0 ? 'Zones on the active agreement' : 'organization-wide scope'}. Welfare and CCTV processing are organization-wide.
          </p>

          <div className="admin-pane-scroll">
          {loading && queue.length === 0 ? (
            <div className="admin-queue-loading" role="status">Refreshing the live queue…</div>
          ) : queue.length === 0 && queueWarnings.length === 0 ? (
            <div className="admin-queue-empty">
              <ClipboardCheck size={24} aria-hidden="true" />
              <strong>Queue clear</strong>
              <span>No active items require review.</span>
              <button type="button" className="btn btn-secondary" onClick={() => onNavigate?.('reports')}>
                View activity history <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className="admin-queue-list">
              {queue.map((item, index) => <QueueCard key={`${item.kind}-${item.id}`} item={item} isNext={index === 0} onOpen={() => onNavigate?.(item.navigate)} />)}
            </div>
          )}
          </div>
          <footer className="admin-queue-footer">
            {isAdminTierRole(profile?.role) && <button type="button" onClick={() => onNavigate?.('approvals')}>Open approvals <ArrowRight size={13} aria-hidden="true" /></button>}
            <small>Review, approve or assign in the governed record.</small>
          </footer>
        </section>
        <div className="admin-console-right">
          <section className="admin-console-pane admin-console-activity" aria-label="Activity ledger" tabIndex={0}>
            <div className="admin-pane-scroll">
              <LoggedActivityPanel refreshKey={lastUpdated?.getTime()} onOpenRecords={() => onNavigate?.('reports')} />
              <details className="admin-trend-panel">
                <summary>Dispatch volume · last seven days</summary>
                <table><thead><tr><th>Day</th><th>Created</th><th>Completed</th></tr></thead><tbody>{trend.map((point) => <tr key={point.label}><td>{point.label}</td><td>{point.jobs}</td><td>{point.completed}</td></tr>)}</tbody></table>
              </details>
            </div>
          </section>
          <section className="admin-console-pane admin-console-exceptions" aria-labelledby="exceptions-heading" tabIndex={0}>
            <div className="admin-section-heading"><h2 id="exceptions-heading">Shift & compliance exceptions</h2><button type="button" onClick={() => onNavigate?.('roster')}>Review shifts <ArrowRight size={13} aria-hidden="true" /></button></div>
            <div className="admin-pane-scroll">
              <p className="admin-queue-scope-note">Safety and compliance queue samples. Shift coverage and readiness require review in the roster.</p>
              {exceptions.length ? exceptions.map((item) => <QueueCard key={`${item.kind}-${item.id}`} item={item} isNext={false} onOpen={() => onNavigate?.(item.navigate)} />) : <p className="admin-queue-loading">{loading ? 'Loading exceptions…' : queueWarnings.length || attentionUnavailable ? 'Exception evidence is incomplete. Review unavailable sources.' : 'No active exceptions in the current queue sample.'}</p>}
            </div>
          </section>
          </div>
        </div>
    </div>
  );
};

export default AdminHubPage;