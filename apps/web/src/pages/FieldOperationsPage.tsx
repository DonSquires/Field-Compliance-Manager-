import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Car,
  Camera,
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
import { useAuth, type AppRole } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { SafetyGate } from '../components/SafetyGate';
import { ACTIVE_DISPATCH_JOB_STATUSES } from '../lib/dispatchStatus';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { useActiveModuleContext } from '../hooks/useActiveModuleContext';
import { supabase } from '../lib/supabase';
import './FieldOperationsPage.css';

type FieldOpsArea = 'dispatch' | 'patrol' | 'live-map' | 'officer-activity' | 'welfare-alerts' | 'breach-review' | 'vehicle-search' | 'observation-search' | 'field-reports' | 'cctv-console' | 'cctv-triage' | 'cctv-review' | 'cctv-library' | 'cctv-import' | 'debrief-followup';

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

type WorkflowGroup = 'respond' | 'review';

interface FieldWorkflow {
  area: FieldOpsArea;
  label: string;
  detail: string;
  icon: LucideIcon;
  tone: string;
  group: WorkflowGroup;
  roles: AppRole[];
  moduleKeys?: string[];
  safetyRelevant?: boolean;
}

const OPERATIONS_ROLES: AppRole[] = ['grand_master', 'master', 'admin', 'admin_officer'];
const COMPLIANCE_ROLES: AppRole[] = [...OPERATIONS_ROLES, 'nzscv_monitor'];

const WORKFLOWS: FieldWorkflow[] = [
  { area: 'dispatch', label: 'Dispatch console', detail: 'Create jobs, assign resources, and manage SLA response', icon: Radio, tone: 'teal', group: 'respond', roles: OPERATIONS_ROLES, moduleKeys: ['dispatch'] },
  { area: 'live-map', label: 'Live operations', detail: 'Review GPS freshness and separately confirmed welfare state', icon: Map, tone: 'blue', group: 'respond', roles: OPERATIONS_ROLES, moduleKeys: ['dispatch'] },
  { area: 'welfare-alerts', label: 'Welfare response', detail: 'Acknowledge, investigate, and resolve active alerts', icon: HeartPulse, tone: 'red', group: 'respond', roles: OPERATIONS_ROLES, moduleKeys: ['welfare'], safetyRelevant: true },
  { area: 'patrol', label: 'Patrol operations', detail: 'Manage routes, checkpoints, visits, and exceptions', icon: Route, tone: 'green', group: 'respond', roles: OPERATIONS_ROLES, moduleKeys: ['static_guarding'] },
  { area: 'field-reports', label: 'Field reports', detail: 'Triage submitted reports and required follow-up', icon: FileWarning, tone: 'amber', group: 'respond', roles: OPERATIONS_ROLES },
  { area: 'debrief-followup', label: 'Debrief follow-up', detail: 'Own safety, equipment, and handover actions', icon: FileWarning, tone: 'amber', group: 'respond', roles: OPERATIONS_ROLES },
  { area: 'cctv-console', label: 'CCTV & video', detail: 'Playback, observations, imports, processing jobs, and evidence exports', icon: Camera, tone: 'slate', group: 'review', roles: OPERATIONS_ROLES, moduleKeys: ['cctv'] },
  { area: 'breach-review', label: 'Breach review', detail: 'Assess compliance alerts and record governed outcomes', icon: ShieldAlert, tone: 'red', group: 'review', roles: COMPLIANCE_ROLES, moduleKeys: ['freedom_camping', 'parking_enforcement'] },
  { area: 'vehicle-search', label: 'Vehicle intelligence', detail: 'Search vehicle, observation, and compliance history', icon: Car, tone: 'blue', group: 'review', roles: COMPLIANCE_ROLES, moduleKeys: ['freedom_camping', 'parking_enforcement'] },
  { area: 'observation-search', label: 'Observation search', detail: 'Search observations by place, person, vehicle, incident, or note', icon: FileSearch, tone: 'teal', group: 'review', roles: COMPLIANCE_ROLES, moduleKeys: ['freedom_camping', 'parking_enforcement', 'cctv'] },
  { area: 'officer-activity', label: 'Officer investigations', detail: 'Build audited timelines and issue hashed evidence', icon: FileSearch, tone: 'slate', group: 'review', roles: OPERATIONS_ROLES },
];

