export const ACTIVE_DISPATCH_JOB_STATUSES = [
  'pending',
  'pending_approval',
  'dispatched',
  'acknowledged',
  'en_route',
  'on_scene',
] as const;

export type ShiftHealthStatus = 'on_track' | 'at_risk' | 'critical' | 'breached';

export function schemaDispatchJobStatus(status: string): string {
  const canonical: Record<string, string> = {
    open: 'pending',
    assigned: 'dispatched',
    in_progress: 'en_route',
    pending: 'pending',
    pending_approval: 'pending_approval',
    dispatched: 'dispatched',
    acknowledged: 'acknowledged',
    en_route: 'en_route',
    on_scene: 'on_scene',
    completed: 'completed',
    cancelled: 'cancelled',
  };

  return canonical[status] ?? status;
}

export function schemaDispatchJobPriority(priority: string): string {
  const canonical: Record<string, string> = {
    low: 'low',
    medium: 'normal',
    normal: 'normal',
    high: 'high',
    critical: 'urgent',
    urgent: 'urgent',
  };

  return canonical[priority] ?? priority;
}

export function schemaShiftHealth(health: string): ShiftHealthStatus {
  const canonical: Record<string, ShiftHealthStatus> = {
    healthy: 'on_track',
    on_track: 'on_track',
    degraded: 'at_risk',
    at_risk: 'at_risk',
    warning: 'at_risk',
    critical: 'critical',
    breached: 'breached',
  };

  return canonical[health] ?? (health as ShiftHealthStatus);
}

export function shiftHealthBadge(health: string): { label: string; tone: 'healthy' | 'degraded' | 'critical' } {
  const normalized = schemaShiftHealth(health);
  const lookups: Record<string, { label: string; tone: 'healthy' | 'degraded' | 'critical' }> = {
    on_track: { label: 'On Track', tone: 'healthy' },
    at_risk: { label: 'At Risk', tone: 'degraded' },
    critical: { label: 'Critical', tone: 'critical' },
    breached: { label: 'Breached', tone: 'critical' },
  };

  return lookups[normalized] ?? { label: normalized.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()), tone: 'degraded' };
}
