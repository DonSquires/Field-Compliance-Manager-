export const ACTIVE_DISPATCH_JOB_STATUSES = [
  'pending',
  'pending_approval',
  'dispatched',
  'acknowledged',
  'en_route',
  'on_scene',
] as const;

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