const FIELD_OPERATIONS_VIEW_BY_ROLE: Partial<Record<AppRole, { eyebrow: string; title: string; description: string }>> = {
  grand_master: { eyebrow: 'Operational oversight', title: 'Field Operations', description: 'Review live delivery across the selected organisation.' },
  master: { eyebrow: 'Operational oversight', title: 'Field Operations', description: 'Review live delivery across your organisation and branches.' },
  admin: { eyebrow: 'Operations control', title: 'Field Operations', description: 'Respond to live work and review field outcomes for your organisation.' },
  admin_officer: { eyebrow: 'Operations control', title: 'Operations workspace', description: 'Respond to live work and complete assigned operational reviews.' },
  nzscv_monitor: { eyebrow: 'Vehicle compliance', title: 'Vehicle compliance', description: 'Review vehicle observations, breaches, and compliance history.' },
};

function toMetric(response: { count: number | null; error: { message: string } | null }): MetricState {
  return response.error ? { value: null, error: response.error.message } : { value: response.count ?? 0, error: null };
}

const FieldOperationsPage: React.FC<FieldOperationsPageProps> = ({ onNavigate }) => {
  const { profile } = useAuth();
  const { selectedAgreementZones } = useServiceRelationships();
  const dispatchContext = useActiveModuleContext('dispatch');
  const { status: moduleStatus, isModuleEnabled } = useEnabledModules(profile?.organizationId);
  const dispatchEnabled = isModuleEnabled('dispatch');
  const dispatchAvailable = dispatchEnabled && dispatchContext.enabled;
  const welfareEnabled = isModuleEnabled('welfare', { safetyRelevant: true });
  const role = profile?.role ?? 'unknown';
  const showTeamMetrics = role !== 'nzscv_monitor';
  const pageView = FIELD_OPERATIONS_VIEW_BY_ROLE[role] ?? FIELD_OPERATIONS_VIEW_BY_ROLE.admin!;
  const visibleWorkflows = WORKFLOWS.filter((workflow) => workflow.roles.includes(role) && (!workflow.moduleKeys || workflow.moduleKeys.some((moduleKey) => moduleKey === 'dispatch' ? dispatchAvailable : isModuleEnabled(moduleKey, { safetyRelevant: workflow.safetyRelevant }))));
  const workflowGroups = [
    { id: 'respond' as const, eyebrow: 'Respond now', title: 'Live operations', workflows: visibleWorkflows.filter((workflow) => workflow.group === 'respond') },
    { id: 'review' as const, eyebrow: 'Review and investigate', title: 'Operational records', workflows: visibleWorkflows.filter((workflow) => workflow.group === 'review') },
  ].filter((group) => group.workflows.length > 0);
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
    const activeZoneIds = selectedAgreementZones.length > 0 ? selectedAgreementZones.map((zone) => zone.id) : null;
    const unavailableForRole = Promise.resolve({ count: null, error: null });
    const [onDuty, dispatch, welfare, reports] = await Promise.all([
      !showTeamMetrics || !dispatchAvailable ? unavailableForRole : activeZoneIds && activeZoneIds.length > 0
        ? supabase.from('shifts').select('id', { count: 'exact', head: true }).in('zone_id', activeZoneIds).lte('scheduled_start', now).gte('scheduled_end', now).in('status', ['accepted', 'in_progress'])
        : supabase.from('shifts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).lte('scheduled_start', now).gte('scheduled_end', now).in('status', ['accepted', 'in_progress']),
      !showTeamMetrics || !dispatchAvailable ? unavailableForRole : activeZoneIds && activeZoneIds.length > 0
        ? supabase.from('dispatch_jobs').select('id', { count: 'exact', head: true }).in('zone_id', activeZoneIds).in('status', ACTIVE_DISPATCH_JOB_STATUSES)
        : supabase.from('dispatch_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ACTIVE_DISPATCH_JOB_STATUSES),
      !showTeamMetrics ? unavailableForRole : welfareEnabled
        ? (activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('welfare_alerts').select('id', { count: 'exact', head: true }).in('zone_id', activeZoneIds).in('status', ['pending', 'acknowledged'])
          : supabase.from('welfare_alerts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['pending', 'acknowledged']))
        : Promise.resolve({ count: null, error: { message: 'Welfare monitoring is unavailable until organisation entitlement is confirmed.' } }),
      !showTeamMetrics ? unavailableForRole : activeZoneIds && activeZoneIds.length > 0
        ? supabase.from('officer_field_reports').select('id', { count: 'exact', head: true }).in('zone_id', activeZoneIds).eq('follow_up_required', true).eq('status', 'submitted')
        : supabase.from('officer_field_reports').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).eq('follow_up_required', true).eq('status', 'submitted'),
    ]);
    setMetrics({ onDuty: toMetric(onDuty), activeDispatch: toMetric(dispatch), welfareAlerts: toMetric(welfare), reportFollowUp: toMetric(reports) });
    setUpdatedAt(new Date());
    setLoading(false);
  }, [dispatchAvailable, profile?.organizationId, selectedAgreementZones, showTeamMetrics, welfareEnabled]);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  const warnings = Object.entries(metrics).filter(([, metric]) => metric.error);
  if (dispatchEnabled && dispatchContext.error) warnings.push(['dispatchContext', { value: null, error: dispatchContext.error }]);

  return (
    <div className="field-ops-home">
      <header className="field-ops-header">
        <div><span>{pageView.eyebrow}</span><h1>{pageView.title}</h1><p>{pageView.description}</p></div>
        <div className="field-ops-refresh">
          {updatedAt && <time dateTime={updatedAt.toISOString()}>Updated {updatedAt.toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</time>}
          <button type="button" onClick={() => void loadMetrics()} disabled={loading} title="Refresh operational counts"><RefreshCw size={16} className={loading ? 'is-spinning' : ''} />Refresh</button>
        </div>
      </header>

      {warnings.length > 0 && <div className="field-ops-warning" role="alert"><AlertTriangle size={18} /><div><strong>Some operational counts are unavailable</strong><span>{warnings.map(([name, metric]) => `${name}: ${metric.error}`).join(' · ')}</span></div></div>}

      {showTeamMetrics && <section className="field-ops-metrics" aria-label="Current operational workload">
        {dispatchAvailable && <MetricButton icon={Users} label="Officers on duty" metric={metrics.onDuty} loading={loading} onClick={() => onNavigate('live-map')} />}
        {dispatchAvailable && <MetricButton icon={Radio} label="Active dispatch" metric={metrics.activeDispatch} loading={loading} onClick={() => onNavigate('dispatch')} />}
        <SafetyGate
          status={moduleStatus}
          isEnabled={welfareEnabled}
          moduleLabel="Welfare monitoring"
          safetyRelevant
          renderUnavailable={(message) => <MetricButton icon={HeartPulse} label="Welfare alerts" metric={{ value: null, error: message.description }} loading={loading} urgent />}
        >
          <MetricButton icon={HeartPulse} label="Welfare alerts" metric={metrics.welfareAlerts} loading={loading} urgent onClick={() => onNavigate('welfare-alerts')} />
        </SafetyGate>
        <MetricButton icon={FileWarning} label="Reports for follow-up" metric={metrics.reportFollowUp} loading={loading} onClick={() => onNavigate('field-reports')} />
      </section>}

      <section className="field-ops-workflows">
        <div className="field-ops-section-heading"><div><span>Workspaces</span><h2>Your operational tools</h2></div><small>Only enabled tools for your role and organisation are shown</small></div>
        {workflowGroups.map((group) => <section className="field-ops-workflow-group" aria-labelledby={`field-ops-${group.id}`} key={group.id}>
          <div><span>{group.eyebrow}</span><h3 id={`field-ops-${group.id}`}>{group.title}</h3></div>
          <div className="field-ops-workflow-grid">
            {group.workflows.map(({ area, label, detail, icon: Icon, tone }) => (
              <button type="button" key={area} className={`field-ops-workflow tone-${tone}`} onClick={() => onNavigate(area)}>
                <span><Icon size={19} aria-hidden="true" /></span><div><strong>{label}</strong><small>{detail}</small></div><ArrowRight size={17} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>)}
      </section>
    </div>
  );
};

function MetricButton({ icon: Icon, label, metric, loading, urgent = false, onClick }: { icon: LucideIcon; label: string; metric: MetricState; loading: boolean; urgent?: boolean; onClick?: () => void }) {
  const unavailable = !loading && metric.value === null;
  return <button type="button" className={`field-ops-metric ${urgent && (metric.value ?? 0) > 0 ? 'is-urgent' : ''} ${unavailable ? 'is-unavailable' : ''}`} onClick={onClick} disabled={!onClick} title={metric.error ?? (onClick ? `Open ${label.toLowerCase()}` : undefined)}><span><Icon size={19} /></span><div><small>{label}</small><strong>{loading ? '—' : unavailable ? 'Unavailable' : metric.value}</strong></div>{onClick && <ArrowRight size={16} />}</button>;
}

export default FieldOperationsPage;