import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
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
  UserSearch,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth, type AppRole } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';
import { ACTIVE_DISPATCH_JOB_STATUSES } from '../lib/dispatchStatus';
import { useEnabledModules } from '../hooks/useEnabledModules';
import { useActiveModuleContext } from '../hooks/useActiveModuleContext';
import { supabase } from '../lib/supabase';
import './FieldOperationsPage.css';

type FieldOpsArea = 'dispatch' | 'patrol' | 'live-map' | 'officer-activity' | 'welfare-alerts' | 'breach-review' | 'vehicle-search' | 'person-search' | 'observation-search' | 'field-reports' | 'operational-continuity' | 'cctv-console' | 'cctv-triage' | 'cctv-review' | 'cctv-library' | 'cctv-import' | 'debrief-followup';

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
  metric?: keyof Metrics;
  moduleKeys?: string[];
  safetyRelevant?: boolean;
}

const OPERATIONS_ROLES: AppRole[] = ['grand_master', 'master', 'admin', 'admin_officer'];

const WORKFLOWS: FieldWorkflow[] = [
  { area: 'dispatch', label: 'Dispatch console', detail: 'Create jobs, assign resources, and manage SLA response', icon: Radio, tone: 'teal', group: 'respond', roles: OPERATIONS_ROLES, metric: 'activeDispatch', moduleKeys: ['dispatch'] },
  { area: 'live-map', label: 'Live operations', detail: 'Review GPS freshness and separately confirmed welfare state', icon: Map, tone: 'blue', group: 'respond', roles: OPERATIONS_ROLES, metric: 'onDuty', moduleKeys: ['dispatch'] },
  { area: 'welfare-alerts', label: 'Welfare response', detail: 'Acknowledge, investigate, and resolve active alerts', icon: HeartPulse, tone: 'red', group: 'respond', roles: OPERATIONS_ROLES, metric: 'welfareAlerts', moduleKeys: ['welfare'], safetyRelevant: true },
  { area: 'patrol', label: 'Patrol evidence', detail: 'Review checkpoint visits, proximity, and exceptions', icon: Route, tone: 'green', group: 'review', roles: OPERATIONS_ROLES, moduleKeys: ['patrol', 'static_guarding'] },
  { area: 'field-reports', label: 'Field reports', detail: 'Triage submitted reports and required follow-up', icon: FileWarning, tone: 'amber', group: 'respond', roles: OPERATIONS_ROLES, metric: 'reportFollowUp' },
  { area: 'debrief-followup', label: 'Debrief follow-up', detail: 'Own safety, equipment, and handover actions', icon: FileWarning, tone: 'amber', group: 'respond', roles: OPERATIONS_ROLES },
  { area: 'operational-continuity', label: 'Operational continuity', detail: 'Publish and acknowledge safe client/provider handoffs', icon: ArrowRightLeft, tone: 'teal', group: 'respond', roles: OPERATIONS_ROLES },
  { area: 'cctv-console', label: 'CCTV & video', detail: 'Playback, observations, imports, processing jobs, and evidence exports', icon: Camera, tone: 'slate', group: 'review', roles: OPERATIONS_ROLES, moduleKeys: ['cctv'] },
  { area: 'breach-review', label: 'Breach review', detail: 'Assess compliance alerts and record governed outcomes', icon: ShieldAlert, tone: 'red', group: 'review', roles: OPERATIONS_ROLES, moduleKeys: ['freedom_camping', 'parking_enforcement'] },
  { area: 'vehicle-search', label: 'Vehicle intelligence', detail: 'Search vehicle, observation, and compliance history', icon: Car, tone: 'blue', group: 'review', roles: OPERATIONS_ROLES, moduleKeys: ['freedom_camping', 'parking_enforcement'] },
  { area: 'person-search', label: 'Person search', detail: 'Find people, trespass and warning notices, expiry, and linked vehicles', icon: UserSearch, tone: 'red', group: 'review', roles: OPERATIONS_ROLES },
  { area: 'observation-search', label: 'Observation search', detail: 'Search observations by place, person, vehicle, incident, or note', icon: FileSearch, tone: 'teal', group: 'review', roles: OPERATIONS_ROLES, moduleKeys: ['freedom_camping', 'parking_enforcement', 'cctv'] },
  { area: 'officer-activity', label: 'Officer investigations', detail: 'Build audited timelines and issue hashed evidence', icon: FileSearch, tone: 'slate', group: 'review', roles: OPERATIONS_ROLES },
];

const FIELD_OPERATIONS_VIEW_BY_ROLE: Partial<Record<AppRole, { eyebrow: string; title: string; description: string }>> = {
  grand_master: { eyebrow: 'Operational oversight', title: 'Field Operations', description: 'Review live delivery across the selected organisation.' },
  master: { eyebrow: 'Operational oversight', title: 'Field Operations', description: 'Review live delivery across your organisation and branches.' },
  admin: { eyebrow: 'Operations control', title: 'Field Operations', description: 'Respond to live work and review field outcomes for your organisation.' },
  admin_officer: { eyebrow: 'Operations control', title: 'Operations workspace', description: 'Respond to live work and complete assigned operational reviews.' },
};

function toMetric(response: { count: number | null; error: { message: string } | null }): MetricState {
  return response.error ? { value: null, error: response.error.message } : { value: response.count ?? 0, error: null };
}

const FieldOperationsPage: React.FC<FieldOperationsPageProps> = ({ onNavigate }) => {
  const { profile, operatingOrganizationId } = useAuth();
  const organizationId = operatingOrganizationId ?? profile?.organizationId;
  const { selectedAgreementZones, loadedOrganizationId } = useServiceRelationships();
  const dispatchContext = useActiveModuleContext('dispatch');
  const { isModuleEnabled } = useEnabledModules(organizationId);
  const dispatchEnabled = isModuleEnabled('dispatch');
  const dispatchAvailable = dispatchEnabled && dispatchContext.enabled;
  const welfareEnabled = isModuleEnabled('welfare', { safetyRelevant: true });
  const role = profile?.role ?? 'unknown';
  const [workflowQuery, setWorkflowQuery] = useState('');
  const [activeGroup, setActiveGroup] = useState<WorkflowGroup>('respond');
  const pageView = FIELD_OPERATIONS_VIEW_BY_ROLE[role] ?? FIELD_OPERATIONS_VIEW_BY_ROLE.admin!;
  const visibleWorkflows = WORKFLOWS.filter((workflow) => workflow.roles.includes(role) && (!workflow.moduleKeys || workflow.moduleKeys.some((moduleKey) => moduleKey === 'dispatch' ? dispatchAvailable : isModuleEnabled(moduleKey, { safetyRelevant: workflow.safetyRelevant }))));
  const matchingWorkflows = visibleWorkflows.filter((workflow) => `${workflow.label} ${workflow.detail}`.toLowerCase().includes(workflowQuery.trim().toLowerCase()));
  const workflowGroups = [
    { id: 'respond' as const, eyebrow: 'Respond now', title: 'Live operations', workflows: matchingWorkflows.filter((workflow) => workflow.group === 'respond') },
    { id: 'review' as const, eyebrow: 'Review and investigate', title: 'Operational records', workflows: matchingWorkflows.filter((workflow) => workflow.group === 'review') },
  ];
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const requestGeneration = useRef(0);

  useLayoutEffect(() => {
    requestGeneration.current += 1;
    setMetrics(EMPTY_METRICS);
    setUpdatedAt(null);
    setLoading(true);
    return () => { requestGeneration.current += 1; };
  }, [organizationId, loadedOrganizationId, selectedAgreementZones, dispatchAvailable, welfareEnabled]);

  const loadMetrics = useCallback(async () => {
    const request = ++requestGeneration.current;
    if (!organizationId) {
      setMetrics(Object.fromEntries(Object.keys(EMPTY_METRICS).map((key) => [key, { value: null, error: 'Organisation access could not be confirmed.' }])) as unknown as Metrics);
      setLoading(false);
      return;
    }
    setLoading(true);
    const now = new Date().toISOString();
    const activeZoneIds = loadedOrganizationId === organizationId && selectedAgreementZones.length > 0 ? selectedAgreementZones.map((zone) => zone.id) : null;
    const unavailableForRole = Promise.resolve({ count: null, error: null });
    try {
      const [onDuty, dispatch, welfare, reports] = await Promise.all([
        !dispatchAvailable ? unavailableForRole : activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('shifts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('zone_id', activeZoneIds).lte('scheduled_start', now).gte('scheduled_end', now).in('status', ['accepted', 'in_progress'])
          : supabase.from('shifts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).lte('scheduled_start', now).gte('scheduled_end', now).in('status', ['accepted', 'in_progress']),
        !dispatchAvailable ? unavailableForRole : activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('dispatch_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('zone_id', activeZoneIds).in('status', ACTIVE_DISPATCH_JOB_STATUSES)
          : supabase.from('dispatch_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ACTIVE_DISPATCH_JOB_STATUSES),
        welfareEnabled
          ? supabase.from('welfare_alerts').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('status', ['pending', 'acknowledged'])
          : Promise.resolve({ count: null, error: { message: 'Welfare monitoring is unavailable until organisation entitlement is confirmed.' } }),
        activeZoneIds && activeZoneIds.length > 0
          ? supabase.from('officer_field_reports').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).in('zone_id', activeZoneIds).eq('follow_up_required', true).eq('status', 'submitted')
          : supabase.from('officer_field_reports').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).eq('follow_up_required', true).eq('status', 'submitted'),
      ]);
      if (request !== requestGeneration.current) return;
      setMetrics({ onDuty: toMetric(onDuty), activeDispatch: toMetric(dispatch), welfareAlerts: toMetric(welfare), reportFollowUp: toMetric(reports) });
      setUpdatedAt(new Date());
    } catch {
      if (request !== requestGeneration.current) return;
      setMetrics(Object.fromEntries(Object.keys(EMPTY_METRICS).map((key) => [key, { value: null, error: 'Operational metrics could not be loaded.' }])) as unknown as Metrics);
    } finally {
      if (request === requestGeneration.current) setLoading(false);
    }
  }, [dispatchAvailable, organizationId, loadedOrganizationId, selectedAgreementZones, welfareEnabled]);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  const warnings = Object.entries(metrics).filter(([, metric]) => metric.error);
  if (dispatchEnabled && dispatchContext.error) warnings.push(['dispatchContext', { value: null, error: dispatchContext.error }]);

  return (
    <div className="field-ops-home field-ops-command" data-active-group={activeGroup}>
      <header className="field-ops-header">
        <div><span>{pageView.eyebrow}</span><h1>{pageView.title}</h1><p>{pageView.description}</p></div>
        <div className="field-ops-refresh">
          {updatedAt && <time dateTime={updatedAt.toISOString()}>Updated {updatedAt.toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</time>}
          <button type="button" onClick={() => void loadMetrics()} disabled={loading} title="Refresh operational counts"><RefreshCw size={16} className={loading ? 'is-spinning' : ''} />Refresh</button>
        </div>
      </header>

      {warnings.length > 0 && <div className="field-ops-warning" role="alert"><AlertTriangle size={18} /><div><strong>Some operational counts are unavailable</strong><span>{warnings.map(([name, metric]) => `${name}: ${metric.error}`).join(' · ')}</span></div></div>}

      <div className="field-ops-filter">
        <label htmlFor="field-ops-query">Find a workflow</label>
        <input id="field-ops-query" type="search" value={workflowQuery} onChange={(event) => setWorkflowQuery(event.target.value)} placeholder="Search available workflows" />
        <small>Available to your role and enabled modules</small>
      </div>
      <nav className="field-ops-pane-switcher" aria-label="Workflow panes">{workflowGroups.map((group) => <button type="button" key={group.id} aria-pressed={activeGroup === group.id} onClick={() => setActiveGroup(group.id)}>{group.title} · {group.workflows.length}</button>)}</nav>
      <section className="field-ops-workflows">
        {workflowGroups.map((group) => <section className={`field-ops-workflow-group field-ops-${group.id}`} aria-labelledby={`field-ops-${group.id}`} key={group.id}>
          <div><h2 id={`field-ops-${group.id}`}>{group.title}</h2><span>{group.eyebrow}</span></div>
          <div className="field-ops-workflow-grid">
            {!group.workflows.length && <p className="field-ops-empty">{visibleWorkflows.some((workflow) => workflow.group === group.id) ? 'No matching workflows. Clear the search to see available tools.' : 'No workflows are available here for your role and enabled modules.'}</p>}
            {group.workflows.map(({ area, label, detail, icon: Icon, tone, metric: metricKey }) => {
              const metric = metricKey ? metrics[metricKey] : null;
              const count = !metricKey ? null : loading && metric?.value === null ? 'Updating' : metric?.value === null ? 'Unavailable' : metricKey === 'onDuty' ? `${metric?.value} on duty` : metricKey === 'reportFollowUp' ? `${metric?.value} follow-up` : `${metric?.value} active`;
              return (
                <button type="button" key={area} className={`field-ops-workflow tone-${tone}`} onClick={() => onNavigate(area)}>
                  <span className="field-ops-workflow-icon"><Icon size={16} aria-hidden="true" /></span><div><strong>{label}</strong><small>{detail}</small></div>{count !== null && <span className={`field-ops-workflow-count ${count === 'Unavailable' ? 'is-unavailable' : ''}`} aria-label={`Current workload: ${count}`}>{count}</span>}<ArrowRight size={14} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>)}
      </section>
    </div>
  );
};

export default FieldOperationsPage;